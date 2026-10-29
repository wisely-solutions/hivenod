package hive

import (
	"context"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// Status checks (item AzveC) with a fake clock, like the former TypeScript channel.test.ts.
func statusSetup(every int64) (*Session, *[]Event, func(time.Duration), func() time.Time) {
	t0 := time.UnixMilli(1_000_000)
	now := t0
	var pushed []Event
	s := NewSession(nil, Config{}, func(e Event) { pushMu.Lock(); pushed = append(pushed, e); pushMu.Unlock() },
		ChannelOptions{MaxItems: 2, Now: func() time.Time { return now }})
	s.every["p1"] = everyState{min: every, at: now.Add(1000 * time.Hour)} // never read again
	for _, i := range []string{"1", "2"} {
		h := &heldItem{Handover: Handover{ItemID: "i" + i, ProjectID: "p1", RunID: "r" + i, Title: "T" + i}, cancel: func() {}}
		if every > 0 {
			h.statusDue = now.Add(time.Duration(every) * time.Minute)
		}
		s.current = append(s.current, h)
	}
	return s, &pushed, func(d time.Duration) { now = now.Add(d) }, func() time.Time { return now }
}

func snapshot(s *Session, run string, over func(it *model.Item), now time.Time) {
	it := &model.Item{Status: "working", Claim: &model.Claim{RunID: run, AgentUID: "a", HeartbeatAt: now}, LastEventID: "e1"}
	if over != nil {
		over(it)
	}
	s.onStatusFields(s.byRun(run), it)
}

var pushMu sync.Mutex

func statuses(p *[]Event) []Event {
	pushMu.Lock()
	defer pushMu.Unlock()
	out := []Event{}
	for _, e := range *p {
		if e.Meta["kind"] == "status" {
			out = append(out, e)
		}
	}
	return out
}

func TestStatusChecksInterval(t *testing.T) {
	s, pushed, tick, _ := statusSetup(30)
	ctx := context.Background()
	tick(30*time.Minute - time.Millisecond)
	if got := s.StatusChecks(ctx); len(got) != 0 {
		t.Fatal(got)
	}
	tick(time.Millisecond)
	if got := s.StatusChecks(ctx); !reflect.DeepEqual(got, []string{"i1", "i2"}) {
		t.Fatal(got)
	}
	e := statuses(pushed)[0]
	if e.Meta["why"] != "interval" || e.Meta["item_id"] != "i1" || e.Meta["run_id"] != "r1" {
		t.Fatal(e.Meta)
	}
	tick(time.Minute)
	if got := s.StatusChecks(ctx); len(got) != 0 {
		t.Fatal(got)
	}
	tick(29 * time.Minute)
	if got := s.StatusChecks(ctx); len(got) != 2 {
		t.Fatal(got)
	}
}

func TestStatusChecksAnswerParkedWaiting(t *testing.T) {
	s, pushed, tick, now := statusSetup(15)
	ctx := context.Background()
	tick(10 * time.Minute)
	snapshot(s, "r1", func(it *model.Item) {
		it.StatusUpdate = &model.StatusUpdate{RunID: "r1", Text: "Tests", At: now(), By: "a"}
	}, now())
	snapshot(s, "r2", func(it *model.Item) {
		it.AwaitingAnswer = &model.Hold{QuestionID: "q", AgentUID: "a", At: now()}
	}, now())
	tick(5 * time.Minute)
	if got := s.StatusChecks(ctx); len(got) != 0 {
		t.Fatal(got)
	}
	tick(10 * time.Minute)
	if got := s.StatusChecks(ctx); !reflect.DeepEqual(got, []string{"i1"}) {
		t.Fatal(got)
	}
	s.byRun("r1").parked = &parkState{reason: "release", at: now()}
	tick(time.Hour)
	if got := s.StatusChecks(ctx); len(got) != 0 {
		t.Fatal(got)
	}
	if n := len(statuses(pushed)); n != 1 {
		t.Fatal(n)
	}
}

func TestStatusAskedOnceAndIntervalOff(t *testing.T) {
	s, pushed, tick, now := statusSetup(0)
	ctx := context.Background()
	snapshot(s, "r1", nil, now())
	tick(2 * time.Hour)
	if got := s.StatusChecks(ctx); len(got) != 0 {
		t.Fatal(got)
	}
	ask := &model.StatusAsk{RunID: "r1", ByUID: "ana", At: now()}
	snapshot(s, "r1", func(it *model.Item) { it.StatusAsk = ask }, now())
	snapshot(s, "r1", func(it *model.Item) { it.StatusAsk = ask }, now())
	time.Sleep(20 * time.Millisecond)
	got := statuses(pushed)
	if len(got) != 1 || got[0].Meta["why"] != "asked" || got[0].Meta["item_id"] != "i1" {
		t.Fatal(got)
	}
}
