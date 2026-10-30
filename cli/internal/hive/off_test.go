package hive

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

func TestOffSilences(t *testing.T) {
	at := time.UnixMilli(5000)
	for _, c := range []struct {
		doc  map[string]any
		want bool
	}{
		{map[string]any{"all": true, "agents": []any{}, "since": at}, true},
		{map[string]any{"all": false, "agents": []any{"other", "me"}, "since": at}, true},
		{map[string]any{"all": false, "agents": []any{"other"}, "since": at}, false},
		{map[string]any{"all": false, "agents": []any{}, "since": nil}, false},
	} {
		if s, off := offSilences(c.doc, "me"); off != c.want || (off && s != 5000) {
			t.Fatalf("%v: %d %v", c.doc, s, off)
		}
	}
}

// Tools refuse automated writes while Off (from the listener's view: no read), unless the
// member acted on the thread since.
func TestRefuseOff(t *testing.T) {
	c := &Client{UID: "me"}
	ctx := context.Background()
	c.setOff([]FeedOff{{MemberUID: "joao", SinceMs: 10_000}})
	if err := c.refuseOff(ctx, "ana", nil); err != nil {
		t.Fatal(err)
	}
	err := c.refuseOff(ctx, "joao", nil)
	if err == nil || !strings.Contains(Message(err), "turned agents Off at") || !strings.Contains(Message(err), "Refused while Off") {
		t.Fatal(err)
	}
	ms := func(v int64) *time.Time { x := time.UnixMilli(v); return &x }
	th := model.InboxThread{MemberUID: "joao", LastMessageAt: time.UnixMilli(9_000)}
	touched := func(s int64) bool { return touchedSince(th, s) }
	if c.refuseOff(ctx, "joao", touched) == nil {
		t.Fatal("an untouched thread is refused while Off")
	}
	th.Instructions = map[string]model.InboxInstruction{"i1": {By: "joao", At: ms(11_000)}}
	if err := c.refuseOff(ctx, "joao", touched); err != nil {
		t.Fatal("Ask the agent while Off goes through", err)
	}
	th.Instructions = nil
	th.Question = &model.InboxQuestion{AnsweredAt: ms(12_000)}
	if !touchedSince(th, 10_000) {
		t.Fatal("an answer while Off")
	}
	th.Question = nil
	th.LastMessageAt = time.UnixMilli(10_001)
	if !touchedSince(th, 10_000) {
		t.Fatal("his own message while Off")
	}
	c.setOff(nil)
	if err := c.refuseOff(ctx, "joao", nil); err != nil {
		t.Fatal("On again", err)
	}
}
