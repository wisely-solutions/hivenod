package hive

// Inbox events of a channel session (item 4PEHrOW5IfXBQWgOK9wo, part 2), ported from the former
// TypeScript inboxfeed.ts. See docs/INBOX.md ("Channel events") for who gets what, the dedupe and
// the flow control.

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// Inbox defaults (INBOX_DEFAULTS).
const (
	InboxMaxDefault    = 3
	InboxPerMinute     = 10
	InboxNudgeAfter    = 3 * 24 * time.Hour
	InboxLease         = 30 * time.Minute
	InboxTick          = 60 * time.Second
	MaxInboxLimit      = 10
	inboxRateWindowMs  = 60_000
	inboxDayMs         = 86_400_000
	inboxMinPumpWaitMs = 50
)

// FeedWaiting is what a waiting thread waits on (untilMs nil: not a date).
type FeedWaiting struct {
	On      string
	UntilMs *int64
}

// FeedThread is what the feed sees of a thread.
type FeedThread struct {
	ID, MemberUID, State, Title, LastEventID string
	UpdatedAtMs, LastMessageAtMs             int64
	Waiting                                  *FeedWaiting
}

// FeedOutcome is an approved outcome this agent carries out.
type FeedOutcome struct {
	ID, ThreadID, MemberUID, Type string
	CreatedAtMs                   int64
	// PlanID: a plan step (item qwFAWxZM5xkcE7PPjAzi), carried out only at its plan's cursor.
	PlanID string
}

// FeedPlan is a live plan (proposed, active or blocked): its steps and whose turn it is.
type FeedPlan struct {
	ID, ThreadID, State string
	Steps               []string
	Cursor              int
}

// stepOf is "3 of 5" for a step of the plan ("" when it is not one).
func (p FeedPlan) stepOf(oid string) string {
	for i, s := range p.Steps {
		if s == oid {
			return fmt.Sprintf("%d of %d", i+1, len(p.Steps))
		}
	}
	return ""
}

// turn says whether step oid is at the cursor of a plan that runs.
func (p FeedPlan) turn(oid string) bool {
	return (p.State == "proposed" || p.State == "active") && p.Cursor < len(p.Steps) && p.Steps[p.Cursor] == oid
}

// FeedRevise is an outcome this agent proposed that the person asked changes for (revising).
type FeedRevise struct {
	ID, ThreadID, MemberUID, Type string
	Instruction                   string
	Chips                         []string
	// AtMs is when they asked: a new request after a cancel is a new event.
	AtMs int64
	// PlanID: a plan step.
	PlanID string
}

// FeedEvent is an inbox event (the timeline).
type FeedEvent struct {
	Type string
	Data map[string]any
	// Step is "3 of 5" when the event is about a step of a plan (data planId and outcomeId).
	Step string
}

// InboxSource is where the feed reads from (Firestore; fakes in tests).
type InboxSource interface {
	WatchThreads(ctx context.Context, on func([]FeedThread))
	WatchOutcomes(ctx context.Context, on func([]FeedOutcome))
	WatchRevising(ctx context.Context, on func([]FeedRevise))
	WatchPlans(ctx context.Context, on func([]FeedPlan))
	EventOf(ctx context.Context, eventID string) (*FeedEvent, error)
	Wake(ctx context.Context, threadID string) error
}

// InboxOptions configure the feed (zero values: the defaults; MaxInbox -1 is "unset").
type InboxOptions struct {
	MaxInbox   int // 0 is off
	PerMinute  int
	NudgeAfter time.Duration
	Lease      time.Duration
	Tick       time.Duration
}

// InboxEventInfo is what an inbox event says (InboxEventInfo in TypeScript).
type InboxEventInfo struct {
	Reason      string  `json:"reason"`
	ThreadID    string  `json:"threadId"`
	Title       string  `json:"title"`
	OutcomeID   string  `json:"outcomeId"`
	OutcomeType string  `json:"outcomeType"`
	Question    string  `json:"question"`
	Answer      *string `json:"answer"`
	Why         string  `json:"why"`
	NudgeDays   *int    `json:"nudgeDays"`
	Update      bool    `json:"update"`
	// Ask for changes (reason revise): what the person asked.
	Instruction string   `json:"instruction"`
	Chips       []string `json:"chips"`
	// PlanID and Step ("3 of 5"): the event is about a plan (item qwFAWxZM5xkcE7PPjAzi).
	PlanID string `json:"planId"`
	Step   string `json:"step"`
	// PlanEnd: how a plan ended for reason rejected ("plan.rejected", "plan.stopped", or a gate's
	// "outcome.rejected").
	PlanEnd string `json:"planEnd"`
}

// reviseChipText is how a chip reads in the event text.
var reviseChipText = map[string]string{"shorter": "shorter", "formal": "more formal", "warmer": "warmer", "availability": "add my availability"}

var inboxTriggers = map[string]string{
	"inbox.added":      "message",
	"thread.answered":  "answered",
	"thread.woke":      "woke",
	"thread.restored":  "restored",
	"outcome.rejected": "rejected",
	"outcome.failed":   "failed",
	// Plans (item qwFAWxZM5xkcE7PPjAzi): the person rejected or stopped the plan.
	"plan.rejected": "rejected",
	"plan.stopped":  "rejected",
}

var inboxPriority = map[string]int{
	"carry_out": 0, "answered": 1, "revise": 1, "new": 2, "message": 2,
	"woke": 3, "rejected": 3, "failed": 3, "restored": 3, "resume": 3, "nudge_due": 4,
}

func or(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

// InboxText is the content of an inbox event (inboxText).
func InboxText(e InboxEventInfo) string {
	t := fmt.Sprintf(`"%s" (thread %s)`, clip(or(e.Title, "Untitled"), 200), e.ThreadID)
	var lines []string
	why := func(end string) string {
		if e.Why != "" {
			return ": " + clip(e.Why, 1000)
		}
		return end
	}
	switch e.Reason {
	case "new":
		lines = append(lines, "New in Inbox: "+t+".")
	case "message":
		lines = append(lines, "A new message on "+t+".")
	case "answered":
		lines = append(lines, "The person answered your question on "+t+".")
		if e.Question != "" {
			lines = append(lines, "Your question: "+clip(e.Question, 1500))
		}
		if e.Answer != nil {
			lines = append(lines, "Their answer: "+clip(*e.Answer, 3000))
		}
	case "woke":
		lines = append(lines, t+" woke up: its snooze is over.")
	case "rejected":
		switch {
		case e.PlanEnd == "plan.stopped":
			lines = append(lines, "The person stopped plan "+e.PlanID+" on "+t+": nothing more of it runs.")
		case e.PlanEnd == "plan.rejected":
			lines = append(lines, "The person rejected plan "+e.PlanID+" on "+t+why("."))
		case e.PlanID != "":
			lines = append(lines, fmt.Sprintf("The person said Not approved to the approval step %s (step %s of plan %s) on %s%s. The plan stopped.", or(e.OutcomeID, "?"), or(e.Step, "?"), e.PlanID, t, why("")))
		default:
			lines = append(lines, "The person turned down the proposed outcome on "+t+why("."))
		}
	case "failed":
		lines = append(lines, "Carrying out an outcome on "+t+" failed"+why(".")+" Investigate it again.")
	case "restored":
		lines = append(lines, "The person brought "+t+" back to the agents.")
	case "resume":
		lines = append(lines, t+" is still being investigated (this session is new: earlier work on it may have stopped).")
	case "nudge_due":
		days := 3
		if e.NudgeDays != nil {
			days = *e.NudgeDays
		}
		lines = append(lines, fmt.Sprintf("%s has waited on them for %d days or more.", t, days))
	case "carry_out":
		if e.PlanID != "" {
			lines = append(lines, fmt.Sprintf("Step %s of plan %s on thread %s is approved and its turn: a %s (outcome %s).", or(e.Step, "?"), e.PlanID, e.ThreadID, or(e.OutcomeType, "?"), or(e.OutcomeID, "?")))
		} else {
			lines = append(lines, fmt.Sprintf("The person approved a %s outcome (outcome %s) on thread %s.", or(e.OutcomeType, "?"), or(e.OutcomeID, "?"), e.ThreadID))
		}
	case "revise":
		var asked []string
		for _, c := range e.Chips {
			asked = append(asked, or(reviseChipText[c], c))
		}
		if e.Instruction != "" {
			asked = append(asked, `"`+clip(e.Instruction, 500)+`"`)
		}
		where := ""
		if e.PlanID != "" {
			where = fmt.Sprintf(", step %s of plan %s", or(e.Step, "?"), e.PlanID)
		}
		lines = append(lines, fmt.Sprintf("The person asked for changes to your %s proposal (outcome %s%s) on thread %s: %s.", or(e.OutcomeType, "?"), or(e.OutcomeID, "?"), where, e.ThreadID, strings.Join(asked, "; ")))
		if e.PlanID != "" {
			lines = append(lines, "Only this step changes; the rest of the plan keeps its state.")
		}
	}
	what := "investigate it (inbox_note for what you find, subject_assign if it is not filed, thread_due if a message states a deadline, inbox_ask only if you must), then propose what should come of it (outcome_propose, with your confidence and what you checked)"
	switch e.Reason {
	case "carry_out":
		what = fmt.Sprintf("carry out outcome %s exactly as approved (its fields, as the person left them), then report it with outcome_done", or(e.OutcomeID, "?"))
		if e.PlanID != "" && e.OutcomeType == "make_it_work" {
			what += " status started with result.itemId once the item is made (the plan waits until the item is Done; then report it done)"
		}
	case "rejected":
		if e.PlanID != "" {
			what = "re-plan: propose a new plan (plan_propose) or a single outcome (outcome_propose), or ask the person (inbox_ask)"
		}
	case "revise":
		what = fmt.Sprintf("revise it with outcome_propose revises=%s (same threadId and type): apply only what they asked and keep the rest; do not reject it or start a new outcome. If you cannot make the change, say why with inbox_ask on the thread", or(e.OutcomeID, "?"))
	case "nudge_due":
		what = "propose a nudge (outcome_propose, type nudge) if one makes sense, otherwise say why not with inbox_note"
	}
	if e.Update {
		lines = append(lines, fmt.Sprintf("Thread %s is already being worked on: this adds to it (thread_read shows the current state).", e.ThreadID))
	} else {
		lines = append(lines, fmt.Sprintf(`Start with thread_read (threadId %s), then %s. Nothing is sent, booked or handed over without the person's approval. Inbox work does not count toward max_items and never holds up an item.`, e.ThreadID, what))
	}
	return strings.Join(lines, "\n")
}

type feedDue struct {
	slot, reason, threadID, memberUID string
	atMs                              int64
	info                              InboxEventInfo
	outcome                           *FeedOutcome
	revise                            *FeedRevise
	state                             string
	updatedAtMs                       *int64
}

type feedFlight struct {
	at          int64
	outcome     bool
	revise      bool
	state       string
	updatedAtMs *int64
}

// InboxFeed pushes inbox events (InboxFeed in TypeScript).
type InboxFeed struct {
	src  InboxSource
	push func(Event)
	now  func() time.Time

	MaxInbox                 int
	perMinute                int
	nudgeMs, leaseMs, tickMs int64

	mu       sync.Mutex
	threads  map[string]FeedThread
	order    []string // thread ids in snapshot order
	outcomes map[string]FeedOutcome
	oorder   []string
	revising map[string]FeedRevise
	rorder   []string
	revised  map[string]int64
	plans    map[string]FeedPlan
	plansIn  bool // the first plans snapshot came
	handled  map[string]string
	seen     map[string]bool
	due      map[string]*feedDue
	nudged   map[string]int64
	carried  map[string]bool
	inflight map[string]*feedFlight
	sent     []int64
	types    map[string]*FeedEvent
	fetching map[string]bool
	wakes    map[string]string
	closed   bool
	pumping  bool

	ctx    context.Context
	cancel context.CancelFunc
	subCtx context.CancelFunc
	pushMu sync.Mutex
}

// NewInboxFeed makes a feed; Start begins it.
func NewInboxFeed(src InboxSource, push func(Event), o InboxOptions, now func() time.Time) *InboxFeed {
	if o.MaxInbox < 0 {
		o.MaxInbox = InboxMaxDefault
	}
	o.MaxInbox = min(o.MaxInbox, MaxInboxLimit)
	if o.PerMinute <= 0 {
		o.PerMinute = InboxPerMinute
	}
	if o.NudgeAfter <= 0 {
		o.NudgeAfter = InboxNudgeAfter
	}
	if o.Lease <= 0 {
		o.Lease = InboxLease
	}
	if o.Tick <= 0 {
		o.Tick = InboxTick
	}
	if now == nil {
		now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &InboxFeed{src: src, push: push, now: now, MaxInbox: o.MaxInbox, perMinute: o.PerMinute,
		nudgeMs: o.NudgeAfter.Milliseconds(), leaseMs: o.Lease.Milliseconds(), tickMs: o.Tick.Milliseconds(),
		threads: map[string]FeedThread{}, outcomes: map[string]FeedOutcome{}, revising: map[string]FeedRevise{}, revised: map[string]int64{}, plans: map[string]FeedPlan{}, handled: map[string]string{},
		seen: map[string]bool{}, due: map[string]*feedDue{}, nudged: map[string]int64{}, carried: map[string]bool{},
		inflight: map[string]*feedFlight{}, types: map[string]*FeedEvent{}, fetching: map[string]bool{},
		wakes: map[string]string{}, ctx: ctx, cancel: cancel}
}

func (f *InboxFeed) nowMs() int64 { return f.now().UnixMilli() }

// Active is how many inbox threads are in flight.
func (f *InboxFeed) Active() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.inflight)
}

// Start subscribes and starts the tick (nothing when MaxInbox is 0).
func (f *InboxFeed) Start() {
	if f.MaxInbox == 0 {
		return
	}
	f.Subscribe()
	go func() {
		t := time.NewTicker(time.Duration(f.tickMs) * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-f.ctx.Done():
				return
			case <-t.C:
				f.Evaluate()
			}
		}
	}()
}

// Subscribe starts the listeners (again): a reconnecting listener delivers every document again.
func (f *InboxFeed) Subscribe() {
	f.mu.Lock()
	if f.subCtx != nil {
		f.subCtx()
	}
	sctx, cancel := context.WithCancel(f.ctx)
	f.subCtx = cancel
	f.mu.Unlock()
	f.src.WatchPlans(sctx, f.OnPlans)
	f.src.WatchThreads(sctx, f.OnThreads)
	f.src.WatchOutcomes(sctx, f.OnOutcomes)
	f.src.WatchRevising(sctx, f.OnRevising)
}

// OnPlans takes a snapshot of the live plans.
func (f *InboxFeed) OnPlans(rows []FeedPlan) {
	f.mu.Lock()
	f.plans = map[string]FeedPlan{}
	f.plansIn = true
	for _, r := range rows {
		f.plans[r.ID] = r
	}
	f.mu.Unlock()
	f.Evaluate()
}

// atTurn says whether an approved outcome may be carried out now: a single outcome always, a
// plan step only at its plan's cursor. Call with f.mu held.
func (f *InboxFeed) atTurn(o FeedOutcome) bool {
	if o.PlanID == "" {
		return true
	}
	p, ok := f.plans[o.PlanID]
	return ok && p.turn(o.ID)
}

// Stop ends the feed.
func (f *InboxFeed) Stop() {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
	f.cancel()
}

// OnThreads takes a snapshot of the open threads.
func (f *InboxFeed) OnThreads(rows []FeedThread) {
	f.mu.Lock()
	f.threads = map[string]FeedThread{}
	f.order = f.order[:0]
	for _, r := range rows {
		f.threads[r.ID] = r
		f.order = append(f.order, r.ID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// OnOutcomes takes a snapshot of the approved outcomes.
func (f *InboxFeed) OnOutcomes(rows []FeedOutcome) {
	f.mu.Lock()
	f.outcomes = map[string]FeedOutcome{}
	f.oorder = f.oorder[:0]
	for _, r := range rows {
		f.outcomes[r.ID] = r
		f.oorder = append(f.oorder, r.ID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// OnRevising takes a snapshot of the outcomes this agent is asked to revise.
func (f *InboxFeed) OnRevising(rows []FeedRevise) {
	f.mu.Lock()
	f.revising = map[string]FeedRevise{}
	f.rorder = f.rorder[:0]
	for _, r := range rows {
		f.revising[r.ID] = r
		f.rorder = append(f.rorder, r.ID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// Evaluate works out what is due and sends what the cap and rate allow.
func (f *InboxFeed) Evaluate() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	now := f.nowMs()
	for slot, fl := range f.inflight {
		over := now-fl.at >= f.leaseMs
		if fl.revise {
			_, ok := f.revising[slot[2:]]
			over = over || !ok
		} else if fl.outcome {
			o, ok := f.outcomes[slot[2:]]
			over = over || !ok || !f.atTurn(o)
		} else {
			t, ok := f.threads[slot[2:]]
			over = over || !ok || t.State != fl.state
			if ok && fl.updatedAtMs != nil {
				over = over || t.UpdatedAtMs != *fl.updatedAtMs
			}
		}
		if over {
			delete(f.inflight, slot)
		}
	}
	var fetch []string
	var wake []string
	for _, id := range f.order {
		t := f.threads[id]
		if t.State == "investigating" {
			if e := f.investigating(t); e != "" {
				fetch = append(fetch, e)
			}
		} else {
			delete(f.due, "i:"+t.ID)
			if t.State == "waiting" {
				if w := f.waiting(t, now); w != "" {
					wake = append(wake, w)
				}
			}
		}
		if t.State != "investigating" || f.handled[t.ID] == t.LastEventID {
			f.seen[t.ID] = true
		}
	}
	for key := range f.due {
		if strings.HasPrefix(key, "i:") {
			if t, ok := f.threads[key[2:]]; !ok || t.State != "investigating" {
				delete(f.due, key)
			}
		}
	}
	for _, id := range f.oorder {
		o := f.outcomes[id]
		slot := "o:" + o.ID
		if f.carried[o.ID] || f.due[slot] != nil || !f.atTurn(o) {
			continue
		}
		oc := o
		info := InboxEventInfo{Reason: "carry_out", ThreadID: o.ThreadID, OutcomeID: o.ID, OutcomeType: o.Type}
		if o.PlanID != "" {
			info.PlanID, info.Step = o.PlanID, f.plans[o.PlanID].stepOf(o.ID)
		}
		f.due[slot] = &feedDue{slot: slot, reason: "carry_out", threadID: o.ThreadID, atMs: o.CreatedAtMs, memberUID: o.MemberUID, outcome: &oc, info: info}
	}
	for slot, d := range f.due {
		if d.outcome != nil {
			if o, ok := f.outcomes[d.outcome.ID]; !ok || !f.atTurn(o) {
				delete(f.due, slot)
			}
		}
	}
	// Ask for changes: one revise event per request (a new request after a cancel is new).
	for _, id := range f.rorder {
		rv := f.revising[id]
		slot := "r:" + rv.ID
		if v, ok := f.revised[rv.ID]; (ok && v == rv.AtMs) || f.due[slot] != nil || (rv.PlanID != "" && !f.plansIn) {
			continue
		}
		rc := rv
		info := InboxEventInfo{Reason: "revise", ThreadID: rv.ThreadID, OutcomeID: rv.ID, OutcomeType: rv.Type, Instruction: rv.Instruction, Chips: rv.Chips}
		if rv.PlanID != "" {
			info.PlanID, info.Step = rv.PlanID, f.plans[rv.PlanID].stepOf(rv.ID)
		}
		f.due[slot] = &feedDue{slot: slot, reason: "revise", threadID: rv.ThreadID, atMs: rv.AtMs, memberUID: rv.MemberUID, revise: &rc, info: info}
	}
	for slot, d := range f.due {
		if d.revise != nil {
			if cur, ok := f.revising[d.revise.ID]; !ok || cur.AtMs != d.revise.AtMs {
				delete(f.due, slot)
			}
		}
	}
	events := f.pump()
	f.mu.Unlock()
	if len(fetch) > 0 {
		// One batch, then one look: the threads of a snapshot go out in priority order.
		go f.fetch(fetch)
	}
	for _, id := range wake {
		go func(id string) {
			if err := f.src.Wake(f.ctx, id); err != nil {
				f.mu.Lock()
				delete(f.wakes, id) // tried again at the next tick
				f.mu.Unlock()
			}
		}(id)
	}
	f.send(events)
}

// investigating decides a thread in investigating; returns an event id to fetch, if any.
// Call with f.mu held.
func (f *InboxFeed) investigating(t FeedThread) string {
	if f.handled[t.ID] == t.LastEventID {
		return ""
	}
	ev, known := f.types[t.LastEventID]
	if !known {
		if f.fetching[t.LastEventID] {
			return ""
		}
		f.fetching[t.LastEventID] = true
		return t.LastEventID
	}
	f.handled[t.ID] = t.LastEventID
	reason := ""
	if ev != nil {
		reason = inboxTriggers[ev.Type]
		if reason == "message" && ev.Data["newThread"] == true {
			reason = "new"
		}
	}
	if reason == "" {
		if f.seen[t.ID] {
			return "" // a note, a filing, a title: nothing new to do
		}
		reason = "resume"
	}
	info := InboxEventInfo{Reason: reason, ThreadID: t.ID, Title: t.Title}
	var data map[string]any
	if ev != nil {
		data = ev.Data
	}
	str := func(k string) string { s, _ := data[k].(string); return s }
	switch reason {
	case "answered":
		info.Question = str("question")
		a := str("answer")
		info.Answer = &a
	case "rejected":
		info.Why = str("reason")
		if pid := str("planId"); pid != "" {
			info.PlanID, info.OutcomeID, info.PlanEnd = pid, str("outcomeId"), ev.Type
			if ev != nil {
				info.Step = ev.Step
			}
		}
	case "failed":
		info.Why = str("error")
	}
	f.due["i:"+t.ID] = &feedDue{slot: "t:" + t.ID, reason: reason, threadID: t.ID, atMs: t.LastMessageAtMs, memberUID: t.MemberUID, state: "investigating", info: info}
	return ""
}

// waiting decides a waiting thread; returns a thread id to wake, if any. Call with f.mu held.
func (f *InboxFeed) waiting(t FeedThread, now int64) string {
	if t.Waiting != nil && t.Waiting.UntilMs != nil {
		if *t.Waiting.UntilMs <= now && f.wakes[t.ID] != t.LastEventID {
			f.wakes[t.ID] = t.LastEventID
			return t.ID
		}
		return ""
	}
	if t.Waiting == nil || t.Waiting.On != "them" || now-t.UpdatedAtMs < f.nudgeMs {
		return ""
	}
	if v, ok := f.nudged[t.ID]; (ok && v == t.UpdatedAtMs) || f.due["n:"+t.ID] != nil {
		return ""
	}
	days := max(1, int(math.Round(float64(f.nudgeMs)/inboxDayMs)))
	u := t.UpdatedAtMs
	f.due["n:"+t.ID] = &feedDue{slot: "t:" + t.ID, reason: "nudge_due", threadID: t.ID, atMs: t.UpdatedAtMs, memberUID: t.MemberUID, state: "waiting", updatedAtMs: &u,
		info: InboxEventInfo{Reason: "nudge_due", ThreadID: t.ID, Title: t.Title, NudgeDays: &days}}
	return ""
}

func (f *InboxFeed) fetch(ids []string) {
	ok := false
	for _, id := range ids {
		e, err := f.src.EventOf(f.ctx, id)
		f.mu.Lock()
		delete(f.fetching, id) // on an error, tried again at the next snapshot or tick
		if err == nil {
			f.types[id] = e
			ok = true
		}
		f.mu.Unlock()
	}
	if ok {
		f.Evaluate()
	}
}

// pump picks what goes out now. Call with f.mu held; send the result after unlocking.
func (f *InboxFeed) pump() []Event {
	for key, d := range f.due {
		if strings.HasPrefix(key, "n:") {
			t, ok := f.threads[d.threadID]
			if !ok || t.State != "waiting" || t.UpdatedAtMs != *d.updatedAtMs {
				delete(f.due, key)
			}
		}
	}
	keys := make([]string, 0, len(f.due))
	for k := range f.due {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		a, b := f.due[keys[i]], f.due[keys[j]]
		if inboxPriority[a.reason] != inboxPriority[b.reason] {
			return inboxPriority[a.reason] < inboxPriority[b.reason]
		}
		if a.atMs != b.atMs {
			return a.atMs < b.atMs
		}
		return keys[i] < keys[j]
	})
	var out []Event
	for _, key := range keys {
		d := f.due[key]
		_, update := f.inflight[d.slot]
		if !update && len(f.inflight) >= f.MaxInbox {
			continue
		}
		if !f.allowed() {
			f.retryPump()
			break
		}
		delete(f.due, key)
		if d.outcome != nil {
			f.carried[d.outcome.ID] = true
		}
		if d.revise != nil {
			f.revised[d.revise.ID] = d.revise.AtMs
		}
		if d.reason == "nudge_due" {
			f.nudged[d.threadID] = *d.updatedAtMs
		}
		if !update {
			f.inflight[d.slot] = &feedFlight{at: f.nowMs(), outcome: d.outcome != nil, revise: d.revise != nil, state: d.state, updatedAtMs: d.updatedAtMs}
		}
		f.sent = append(f.sent, f.nowMs())
		meta := map[string]string{
			"kind": "inbox", "thread_id": d.threadID, "reason": d.reason, "member": d.memberUID,
			"inbox_cap": strconv.Itoa(f.MaxInbox), "inbox_active": strconv.Itoa(len(f.inflight)),
		}
		if d.outcome != nil {
			meta["outcome_id"], meta["outcome_type"] = d.outcome.ID, d.outcome.Type
		}
		if d.revise != nil {
			meta["outcome_id"], meta["outcome_type"] = d.revise.ID, d.revise.Type
		}
		if d.info.PlanID != "" && d.info.Step == "" && d.info.OutcomeID != "" {
			// The plans may arrive after the step (a fresh listener): look again when it goes out.
			d.info.Step = f.plans[d.info.PlanID].stepOf(d.info.OutcomeID)
		}
		if d.info.PlanID != "" {
			meta["plan_id"] = d.info.PlanID
			if d.info.Step != "" {
				meta["step"] = d.info.Step
			}
			if d.info.OutcomeID != "" && meta["outcome_id"] == "" {
				meta["outcome_id"] = d.info.OutcomeID
			}
		}
		info := d.info
		if update {
			meta["update"] = "true"
			info.Update = true
		}
		out = append(out, Event{Content: InboxText(info), Meta: meta})
	}
	return out
}

func (f *InboxFeed) allowed() bool {
	now := f.nowMs()
	kept := f.sent[:0]
	for _, t := range f.sent {
		if now-t < inboxRateWindowMs {
			kept = append(kept, t)
		}
	}
	f.sent = kept
	return len(f.sent) < f.perMinute
}

// retryPump looks again when the rate allows. Call with f.mu held.
func (f *InboxFeed) retryPump() {
	if f.pumping || f.closed {
		return
	}
	f.pumping = true
	first := f.nowMs()
	if len(f.sent) > 0 {
		first = f.sent[0]
	}
	wait := max(inboxMinPumpWaitMs, inboxRateWindowMs-(f.nowMs()-first))
	go func() {
		select {
		case <-f.ctx.Done():
			return
		case <-time.After(time.Duration(wait) * time.Millisecond):
		}
		f.mu.Lock()
		f.pumping = false
		f.mu.Unlock()
		f.Evaluate()
	}()
}

// send pushes in order, one at a time.
func (f *InboxFeed) send(events []Event) {
	if len(events) == 0 {
		return
	}
	f.pushMu.Lock()
	defer f.pushMu.Unlock()
	for _, e := range events {
		f.push(e)
	}
}

// ---------- the Firestore source ----------

type firestoreInbox struct{ c *Client }

// InboxSource is what the channel's inbox feed reads: this agent's open threads and the approved
// outcomes it carries out, live.
func (c *Client) InboxSource() InboxSource { return firestoreInbox{c} }

func feedMs(v any) int64 {
	if t, ok := v.(time.Time); ok {
		return t.UnixMilli()
	}
	return 0
}

func (s firestoreInbox) WatchThreads(ctx context.Context, on func([]FeedThread)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxThreads")).
		Where("fetchedBy", "==", s.c.UID).Where("state", "in", []any{"investigating", "waiting"})
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedThread, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			t := FeedThread{ID: d.Ref.ID, MemberUID: str("memberUid"), State: str("state"), Title: str("title"),
				LastEventID: str("lastEventId"), UpdatedAtMs: feedMs(m["updatedAt"]), LastMessageAtMs: feedMs(m["lastMessageAt"])}
			if w, ok := m["waiting"].(map[string]any); ok {
				on, _ := w["on"].(string)
				fw := &FeedWaiting{On: on}
				if u, ok := w["until"].(time.Time); ok {
					ms := u.UnixMilli()
					fw.UntilMs = &ms
				}
				t.Waiting = fw
			}
			rows = append(rows, t)
		}
		on(rows)
	}, nil)
}

func (s firestoreInbox) WatchOutcomes(ctx context.Context, on func([]FeedOutcome)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxOutcomes")).
		Where("executor", "==", s.c.UID).Where("state", "==", "approved")
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedOutcome, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			rows = append(rows, FeedOutcome{ID: d.Ref.ID, ThreadID: str("threadId"), MemberUID: str("memberUid"), Type: str("type"), CreatedAtMs: feedMs(m["createdAt"]), PlanID: str("planId")})
		}
		on(rows)
	}, nil)
}

func (s firestoreInbox) WatchRevising(ctx context.Context, on func([]FeedRevise)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxOutcomes")).
		Where("proposedBy", "==", s.c.UID).Where("state", "==", "revising")
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedRevise, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			r := FeedRevise{ID: d.Ref.ID, ThreadID: str("threadId"), MemberUID: str("memberUid"), Type: str("type"), AtMs: feedMs(m["updatedAt"]), PlanID: str("planId")}
			if rv, ok := m["revise"].(map[string]any); ok {
				r.Instruction, _ = rv["instruction"].(string)
				if cs, ok := rv["chips"].([]any); ok {
					for _, c := range cs {
						if s, ok := c.(string); ok {
							r.Chips = append(r.Chips, s)
						}
					}
				}
				if at := feedMs(rv["at"]); at != 0 {
					r.AtMs = at
				}
			}
			rows = append(rows, r)
		}
		on(rows)
	}, nil)
}

// WatchPlans listens to the workspace's live plans (what an agent may read of Inbox; a plan
// step's carry_out waits for its turn).
func (s firestoreInbox) WatchPlans(ctx context.Context, on func([]FeedPlan)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxPlans")).
		Where("state", "in", []any{"proposed", "active", "blocked"})
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedPlan, 0, len(docs))
		for _, d := range docs {
			rows = append(rows, feedPlanOf(d.Ref.ID, d.Data()))
		}
		on(rows)
	}, nil)
}

func feedPlanOf(id string, m map[string]any) FeedPlan {
	str := func(k string) string { v, _ := m[k].(string); return v }
	p := FeedPlan{ID: id, ThreadID: str("threadId"), State: str("state")}
	if c, ok := m["cursor"].(int64); ok {
		p.Cursor = int(c)
	}
	if steps, ok := m["steps"].([]any); ok {
		for _, e := range steps {
			if v, ok := e.(string); ok {
				p.Steps = append(p.Steps, v)
			}
		}
	}
	return p
}

func (s firestoreInbox) EventOf(ctx context.Context, eventID string) (*FeedEvent, error) {
	snap, err := s.c.DB.Doc(model.Paths.InboxEvent(s.c.WorkspaceID, eventID)).Get(ctx)
	if err != nil {
		if snap != nil && !snap.Exists() {
			return nil, nil
		}
		return nil, err
	}
	m := snap.Data()
	typ, _ := m["type"].(string)
	data, _ := m["data"].(map[string]any)
	e := &FeedEvent{Type: typ, Data: data}
	pid, _ := data["planId"].(string)
	oid, _ := data["outcomeId"].(string)
	if pid != "" && oid != "" {
		if ps, err := s.c.DB.Doc(model.Paths.InboxPlan(s.c.WorkspaceID, pid)).Get(ctx); err == nil {
			e.Step = feedPlanOf(pid, ps.Data()).stepOf(oid)
		}
	}
	return e, nil
}

func (s firestoreInbox) Wake(ctx context.Context, threadID string) error {
	_, err := s.c.ThreadWake(ctx, threadID)
	return err
}
