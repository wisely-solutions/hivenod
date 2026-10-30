package hive

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// The texts the channel sends to the model (instructions and inbox events) are
// snapshot-tested against testdata/texts.json. After changing one on purpose, rewrite the
// snapshots with UPDATE_GO_SURFACE=1 go test ./internal/hive/ and review the diff.

const textsFile = "testdata/texts.json"

type instructionsSample struct {
	MaxItems int    `json:"maxItems"`
	Text     string `json:"text"`
}

type inboxSample struct {
	Info json.RawMessage `json:"info"`
	Text string          `json:"text"`
}

type textSamples struct {
	ChannelInstructions []instructionsSample `json:"channelInstructions"`
	InboxText           []inboxSample        `json:"inboxText"`
}

func (s *inboxSample) render(t *testing.T) string {
	var info InboxEventInfo
	if err := json.Unmarshal(s.Info, &info); err != nil {
		t.Fatal(err)
	}
	return InboxText(info)
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
	if len(s.ChannelInstructions) != MaxItemsLimit || len(s.InboxText) < 15 {
		t.Fatalf("too few samples: %d %d", len(s.ChannelInstructions), len(s.InboxText))
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
	for i := range s.InboxText {
		x := &s.InboxText[i]
		check("InboxText "+string(x.Info), x.render(t), &x.Text)
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
	if !bytes.Contains([]byte(ChannelInstructions(7)), []byte("max_items is 7")) {
		t.Fatal("max items missing")
	}
	// Threads only (item OE8FmrTaIxFVGcaeGG3N, slice 11): no item tools or work events.
	for _, w := range []string{"read_item", "kind=\"work\"", "list_work", "claim ", "send_back to an earlier", "item_done", "Build it step"} {
		if strings.Contains(ChannelInstructions(3), w) {
			t.Errorf("instructions still mention %s", w)
		}
	}
}

// The channel protocol states the contract only; "one sub-agent per item" is the Claude Code
// plugin's skill (item xkQd9).
func TestChannelTextsHaveNoSubAgentHint(t *testing.T) {
	data, err := os.ReadFile(textsFile)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(data)), "sub-agent") {
		t.Fatal("a channel text mentions sub-agents")
	}
	for n := 0; n <= 10; n++ {
		if strings.Contains(ChannelInstructions(n), "sub-agent") {
			t.Fatalf("instructions for %d mention sub-agents", n)
		}
	}
}
