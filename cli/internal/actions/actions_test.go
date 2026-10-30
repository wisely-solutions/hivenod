package actions

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

func TestRandomID(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		id := RandomID(20)
		if len(id) != 20 || strings.Trim(id, alphabet) != "" {
			t.Fatalf("bad id %q", id)
		}
		seen[id] = true
	}
	if len(seen) != 200 {
		t.Fatal("ids repeat")
	}
	if got := (Ctx{}).nid(); len(got) != 20 {
		t.Fatalf("default NewID gave %q", got)
	}
}

func TestAttachSizeLimit(t *testing.T) {
	ctx := Ctx{WorkspaceID: "w1", Actor: Actor{Type: "agent", ID: "a", Name: "A"}}
	ok := strings.Repeat("a", model.MaxAttachmentBytes)
	if _, err := Attach(ctx, AttachInput{ProjectID: "p", ItemID: "i", Kind: "text", Name: "n", Content: &ok}); err != nil {
		t.Fatal(err)
	}
	// 3-byte runes: the limit is in UTF-8 bytes, not characters.
	big := strings.Repeat("€", model.MaxAttachmentBytes/3+1)
	_, err := Attach(ctx, AttachInput{ProjectID: "p", ItemID: "i", Kind: "text", Name: "n", Content: &big})
	if err == nil || err.Error() != "Attachments over 900 KB must be attached as a link" {
		t.Fatalf("got %v", err)
	}
}

func TestJSStrings(t *testing.T) {
	if got := jsLen("é😀"); got != 3 {
		t.Errorf("jsLen = %d", got)
	}
	if got := jsSlice("ab😀c", 3); got != "ab" {
		t.Errorf("a cut through a pair drops it: %q", got)
	}
	if got := jsSlice("ab😀c", 4); got != "ab😀" {
		t.Errorf("jsSlice = %q", got)
	}
	// JS trims U+FEFF but not U+0085 (Go's TrimSpace does the opposite).
	if got := jsTrim("\ufeff\u2028 x \u0085"); got != "x \u0085" {
		t.Errorf("jsTrim = %q", got)
	}
	if got := jsKeys([]string{"x", "10", "2", "01", "4294967295", "4294967294"}); !reflect.DeepEqual(got,
		[]string{"2", "10", "4294967294", "x", "01", "4294967295"}) {
		t.Errorf("jsKeys = %v", got)
	}
	for _, c := range []struct{ in, want float64 }{{2.5, 3}, {-2.5, -2}, {0.49999999999999994, 0}, {-0.6, -1}} {
		if got := jsRound(c.in); got != c.want {
			t.Errorf("jsRound(%v) = %v", c.in, got)
		}
	}
}

func TestNum(t *testing.T) {
	if _, ok := Num(3).(int64); !ok {
		t.Error("3 should be an int64")
	}
	if _, ok := Num(0.25).(float64); !ok {
		t.Error("0.25 should be a float64")
	}
	if _, ok := Num(1 << 54).(float64); !ok {
		t.Error("an unsafe integer stays a float64")
	}
}

func TestItemShapeAbsentVersusNull(t *testing.T) {
	var absent, null, set model.Item
	for s, it := range map[string]*model.Item{`{}`: &absent, `{"shape":null}`: &null,
		`{"shape":{"by":{"type":"agent","id":"a"},"at":"2026-01-01T00:00:00Z","note":"n"}}`: &set} {
		if err := json.Unmarshal([]byte(s), it); err != nil {
			t.Fatal(err)
		}
	}
	if IsUnshaped(absent) || !IsUnshaped(null) || IsUnshaped(set) || !IsShaped(set) {
		t.Errorf("absent %v null %v set %v", IsUnshaped(absent), IsUnshaped(null), IsUnshaped(set))
	}
	if !IsUnshaped(model.Item{}.Unshaped()) {
		t.Error("Unshaped() should mark shape null")
	}
}

func TestMaybe(t *testing.T) {
	var in RunUsage
	if err := json.Unmarshal([]byte(`{"tokensIn":1,"tokensOut":2}`), &in); err != nil || in.Model.Set {
		t.Fatalf("absent: %+v %v", in.Model, err)
	}
	if err := json.Unmarshal([]byte(`{"model":null}`), &in); err != nil || !in.Model.Set || in.Model.V != nil {
		t.Fatalf("null: %+v %v", in.Model, err)
	}
	if u := usageFields(RunUsage{Model: Given("m")}); u["model"] != "m" {
		t.Errorf("given: %v", u)
	}
	if u := usageFields(RunUsage{Model: Null[string]()}); u["model"] != nil {
		t.Errorf("null: %v", u)
	}
}

// Item KZ6O9: the 30 s gap between two statuses is per item: a status on one item right after one
// on another item is fine; a second one on the same item within 30 s is refused.
func TestReportStatusGapPerItem(t *testing.T) {
	now := time.UnixMilli(5_000_000)
	ctx := Ctx{WorkspaceID: "w1", Actor: Actor{Type: "agent", ID: "a", Name: "A"}, Now: func() time.Time { return now }}
	item := func(run string, last *time.Time) model.Item {
		it := model.Item{Status: "working", Claim: &model.Claim{RunID: run, AgentUID: "a", HeartbeatAt: now}}
		if last != nil {
			it.StatusUpdate = &model.StatusUpdate{RunID: run, Text: "x", At: *last, By: "a"}
		}
		return it
	}
	recent := now.Add(-10 * time.Second)
	if _, err := ReportStatus(ctx, ReportStatusInput{ProjectID: "p", ItemID: "i2", Item: item("r2", nil), Text: "B"}); err != nil {
		t.Fatal(err)
	}
	if _, err := ReportStatus(ctx, ReportStatusInput{ProjectID: "p", ItemID: "i1", Item: item("r1", &recent), Text: "A"}); err == nil {
		t.Fatal("same item within 30 s should be refused")
	}
	old := now.Add(-31 * time.Second)
	if _, err := ReportStatus(ctx, ReportStatusInput{ProjectID: "p", ItemID: "i1", Item: item("r1", &old), Text: "A"}); err != nil {
		t.Fatal(err)
	}
}
