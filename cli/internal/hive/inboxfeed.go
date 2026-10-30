package hive

// Inbox events of a channel session (item 4PEHrOW5IfXBQWgOK9wo, part 2), ported from the former
// TypeScript inboxfeed.ts. See docs/INBOX.md ("Channel events") for who gets what, the dedupe and
// the flow control.

import (
	"context"
	"errors"
	"fmt"
	"github.com/wisely-solutions/hivenod/cli/internal/actions"
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
	InboxMaxDefault = 3
	InboxPerMinute  = 10
	InboxNudgeAfter = 3 * 24 * time.Hour
	InboxLease      = 30 * time.Minute
	InboxTick       = 60 * time.Second
	// InboxSummarizeAfter: a thread changed this long ago without a newer summary gets
	// reason summarize (SUMMARIZE_AFTER_MS, item OE8FmrTaIxFVGcaeGG3N).
	InboxSummarizeAfter = 3 * time.Minute
	MaxInboxLimit       = 10
	inboxRateWindowMs   = 60_000
	inboxDayMs          = 86_400_000
	inboxMinPumpWaitMs  = 50
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
	// AskAtMs: Hivenod's (or the person's Ping again) status request on it (item KZ6O9); 0: none.
	AskAtMs int64
}

// FeedRunning is a running plan step this agent carries out: a Build it step waiting for its
// item, or a long step (Build, Release: slice 6b) being worked on.
type FeedRunning struct {
	ID, ThreadID, MemberUID, Type, PlanID string
	// ItemID and ProjectID: the item it made (ProjectID "" when the link does not say).
	ItemID, ProjectID string
	// Long (slice 6b): a long step; BeatAtMs is its last heartbeat (progress, or the start).
	Long     bool
	BeatAtMs int64
	// AskAtMs: a status request on the running step (item KZ6O9); 0: none.
	AskAtMs int64
}

// FeedPlan is a live plan (proposed, active or blocked): its steps and whose turn it is.
type FeedPlan struct {
	ID, ThreadID, State string
	Steps               []string
	Cursor              int
	// SentBack (slice 6): how many send backs so far, the step the last one went to, and why.
	SentBack               int
	SentBackTo, SentBackOf string
}

// round is the plan's send-back count: a step carried out before a send back is carried out
// again after it (the feed remembers carry_outs per step and round).
func (f *InboxFeed) round(o FeedOutcome) string {
	if o.PlanID == "" {
		return o.ID
	}
	return o.ID + "#" + strconv.Itoa(f.plans[o.PlanID].SentBack)
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

// FeedRecheck is a thread of this agent's whose person asked for a re-check (recheck pending,
// item bmNoIvvqKCdAorLSShE9).
type FeedRecheck struct {
	ThreadID, MemberUID, Title string
	// AtMs is when they asked: a new request (after an answer) is a new event.
	AtMs int64
}

// FeedInstruct is a thread of this agent's whose person asked it something (instruct pending,
// item w6O2KOw4ys70TQv9I1xD).
type FeedInstruct struct {
	ThreadID, MemberUID, Title string
	// ID is the instruction's id; Text or Chip is what they asked.
	ID, Text, Chip string
	AtMs           int64
}

// FeedSummary is an open thread of this agent's with its last change and its summary's time
// (SummaryAtMs 0: no summary yet), item OE8FmrTaIxFVGcaeGG3N.
type FeedSummary struct {
	ThreadID, MemberUID, Title string
	UpdatedAtMs, SummaryAtMs   int64
}

// stale says whether the thread changed after its summary (or has none).
func (s FeedSummary) stale() bool { return s.SummaryAtMs == 0 || s.SummaryAtMs < s.UpdatedAtMs }

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
	WatchRechecks(ctx context.Context, on func([]FeedRecheck))
	WatchInstructs(ctx context.Context, on func([]FeedInstruct))
	WatchSummaries(ctx context.Context, on func([]FeedSummary))
	WatchPlans(ctx context.Context, on func([]FeedPlan))
	WatchRunning(ctx context.Context, on func([]FeedRunning))
	// ItemState is an item's status ("done", "stopped" for stopped or archived, …); gone: deleted.
	ItemState(ctx context.Context, projectID, itemID string) (status string, gone bool, err error)
	EventOf(ctx context.Context, eventID string) (*FeedEvent, error)
	Wake(ctx context.Context, threadID string) error
	// Heartbeat stamps a running long step this session holds (step_progress, its last line).
	Heartbeat(ctx context.Context, outcomeID string) error
}

// InboxOptions configure the feed (zero values: the defaults; MaxInbox -1 is "unset").
type InboxOptions struct {
	MaxInbox int // 0 is off
	// MaxSteps (slice 6b): long steps this session runs at once (--max-items); 0 means 1.
	MaxSteps   int
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
	// ItemID: the Build it step's item (reasons item_done and item_stopped).
	ItemID string `json:"itemId"`
	// PlanEnd: how a plan ended for reason rejected ("plan.rejected", "plan.stopped", or a gate's
	// "outcome.rejected").
	PlanEnd string `json:"planEnd"`
	// InstructionID: the person's request (reason instruct; its text is Instruction, a chip Chips[0]).
	InstructionID string `json:"instructionId"`
	// SentBack (reason carry_out, slice 6): the plan was sent back to this step; Why says why.
	SentBack bool `json:"sentBack"`
	// Long (reason carry_out, slice 6b): a long step; Resume: it was running before this session.
	Long   bool `json:"long"`
	Resume bool `json:"resume"`
}

// instructChipText is INSTRUCT_CHIP_TEXT: what a chip asks.
var instructChipText = map[string]string{
	"prepare_meeting": "Prepare me for the meeting on this thread: who, what it is about, what to bring or decide.",
	"recheck":         "Check this thread again.",
	"follow_up":       "They have not answered: propose a follow-up (a nudge) if one makes sense.",
	"summarize":       "Summarize this thread: where it stands, what was agreed, what is open.",
	"draft_reply":     "Draft a reply to their last message.",
}

// reviseChipText is how a chip reads in the event text.
var reviseChipText = map[string]string{"shorter": "shorter", "formal": "more formal", "warmer": "warmer", "availability": "add my availability"}

var inboxTriggers = map[string]string{
	"inbox.added": "message",
	// New thread (slice 6): the person wrote to this agent from Hivenod.
	"thread.created":   "new",
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
	"carry_out": 0, "item_done": 0, "item_stopped": 1, "answered": 1, "revise": 1, "recheck": 1, "instruct": 1, "new": 2, "message": 2,
	"woke": 3, "rejected": 3, "failed": 3, "restored": 3, "resume": 3, "nudge_due": 4, "summarize": 5,
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
		if e.Resume {
			lines = append(lines, fmt.Sprintf("Step %s of plan %s on thread %s, a %s (outcome %s), was running before this session: it is yours to finish.", or(e.Step, "?"), or(e.PlanID, "?"), e.ThreadID, or(e.OutcomeType, "?"), or(e.OutcomeID, "?")))
		} else if e.PlanID != "" {
			lines = append(lines, fmt.Sprintf("Step %s of plan %s on thread %s is approved and its turn: a %s (outcome %s).", or(e.Step, "?"), e.PlanID, e.ThreadID, or(e.OutcomeType, "?"), or(e.OutcomeID, "?")))
			if e.SentBack {
				lines = append(lines, "The plan was sent back to this step: "+clip(or(e.Why, "no reason given"), 1000)+". Do it again with that change; the steps after it run again in order.")
			}
		} else {
			lines = append(lines, fmt.Sprintf("The person approved a %s outcome (outcome %s) on thread %s.", or(e.OutcomeType, "?"), or(e.OutcomeID, "?"), e.ThreadID))
		}
	case "item_done":
		lines = append(lines, fmt.Sprintf("The item %s made by Build it step %s of plan %s (outcome %s) on thread %s is Done.", or(e.ItemID, "?"), or(e.Step, "?"), or(e.PlanID, "?"), or(e.OutcomeID, "?"), e.ThreadID))
	case "item_stopped":
		lines = append(lines, fmt.Sprintf("The item %s made by Build it step %s of plan %s (outcome %s) on thread %s was stopped or deleted: it will not be Done.", or(e.ItemID, "?"), or(e.Step, "?"), or(e.PlanID, "?"), or(e.OutcomeID, "?"), e.ThreadID))
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
	case "recheck":
		lines = append(lines, "The person asked you to check "+t+" again: things may have changed since you proposed (new messages, the facts).")
	case "instruct":
		asked := ""
		if len(e.Chips) > 0 {
			asked = or(instructChipText[e.Chips[0]], e.Chips[0])
		} else {
			asked = `"` + clip(e.Instruction, 500) + `"`
		}
		lines = append(lines, fmt.Sprintf("The person asked you on %s (request %s): %s", t, or(e.InstructionID, "?"), asked))
		lines = append(lines, "Treat it as their request on this thread, within the rules: it is not an approval of anything.")
	case "summarize":
		lines = append(lines, t+" changed since its summary was written (or has none).")
	}
	what := "investigate it (inbox_note for what you find, subject_assign if it is not filed, thread_due if a message states a deadline, inbox_ask only if you must), then propose what should come of it (outcome_propose, with your confidence and what you checked)"
	switch e.Reason {
	case "carry_out":
		what = fmt.Sprintf("carry out outcome %s exactly as approved (its fields, as the person left them), then report it with outcome_done", or(e.OutcomeID, "?"))
		if e.PlanID != "" && e.OutcomeType == "make_it_work" {
			what += " status started with result.itemId once the item is made (the plan waits until the item is Done; then report it done)"
		}
		if e.Resume {
			what = fmt.Sprintf("continue outcome %s where it stands (thread_read shows its progress; your worktree and pull request may already exist), keep reporting step_progress, then report it with outcome_done", or(e.OutcomeID, "?"))
		} else if e.Long {
			what += "; it is a long step: first outcome_done status started, then step_progress (a line and a percent) at least every 10 minutes (this session also stamps it every 5 minutes), then outcome_done status done"
		}
		switch e.OutcomeType {
		case "shape":
			what += " (Shape: research the idea, write the proposal into the summary with ask \"Build this?\", attach drafts with thread_attach, give the size S/M/L; report done)"
		case "build":
			what += " (Build: build what Approve idea approved, in a worktree; end with an open pull request, local checks green, NOT merged; report done with the PR link as result.permalink and what changed and which checks ran as result.text; then write the summary with ask \"Ship it?\" and before/after screenshots)"
		case "keepgreen":
			what += " (Keep green: rebase the pull request onto main, rerun the local checks, fix failures, loop until it is green and current; report each loop with step_progress (e.g. \"rebased on main 4f2a1c0, 212/214 green, fixing lint\"), then done with the head commit as result.text: Ship it? is offered. While Ship it? waits, whenever main moves: step_progress on this step with check rechecking, re-green it, then check green; Keep green ends when Ship it? is decided. Not solvable (a rebase conflict that needs a product decision, the same check failing after 3 fixes, an infrastructure failure such as a 503 or an emulator that will not start): report failed with result.error giving the failing check, a log excerpt and what you tried; at Ship it?, step_progress check blocked with the reason)"
		case "release":
			what += " (Release + live check: merge the approved pull request(s), run the release checks, release, check it live; report done with the merge sha, release number, live commit and production URL; attach screenshots with thread_attach. A bug: plan_send_back to Build with the reason)"
		}
	case "item_done":
		what = fmt.Sprintf("report the step done: outcome_done %s status done with result.itemId %s; the plan then moves to its next step", or(e.OutcomeID, "?"), or(e.ItemID, "?"))
	case "item_stopped":
		what = fmt.Sprintf("report the step failed: outcome_done %s status failed with result.error saying the item was stopped; the person then retries, skips or stops the plan", or(e.OutcomeID, "?"))
	case "rejected":
		if e.PlanID != "" {
			what = "re-plan: propose a new plan (plan_propose) or a single outcome (outcome_propose), or ask the person (inbox_ask)"
		}
	case "revise":
		what = fmt.Sprintf("revise it with outcome_propose revises=%s (same threadId and type): apply only what they asked and keep the rest; do not reject it or start a new outcome. If you cannot make the change, say why with inbox_ask on the thread", or(e.OutcomeID, "?"))
	case "recheck":
		what = "re-read the messages (new ones especially) and the context; for each open proposal and each step of a live plan that has not run, keep it or write its next version with outcome_propose revises=<outcomeId> (only what changed), or ask with inbox_ask; then answer with thread_recheck_done (result still_good, revised or asked, with a one-line note)"
	case "instruct":
		what = fmt.Sprintf("do what they asked: investigate (inbox_note), then answer with thread_answer_instruction instructionId=%s: kind note (your answer in the note), ask (after inbox_ask), outcome (after outcome_propose, refId its outcomeId) or plan (after plan_propose, refId its planId)", or(e.InstructionID, "?"))
	case "summarize":
		what = "re-read the thread and write its summary (thread_summary, baseVersion the summary version thread_read shows). Change nothing else"
	case "nudge_due":
		what = "propose a nudge (outcome_propose, type nudge) if one makes sense, otherwise say why not with inbox_note"
	}
	if e.Update {
		lines = append(lines, fmt.Sprintf("Thread %s is already being worked on: this adds to it (thread_read shows the current state).", e.ThreadID))
	} else if e.Long {
		lines = append(lines, fmt.Sprintf(`Start with thread_read (threadId %s), then %s. Nothing is sent or handed over without the person's approval. A long step counts toward max_items until it is done.`, e.ThreadID, what))
	} else {
		lines = append(lines, fmt.Sprintf(`Start with thread_read (threadId %s), then %s. Nothing is sent or handed over without the person's approval. Inbox work does not count toward max_items and never holds up an item.`, e.ThreadID, what))
	}
	return strings.Join(lines, "\n")
}

type feedDue struct {
	slot, reason, threadID, memberUID string
	atMs                              int64
	info                              InboxEventInfo
	outcome                           *FeedOutcome
	revise                            *FeedRevise
	recheck                           *FeedRecheck
	instruct                          *FeedInstruct
	summary                           *FeedSummary
	build                             *FeedRunning
	long                              *FeedRunning
	state                             string
	updatedAtMs                       *int64
}

type feedFlight struct {
	at          int64
	outcome     bool
	revise      bool
	recheck     bool
	instruct    bool
	summary     bool
	threadID    string
	build       bool
	state       string
	updatedAtMs *int64
}

// InboxFeed pushes inbox events (InboxFeed in TypeScript).
type InboxFeed struct {
	src  InboxSource
	push func(Event)
	now  func() time.Time

	MaxInbox                 int
	maxSteps                 int
	perMinute                int
	nudgeMs, leaseMs, tickMs int64

	mu          sync.Mutex
	threads     map[string]FeedThread
	order       []string // thread ids in snapshot order
	outcomes    map[string]FeedOutcome
	oorder      []string
	revising    map[string]FeedRevise
	rorder      []string
	revised     map[string]int64
	rechecks    map[string]FeedRecheck
	korder      []string
	recheckd    map[string]int64 // thread id -> the request (AtMs) sent
	instructs   map[string]FeedInstruct
	iorder      []string
	instructd   map[string]string // thread id -> the instruction id sent
	summaries   map[string]FeedSummary
	sumorder    []string
	summarized  map[string]int64 // thread id -> the updatedAt a summarize was sent for
	summarizeMs int64
	plans       map[string]FeedPlan
	running     map[string]FeedRunning
	norder      []string
	// Long steps (slice 6b): the ones this session was handed (carry_out or resume), and the
	// heartbeats under way.
	mine    map[string]bool
	beating map[string]bool
	// handed: long carry_outs sent and not seen running yet (outcome id -> when).
	handed   map[string]int64
	items    map[string]string // outcome id -> its item's state ("done", "stopped", "gone", …)
	checked  map[string]int64  // outcome id -> when its item was last looked at
	checking map[string]bool
	built    map[string]string // outcome id -> the item reason sent
	plansIn  bool              // the first plans snapshot came
	handled  map[string]string
	seen     map[string]bool
	due      map[string]*feedDue
	nudged   map[string]int64
	carried  map[string]bool
	// asked: the newest status request seen per outcome (item KZ6O9).
	asked    map[string]int64
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
	if o.MaxSteps <= 0 {
		o.MaxSteps = 1
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &InboxFeed{src: src, push: push, now: now, MaxInbox: o.MaxInbox, maxSteps: o.MaxSteps, mine: map[string]bool{}, beating: map[string]bool{}, handed: map[string]int64{}, perMinute: o.PerMinute,
		nudgeMs: o.NudgeAfter.Milliseconds(), leaseMs: o.Lease.Milliseconds(), tickMs: o.Tick.Milliseconds(),
		threads: map[string]FeedThread{}, outcomes: map[string]FeedOutcome{}, revising: map[string]FeedRevise{}, revised: map[string]int64{}, rechecks: map[string]FeedRecheck{}, recheckd: map[string]int64{}, instructs: map[string]FeedInstruct{}, instructd: map[string]string{}, summaries: map[string]FeedSummary{}, summarized: map[string]int64{}, summarizeMs: InboxSummarizeAfter.Milliseconds(), plans: map[string]FeedPlan{}, running: map[string]FeedRunning{}, items: map[string]string{}, checked: map[string]int64{}, checking: map[string]bool{}, built: map[string]string{}, handled: map[string]string{},
		seen: map[string]bool{}, due: map[string]*feedDue{}, nudged: map[string]int64{}, carried: map[string]bool{}, asked: map[string]int64{},
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
	f.src.WatchRechecks(sctx, f.OnRechecks)
	f.src.WatchInstructs(sctx, f.OnInstructs)
	f.src.WatchSummaries(sctx, f.OnSummaries)
	f.src.WatchRunning(sctx, f.OnRunning)
}

// OnRunning takes a snapshot of this agent's running Build it steps.
func (f *InboxFeed) OnRunning(rows []FeedRunning) {
	f.mu.Lock()
	f.running = map[string]FeedRunning{}
	f.norder = f.norder[:0]
	var events []Event
	for _, r := range rows {
		f.running[r.ID] = r
		f.norder = append(f.norder, r.ID)
		if r.Long && f.newAsk(r.ID, r.AskAtMs) && f.mine[r.ID] {
			events = append(events, f.stepStatus(r.ID, r.ThreadID, r.Type, r.PlanID, true))
		}
	}
	f.mu.Unlock()
	f.send(events)
	f.Evaluate()
}

// checkItems looks at the items of running Build it steps, then evaluates again.
func (f *InboxFeed) checkItems(rows []FeedRunning) {
	ok := false
	for _, r := range rows {
		status, gone, err := f.src.ItemState(f.ctx, r.ProjectID, r.ItemID)
		f.mu.Lock()
		delete(f.checking, r.ID)
		if err == nil {
			if gone {
				status = "gone"
			}
			f.items[r.ID] = status
			ok = true
		}
		f.mu.Unlock()
	}
	if ok {
		f.Evaluate()
	}
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
	var events []Event
	for _, r := range rows {
		f.outcomes[r.ID] = r
		f.oorder = append(f.oorder, r.ID)
		// A status request on a step this session already got the carry_out for (item KZ6O9).
		if f.newAsk(r.ID, r.AskAtMs) && f.carried[f.round(r)] {
			events = append(events, f.stepStatus(r.ID, r.ThreadID, r.Type, r.PlanID, false))
		}
	}
	f.mu.Unlock()
	f.send(events)
	f.Evaluate()
}

// newAsk records a status request on an outcome; true when it is newer than the last one seen
// (the first sight of an outcome only records it). Call with f.mu held.
func (f *InboxFeed) newAsk(id string, askMs int64) bool {
	prev, seen := f.asked[id]
	if askMs > prev {
		f.asked[id] = askMs
	} else if !seen {
		f.asked[id] = prev
	}
	return seen && askMs > prev
}

// stepStatus is the status event of a step in this agent's hands (item KZ6O9). Call with f.mu held.
func (f *InboxFeed) stepStatus(id, threadID, typ, planID string, long bool) Event {
	step := ""
	if planID != "" {
		step = fmt.Sprintf("step %s of plan %s, ", or(f.plans[planID].stepOf(id), "?"), planID)
	}
	how := `if it waits on something, say what with inbox_note; if it is done, report it with outcome_done`
	if long {
		how = `say where it stands with step_progress (a line and a percent); when it is done, report it with outcome_done`
	}
	return Event{
		Content: fmt.Sprintf(`Hivenod asks for a status on %sa %s (outcome %s) on thread %s: nothing was heard from you on it for a while. Carry on with it: %s.`, step, or(typ, "?"), id, threadID, how),
		Meta:    map[string]string{"kind": "inbox", "reason": "status", "thread_id": threadID, "outcome_id": id, "outcome_type": typ},
	}
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

// OnRechecks takes a snapshot of this agent's threads with a pending re-check request.
func (f *InboxFeed) OnRechecks(rows []FeedRecheck) {
	f.mu.Lock()
	f.rechecks = map[string]FeedRecheck{}
	f.korder = f.korder[:0]
	for _, r := range rows {
		f.rechecks[r.ThreadID] = r
		f.korder = append(f.korder, r.ThreadID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// OnInstructs takes a snapshot of this agent's threads with a pending request of the person's.
func (f *InboxFeed) OnInstructs(rows []FeedInstruct) {
	f.mu.Lock()
	f.instructs = map[string]FeedInstruct{}
	f.iorder = f.iorder[:0]
	for _, r := range rows {
		f.instructs[r.ThreadID] = r
		f.iorder = append(f.iorder, r.ThreadID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// OnSummaries takes a snapshot of this agent's open threads with their summaries' times.
func (f *InboxFeed) OnSummaries(rows []FeedSummary) {
	f.mu.Lock()
	f.summaries = map[string]FeedSummary{}
	f.sumorder = f.sumorder[:0]
	for _, r := range rows {
		f.summaries[r.ThreadID] = r
		f.sumorder = append(f.sumorder, r.ThreadID)
	}
	f.mu.Unlock()
	f.Evaluate()
}

// busyThread says whether something about thread id is in flight or due (other than its
// summarize). Call with f.mu held.
func (f *InboxFeed) busyThread(id string) bool {
	for _, fl := range f.inflight {
		if fl.threadID == id && !fl.summary {
			return true
		}
	}
	for key, d := range f.due {
		if d.threadID == id && !strings.HasPrefix(key, "s:") {
			return true
		}
	}
	return false
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
		} else if fl.recheck {
			_, ok := f.rechecks[slot[2:]]
			over = over || !ok
		} else if fl.instruct {
			_, ok := f.instructs[slot[2:]]
			over = over || !ok
		} else if fl.summary {
			s, ok := f.summaries[slot[2:]]
			over = over || !ok || !s.stale() || s.UpdatedAtMs != *fl.updatedAtMs
		} else if fl.build {
			_, ok := f.running[slot[2:]]
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
		if f.carried[f.round(o)] || f.due[slot] != nil || !f.atTurn(o) {
			continue
		}
		long := isLong(o.Type)
		// Long steps count toward max items (slice 6b): one more only while a slot is free.
		if long && f.longBusy(o.ID) >= f.maxSteps {
			continue
		}
		oc := o
		info := InboxEventInfo{Reason: "carry_out", ThreadID: o.ThreadID, OutcomeID: o.ID, OutcomeType: o.Type, Long: long}
		if o.PlanID != "" {
			p := f.plans[o.PlanID]
			info.PlanID, info.Step = o.PlanID, p.stepOf(o.ID)
			if p.SentBack > 0 && p.SentBackTo == o.ID {
				info.SentBack, info.Why = true, p.SentBackOf
			}
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
	// Re-check (item bmNoIvvqKCdAorLSShE9): one recheck event per request.
	for _, id := range f.korder {
		rk := f.rechecks[id]
		slot := "k:" + rk.ThreadID
		if v, ok := f.recheckd[rk.ThreadID]; (ok && v == rk.AtMs) || f.due[slot] != nil {
			continue
		}
		rc := rk
		f.due[slot] = &feedDue{slot: slot, reason: "recheck", threadID: rk.ThreadID, atMs: rk.AtMs, memberUID: rk.MemberUID, recheck: &rc,
			info: InboxEventInfo{Reason: "recheck", ThreadID: rk.ThreadID, Title: rk.Title}}
	}
	for slot, d := range f.due {
		if d.recheck != nil {
			if cur, ok := f.rechecks[d.recheck.ThreadID]; !ok || cur.AtMs != d.recheck.AtMs {
				delete(f.due, slot)
			}
		}
	}
	// Ask the agent (item w6O2KOw4ys70TQv9I1xD): one instruct event per request.
	for _, id := range f.iorder {
		in := f.instructs[id]
		slot := "q:" + in.ThreadID
		if v, ok := f.instructd[in.ThreadID]; (ok && v == in.ID) || f.due[slot] != nil {
			continue
		}
		rc := in
		info := InboxEventInfo{Reason: "instruct", ThreadID: in.ThreadID, Title: in.Title, InstructionID: in.ID, Instruction: in.Text}
		if in.Chip != "" {
			info.Chips = []string{in.Chip}
		}
		f.due[slot] = &feedDue{slot: slot, reason: "instruct", threadID: in.ThreadID, atMs: in.AtMs, memberUID: in.MemberUID, instruct: &rc, info: info}
	}
	for slot, d := range f.due {
		if d.instruct != nil {
			if cur, ok := f.instructs[d.instruct.ThreadID]; !ok || cur.ID != d.instruct.ID {
				delete(f.due, slot)
			}
		}
	}
	// Summaries (item OE8FmrTaIxFVGcaeGG3N): a thread that changed 3 minutes ago or more with no
	// newer summary, nothing else of it in flight or due; once per change, at the lowest priority.
	for _, id := range f.sumorder {
		sm := f.summaries[id]
		slot := "s:" + id
		if !sm.stale() || now-sm.UpdatedAtMs < f.summarizeMs || f.due[slot] != nil || f.busyThread(id) {
			continue
		}
		if v, ok := f.summarized[id]; ok && v == sm.UpdatedAtMs {
			continue
		}
		sc := sm
		u := sm.UpdatedAtMs
		f.due[slot] = &feedDue{slot: slot, reason: "summarize", threadID: id, atMs: sm.UpdatedAtMs, memberUID: sm.MemberUID, summary: &sc, updatedAtMs: &u,
			info: InboxEventInfo{Reason: "summarize", ThreadID: id, Title: sm.Title}}
	}
	for slot, d := range f.due {
		if d.summary != nil {
			if cur, ok := f.summaries[d.threadID]; !ok || !cur.stale() || cur.UpdatedAtMs != d.summary.UpdatedAtMs || f.busyThread(d.threadID) {
				delete(f.due, slot)
			}
		}
	}
	// Build it (item qwFAWxZM5xkcE7PPjAzi): a running step's item reaching Done (or stopped).
	var look, beat []FeedRunning
	for _, id := range f.norder {
		r := f.running[id]
		if r.Long {
			// A long step running before this session (slice 6b): resume it, once.
			if slot := "l:" + r.ID; !f.mine[r.ID] && f.due[slot] == nil {
				rc := r
				info := InboxEventInfo{Reason: "carry_out", ThreadID: r.ThreadID, OutcomeID: r.ID, OutcomeType: r.Type, PlanID: r.PlanID, Long: true, Resume: true}
				f.due[slot] = &feedDue{slot: slot, reason: "carry_out", threadID: r.ThreadID, atMs: now, memberUID: r.MemberUID, long: &rc, info: info}
			}
			// The heartbeat of a step this session holds.
			if f.mine[r.ID] && !f.beating[r.ID] && now-r.BeatAtMs >= StepHeartbeatMs {
				f.beating[r.ID] = true
				beat = append(beat, r)
			}
			continue
		}
		slot := "b:" + r.ID
		reason := ""
		switch f.items[r.ID] {
		case "done":
			reason = "item_done"
		case "stopped", "gone":
			reason = "item_stopped"
		}
		if reason == "" {
			if !f.checking[r.ID] && now-f.checked[r.ID] >= f.tickMs {
				f.checking[r.ID], f.checked[r.ID] = true, now
				look = append(look, r)
			}
			continue
		}
		if f.built[r.ID] == reason || f.due[slot] != nil {
			continue
		}
		rc := r
		info := InboxEventInfo{Reason: reason, ThreadID: r.ThreadID, OutcomeID: r.ID, OutcomeType: r.Type, PlanID: r.PlanID, ItemID: r.ItemID}
		f.due[slot] = &feedDue{slot: slot, reason: reason, threadID: r.ThreadID, atMs: now, memberUID: r.MemberUID, build: &rc, info: info}
	}
	for slot, d := range f.due {
		if d.build != nil || d.long != nil {
			id := ""
			if d.build != nil {
				id = d.build.ID
			} else {
				id = d.long.ID
			}
			if _, ok := f.running[id]; !ok {
				delete(f.due, slot)
			}
		}
	}
	for id := range f.items {
		if _, ok := f.running[id]; !ok {
			delete(f.items, id)
			delete(f.checked, id)
		}
	}
	events := f.pump()
	f.mu.Unlock()
	if len(look) > 0 {
		go f.checkItems(look)
	}
	for _, r := range beat {
		go func(id string) {
			_ = f.src.Heartbeat(f.ctx, id) // tried again at a later tick when it fails
			f.mu.Lock()
			delete(f.beating, id)
			f.mu.Unlock()
		}(r.ID)
	}
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
		// Long steps (slice 6b) count toward max items, not toward the inbox cap.
		long := d.long != nil || (d.outcome != nil && isLong(d.outcome.Type))
		if !long && !update && len(f.inflight) >= f.MaxInbox {
			continue
		}
		if !f.allowed() {
			f.retryPump()
			break
		}
		delete(f.due, key)
		if d.outcome != nil {
			f.carried[f.round(*d.outcome)] = true
		}
		if long {
			f.mine[d.info.OutcomeID] = true
			if d.outcome != nil {
				f.handed[d.outcome.ID] = f.nowMs()
			}
		}
		if d.revise != nil {
			f.revised[d.revise.ID] = d.revise.AtMs
		}
		if d.recheck != nil {
			f.recheckd[d.recheck.ThreadID] = d.recheck.AtMs
		}
		if d.instruct != nil {
			f.instructd[d.instruct.ThreadID] = d.instruct.ID
		}
		if d.summary != nil {
			f.summarized[d.threadID] = d.summary.UpdatedAtMs
		}
		if d.build != nil {
			f.built[d.build.ID] = d.reason
		}
		if d.reason == "nudge_due" {
			f.nudged[d.threadID] = *d.updatedAtMs
		}
		if !update && !long {
			f.inflight[d.slot] = &feedFlight{at: f.nowMs(), outcome: d.outcome != nil, revise: d.revise != nil, recheck: d.recheck != nil, instruct: d.instruct != nil, summary: d.summary != nil, threadID: d.threadID, build: d.build != nil, state: d.state, updatedAtMs: d.updatedAtMs}
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
		if d.build != nil {
			meta["outcome_id"], meta["outcome_type"], meta["item_id"] = d.build.ID, d.build.Type, d.build.ItemID
		}
		if d.long != nil {
			meta["outcome_id"], meta["outcome_type"], meta["why"] = d.long.ID, d.long.Type, "resume"
		}
		if long {
			meta["long"] = "true"
		}
		if d.instruct != nil {
			meta["instruction_id"] = d.instruct.ID
		}
		if d.info.PlanID != "" && d.info.Step == "" && d.info.OutcomeID != "" {
			// The plans may arrive after the step (a fresh listener): look again when it goes out.
			d.info.Step = f.plans[d.info.PlanID].stepOf(d.info.OutcomeID)
		}
		if d.info.SentBack {
			meta["why"] = "sent_back"
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
			o := FeedOutcome{ID: d.Ref.ID, ThreadID: str("threadId"), MemberUID: str("memberUid"), Type: str("type"), CreatedAtMs: feedMs(m["createdAt"]), PlanID: str("planId")}
			if sa, ok := m["statusAsk"].(map[string]any); ok {
				o.AskAtMs = feedMs(sa["at"])
			}
			rows = append(rows, o)
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

// WatchRechecks listens to this agent's threads whose person asked for a re-check.
func (s firestoreInbox) WatchRechecks(ctx context.Context, on func([]FeedRecheck)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxThreads")).
		Where("fetchedBy", "==", s.c.UID).Where("recheck.state", "==", "pending")
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedRecheck, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			r := FeedRecheck{ThreadID: d.Ref.ID, MemberUID: str("memberUid"), Title: str("title"), AtMs: feedMs(m["updatedAt"])}
			if rk, ok := m["recheck"].(map[string]any); ok {
				if at := feedMs(rk["requestedAt"]); at != 0 {
					r.AtMs = at
				}
			}
			rows = append(rows, r)
		}
		on(rows)
	}, nil)
}

// WatchInstructs listens to this agent's threads whose person asked it something.
func (s firestoreInbox) WatchInstructs(ctx context.Context, on func([]FeedInstruct)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxThreads")).
		Where("fetchedBy", "==", s.c.UID).Where("instruct.state", "==", "pending")
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedInstruct, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(m map[string]any, k string) string { v, _ := m[k].(string); return v }
			r := FeedInstruct{ThreadID: d.Ref.ID, MemberUID: str(m, "memberUid"), Title: str(m, "title"), AtMs: feedMs(m["updatedAt"])}
			if in, ok := m["instruct"].(map[string]any); ok {
				r.ID = str(in, "id")
				if at := feedMs(in["at"]); at != 0 {
					r.AtMs = at
				}
			}
			if all, ok := m["instructions"].(map[string]any); ok {
				if one, ok := all[r.ID].(map[string]any); ok {
					r.Text, r.Chip = str(one, "text"), str(one, "chip")
					// Answered already (the latest state not yet caught up): nothing to send.
					if str(one, "state") != "pending" {
						continue
					}
				}
			}
			if r.ID == "" {
				continue
			}
			rows = append(rows, r)
		}
		on(rows)
	}, nil)
}

// WatchSummaries listens to this agent's open threads (their last change and their summary's
// time), for reason summarize.
func (s firestoreInbox) WatchSummaries(ctx context.Context, on func([]FeedSummary)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxThreads")).
		Where("fetchedBy", "==", s.c.UID).Where("state", "in", []any{"investigating", "needsYou", "yourCall", "waiting"})
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedSummary, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			r := FeedSummary{ThreadID: d.Ref.ID, MemberUID: str("memberUid"), Title: str("title"), UpdatedAtMs: feedMs(m["updatedAt"])}
			if sm, ok := m["summary"].(map[string]any); ok {
				r.SummaryAtMs = feedMs(sm["at"])
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

// WatchRunning listens to this agent's running plan steps (Build it, waiting for its item).
// Heartbeat stamps a running long step this session holds (slice 6b).
func (s firestoreInbox) Heartbeat(ctx context.Context, outcomeID string) error {
	return s.c.StepHeartbeat(ctx, outcomeID)
}

func (s firestoreInbox) WatchRunning(ctx context.Context, on func([]FeedRunning)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "inboxOutcomes")).
		Where("executor", "==", s.c.UID).Where("state", "==", "running")
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedRunning, 0, len(docs))
		for _, d := range docs {
			m := d.Data()
			str := func(k string) string { v, _ := m[k].(string); return v }
			r := FeedRunning{ID: d.Ref.ID, ThreadID: str("threadId"), MemberUID: str("memberUid"), Type: str("type"), PlanID: str("planId")}
			if sa, ok := m["statusAsk"].(map[string]any); ok {
				r.AskAtMs = feedMs(sa["at"])
			}
			if res, ok := m["result"].(map[string]any); ok {
				r.ItemID, _ = res["itemId"].(string)
				if link, ok := res["permalink"].(string); ok {
					if pid, iid := ItemLinkParts(link); iid == r.ItemID {
						r.ProjectID = pid
					}
				}
			}
			if isLong(r.Type) {
				r.Long, r.BeatAtMs = true, feedMs(m["updatedAt"])
				if pr, ok := m["progress"].(map[string]any); ok {
					r.BeatAtMs = max(r.BeatAtMs, feedMs(pr["at"]))
				}
				rows = append(rows, r)
			} else if r.ItemID != "" {
				rows = append(rows, r)
			}
		}
		on(rows)
	}, nil)
}

// ItemState reads a Build it item: its status ("stopped" when archived), or gone when deleted.
func (s firestoreInbox) ItemState(ctx context.Context, projectID, itemID string) (string, bool, error) {
	if projectID == "" {
		l, err := s.c.load(ctx, itemID, "")
		if err != nil {
			var he *Error
			if errors.As(err, &he) {
				return "", true, nil
			}
			return "", false, err
		}
		projectID = l.ProjectID
	}
	snap, err := s.c.DB.Doc(model.Paths.Item(s.c.WorkspaceID, projectID, itemID)).Get(ctx)
	if err != nil {
		if NotFound(err) {
			return "", true, nil
		}
		return "", false, err
	}
	if !snap.Exists() {
		return "", true, nil
	}
	m := snap.Data()
	if m["archivedAt"] != nil {
		return "stopped", false, nil
	}
	st, _ := m["status"].(string)
	return st, false, nil
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
	if sb, ok := m["sentBack"].(map[string]any); ok {
		if n, ok := sb["n"].(int64); ok {
			p.SentBack = int(n)
		}
		p.SentBackTo, _ = sb["to"].(string)
		p.SentBackOf, _ = sb["reason"].(string)
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

// StepHeartbeatMs is how often this session stamps a running long step it holds (slice 6b).
const StepHeartbeatMs = int64(5 * 60_000)

// longStartGraceMs: a long step handed over and gone from the approved outcomes still counts
// this long, until the running listener shows it.
const longStartGraceMs = int64(10_000)

func isLong(typeID string) bool {
	t := actions.OutcomeTypeOf(typeID)
	return t != nil && t.Long
}

// longBusy counts the long steps this agent runs (running, or handed over and not yet started)
// plus the long carry_outs due, the step `except` aside (the one being decided). Call with f.mu
// held.
func (f *InboxFeed) longBusy(except string) int {
	n := 0
	for _, r := range f.running {
		if r.Long {
			n++
		}
	}
	// Handed over and not seen running yet: still approved at its turn, or just started (the
	// two listeners may tell it in either order; a short grace covers the gap).
	now := f.nowMs()
	for id, at := range f.handed {
		if id == except {
			continue
		}
		if r, ok := f.running[id]; ok && r.Long {
			delete(f.handed, id)
			continue
		}
		if o, ok := f.outcomes[id]; (ok && f.atTurn(o)) || now-at < longStartGraceMs {
			n++
		} else {
			delete(f.handed, id)
		}
	}
	for _, d := range f.due {
		if d.outcome != nil && isLong(d.outcome.Type) {
			n++
		}
	}
	return n
}
