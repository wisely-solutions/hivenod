package hive

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// Item OE8FmrTaIxFVGcaeGG3N: the visual rule at person steps is in the channel instructions and
// in thread_summary's and thread_attach's descriptions (SKILL.md: scripts/plugin-skill.test.mjs).
// Slice 4: a UI change shows before/after screenshots (thread_attach both, then an image_pair).
func TestSummaryVisualRuleTexts(t *testing.T) {
	for _, w := range []string{"thread_summary", "At every person step", "noVisualWhy", "summarize", "thread_attach both, then an image_pair"} {
		if !strings.Contains(InboxInstructions, w) {
			t.Errorf("channel instructions lack %q", w)
		}
	}
	b, err := os.ReadFile("../mcpserver/surface.json")
	if err != nil {
		t.Fatal(err)
	}
	var sf struct {
		Plain, Channel struct {
			Tools []struct {
				Name        string `json:"name"`
				Description string `json:"description"`
			} `json:"tools"`
		}
	}
	if err := json.Unmarshal(b, &sf); err != nil {
		t.Fatal(err)
	}
	for _, mode := range [][]struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}{sf.Plain.Tools, sf.Channel.Tools} {
		want := map[string][]string{
			"thread_summary": {"At every person step", "noVisualWhy", "baseVersion", "thread_attach both, then an image_pair", "image_pair {"},
			"thread_attach":  {"At every person step", "before and after screenshots", "image_pair", "webp"},
		}
		for _, tl := range mode {
			for _, w := range want[tl.Name] {
				if !strings.Contains(tl.Description, w) {
					t.Errorf("%s description lacks %q", tl.Name, w)
				}
			}
			delete(want, tl.Name)
		}
		for name := range want {
			t.Errorf("%s missing from surface.json", name)
		}
	}
}

func TestSummaryState(t *testing.T) {
	at := time.UnixMilli(1000)
	later := at.Add(time.Second)
	if s := summaryState(model.InboxThread{UpdatedAt: &at}); s != "none" {
		t.Fatal(s)
	}
	if s := summaryState(model.InboxThread{UpdatedAt: &at, Summary: &model.InboxThreadSummary{At: &at}}); s != "fresh" {
		t.Fatal(s)
	}
	if s := summaryState(model.InboxThread{UpdatedAt: &later, Summary: &model.InboxThreadSummary{At: &at}}); s != "stale" {
		t.Fatal(s)
	}
	out := summaryOut(map[string]any{"at": at, "visuals": []any{map[string]any{"x": int64(1)}}}).(map[string]any)
	if out["at"] != "1970-01-01T00:00:01.000Z" {
		t.Fatal(out)
	}
}
