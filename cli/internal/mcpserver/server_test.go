package mcpserver

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type pipeClient struct {
	w   io.Writer
	sc  *bufio.Scanner
	t   *testing.T
	got chan map[string]any
}

func start(t *testing.T, s *Server) *pipeClient {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	go func() { _ = s.Serve(context.Background(), inR, outW); outW.Close() }()
	c := &pipeClient{w: inW, sc: bufio.NewScanner(outR), t: t, got: make(chan map[string]any, 10)}
	c.sc.Buffer(make([]byte, 1<<20), 1<<24)
	go func() {
		for c.sc.Scan() {
			var m map[string]any
			_ = json.Unmarshal(c.sc.Bytes(), &m)
			c.got <- m
		}
		close(c.got)
	}()
	t.Cleanup(func() { inW.Close() })
	return c
}

func (c *pipeClient) send(v any) {
	b, _ := json.Marshal(v)
	c.w.Write(append(b, '\n'))
}

func (c *pipeClient) next() map[string]any {
	select {
	case m := <-c.got:
		return m
	case <-time.After(3 * time.Second):
		c.t.Fatal("no message")
	}
	return nil
}

func TestServer(t *testing.T) {
	sf := LoadSurface()
	if len(sf.Plain.Tools) != 40 || len(sf.Channel.Tools) != 41 { // channel: no wait_for_work, plus park and unpark (item QjTTL); create_item (item DhsO9); calendar_upsert/delete/free (item w9SAf); 13 inbox tools (item 4PEHr); calendar_sync and calendar_mirror (item fJnu6); status (item AzveC); thread_due (item kt3E7)
		t.Fatalf("surface: %d plain, %d channel tools", len(sf.Plain.Tools), len(sf.Channel.Tools))
	}
	var spec ToolSpec
	for _, ts := range sf.Plain.Tools {
		if ts.Name == "progress" {
			spec = ts
		}
	}
	initialized := make(chan bool, 1)
	block := make(chan struct{})
	s := &Server{
		Info:         sf.ServerInfo,
		Capabilities: sf.Plain.Capabilities,
		Tools: []Tool{
			{Spec: spec, Run: func(_ context.Context, a map[string]any) (any, error) {
				if a["itemId"] == "bad" {
					return nil, errors.New("Nope.")
				}
				if _, ok := a["extra"]; ok {
					return nil, errors.New("extra not stripped")
				}
				return map[string]any{"itemId": a["itemId"], "html": "<b>&</b>"}, nil
			}},
			{Spec: ToolSpec{Name: "slow", InputSchema: json.RawMessage(`{"type":"object"}`)}, Run: func(ctx context.Context, _ map[string]any) (any, error) {
				select {
				case <-ctx.Done():
					close(block)
					return nil, ctx.Err()
				case <-time.After(5 * time.Second):
					return "late", nil
				}
			}},
		},
		OnInitialized: func() { initialized <- true },
	}
	c := start(t, s)
	c.send(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{"protocolVersion": "2025-06-18", "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "t", "version": "1"}}})
	m := c.next()
	res := m["result"].(map[string]any)
	if res["protocolVersion"] != "2025-06-18" || res["serverInfo"].(map[string]any)["name"] != "hivenod" {
		t.Fatalf("initialize: %v", m)
	}
	c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/initialized"})
	select {
	case <-initialized:
	case <-time.After(time.Second):
		t.Fatal("OnInitialized not called")
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
	if tools := c.next()["result"].(map[string]any)["tools"].([]any); len(tools) != 2 {
		t.Fatal("tools/list")
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": map[string]any{"name": "progress", "arguments": map[string]any{"itemId": "i1", "done": 1, "total": 2, "extra": 1}}})
	r := c.next()["result"].(map[string]any)
	text := r["content"].([]any)[0].(map[string]any)["text"].(string)
	if r["isError"] != nil || text != "{\n  \"html\": \"<b>&</b>\",\n  \"itemId\": \"i1\"\n}" {
		t.Fatalf("call: %v", r)
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": map[string]any{"name": "progress", "arguments": map[string]any{"itemId": "i1", "done": 1.5, "total": 2}}})
	r = c.next()["result"].(map[string]any)
	if r["isError"] != true || !strings.Contains(r["content"].([]any)[0].(map[string]any)["text"].(string), "done: expected a whole number") {
		t.Fatalf("validation: %v", r)
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": map[string]any{"name": "progress", "arguments": map[string]any{"itemId": "bad", "done": 1, "total": 2}}})
	r = c.next()["result"].(map[string]any)
	if r["isError"] != true || r["content"].([]any)[0].(map[string]any)["text"] != "Nope." {
		t.Fatalf("error: %v", r)
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": map[string]any{"name": "slow", "arguments": map[string]any{}}})
	c.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/cancelled", "params": map[string]any{"requestId": 6}})
	select {
	case <-block:
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not reach the tool")
	}
	s.Notify("notifications/claude/channel", map[string]any{"content": "x", "meta": map[string]string{"kind": "info"}})
	if n := c.next(); n["method"] != "notifications/claude/channel" {
		t.Fatalf("notify: %v", n)
	}
	c.send(map[string]any{"jsonrpc": "2.0", "id": 7, "method": "nope"})
	if e := c.next()["error"].(map[string]any); e["code"].(float64) != -32601 {
		t.Fatal("unknown method")
	}
}
