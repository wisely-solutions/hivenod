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
	onP      func([]FeedPlan)
	plans    []FeedPlan
	onN      func([]FeedRunning)
	running  []FeedRunning
	itemSt   map[string]string // item id -> status ("gone": deleted)
	looks    int
	revising []FeedRevise
	onK      func([]FeedRecheck)
	rechecks []FeedRecheck
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
func (f *fakeInbox) WatchRechecks(_ context.Context, on func([]FeedRecheck)) {
	f.mu.Lock()
	f.onK = on
	rows := f.rechecks
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) WatchPlans(_ context.Context, on func([]FeedPlan)) {
	f.mu.Lock()
	f.onP = on
	rows := f.plans
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) WatchRunning(_ context.Context, on func([]FeedRunning)) {
	f.mu.Lock()
	f.onN = on
	rows := f.running
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) ItemState(_ context.Context, _, itemID string) (string, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.looks++
	st := f.itemSt[itemID]
	return st, st == "gone", nil
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

func (r *feedRig) recheck(rows []FeedRecheck) {
	r.src.mu.Lock()
	r.src.rechecks = rows
	on := r.src.onK
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

// Re-check (item bmNoIvvqKCdAorLSShE9): one recheck event per request, at priority 1 (before
// new work); answered, the slot frees; a later request is a new event.
func TestInboxFeedRecheck(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1})
	r.event("e-t1", "inbox.added", map[string]any{"newThread": true})
	rk := FeedRecheck{ThreadID: "t7", MemberUID: "joao", Title: "Review move", AtMs: r.now.UnixMilli()}
	r.src.mu.Lock()
	r.src.rechecks = []FeedRecheck{rk}
	r.src.threads = []FeedThread{r.th("t1", nil)}
	r.src.mu.Unlock()
	r.feed.Start()
	r.settle()
	r.want("t7:recheck")
	r.mu.Lock()
	e := r.pushed[0]
	r.mu.Unlock()
	for _, w := range []string{"check \"Review move\" (thread t7) again", "calendar_free", "outcome_propose revises=<outcomeId>", "thread_recheck_done", "inbox_ask"} {
		if !strings.Contains(e.Content, w) {
			t.Fatalf("%q lacks %q", e.Content, w)
		}
	}
	// The same request again (a reconnect) is not sent twice.
	r.recheck([]FeedRecheck{rk})
	r.want("t7:recheck")
	// Answered: the slot frees, the new thread goes out.
	r.recheck(nil)
	r.want("t7:recheck", "t1:new")
	// A new request later is a new event.
	r.set(nil, nil)
	rk2 := rk
	rk2.AtMs += 60_000
	r.recheck([]FeedRecheck{rk2})
	r.want("t7:recheck", "t1:new", "t7:recheck")
}

func (r *feedRig) plans(rows []FeedPlan) {
	r.src.mu.Lock()
	r.src.plans = rows
	on := r.src.onP
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

func (r *feedRig) meta(i int) map[string]string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pushed[i].Meta
}

// Plans (item qwFAWxZM5xkcE7PPjAzi): an approved plan step is carried out only at its turn
// (the plan's cursor), with plan_id and step in the meta; a step approved ahead waits.
func TestInboxFeedPlanCarryOutAtTheCursor(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	r.feed.Start()
	o1 := FeedOutcome{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	o3 := FeedOutcome{ID: "o3", ThreadID: "t1", MemberUID: "joao", Type: "make_it_work", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	// The steps are approved before the plan is known: nothing goes out.
	r.set(nil, []FeedOutcome{o1, o3})
	r.want()
	pl := FeedPlan{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2", "o3"}, Cursor: 0}
	r.plans([]FeedPlan{pl})
	r.want("t1:carry_out")
	m := r.meta(0)
	if m["plan_id"] != "p1" || m["step"] != "1 of 3" || m["outcome_id"] != "o1" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	if !strings.Contains(c, "Step 1 of 3 of plan p1") {
		t.Fatal(c)
	}
	// Step 1 done, step 2 (a gate) at the cursor: o3 still waits.
	r.set(nil, []FeedOutcome{o3})
	pl.Cursor = 1
	r.plans([]FeedPlan{pl})
	r.want("t1:carry_out")
	// The gate passed: o3's turn.
	pl.Cursor = 2
	r.plans([]FeedPlan{pl})
	r.want("t1:carry_out", "t1:carry_out")
	m = r.meta(1)
	if m["outcome_id"] != "o3" || m["step"] != "3 of 3" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c = r.pushed[1].Content
	r.mu.Unlock()
	if !strings.Contains(c, "status started") {
		t.Fatal(c)
	}
}

func TestInboxFeedPlanBlockedOrStoppedSendsNothing(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	r.feed.Start()
	o := FeedOutcome{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	r.plans([]FeedPlan{{ID: "p1", ThreadID: "t1", State: "blocked", Steps: []string{"o1"}}})
	r.set(nil, []FeedOutcome{o})
	r.want()
	r.plans(nil) // stopped: no longer live
	r.want()
}

func TestInboxFeedPlanRejectedAndRevise(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	r.feed.Start()
	r.src.mu.Lock()
	r.src.events["x1"] = &FeedEvent{Type: "plan.rejected", Data: map[string]any{"planId": "p1", "reason": "Not now"}}
	r.src.events["x2"] = &FeedEvent{Type: "outcome.rejected", Data: map[string]any{"planId": "p2", "outcomeId": "g1", "reason": "Too high"}, Step: "3 of 5"}
	r.src.events["x3"] = &FeedEvent{Type: "plan.stopped", Data: map[string]any{"planId": "p3"}}
	r.src.mu.Unlock()
	r.set([]FeedThread{
		r.th("t1", func(t *FeedThread) { t.LastEventID = "x1" }),
		r.th("t2", func(t *FeedThread) { t.LastEventID = "x2" }),
		r.th("t3", func(t *FeedThread) { t.LastEventID = "x3" }),
	}, nil)
	r.settle()
	r.want("t1:rejected", "t2:rejected", "t3:rejected")
	r.mu.Lock()
	ev := append([]Event{}, r.pushed...)
	r.mu.Unlock()
	if ev[0].Meta["plan_id"] != "p1" || !strings.Contains(ev[0].Content, "rejected plan p1") || !strings.Contains(ev[0].Content, "plan_propose") {
		t.Fatal(ev[0])
	}
	if ev[1].Meta["plan_id"] != "p2" || ev[1].Meta["step"] != "3 of 5" || ev[1].Meta["outcome_id"] != "g1" || !strings.Contains(ev[1].Content, "Not approved") {
		t.Fatal(ev[1])
	}
	if !strings.Contains(ev[2].Content, "stopped plan p3") {
		t.Fatal(ev[2])
	}
	r2 := newRig(t, InboxOptions{MaxInbox: 3})
	r2.src.plans = []FeedPlan{{ID: "p1", ThreadID: "t5", State: "proposed", Steps: []string{"o0", "o1"}}}
	r2.src.revising = []FeedRevise{{ID: "o1", ThreadID: "t5", MemberUID: "joao", Type: "reply", Chips: []string{"shorter"}, AtMs: r2.now.UnixMilli(), PlanID: "p1"}}
	r2.feed.Start()
	r2.settle()
	r2.want("t5:revise")
	if m := r2.meta(0); m["plan_id"] != "p1" || m["step"] != "2 of 2" {
		t.Fatal(m)
	}
}

func (r *feedRig) runningSteps(rows []FeedRunning) {
	r.src.mu.Lock()
	r.src.running = rows
	on := r.src.onN
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

func (r *feedRig) item(id, status string) {
	r.src.mu.Lock()
	if r.src.itemSt == nil {
		r.src.itemSt = map[string]string{}
	}
	r.src.itemSt[id] = status
	r.src.mu.Unlock()
}

// Build it (item qwFAWxZM5xkcE7PPjAzi, slice 6): the item of a running step is looked at once
// a tick; Done sends item_done, stopped or deleted sends item_stopped, each once.
func TestInboxFeedBuildItItemDoneAndStopped(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3, Tick: time.Minute})
	r.src.plans = []FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o0", "o1"}, Cursor: 1}}
	r.item("i1", "working")
	r.feed.Start()
	run := FeedRunning{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "make_it_work", PlanID: "p1", ItemID: "i1", ProjectID: "web"}
	r.runningSteps([]FeedRunning{run})
	r.want()
	// Done, but looked at only once a tick.
	r.item("i1", "done")
	r.feed.Evaluate()
	r.settle()
	r.want()
	r.advance(time.Minute)
	r.feed.Evaluate()
	r.settle()
	r.want("t1:item_done")
	m := r.meta(0)
	if m["outcome_id"] != "o1" || m["item_id"] != "i1" || m["plan_id"] != "p1" || m["step"] != "2 of 2" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	for _, w := range []string{"is Done", "outcome_done o1 status done"} {
		if !strings.Contains(c, w) {
			t.Fatalf("%q lacks %q", c, w)
		}
	}
	// Once: later ticks send nothing more; reported done (no longer running) frees the slot.
	r.advance(time.Minute)
	r.feed.Evaluate()
	r.settle()
	r.want("t1:item_done")
	r.runningSteps(nil)
	if r.feed.Active() != 0 {
		t.Fatal(r.feed.Active())
	}
	// Another step whose item is deleted: item_stopped.
	r.item("i2", "gone")
	r.runningSteps([]FeedRunning{{ID: "o2", ThreadID: "t2", MemberUID: "joao", Type: "make_it_work", PlanID: "p2", ItemID: "i2"}})
	r.want("t1:item_done", "t2:item_stopped")
	r.mu.Lock()
	c = r.pushed[1].Content
	r.mu.Unlock()
	if !strings.Contains(c, "stopped or deleted") || !strings.Contains(c, "status failed") {
		t.Fatal(c)
	}
}

func TestItemLink(t *testing.T) {
	l := ItemLink("https://hivenod.com", "web site", "i/9")
	if l != "https://hivenod.com/p/web%20site?item=i%2F9" {
		t.Fatal(l)
	}
	if p, i := ItemLinkParts(l); p != "web site" || i != "i/9" {
		t.Fatal(p, i)
	}
	if p, i := ItemLinkParts("https://teams.example.com/m/1"); p != "" || i != "" {
		t.Fatal(p, i)
	}
}
