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

// Fair hand-out (item lkkyB): agents on one step do not all go for the head item, and a lone agent
// keeps strict oldest-first.
func TestFairPick(t *testing.T) {
	var rows []WorkRow
	for _, id := range []string{"i1", "i2", "i3", "i4", "i5", "i6"} {
		rows = append(rows, WorkRow{ItemID: id})
	}
	ids := func(r []WorkRow) string {
		s := ""
		for _, x := range r {
			s += x.ItemID + " "
		}
		return s
	}
	// A lone agent (window 1): oldest first, untouched.
	if got := ids(fairPick(rows, "agentA", 1)); got != "i1 i2 i3 i4 i5 i6 " {
		t.Fatalf("lone agent: %s", got)
	}
	// Three contending agents (window 3): the first picks are spread, not all the head item.
	first := map[string]bool{}
	for _, a := range []string{"agentA", "agentB", "agentC"} {
		got := fairPick(rows, a, 3)
		first[got[0].ItemID] = true
		if len(got) != 6 || ids(got[3:]) != "i4 i5 i6 " {
			t.Fatalf("%s: rows beyond the window must stay oldest-first and none lost: %s", a, ids(got))
		}
		seen := map[string]bool{}
		for _, r := range got[:3] {
			seen[r.ItemID] = true
		}
		if !seen["i1"] || !seen["i2"] || !seen["i3"] {
			t.Fatalf("%s: the window holds the 3 oldest: %s", a, ids(got))
		}
	}
	if len(first) < 2 {
		t.Fatalf("first picks not spread: %v", first)
	}
	// Items this agent already holds stay first.
	held := []WorkRow{{ItemID: "h", Claim: &ClaimRef{Mine: true}}, rows[0], rows[1], rows[2]}
	if got := fairPick(held, "agentA", 3); got[0].ItemID != "h" {
		t.Fatalf("held first: %s", ids(got))
	}
}

func TestContentionWindow(t *testing.T) {
	s := NewSession(nil, Config{}, func(Event) {}, ChannelOptions{})
	s.noteContention(true)
	s.noteContention(true)
	if s.contended != 2 {
		t.Fatal("two losses widen the window")
	}
	s.noteContention(false)
	if s.contended != 1 {
		t.Fatal("a win narrows it")
	}
	for i := 0; i < 20; i++ {
		s.noteContention(true)
	}
	if s.contended != maxContention-1 {
		t.Fatalf("capped, got %d", s.contended)
	}
	if !IsTaken(Errf(TakenPrefix+".")) || IsTaken(Errf("other")) {
		t.Fatal("IsTaken")
	}
}

// Items tied on stepAt and updatedAt come back in id order whatever order they were listed in.
func TestOldestFirstTiesById(t *testing.T) {
	c := &Client{arrivalKeys: map[string]arrivalKey{}}
	same := model.Item{UpdatedAt: time.UnixMilli(1000)}
	for _, perm := range [][]string{{"u1", "old"}, {"old", "u1"}} {
		rows := []WorkRow{}
		for _, id := range perm {
			c.arrivalKeys[id] = arrivalKeyOf(same, id)
			rows = append(rows, WorkRow{ItemID: id})
		}
		got := c.oldestFirst(rows)
		if got[0].ItemID != "old" || got[1].ItemID != "u1" {
			t.Fatalf("order %v for input %v, want old,u1", []string{got[0].ItemID, got[1].ItemID}, perm)
		}
	}
}
