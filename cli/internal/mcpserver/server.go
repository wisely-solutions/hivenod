// Package mcpserver is a small MCP stdio server (JSON-RPC 2.0, one message per line) for
// `hivenod mcp`. The tool names, descriptions and input schemas come from surface.json, which is
// edited by hand (see cli/README.md). It also sends custom notifications
// (notifications/claude/channel).
package mcpserver

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

//go:embed surface.json
var surfaceJSON []byte

// ToolSpec is one tool as listed.
type ToolSpec struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Execution   json.RawMessage `json:"execution,omitempty"`
}

// Surface is surface.json: the server info and the tools (names, descriptions, input schemas)
// in plain and channel mode. It is hand-edited and the source of truth for the tool list: the Go
// CLI is the only agent client. surface_test.go checks it; hive's tests check every tool has a
// handler.
type Surface struct {
	ServerInfo map[string]any `json:"serverInfo"`
	Plain      struct {
		Capabilities map[string]any `json:"capabilities"`
		Tools        []ToolSpec     `json:"tools"`
	} `json:"plain"`
	Channel struct {
		Capabilities map[string]any `json:"capabilities"`
		Tools        []ToolSpec     `json:"tools"`
	} `json:"channel"`
}

// LoadSurface parses the embedded surface.
func LoadSurface() Surface {
	var s Surface
	if err := json.Unmarshal(surfaceJSON, &s); err != nil {
		panic("mcpserver: bad surface.json: " + err.Error())
	}
	return s
}

// Handler runs a tool call; args are the raw arguments (already checked against the schema).
type Handler func(ctx context.Context, args map[string]any) (any, error)

// Tool is a listed tool with its handler.
type Tool struct {
	Spec ToolSpec
	Run  Handler
}

// Server is one MCP connection over a reader/writer pair.
type Server struct {
	Info         map[string]any
	Capabilities map[string]any
	Instructions string
	Tools        []Tool
	// OnInitialized runs (in its own goroutine) after notifications/initialized.
	OnInitialized func()

	out     io.Writer
	outMu   sync.Mutex
	reqMu   sync.Mutex
	cancels map[string]context.CancelFunc
	wg      sync.WaitGroup
}

// SupportedVersions, newest first (as the TypeScript SDK).
var SupportedVersions = []string{"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"}

type message struct {
	JSONRPC string           `json:"jsonrpc"`
	ID      *json.RawMessage `json:"id,omitempty"`
	Method  string           `json:"method,omitempty"`
	Params  json.RawMessage  `json:"params,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (s *Server) write(v any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	s.outMu.Lock()
	defer s.outMu.Unlock()
	_, err := s.out.Write(buf.Bytes())
	return err
}

// Notify sends a notification to the client.
func (s *Server) Notify(method string, params any) error {
	return s.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (s *Server) reply(id *json.RawMessage, result any) {
	_ = s.write(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (s *Server) fail(id *json.RawMessage, code int, msg string) {
	_ = s.write(map[string]any{"jsonrpc": "2.0", "id": id, "error": rpcError{code, msg}})
}

// Serve reads requests until in ends (the client closed the connection) or ctx is done. It
// returns after the in-flight tool calls have been cancelled and finished.
func (s *Server) Serve(ctx context.Context, in io.Reader, out io.Writer) error {
	s.out = out
	s.cancels = map[string]context.CancelFunc{}
	ctx, cancel := context.WithCancel(ctx)
	defer func() {
		cancel()
		s.wg.Wait()
	}()
	lines := make(chan []byte)
	errc := make(chan error, 1)
	go func() {
		sc := bufio.NewScanner(in)
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			b := append([]byte(nil), sc.Bytes()...)
			select {
			case lines <- b:
			case <-ctx.Done():
				return
			}
		}
		errc <- sc.Err()
	}()
	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-errc:
			return err
		case line := <-lines:
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			s.handle(ctx, line)
		}
	}
}

func (s *Server) handle(ctx context.Context, line []byte) {
	var m message
	if err := json.Unmarshal(line, &m); err != nil {
		s.fail(nil, -32700, "Parse error")
		return
	}
	if m.ID == nil { // a notification
		switch m.Method {
		case "notifications/initialized":
			if s.OnInitialized != nil {
				go s.OnInitialized()
			}
		case "notifications/cancelled":
			var p struct {
				RequestID json.RawMessage `json:"requestId"`
			}
			_ = json.Unmarshal(m.Params, &p)
			s.reqMu.Lock()
			if c := s.cancels[string(p.RequestID)]; c != nil {
				c()
			}
			s.reqMu.Unlock()
		}
		return
	}
	if m.Method == "" { // a response to something we never send
		return
	}
	switch m.Method {
	case "initialize":
		var p struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		_ = json.Unmarshal(m.Params, &p)
		v := SupportedVersions[0]
		for _, sv := range SupportedVersions {
			if sv == p.ProtocolVersion {
				v = sv
			}
		}
		res := map[string]any{"protocolVersion": v, "capabilities": s.Capabilities, "serverInfo": s.Info}
		if s.Instructions != "" {
			res["instructions"] = s.Instructions
		}
		s.reply(m.ID, res)
	case "ping":
		s.reply(m.ID, map[string]any{})
	case "tools/list":
		specs := make([]ToolSpec, len(s.Tools))
		for i, t := range s.Tools {
			specs[i] = t.Spec
		}
		s.reply(m.ID, map[string]any{"tools": specs})
	case "tools/call":
		var p struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(m.Params, &p); err != nil {
			s.fail(m.ID, -32602, "Invalid params")
			return
		}
		var tool *Tool
		for i := range s.Tools {
			if s.Tools[i].Spec.Name == p.Name {
				tool = &s.Tools[i]
			}
		}
		if tool == nil {
			s.reply(m.ID, errorResult(fmt.Sprintf("MCP error -32602: Tool %s not found", p.Name)))
			return
		}
		if p.Arguments == nil {
			p.Arguments = map[string]any{}
		}
		if err := Validate(tool.Spec.InputSchema, p.Arguments); err != nil {
			s.reply(m.ID, errorResult(fmt.Sprintf("MCP error -32602: Input validation error: Invalid arguments for tool %s: %s", p.Name, err.Error())))
			return
		}
		p.Arguments = Strip(tool.Spec.InputSchema, p.Arguments)
		cctx, cancel := context.WithCancel(ctx)
		key := string(*m.ID)
		s.reqMu.Lock()
		s.cancels[key] = cancel
		s.reqMu.Unlock()
		s.wg.Add(1)
		go func(id *json.RawMessage) {
			defer s.wg.Done()
			defer func() {
				s.reqMu.Lock()
				delete(s.cancels, key)
				s.reqMu.Unlock()
				cancel()
			}()
			res, err := runSafe(cctx, tool.Run, p.Arguments)
			if cctx.Err() != nil {
				return // cancelled by the client, or shutting down: no answer is expected
			}
			if err != nil {
				s.reply(id, errorResult(err.Error()))
				return
			}
			s.reply(id, textResult(res))
		}(m.ID)
	default:
		s.fail(m.ID, -32601, "Method not found")
	}
}

func runSafe(ctx context.Context, h Handler, args map[string]any) (res any, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("internal error: %v", r)
		}
	}()
	return h(ctx, args)
}

// JSON renders a result as the TypeScript server does (JSON.stringify(result, null, 2)).
func JSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return string(bytes.TrimRight(buf.Bytes(), "\n"))
}

func textResult(v any) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": JSON(v)}}}
}

func errorResult(msg string) map[string]any {
	return map[string]any{"isError": true, "content": []map[string]any{{"type": "text", "text": msg}}}
}
