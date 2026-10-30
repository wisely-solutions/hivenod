package mcpserver

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

// surface.json is edited by hand (the Go CLI is the only agent client): these checks catch a
// broken edit before it ships. hive's TestEveryToolHasAHandler checks the handlers.

// The schema keywords the validator understands, plus the annotations it may ignore. Anything
// else (anyOf, oneOf, pattern, ...) would be silently unchecked, so it fails here first.
var knownKeywords = map[string]bool{
	"type": true, "properties": true, "required": true, "items": true, "enum": true,
	"minLength": true, "maxLength": true, "minimum": true, "maximum": true, "exclusiveMinimum": true,
	"maxItems": true, "minItems": true, "additionalProperties": true,
	"$schema": true, "description": true, "propertyNames": true,
}

func checkSchema(t *testing.T, tool, path string, raw any) {
	t.Helper()
	m, ok := raw.(map[string]any)
	if !ok {
		t.Errorf("%s %s: schema is not an object", tool, path)
		return
	}
	for k := range m {
		if !knownKeywords[k] {
			t.Errorf("%s %s: unknown schema keyword %q (teach validate.go first)", tool, path, k)
		}
	}
	if props, ok := m["properties"].(map[string]any); ok {
		for name, p := range props {
			checkSchema(t, tool, path+"."+name, p)
		}
		if req, ok := m["required"].([]any); ok {
			for _, r := range req {
				if _, ok := props[r.(string)]; !ok {
					t.Errorf("%s %s: required %v is not a property", tool, path, r)
				}
			}
		}
	}
	if items, ok := m["items"]; ok {
		checkSchema(t, tool, path+"[]", items)
	}
}

var toolName = regexp.MustCompile(`^[a-z][a-z_]*$`)

func checkTools(t *testing.T, mode string, tools []ToolSpec) map[string]ToolSpec {
	t.Helper()
	seen := map[string]ToolSpec{}
	for _, ts := range tools {
		if !toolName.MatchString(ts.Name) {
			t.Errorf("%s: bad tool name %q", mode, ts.Name)
		}
		if _, dup := seen[ts.Name]; dup {
			t.Errorf("%s: %s listed twice", mode, ts.Name)
		}
		seen[ts.Name] = ts
		if len(ts.Description) < 10 {
			t.Errorf("%s %s: description missing", mode, ts.Name)
		}
		var s map[string]any
		if err := json.Unmarshal(ts.InputSchema, &s); err != nil {
			t.Errorf("%s %s: inputSchema: %v", mode, ts.Name, err)
			continue
		}
		if s["type"] != "object" {
			t.Errorf("%s %s: inputSchema must be an object schema", mode, ts.Name)
		}
		if _, ok := s["properties"].(map[string]any); !ok {
			t.Errorf("%s %s: inputSchema has no properties", mode, ts.Name)
		}
		checkSchema(t, ts.Name, "", s)
		var v schema
		if err := json.Unmarshal(ts.InputSchema, &v); err != nil {
			t.Errorf("%s %s: the validator cannot read the schema: %v", mode, ts.Name, err)
		}
	}
	return seen
}

func TestSurfaceIsWellFormed(t *testing.T) {
	sf := LoadSurface()
	if sf.ServerInfo["name"] != "hivenod" {
		t.Fatalf("serverInfo: %v", sf.ServerInfo)
	}
	if _, ok := sf.Channel.Capabilities["experimental"].(map[string]any)["claude/channel"]; !ok {
		t.Fatal("channel mode must declare the claude/channel capability")
	}
	plain := checkTools(t, "plain", sf.Plain.Tools)
	channel := checkTools(t, "channel", sf.Channel.Tools)
	// Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 11): both modes serve the same
	// thread tools, and no item, run or calendar tool is left.
	if len(plain) != len(channel) {
		t.Errorf("plain has %d tools, channel %d", len(plain), len(channel))
	}
	for n := range plain {
		if _, ok := channel[n]; !ok {
			t.Errorf("%s only in plain mode", n)
		}
	}
	for _, n := range RemovedTools {
		if _, ok := plain[n]; ok {
			t.Errorf("removed tool %s is still listed", n)
		}
		if _, ok := channel[n]; ok {
			t.Errorf("removed tool %s is still listed in channel mode", n)
		}
	}
	for n := range plain {
		if strings.HasPrefix(n, "calendar_") {
			t.Errorf("calendar tool %s is still listed", n)
		}
	}
}

// tools/list serves surface.json as it is.
func TestToolsListServesTheSurface(t *testing.T) {
	sf := LoadSurface()
	tools := make([]Tool, len(sf.Channel.Tools))
	for i, ts := range sf.Channel.Tools {
		tools[i] = Tool{Spec: ts}
	}
	c := start(t, &Server{Info: sf.ServerInfo, Capabilities: sf.Channel.Capabilities, Tools: tools})
	c.send(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
	got, _ := json.Marshal(c.next()["result"].(map[string]any)["tools"])
	var want []any
	b, _ := json.Marshal(sf.Channel.Tools)
	_ = json.Unmarshal(b, &want)
	wantB, _ := json.Marshal(want)
	if string(got) != string(wantB) {
		t.Fatalf("tools/list differs from surface.json:\n got %s\nwant %s", got, wantB)
	}
}
