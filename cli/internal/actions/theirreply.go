package actions

// Their reply: stepAsk, stepSent and finishOutcome's evidence of
// packages/shared/src/theirreply.ts and inbox.ts. A plan step that waits on one person outside
// Hivenod: the agent drafts each message for the person's approval, sends it, and reports it done
// only with their reply (a message from them newer than the last send) as evidence.

import (
	"slices"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// TheirReply is THEIR_REPLY, the outcome type.
const TheirReply = "their_reply"

// ExtState is a Their reply step's state (model.InboxExt).
type ExtState = model.InboxExt

// ExtAskKinds is EXT_ASK_KINDS.
var ExtAskKinds = []string{"ask", "follow_up", "nudge"}

const (
	extMaxText  = 20000
	extMaxQuote = 1000
)

func extAskState(e *ExtState) string {
	if e == nil || e.Ask == nil {
		return ""
	}
	return e.Ask.State
}

func timeOrNil(t *time.Time) any {
	if t == nil {
		return nil
	}
	return *t
}

func extAskDoc(a *model.InboxExtAsk, state string, at any) map[string]any {
	if at == nil {
		at = timeOrNil(a.At)
	}
	return map[string]any{"n": a.N, "kind": a.Kind, "text": a.Text, "state": state, "by": a.By, "at": at}
}

func extReplyDoc(r *model.InboxExtReply) any {
	if r == nil {
		return nil
	}
	return map[string]any{"messageDocId": r.MessageDocID, "quote": r.Quote}
}

// extTurn: a Their reply step at its turn in a live plan.
func extTurn(o OutcomeState, oid string, pl *PlanInput) (PlanInput, error) {
	if err := need(o.Type == TheirReply, "This is for a Their reply step only."); err != nil {
		return PlanInput{}, err
	}
	p, err := planFor(pl, o, oid)
	if err != nil {
		return PlanInput{}, err
	}
	live := p.Plan.State == "proposed" || p.Plan.State == "active"
	if err := need(live && p.Plan.Cursor < len(p.Plan.Steps) && p.Plan.Steps[p.Plan.Cursor] == oid, "Not its turn: this step is not the one the plan runs now."); err != nil {
		return PlanInput{}, err
	}
	return p, nil
}

func extWrites(ctx Ctx, oid string, o OutcomeState, th ThreadState, outcome, thread, data map[string]any) plan.Plan {
	data["outcomeId"] = oid
	return InboxPlan(ctx, "step.external", o.MemberUID, sp(o.ThreadID), th.SubjectID, data, func(eventID string) []plan.Op {
		return []plan.Op{
			upd(model.Paths.InboxOutcome(ctx.WorkspaceID, oid), outcome, eventID),
			upd(model.Paths.InboxThread(ctx.WorkspaceID, o.ThreadID), thread, eventID),
		}
	}, "")
}

// ExtReplyIn is the reply a follow-up answers, and that message as read.
type ExtReplyIn struct {
	MessageDocID string `json:"messageDocId"`
	Quote        string `json:"quote"`
}

// ExtMessage is a message as an action needs it (its thread, direction and arrival).
type ExtMessage struct {
	ThreadID    string `json:"threadId"`
	Direction   string `json:"direction"`
	CreatedAtMs int64  `json:"createdAtMs"`
}

// StepAskInput is stepAsk's input.
type StepAskInput struct {
	OutcomeID    string       `json:"outcomeId"`
	Outcome      OutcomeState `json:"outcome"`
	Thread       ThreadState  `json:"thread"`
	Plan         *PlanInput   `json:"plan"`
	Kind         string       `json:"kind"`
	Text         string       `json:"text"`
	Reply        *ExtReplyIn  `json:"reply"`
	ReplyMessage *ExtMessage  `json:"replyMessage"`
}

// StepAskResult is stepAsk's result: the plan and the message's number.
type StepAskResult struct {
	plan.Plan
	N int `json:"n"`
}

// StepAsk is stepAsk: the executing agent drafts the next message to them for the person's
// approval; the step runs and the thread is the person's call.
func StepAsk(ctx Ctx, in StepAskInput) (StepAskResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return StepAskResult{}, err
	}
	o := in.Outcome
	if err := need(o.Executor != nil && *o.Executor == ctx.Actor.ID, "Only the agent that carries this step out drafts its messages."); err != nil {
		return StepAskResult{}, err
	}
	pl, err := extTurn(o, in.OutcomeID, in.Plan)
	if err != nil {
		return StepAskResult{}, err
	}
	msg := "This step is " + o.State + "."
	if o.State == "proposed" || o.State == "revising" {
		msg = "Not approved: the step runs only once the person approved the plan."
	}
	if err := need(o.State == "approved" || o.State == "running", msg); err != nil {
		return StepAskResult{}, err
	}
	ext := ExtState{}
	if o.Ext != nil {
		ext = *o.Ext
	}
	if err := need(extAskState(&ext) != "approved", "The approved message is not sent yet: send it, then step_sent."); err != nil {
		return StepAskResult{}, err
	}
	if err := need(slices.Contains(ExtAskKinds, in.Kind), "The kind is ask, follow_up or nudge."); err != nil {
		return StepAskResult{}, err
	}
	if err := need(ext.Sent > 0 || in.Kind == "ask", "Nothing was sent yet: the first message is the ask."); err != nil {
		return StepAskResult{}, err
	}
	text := jsTrim(in.Text)
	if err := need(text != "", "Write the message (text)."); err != nil {
		return StepAskResult{}, err
	}
	if err := need(jsLen(text) <= extMaxText, "The message is at most 20000 characters."); err != nil {
		return StepAskResult{}, err
	}
	reply := extReplyDoc(ext.Reply)
	if in.Reply != nil {
		quote := spaces.ReplaceAllString(jsTrim(in.Reply.Quote), " ")
		if err := need(quote != "" && jsLen(quote) <= extMaxQuote, "The quote is 1 to 1000 characters."); err != nil {
			return StepAskResult{}, err
		}
		m := in.ReplyMessage
		if err := need(m != nil && m.ThreadID == o.ThreadID && m.Direction == "in", "The reply is a message from them on this thread (its messageId as thread_read shows it)."); err != nil {
			return StepAskResult{}, err
		}
		reply = map[string]any{"messageDocId": in.Reply.MessageDocID, "quote": quote}
	}
	n := 1
	if ext.Ask != nil {
		n = ext.Ask.N + 1
	}
	ask := map[string]any{"n": n, "kind": in.Kind, "text": text, "state": "proposed", "by": ctx.Actor.ID, "at": ServerTime()}
	p := extWrites(ctx, in.OutcomeID, o, in.Thread,
		map[string]any{"state": "running", "ext": map[string]any{"ask": ask, "outAt": timeOrNil(ext.OutAt), "sent": ext.Sent, "reply": reply}},
		map[string]any{"state": "yourCall", "waiting": nil},
		map[string]any{"planId": pl.PlanID, "op": "ask", "n": n, "kind": in.Kind})
	return StepAskResult{Plan: p, N: n}, nil
}

// StepSentInput is stepSent's input.
type StepSentInput struct {
	OutcomeID string       `json:"outcomeId"`
	Outcome   OutcomeState `json:"outcome"`
	Thread    ThreadState  `json:"thread"`
	Plan      *PlanInput   `json:"plan"`
}

// StepSent is stepSent: the agent sent the approved message; the step waits on them.
func StepSent(ctx Ctx, in StepSentInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	o := in.Outcome
	if err := need(o.Executor != nil && *o.Executor == ctx.Actor.ID, "Only the agent that carries this step out reports it."); err != nil {
		return plan.Plan{}, err
	}
	pl, err := extTurn(o, in.OutcomeID, in.Plan)
	if err != nil {
		return plan.Plan{}, err
	}
	st := extAskState(o.Ext)
	msg := "No approved message waits to be sent."
	if st == "proposed" {
		msg = "Not approved: nothing is sent before the person approves it."
	}
	if err := need(o.State == "running" && st == "approved", msg); err != nil {
		return plan.Plan{}, err
	}
	e := o.Ext
	ext := map[string]any{"ask": extAskDoc(e.Ask, "sent", nil), "outAt": ServerTime(), "sent": e.Sent + 1, "reply": extReplyDoc(e.Reply)}
	return extWrites(ctx, in.OutcomeID, o, in.Thread,
		map[string]any{"ext": ext},
		map[string]any{"state": "waiting", "waiting": map[string]any{"on": "them", "until": nil}},
		map[string]any{"planId": pl.PlanID, "op": "sent", "n": e.Ask.N}), nil
}

// FinishEvidence is finishOutcome's evidence for a Their reply step.
type FinishEvidence struct {
	MessageDocID string  `json:"messageDocId"`
	Quote        string  `json:"quote"`
	Confidence   *string `json:"confidence"`
}

type theirEvidence struct {
	messageDocID, quote string
	confidence          *string
}

// theirReplyEvidence is theirReplyEvidence: a Their reply step is done only with their message,
// on this thread, that came in after the last send. nil for other types and statuses.
func theirReplyEvidence(o OutcomeState, in FinishInput) (*theirEvidence, error) {
	if o.Type != TheirReply {
		return nil, nil
	}
	if err := need(in.Status != "started", "A Their reply step starts with step_ask, not status started."); err != nil {
		return nil, err
	}
	if in.Status != "done" {
		return nil, nil
	}
	e := in.Evidence
	if err := need(e != nil && e.MessageDocID != "", "Give the evidence: the messageId of their reply (as thread_read shows it) and a quote."); err != nil {
		return nil, err
	}
	quote := spaces.ReplaceAllString(jsTrim(e.Quote), " ")
	if err := need(quote != "" && jsLen(quote) <= extMaxQuote, "The quote is 1 to 1000 characters."); err != nil {
		return nil, err
	}
	if err := need(e.Confidence == nil || slices.Contains([]string{"high", "medium", "low"}, *e.Confidence), "The confidence is high, medium or low."); err != nil {
		return nil, err
	}
	if err := need(extAskState(o.Ext) == "sent" && o.Ext.OutAt != nil, "Nothing was sent to them yet: draft the ask with step_ask first."); err != nil {
		return nil, err
	}
	m := in.EvidenceMessage
	if err := need(m != nil && m.ThreadID == o.ThreadID && m.Direction == "in" && m.CreatedAtMs > o.Ext.OutAt.UnixMilli(), "The evidence is a message from them on this thread that came in after your last message."); err != nil {
		return nil, err
	}
	return &theirEvidence{e.MessageDocID, quote, e.Confidence}, nil
}
