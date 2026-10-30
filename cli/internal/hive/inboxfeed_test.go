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
	onQ      func([]FeedInstruct)
	instrs   []FeedInstruct
	onS      func([]FeedSummary)
	sums     []FeedSummary
	events   map[string]*FeedEvent
	woken    []string
	beats    []string
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
func (f *fakeInbox) WatchInstructs(_ context.Context, on func([]FeedInstruct)) {
	f.mu.Lock()
	f.onQ = on
	rows := f.instrs
	f.mu.Unlock()
	on(rows)
}
func (f *fakeInbox) WatchSummaries(_ context.Context, on func([]FeedSummary)) {
	f.mu.Lock()
	f.onS = on
	rows := f.sums
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

func (f *fakeInbox) Heartbeat(_ context.Context, id string) error {
	f.mu.Lock()
	f.beats = append(f.beats, id)
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
	for _, w := range []string{"check \"Review move\" (thread t7) again", "outcome_propose revises=<outcomeId>", "thread_recheck_done", "inbox_ask"} {
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

func (r *feedRig) instruct(rows []FeedInstruct) {
	r.src.mu.Lock()
	r.src.instrs = rows
	on := r.src.onQ
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

// Ask the agent (item w6O2KOw4ys70TQv9I1xD): one instruct event per request, at priority 1,
// with the request's text or chip; answered, the slot frees; a new request is a new event.
func TestInboxFeedInstruct(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1})
	r.event("e-t1", "inbox.added", map[string]any{"newThread": true})
	in := FeedInstruct{ThreadID: "t8", MemberUID: "joao", Title: "Review move", ID: "ins1", Text: "Prepare me for Thursday", AtMs: r.now.UnixMilli()}
	r.src.mu.Lock()
	r.src.instrs = []FeedInstruct{in}
	r.src.threads = []FeedThread{r.th("t1", nil)}
	r.src.mu.Unlock()
	r.feed.Start()
	r.settle()
	r.want("t8:instruct")
	r.mu.Lock()
	e := r.pushed[0]
	r.mu.Unlock()
	for _, w := range []string{"\"Review move\" (thread t8)", "request ins1", "\"Prepare me for Thursday\"", "thread_answer_instruction instructionId=ins1", "not an approval"} {
		if !strings.Contains(e.Content, w) {
			t.Fatalf("%q lacks %q", e.Content, w)
		}
	}
	if e.Meta["instruction_id"] != "ins1" {
		t.Fatalf("meta %v", e.Meta)
	}
	// The same request again (a reconnect) is not sent twice.
	r.instruct([]FeedInstruct{in})
	r.want("t8:instruct")
	// Answered: the slot frees, the new thread goes out.
	r.instruct(nil)
	r.want("t8:instruct", "t1:new")
	// A new request (a chip) is a new event.
	r.set(nil, nil)
	in2 := FeedInstruct{ThreadID: "t8", MemberUID: "joao", Title: "Review move", ID: "ins2", Chip: "summarize", AtMs: r.now.UnixMilli() + 60_000}
	r.instruct([]FeedInstruct{in2})
	r.want("t8:instruct", "t1:new", "t8:instruct")
	r.mu.Lock()
	e = r.pushed[2]
	r.mu.Unlock()
	if !strings.Contains(e.Content, "Summarize this thread") {
		t.Fatalf("%q lacks the chip's text", e.Content)
	}
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

// Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): a step carried out before a send back
// is carried out again after it, once per round, with why=sent_back and the reason; a member's
// New thread arrives as new.
func TestInboxFeedPlanSentBackCarriesOutAgain(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	r.feed.Start()
	b := FeedOutcome{ID: "o3", ThreadID: "t1", MemberUID: "joao", Type: "build", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	pl := FeedPlan{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2", "o3", "o4"}, Cursor: 2}
	r.plans([]FeedPlan{pl})
	r.set(nil, []FeedOutcome{b})
	r.want("t1:carry_out")
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	if !strings.Contains(c, "NOT merged") || r.meta(0)["why"] != "" {
		t.Fatal(c, r.meta(0))
	}
	// Build done: the gate at the cursor; then Ship it? sends the plan back to Build.
	r.set(nil, nil)
	pl.Cursor = 3
	r.plans([]FeedPlan{pl})
	r.want("t1:carry_out")
	pl.Cursor, pl.SentBack, pl.SentBackTo, pl.SentBackOf = 2, 1, "o3", "Make the button bigger"
	r.plans([]FeedPlan{pl})
	r.set(nil, []FeedOutcome{b})
	r.want("t1:carry_out", "t1:carry_out")
	if m := r.meta(1); m["why"] != "sent_back" || m["outcome_id"] != "o3" || m["step"] != "3 of 4" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c = r.pushed[1].Content
	r.mu.Unlock()
	if !strings.Contains(c, "sent back to this step: Make the button bigger") {
		t.Fatal(c)
	}
	// The same round again (a reconnect): not sent twice.
	r.set(nil, []FeedOutcome{b})
	r.want("t1:carry_out", "t1:carry_out")
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

func (r *feedRig) summaries(rows []FeedSummary) {
	r.src.mu.Lock()
	r.src.sums = rows
	on := r.src.onS
	r.src.mu.Unlock()
	if on != nil {
		on(rows)
	}
	r.settle()
}

// Summaries (item OE8FmrTaIxFVGcaeGG3N): a thread changed 3 minutes ago or more without a newer
// summary gets one summarize event, at the lowest priority, once per change, never while other
// work on it is in flight; a fresh summary frees the slot.
func TestInboxFeedSummarize(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	now := r.now.UnixMilli()
	fresh := FeedSummary{ThreadID: "t2", MemberUID: "joao", Title: "Fresh", UpdatedAtMs: now - 600_000, SummaryAtMs: now - 600_000}
	young := FeedSummary{ThreadID: "t3", MemberUID: "joao", Title: "Young", UpdatedAtMs: now - 60_000, SummaryAtMs: now - 600_000}
	stale := FeedSummary{ThreadID: "t4", MemberUID: "joao", Title: "Stale", UpdatedAtMs: now - 200_000, SummaryAtMs: now - 600_000}
	none := FeedSummary{ThreadID: "t5", MemberUID: "joao", Title: "None", UpdatedAtMs: now - 200_000}
	r.src.mu.Lock()
	r.src.sums = []FeedSummary{fresh, young, stale, none}
	r.src.mu.Unlock()
	r.feed.Start()
	r.settle()
	r.want("t4:summarize", "t5:summarize")
	r.mu.Lock()
	e := r.pushed[0]
	r.mu.Unlock()
	for _, w := range []string{"\"Stale\" (thread t4) changed since its summary", "thread_summary", "Change nothing else"} {
		if !strings.Contains(e.Content, w) {
			t.Fatalf("%q lacks %q", e.Content, w)
		}
	}
	// The same rows again send nothing; a summary written frees the slots; t3 comes of age.
	r.summaries([]FeedSummary{fresh, young, stale, none})
	r.want("t4:summarize", "t5:summarize")
	stale.SummaryAtMs, none.SummaryAtMs = stale.UpdatedAtMs, none.UpdatedAtMs
	r.advance(3 * time.Minute)
	r.summaries([]FeedSummary{fresh, young, stale, none})
	r.want("t4:summarize", "t5:summarize", "t3:summarize")
	// New work on a thread goes first; its summarize waits until that is out of flight.
	r.event("e-t6", "inbox.added", map[string]any{"newThread": true})
	r.set([]FeedThread{r.th("t6", nil)}, nil)
	r.want("t4:summarize", "t5:summarize", "t3:summarize", "t6:new")
	r.summaries([]FeedSummary{fresh, young, stale, none, {ThreadID: "t6", MemberUID: "joao", Title: "Thread t6", UpdatedAtMs: r.now.UnixMilli() - 600_000}})
	r.want("t4:summarize", "t5:summarize", "t3:summarize", "t6:new")
}

// Long steps (item OE8FmrTaIxFVGcaeGG3N, slice 6b): a long carry_out counts toward max items (a
// second Build waits until the first ends), bypasses the inbox cap, gets a heartbeat every 5
// minutes while this session holds it, and a running one is resumed by a new session.
func TestInboxFeedLongStepsCountTowardMaxItems(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1, MaxSteps: 1, Tick: 20 * time.Millisecond})
	r.feed.Start()
	b1 := FeedOutcome{ID: "b1", ThreadID: "t1", MemberUID: "joao", Type: "build", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	b2 := FeedOutcome{ID: "b2", ThreadID: "t2", MemberUID: "joao", Type: "build", CreatedAtMs: r.now.UnixMilli() + 1, PlanID: "p2"}
	rp := FeedOutcome{ID: "r1", ThreadID: "t3", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli()}
	r.plans([]FeedPlan{
		{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"b1"}},
		{ID: "p2", ThreadID: "t2", State: "active", Steps: []string{"b2"}},
	})
	r.set(nil, []FeedOutcome{b1, b2, rp})
	// One Build and the reply (inbox cap 1 is not used by the Build); the second Build waits.
	r.want("t1:carry_out", "t3:carry_out")
	if m := r.meta(0); m["long"] != "true" || m["outcome_id"] != "b1" {
		t.Fatal(m)
	}
	// Started: still one running, b2 still waits.
	r.set(nil, []FeedOutcome{b2})
	r.runningSteps([]FeedRunning{{ID: "b1", ThreadID: "t1", MemberUID: "joao", Type: "build", PlanID: "p1", Long: true, BeatAtMs: r.now.UnixMilli()}})
	r.want("t1:carry_out", "t3:carry_out")
	// Five minutes on: this session stamps b1.
	r.mu.Lock()
	r.now = r.now.Add(5 * time.Minute)
	r.mu.Unlock()
	r.settle()
	r.src.mu.Lock()
	beats := append([]string{}, r.src.beats...)
	r.src.mu.Unlock()
	if len(beats) == 0 || beats[0] != "b1" {
		t.Fatalf("beats %v", beats)
	}
	// b1 done: the second Build goes out (once the start grace is over).
	r.runningSteps(nil)
	r.mu.Lock()
	r.now = r.now.Add(11 * time.Second)
	r.mu.Unlock()
	r.settle()
	r.want("t1:carry_out", "t3:carry_out", "t2:carry_out")
}

func TestInboxFeedLongStepResumedByANewSession(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3, MaxSteps: 2})
	r.feed.Start()
	r.plans([]FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"x", "b1"}, Cursor: 1}})
	r.runningSteps([]FeedRunning{{ID: "b1", ThreadID: "t1", MemberUID: "joao", Type: "release", PlanID: "p1", Long: true, BeatAtMs: r.now.UnixMilli() - 3_600_000}})
	r.want("t1:carry_out")
	m := r.meta(0)
	if m["why"] != "resume" || m["outcome_id"] != "b1" || m["step"] != "2 of 2" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	if !strings.Contains(c, "was running before this session") {
		t.Fatal(c)
	}
	// Once only.
	r.runningSteps([]FeedRunning{{ID: "b1", ThreadID: "t1", MemberUID: "joao", Type: "release", PlanID: "p1", Long: true}})
	r.want("t1:carry_out")
}

// Keep green (slice 6c): a long step after Build; its carry_out says how to keep the pull
// request green and current, how to re-check while Ship it? waits, and when to give up.
func TestInboxFeedKeepGreenCarryOut(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3})
	r.feed.Start()
	k := FeedOutcome{ID: "o4", ThreadID: "t1", MemberUID: "joao", Type: "keepgreen", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	r.plans([]FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2", "o3", "o4", "o5"}, Cursor: 3}})
	r.set(nil, []FeedOutcome{k})
	r.want("t1:carry_out")
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	for _, w := range []string{"long step", "status started", "Keep green: rebase", "check rechecking", "after 3 fixes", "report failed"} {
		if !strings.Contains(c, w) {
			t.Fatalf("missing %q in %s", w, c)
		}
	}
	if m := r.meta(0); m["long"] != "true" || m["step"] != "4 of 5" {
		t.Fatal(m)
	}
}

// Reach out (item KZ6O9): a status request on an approved step this session got the carry_out for
// is pushed once as reason "status"; one on a step it never carried (or seen on first sight) is not.
func TestInboxFeedStepStatusRequest(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 1})
	r.feed.Start()
	o := FeedOutcome{ID: "o1", ThreadID: "t9", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli()}
	other := FeedOutcome{ID: "o2", ThreadID: "t8", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli(), AskAtMs: r.now.UnixMilli() - 1}
	r.set(nil, []FeedOutcome{o, other})
	r.want("t9:carry_out")
	asked := o
	asked.AskAtMs = r.now.UnixMilli() + 30*60_000
	r.set(nil, []FeedOutcome{asked, other})
	r.set(nil, []FeedOutcome{asked, other})
	r.want("t9:carry_out", "t9:status")
	r.mu.Lock()
	e := r.pushed[1]
	r.mu.Unlock()
	if e.Meta["outcome_id"] != "o1" || !strings.Contains(e.Content, "Hivenod asks for a status on a reply (outcome o1) on thread t9") {
		t.Fatal(e)
	}
}

func TestInboxFeedTheirReply(t *testing.T) {
	r := newRig(t, InboxOptions{MaxInbox: 3, Tick: time.Minute})
	r.src.plans = []FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2"}, Cursor: 0}}
	r.feed.Start()
	step := FeedRunning{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "their_reply", PlanID: "p1", ExtN: 1, ExtState: "proposed"}
	r.runningSteps([]FeedRunning{step})
	r.want() // a draft waits for the person: nothing for the agent
	// Approved: send it, once.
	step.ExtState = "approved"
	r.runningSteps([]FeedRunning{step})
	r.want("t1:ask_approved")
	m := r.meta(0)
	if m["outcome_id"] != "o1" || m["plan_id"] != "p1" || m["step"] != "1 of 2" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	if !strings.Contains(c, "step_sent outcomeId=o1") || !strings.Contains(c, "message 1") {
		t.Fatal(c)
	}
	r.runningSteps([]FeedRunning{step})
	r.want("t1:ask_approved")
	// Sent and waiting on them: no thread nudge after 3 days (the step has its own reminder).
	step.ExtState = "sent"
	r.runningSteps([]FeedRunning{step})
	r.set([]FeedThread{r.th("t1", func(x *FeedThread) { x.State = "waiting"; x.Waiting = &FeedWaiting{On: "them"} })}, nil)
	r.advance(4 * 24 * time.Hour)
	r.feed.Evaluate()
	r.settle()
	r.want("t1:ask_approved")
	// The notifier's timer fired for message 1: one reminder.
	step.RemindDue = 1
	r.runningSteps([]FeedRunning{step})
	r.runningSteps([]FeedRunning{step})
	r.want("t1:ask_approved", "t1:nudge_due")
	r.mu.Lock()
	c = r.pushed[1].Content
	r.mu.Unlock()
	if !strings.Contains(c, "step_ask outcomeId=o1 kind nudge") {
		t.Fatal(c)
	}
	// Their reply comes in: external_reply with the step.
	r.event("e-t1", "inbox.added", map[string]any{"messageDocId": "im1", "reopened": true})
	r.set([]FeedThread{r.th("t1", nil)}, nil)
	r.want("t1:ask_approved", "t1:nudge_due", "t1:external_reply")
	m = r.meta(2)
	if m["outcome_id"] != "o1" || m["plan_id"] != "p1" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c = r.pushed[2].Content
	r.mu.Unlock()
	for _, w := range []string{"outcome_done o1 status done with evidence", "kind follow_up", "inbox_ask"} {
		if !strings.Contains(c, w) {
			t.Fatalf("%q lacks %q", c, w)
		}
	}
}

// schedInbox is a fake source that also reads a run's `scheduled` context.
type schedInbox struct {
	*fakeInbox
	reads int
	fail  bool
}

func (s *schedInbox) ScheduledOf(_ context.Context, sid, key string) (*ScheduledInfo, error) {
	s.mu.Lock()
	s.reads++
	s.mu.Unlock()
	if s.fail {
		return nil, fmt.Errorf("offline")
	}
	return &ScheduledInfo{ScheduleID: sid, Title: "Send invoices", Period: "Nov 2026", DueAt: "2026-11-01T09:00:00Z", Due: "1 Nov 09:00"}, nil
}

func newSchedRig(t *testing.T, fail bool) (*feedRig, *schedInbox) {
	r := &feedRig{t: t, src: &fakeInbox{events: map[string]*FeedEvent{}}, now: time.UnixMilli(1_000_000_000_000)}
	src := &schedInbox{fakeInbox: r.src, fail: fail}
	r.feed = NewInboxFeed(src, func(e Event) { r.mu.Lock(); r.pushed = append(r.pushed, e); r.mu.Unlock() }, InboxOptions{MaxInbox: 3, Tick: time.Hour}, func() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.now })
	t.Cleanup(r.feed.Stop)
	return r, src
}

// Scheduled tasks (design 6): a step of a scheduled run's thread goes out with the `scheduled`
// context (which schedule, period and due time), read once per run; the next step reuses it.
func TestInboxFeedScheduledRunCarryOut(t *testing.T) {
	r, src := newSchedRig(t, false)
	r.feed.Start()
	run := r.th("t1", func(t *FeedThread) {
		t.State, t.Waiting = "waiting", &FeedWaiting{On: "agent"}
		t.Schedule = &FeedThreadSchedule{ScheduleID: "s1", RunKey: "2026-11"}
	})
	o1 := FeedOutcome{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	r.plans([]FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2"}, Cursor: 0}})
	r.set([]FeedThread{run}, []FeedOutcome{o1})
	r.want("t1:carry_out")
	m := r.meta(0)
	if m["schedule_id"] != "s1" || m["period"] != "Nov 2026" || m["plan_id"] != "p1" {
		t.Fatal(m)
	}
	r.mu.Lock()
	c := r.pushed[0].Content
	r.mu.Unlock()
	if !strings.Contains(c, "Scheduled run of 'Send invoices' for Nov 2026 (due 1 Nov 09:00) (schedule s1)") || !strings.Contains(c, "Never reschedule it yourself") {
		t.Fatal(c)
	}
	// Step 2 of the same run: no second read.
	o2 := FeedOutcome{ID: "o2", ThreadID: "t1", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli(), PlanID: "p1"}
	r.plans([]FeedPlan{{ID: "p1", ThreadID: "t1", State: "active", Steps: []string{"o1", "o2"}, Cursor: 1}})
	r.set([]FeedThread{run}, []FeedOutcome{o2})
	r.want("t1:carry_out", "t1:carry_out")
	src.mu.Lock()
	reads := src.reads
	src.mu.Unlock()
	if reads != 1 {
		t.Fatalf("reads %d, want 1", reads)
	}
	// A thread that is not a run: no context, no read.
	plain := r.th("t2", func(t *FeedThread) { t.State, t.Waiting = "waiting", &FeedWaiting{On: "agent"} })
	o3 := FeedOutcome{ID: "o3", ThreadID: "t2", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli()}
	r.set([]FeedThread{run, plain}, []FeedOutcome{o2, o3})
	r.want("t1:carry_out", "t1:carry_out", "t2:carry_out")
	if m := r.meta(2); m["schedule_id"] != "" {
		t.Fatal(m)
	}
}

// A failed read never holds the step up: it goes out with the schedule id and run key.
func TestInboxFeedScheduledReadFails(t *testing.T) {
	r, _ := newSchedRig(t, true)
	r.feed.Start()
	run := r.th("t1", func(t *FeedThread) {
		t.State, t.Waiting = "waiting", &FeedWaiting{On: "agent"}
		t.Schedule = &FeedThreadSchedule{ScheduleID: "s1", RunKey: "2026-11"}
	})
	o1 := FeedOutcome{ID: "o1", ThreadID: "t1", MemberUID: "joao", Type: "reply", CreatedAtMs: r.now.UnixMilli()}
	r.set([]FeedThread{run}, []FeedOutcome{o1})
	r.want("t1:carry_out")
	if m := r.meta(0); m["schedule_id"] != "s1" || m["period"] != "2026-11" {
		t.Fatal(m)
	}
}
