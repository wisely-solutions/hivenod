package hive

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
)

// The texts the channel sends to the model (instructions, work, inbox and status events) are
// snapshot-tested against testdata/texts.json. After changing one on purpose, rewrite the
// snapshots with UPDATE_GO_SURFACE=1 go test ./internal/hive/ and review the diff.

const textsFile = "testdata/texts.json"

type instructionsSample struct {
	MaxItems int    `json:"maxItems"`
	Text     string `json:"text"`
}

type workSample struct {
	Row struct {
		ItemID  string  `json:"itemId"`
		Title   string  `json:"title"`
		Project string  `json:"project"`
		Step    string  `json:"step"`
		Job     *string `json:"job"`
	} `json:"row"`
	Why struct {
		Why      string  `json:"why"`
		By       string  `json:"by,omitempty"`
		Text     string  `json:"text,omitempty"`
		Question *string `json:"question,omitempty"`
	} `json:"why"`
	MaxItems int    `json:"maxItems"`
	Text     string `json:"text"`
}

type inboxSample struct {
	Info json.RawMessage `json:"info"`
	Text string          `json:"text"`
}

type statusSample struct {
	Item struct {
		ItemID string `json:"itemId"`
		Title  string `json:"title"`
	} `json:"item"`
	Why struct {
		Why string `json:"why"`
		By  string `json:"by"`
	} `json:"why"`
	MaxItems int    `json:"maxItems"`
	Text     string `json:"text"`
}

type textSamples struct {
	ChannelInstructions []instructionsSample `json:"channelInstructions"`
	WorkText            []workSample         `json:"workText"`
	InboxText           []inboxSample        `json:"inboxText"`
	StatusText          []statusSample       `json:"statusText"`
}

func (s *workSample) render() string {
	row := WorkRow{ItemID: s.Row.ItemID, Title: s.Row.Title, Project: s.Row.Project, Step: s.Row.Step, Job: s.Row.Job}
	why := Arrival{Why: s.Why.Why, By: s.Why.By, Text: s.Why.Text}
	if s.Why.Question != nil {
		why.Question, why.HasQ = *s.Why.Question, true
	}
	return WorkText(row, why, s.MaxItems)
}

func (s *inboxSample) render(t *testing.T) string {
	var info InboxEventInfo
	if err := json.Unmarshal(s.Info, &info); err != nil {
		t.Fatal(err)
	}
	return InboxText(info)
}

func (s *statusSample) render() string {
	return StatusText(s.Item.ItemID, s.Item.Title, s.Why.Why, s.Why.By, s.MaxItems)
}

func loadTexts(t *testing.T) textSamples {
	t.Helper()
	b, err := os.ReadFile(textsFile)
	if err != nil {
		t.Fatal(err)
	}
	var s textSamples
	if err := json.Unmarshal(b, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestTextSnapshots(t *testing.T) {
	s := loadTexts(t)
	if len(s.ChannelInstructions) != MaxItemsLimit || len(s.WorkText) < 20 || len(s.InboxText) < 15 || len(s.StatusText) < 10 {
		t.Fatalf("too few samples: %d %d %d %d", len(s.ChannelInstructions), len(s.WorkText), len(s.InboxText), len(s.StatusText))
	}
	update := os.Getenv("UPDATE_GO_SURFACE") == "1"
	check := func(name string, got string, want *string) {
		t.Helper()
		if update {
			*want = got
		} else if got != *want {
			t.Errorf("%s:\n got %q\nwant %q\n(rewrite with UPDATE_GO_SURFACE=1 if the change is intended)", name, got, *want)
		}
	}
	for i := range s.ChannelInstructions {
		c := &s.ChannelInstructions[i]
		if c.MaxItems != i+1 {
			t.Fatalf("channelInstructions[%d] is for %d", i, c.MaxItems)
		}
		check("ChannelInstructions", ChannelInstructions(c.MaxItems), &c.Text)
	}
	for i := range s.WorkText {
		w := &s.WorkText[i]
		check("WorkText", w.render(), &w.Text)
	}
	for i := range s.InboxText {
		x := &s.InboxText[i]
		check("InboxText "+string(x.Info), x.render(t), &x.Text)
	}
	for i := range s.StatusText {
		x := &s.StatusText[i]
		check("StatusText", x.render(), &x.Text)
	}
	if update {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(s); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(textsFile, buf.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// One item and more than one differ only where they must.
func TestChannelInstructionsMaxItems(t *testing.T) {
	if got := ChannelInstructions(0); got != ChannelInstructions(1) {
		t.Fatal("0 must read like 1")
	}
	if !bytes.Contains([]byte(ChannelInstructions(7)), []byte("Up to 7 items at a time")) {
		t.Fatal("max items missing")
	}
}
