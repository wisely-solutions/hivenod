package hive

import (
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
)

// Every tool in surface.json has a Go handler, and every handler is listed (a tool is added or
// removed in Go only: surface.json plus ToolRuns).
func TestEveryToolHasAHandler(t *testing.T) {
	sf := mcpserver.LoadSurface()
	listed := map[string]bool{}
	for _, ts := range append(append([]mcpserver.ToolSpec{}, sf.Plain.Tools...), sf.Channel.Tools...) {
		listed[ts.Name] = true
		if _, ok := ToolRuns[ts.Name]; !ok {
			t.Errorf("%s is listed in surface.json but has no handler in ToolRuns", ts.Name)
		}
	}
	for name := range ToolRuns {
		if !listed[name] {
			t.Errorf("ToolRuns has %s, which surface.json does not list", name)
		}
	}
	// Building the tool lists panics on a missing handler.
	if n := len(PlainTools(&Lazy{})); n != len(sf.Plain.Tools) {
		t.Fatalf("plain: %d tools", n)
	}
	if n := len(ChannelTools(&Lazy{}, &ChannelServer{})); n != len(sf.Channel.Tools) {
		t.Fatalf("channel: %d tools", n)
	}
}
