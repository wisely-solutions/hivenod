package hive

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeInbox struct {
	mu       sync.Mutex
	onT      func([]FeedThread)
	onO      func([]FeedOutcome)
	onR      func([]FeedRevise)
	revising []FeedRevise
	events   map[string]*FeedEvent
	woken    []string
	subs     int
	threads  []FeedThread
	outcomes []FeedOutcome
}

func (f *fakeInbox) WatchThreads(_ context.Context, on func([]FeedThread)) {
	f.mu.Lock()
	f.subs++
	f.onT = on
	rows := f.threads
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) WatchOutcomes(_ context.Context, on func([]FeedOutcome)) {
	f.mu.Lock()
	f.onO = on
	rows := f.outcomes
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) WatchRevising(_ context.Context, on func([]FeedRevise)) {
	f.mu.Lock()
	f.onR = on
	rows := f.revising
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) EventOf(_ context.Context, id string) (*FeedEvent, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.events[id], nil
}
func (f *fakeInbox) Wake(_ context.Context, id string) error {
	f.mu.Lock()
	f.woken = append(f.woken, id)
	f.mu.Unlock()
	return nil
}

type feedRig struct {
	t      *testing.T
	src    *fakeInbox
	feed   *InboxFeed
	now    time.Time
	mu     sync.Mutex
	pushed []Event
}

func newRig(t *testing.T, o InboxOptions) *feedRig {
	r := &feedRig{t: t, src: &fakeInbox{events: map[string]*FeedEvent{}}, now: time.UnixMilli(1_000_000_000_000)}
	if o.Tick == 0 {
		o.Tick = time.Hour
	}
	r.feed = NewInboxFeed(r.src, func(e Event) { r.mu.Lock(); r.pushed = append(r.pushed, e); r.mu.Unlock() }, o, func() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.now })
	t.Cleanup(r.feed.Stop)
	return r
}

func (r *feedRig) th(id string, mod func(*FeedThread)) FeedThread {
	t := FeedThread{ID: id, MemberUID: "joao", State: "investigating", Title: "Thread " + id, LastEventID: "e-" + id, UpdatedAtMs: r.now.UnixMilli(), LastMessageAtMs: r.now.UnixMilli()}
	if mod != nil {
		mod(&t)
	}
	return t
}
func (r *feedRig) event(id, typ string, data map[string]any) {
	r.src.mu.Lock()
	r.src.events[id] = &FeedEvent{Type: typ, Data: data}
	r.src.mu.Unlock()
}
func (r *feedRig) settle() { time.Sleep(30 * time.Millisecond) }
func (r *feedRig) set(ts []FeedThread, os []FeedOutcome) {
	r.src.mu.Lock()
	r.src.threads, r.src.outcomes = ts, os
	onT, onO := r.src.onT, r.src.onO
	r.src.mu.Unlock()
	if onT != nil {
		onT(ts)
	}
	if onO != nil {
		onO(os)
	}
	r.settle()
}
func (r *feedRig) advance(d time.Duration) { r.mu.Lock(); r.now = r.now.Add(d); r.mu.Unlock() }
func (r *feedRig) kinds() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := []string{}
	for _, e := range r.pushed {
		k := e.Meta["thread_id"] + ":" + e.Meta["reason"]
		if e.Meta["update"] == "true" {
			k += "+"
		}
		out = append(out, k)
	}
	return out
}
func (r *feedRig) want(w ...string) {
	r.t.Helper()
	if got := fmt.Sprint(r.kinds()); got != fmt.Sprint(w) {
		r.t.Fatalf("pushed %s, want %s", got, fmt.Sprint(w))
	}
}

func TestInboxFeedDedupeAndReconnect(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: -1})
	r.feed.Start()
	r.event("e-t1", "inbox.added", map[string]any{"newThread": true})
	r.set([]FeedThread{r.th("t1", nil)}, nil)
	r.want("t1:new")
	r.mu.Lock()
	m := r.pushed[0].Meta
	r.mu.Unlock()
	if m["kind"] != "inbox" || m["inbox_cap"] != "3" || m["inbox_active"] != "1" || m["member"] != "joao" {
		t.Fatal(m)
	}
	r.set([]FeedThread{r.th("t1", nil)}, nil)
	r.feed.Subscribe() // a reconnect: every document again
	r.settle()
	r.want("t1:new")
	r.src.mu.Lock()
	defer r.src.mu.Unlock()
	if r.src.subs != 2 {
		t.Fatal(r.src.subs)
	}
}

func TestInboxFeedCap(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 2})
	r.feed.Start()
	for _, id := range []string{"a", "b", "c"} {
		r.event("e-"+id, "inbox.added", map[string]any{"newThread": true})
	}
	r.set([]FeedThread{r.th("a", nil), r.th("b", nil), r.th("c", nil)}, nil)
	r.want("a:new", "b:new")
	r.event("n-a", "thread.note", nil)
	r.event("m-b", "inbox.added", map[string]any{"newThread": false})
	r.set([]FeedThread{r.th("a", func(t *FeedThread) { t.LastEventID = "n-a" }), r.th("b", func(t *FeedThread) { t.LastEventID = "m-b" }), r.th("c", nil)}, nil)
	r.want("a:new", "b:new", "b:message+")
	r.set([]FeedThread{r.th("b", func(t *FeedThread) { t.LastEventID = "m-b" }), r.th("c", nil)}, nil)
	r.want("a:new", "b:new", "b:message+", "c:new")
}

func TestInboxFeedReasonsResumeCarryOut(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1})
	r.event("x1", "thread.answered", map[string]any{"question": "Thursday?", "answer": "Yes"})
	r.event("n1", "thread.note", nil)
	r.feed.Start()
	o := FeedOutcome{ID: "o1", ThreadID: "t9", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli()}
	r.set([]FeedThread{r.th("t1", func(t *FeedThread) { t.LastEventID = "x1" }), r.th("t2", func(t *FeedThread) { t.LastEventID = "n1" })}, []FeedOutcome{o})
	r.want("t9:carry_out")
	r.set([]FeedThread{r.th("t1", func(t *FeedThread) { t.LastEventID = "x1" }), r.th("t2", func(t *FeedThread) { t.LastEventID = "n1" })}, []FeedOutcome{o})
	r.want("t9:carry_out")
	r.set([]FeedThread{r.th("t1", func(t *FeedThread) { t.LastEventID = "x1" }), r.th("t2", func(t *FeedThread) { t.LastEventID = "n1" })}, nil)
	r.want("t9:carry_out", "t1:answered")
	r.set([]FeedThread{r.th("t2", func(t *FeedThread) { t.LastEventID = "n1" })}, nil)
	r.want("t9:carry_out", "t1:answered", "t2:resume")
}

func TestInboxFeedSnoozeNudgeRate(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 10, PerMinute: 2, NudgeAfter: 72 * time.Hour})
	r.feed.Start()
	until := r.now.UnixMilli() + 1000
	snoozed := r.th("s", func(t *FeedThread) {
		t.State, t.LastEventID, t.Waiting = "waiting", "s1", &FeedWaiting{On: "date", UntilMs: &until}
	})
	waiting := r.th("w", func(t *FeedThread) { t.State, t.LastEventID, t.Waiting = "waiting", "w1", &FeedWaiting{On: "them"} })
	r.set([]FeedThread{snoozed, waiting}, nil)
	r.want()
	r.advance(72 * time.Hour)
	r.feed.Evaluate()
	r.feed.Evaluate()
	r.settle()
	r.want("w:nudge_due")
	r.src.mu.Lock()
	woken := fmt.Sprint(r.src.woken)
	r.src.mu.Unlock()
	if woken != "[s]" {
		t.Fatal(woken)
	}
	for _, id := range []string{"a", "b"} {
		r.event("e-"+id, "inbox.added", map[string]any{"newThread": true})
	}
	r.set([]FeedThread{waiting, r.th("a", nil), r.th("b", nil)}, nil)
	r.want("w:nudge_due", "a:new") // 2 a minute
	r.advance(time.Minute)
	r.feed.Evaluate()
	r.settle()
	r.want("w:nudge_due", "a:new", "b:new")
}

func TestInboxFeedOff(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 0})
	r.feed.Start()
	if r.src.subs != 0 {
		t.Fatal("subscribed while off")
	}
}

func (r *feedRig) revise(rows []FeedRevise) {
	r.src.mu.Lock()
	r.src.revising = rows
	on := r.src.onR
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

// Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): one revise event per request, at priority 1
// (after carry_out, before new work); a new request after a cancel is a new event.
func TestInboxFeedRevise(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1})
	r.event("e-t1", "inbox.added", map[string]any{"newThread": true})
	rv := FeedRevise{ID: "o1", ThreadID: "t5", MemberUID: "joao", Type: "reply", Instruction: "Mention 14:00", Chips: []string{"shorter", "availability"}, AtMs: r.now.UnixMilli()}
	r.src.mu.Lock()
	r.src.revising = []FeedRevise{rv}
	r.src.threads = []FeedThread{r.th("t1", nil)}
	r.src.mu.Unlock()
	r.feed.Start()
	r.settle()
	r.want("t5:revise")
	r.mu.Lock()
	e := r.pushed[0]
	r.mu.Unlock()
	if e.Meta["outcome_id"] != "o1" || e.Meta["outcome_type"] != "reply" {
		t.Fatal(e.Meta)
	}
	for _, w := range []string{"shorter; add my availability; \"Mention 14:00\"", "outcome_propose revises=o1", "inbox_ask"} {
		if !strings.Contains(e.Content, w) {
			t.Fatalf("%q lacks %q", e.Content, w)
		}
	}
	// The same request again (a reconnect) is not sent twice.
	r.revise([]FeedRevise{rv})
	r.want("t5:revise")
	// Revised (no longer revising): the slot frees, the new thread goes out.
	r.revise(nil)
	r.want("t5:revise", "t1:new")
	// A new request later is a new event.
	r.set(nil, nil)
	rv2 := rv
	rv2.AtMs += 60_000
	rv2.Chips, rv2.Instruction = []string{"warmer"}, ""
	r.revise([]FeedRevise{rv2})
	r.want("t5:revise", "t1:new", "t5:revise")
}
