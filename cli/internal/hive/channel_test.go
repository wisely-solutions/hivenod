package hive

import (
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
)

// WorkText must read exactly like the TypeScript workText (samples in surface.json).
func TestWorkTextMatchesTypeScript(t *testing.T) {
	samples := mcpserver.LoadSurface().WorkText
	if len(samples) < 20 {
		t.Fatalf("only %d samples", len(samples))
	}
	for _, s := range samples {
		row := WorkRow{ItemID: s.Row.ItemID, Title: s.Row.Title, Project: s.Row.Project, Step: s.Row.Step, Job: s.Row.Job}
		why := Arrival{Why: s.Why.Why, By: s.Why.By, Text: s.Why.Text}
		if s.Why.Question != nil {
			why.Question, why.HasQ = *s.Why.Question, true
		}
		if got := WorkText(row, why, s.MaxItems); got != s.Text {
			t.Errorf("%+v %+v %d:\n got %q\nwant %q", s.Row, s.Why, s.MaxItems, got, s.Text)
		}
	}
}

// StatusText must read exactly like the TypeScript statusText (item AzveC; samples in surface.json).
func TestStatusTextMatchesTypeScript(t *testing.T) {
	samples := mcpserver.LoadSurface().StatusText
	if len(samples) < 10 {
		t.Fatalf("only %d samples", len(samples))
	}
	for _, s := range samples {
		if got := StatusText(s.Item.ItemID, s.Item.Title, s.Why.Why, s.Why.By, s.MaxItems); got != s.Text {
			t.Errorf("%+v %+v %d:\n got %q\nwant %q", s.Item, s.Why, s.MaxItems, got, s.Text)
		}
	}
}

func TestClipLikeTypeScript(t *testing.T) {
	if clip("abc", 5) != "abc" || clip("abcdef", 4) != "abc…" {
		t.Fatal(clip("abcdef", 4))
	}
}
