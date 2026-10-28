package hive

import (
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// The give-back skip (item QjTTL), with a fake clock.
func TestGiveBackSkip(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	s := NewSession(nil, Config{}, func(Event) {}, ChannelOptions{Now: func() time.Time { return now }})
	skipped := func(id string) bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.skipped(id)
	}
	if skipped("a") {
		t.Fatal("not given back yet")
	}
	s.GaveBack("a")
	if !skipped("a") || skipped("b") {
		t.Fatal("a skipped, b not")
	}
	now = now.Add(GiveBackSkip - time.Millisecond)
	if !skipped("a") {
		t.Fatal("still skipped just before 10 minutes")
	}
	now = now.Add(time.Millisecond)
	if skipped("a") {
		t.Fatal("back after 10 minutes")
	}
	s.GaveBack("b")
	s.ForgetGiveBack("b")
	if skipped("b") {
		t.Fatal("forgotten")
	}
}

// Hand-out order (item QjTTL): oldest stepAt first, items without one before them (by their last
// change), the id breaking ties. Same order as compareArrival in client.ts.
func TestOldestFirst(t *testing.T) {
	at := func(ms int64) *time.Time { v := time.UnixMilli(ms); return &v }
	c := &Client{arrivalKeys: map[string]arrivalKey{}}
	items := map[string]model.Item{
		"a": {StepAt: at(300), UpdatedAt: time.UnixMilli(10)},
		"b": {StepAt: at(100), UpdatedAt: time.UnixMilli(900)},
		"c": {UpdatedAt: time.UnixMilli(50)},
		"d": {UpdatedAt: time.UnixMilli(20)},
		"e": {StepAt: at(100), UpdatedAt: time.UnixMilli(900)},
	}
	rows := []WorkRow{}
	for _, id := range []string{"a", "e", "b", "c", "d"} {
		c.arrivalKeys[id] = arrivalKeyOf(items[id], id)
		rows = append(rows, WorkRow{ItemID: id})
	}
	got := ""
	for _, r := range c.oldestFirst(rows) {
		got += r.ItemID
	}
	if got != "dcbea" {
		t.Fatalf("order %s, want dcbea", got)
	}
}
