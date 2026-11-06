package actions

// May act on my word (packages/shared/src/decideword.ts): the thread's home agent records the
// member's decision at a plan's person step, or closes the thread, on his quoted words, while he
// trusts it. The writes are the member's own decisions (approveOutcome, rejectOutcome, rejectPlan,
// sendBackPlan, closeThread), with the agent as the actor; the event names on whose word
// (onBehalfOf, memberName, via "terminal", words). firestore.rules (inboxOnWord, inboxDecider)
// enforces it.

import (
	"math"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// StepDecisions are the decisions step_decide takes.
var StepDecisions = []string{"approve", "accept", "reject", "changes", "close"}

// OnWordMaxWords is ON_WORD_LIMITS.words.
const OnWordMaxWords = 500

// DecideOnWordInput is decideOnWord's input.
type DecideOnWordInput struct {
	Decision   string      `json:"decision"`
	Words      string      `json:"words"`
	ThreadID   string      `json:"threadId"`
	Thread     ThreadState `json:"thread"`
	MemberName string      `json:"memberName"`
	OutcomeID  *string     `json:"outcomeId"`
	Plan       *PlanInput  `json:"plan"`
	ToStep     *int        `json:"toStep"`
}

// CleanWords is cleanWords: the trimmed words, 1-500 characters.
func CleanWords(words string) (string, error) {
	w := jsTrim(words)
	if w == "" {
		return "", fail("Quote the person’s words (words): what they typed in this session.")
	}
	if jsLen(w) > OnWordMaxWords {
		return "", fail("The words are at most 500 characters.")
	}
	return w, nil
}

type onWordFacts struct{ member, name, words string }

// DecideOnWord is decideOnWord (step_decide).
func DecideOnWord(ctx Ctx, in DecideOnWordInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return plan.Plan{}, fail("Only the thread’s home agent decides on the person’s word.")
	}
	words, err := CleanWords(in.Words)
	if err != nil {
		return plan.Plan{}, err
	}
	w := onWordFacts{member: t.MemberUID, name: jsSlice(jsTrim(in.MemberName), 200), words: words}
	if in.Decision == "close" {
		if t.State == "done" || t.State == "ignored" {
			return plan.Plan{}, fail("This thread is closed already.")
		}
		data := map[string]any{"from": t.State}
		return onWordPlan(ctx, "thread.closed", t, sp(in.ThreadID), data, w, func(eventID string) []plan.Op {
			return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "done", "waiting": nil}, eventID)}
		})
	}
	pl := in.Plan
	oid := ""
	if in.OutcomeID != nil {
		oid = *in.OutcomeID
	}
	var o OutcomeState
	ok := false
	if pl != nil {
		o, ok = pl.Outcomes[oid]
	}
	if pl == nil || !ok || !contains(pl.Plan.Steps, oid) {
		return plan.Plan{}, fail("Name a person step of the thread’s plan (outcomeId).")
	}
	if pl.Plan.ThreadID != in.ThreadID {
		return plan.Plan{}, fail("That plan is on another thread.")
	}
	if in.Decision == "reject" && pl.Plan.State == "proposed" {
		return rejectPlanOnWord(ctx, *pl, t, w)
	}
	if OutcomeKind(o.Type) != "human" {
		return plan.Plan{}, fail("Only a person step (Approve idea, Ship it?, Accept on live, …) is decided on the person’s word.")
	}
	switch in.Decision {
	case "approve", "accept":
		return approveGateOnWord(ctx, *pl, oid, o, t, w)
	case "reject":
		return rejectGateOnWord(ctx, *pl, oid, o, t, w)
	case "changes":
		if pl.Plan.Steps[pl.Plan.Cursor] != oid {
			return plan.Plan{}, fail("Not its turn yet: the person decides this step once the steps before it are done.")
		}
		r, err := sendBackPlan(ctx, SendBackPlanInput{PlanInput: *pl, Thread: t, Reason: words, ToStep: in.ToStep}, &w)
		return r.Plan, err
	}
	return plan.Plan{}, fail("decision is approve, accept, reject, changes or close.")
}

// onWordPlan is InboxPlan for a decision on the member's word.
func onWordPlan(ctx Ctx, typ string, t ThreadState, threadID *string, data map[string]any, w onWordFacts, build func(string) []plan.Op) (plan.Plan, error) {
	data["onBehalfOf"] = w.member
	data["memberName"] = w.name
	data["words"] = w.words
	data["via"] = "terminal"
	return InboxPlan(ctx, typ, t.MemberUID, threadID, t.SubjectID, data, build, ""), nil
}

// StepLabelOf is stepLabelOf: an approval's own words, else the type's label.
func StepLabelOf(o *OutcomeState) any {
	if o == nil {
		return nil
	}
	what := ""
	if o.Type == "approval" {
		if s, ok := o.Fields["what"].(string); ok {
			what = jsTrim(s)
		}
	}
	if what == "" {
		if t := OutcomeTypeOf(o.Type); t != nil && t.Label != "" {
			what = t.Label
		} else {
			what = o.Type
		}
	}
	return jsSlice(what, 80)
}

// decisionFacts is decisionFacts for a plan decision: on a step the wait runs from when the
// cursor reached it (cursorAt, older plans createdAt); on the whole plan (o nil, label given)
// from the plan's creation.
func decisionFacts(ctx Ctx, t ThreadState, p PlanState, o *OutcomeState, label any) map[string]any {
	from := p.CreatedAt
	if o != nil && p.CursorAt != nil {
		from = p.CursorAt
	}
	var waited any
	if from != nil {
		waited = int64(math.Max(0, jsRound(float64(ctx.now().UnixMilli()-from.UnixMilli()))))
	}
	var rec, sv any
	if t.Summary != nil {
		rec = strOrNil(t.Summary.RecAction)
		sv = t.Summary.Version
	}
	if o != nil {
		label = StepLabelOf(o)
	}
	return map[string]any{"stepLabel": label, "templateId": strOrNil(p.TemplateID), "waitedMs": waited, "recommended": rec, "summaryVersion": sv}
}

func livePlanErr(p PlanState) error {
	if p.State == "proposed" || p.State == "active" || p.State == "blocked" {
		return nil
	}
	if p.State == "done" {
		return fail("This plan is done.")
	}
	return fail("This plan is stopped.")
}

// gateChecks are approveOutcome's and rejectOutcome's checks of a gate at its turn.
func gateChecks(pl PlanInput, oid string, o OutcomeState, t ThreadState) (PlanInput, error) {
	if o.MemberUID != t.MemberUID {
		return PlanInput{}, fail("Only the person this is for can do this.")
	}
	p, err := planFor(&pl, o, oid)
	if err != nil {
		return PlanInput{}, err
	}
	if err := livePlanErr(p.Plan); err != nil {
		return PlanInput{}, err
	}
	return p, nil
}

func notItsTurn(pl PlanInput, oid string) error {
	if pl.Plan.Steps[pl.Plan.Cursor] != oid {
		return fail("Not its turn yet: you decide this approval once the steps before it are done.")
	}
	return nil
}

// approveGateOnWord is approveOutcome on a gate at its turn (as proposed, unedited).
func approveGateOnWord(ctx Ctx, pl PlanInput, oid string, o OutcomeState, t ThreadState, w onWordFacts) (plan.Plan, error) {
	if o.MemberUID != t.MemberUID {
		return plan.Plan{}, fail("Only the person this is for can do this.")
	}
	if o.State != "proposed" && o.State != "revising" {
		return plan.Plan{}, fail("Only a proposed outcome can be approved.")
	}
	if ot := OutcomeTypeOf(o.Type); ot != nil && ot.Retired {
		return plan.Plan{}, fail(RetiredMessage(o.Type))
	}
	p, err := gateChecks(pl, oid, o, t)
	if err != nil {
		return plan.Plan{}, err
	}
	if err := notItsTurn(p, oid); err != nil {
		return plan.Plan{}, err
	}
	var version any
	if n := len(o.Versions); n > 0 {
		version = int64(n)
	}
	data := map[string]any{"outcomeId": oid, "type": o.Type, "edited": false, "planId": p.PlanID}
	if version != nil {
		data["version"] = version
	}
	for k, v := range decisionFacts(ctx, t, p.Plan, &o, nil) {
		data[k] = v
	}
	next := advance(p, oid, "done", true)
	var werr error
	pln, _ := onWordPlan(ctx, "outcome.approved", t, sp(o.ThreadID), data, w, func(eventID string) []plan.Op {
		dec := map[string]any{"byUid": ctx.Actor.ID, "at": ServerTime(), "edited": false, "reason": nil}
		if version != nil {
			dec["version"] = version
		}
		od := map[string]any{"state": "done", "fields": o.Fields, "decision": dec}
		if o.State == "revising" {
			od["revise"] = nil
		}
		ops := []plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, oid), od, eventID)}
		pw, err := planWrites(ctx, p, next, "", eventID)
		werr = err
		return append(ops, pw...)
	})
	return pln, werr
}

// rejectGateOnWord is rejectOutcome on a gate at its turn: the plan stops.
func rejectGateOnWord(ctx Ctx, pl PlanInput, oid string, o OutcomeState, t ThreadState, w onWordFacts) (plan.Plan, error) {
	if o.MemberUID != t.MemberUID {
		return plan.Plan{}, fail("Only the person this is for can do this.")
	}
	if o.State != "proposed" {
		return plan.Plan{}, fail("Only a proposed outcome can be rejected.")
	}
	p, err := gateChecks(pl, oid, o, t)
	if err != nil {
		return plan.Plan{}, err
	}
	if err := notItsTurn(p, oid); err != nil {
		return plan.Plan{}, err
	}
	next := advance(p, oid, "rejected", false)
	data := map[string]any{"outcomeId": oid, "type": o.Type, "reason": w.words, "planId": p.PlanID}
	for k, v := range decisionFacts(ctx, t, p.Plan, &o, nil) {
		data[k] = v
	}
	var werr error
	pln, _ := onWordPlan(ctx, "outcome.rejected", t, sp(o.ThreadID), data, w, func(eventID string) []plan.Op {
		ops := []plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, oid), map[string]any{
			"state":    "rejected",
			"decision": map[string]any{"byUid": ctx.Actor.ID, "at": ServerTime(), "edited": false, "reason": w.words},
		}, eventID)}
		pw, err := planWrites(ctx, p, next, "stopped", eventID)
		werr = err
		return append(ops, pw...)
	})
	return pln, werr
}

// rejectPlanOnWord is rejectPlan: every step not started is rejected, the plan stops.
func rejectPlanOnWord(ctx Ctx, pl PlanInput, t ThreadState, w onWordFacts) (plan.Plan, error) {
	if pl.Plan.MemberUID != t.MemberUID {
		return plan.Plan{}, fail("Only the person this is for can do this.")
	}
	if err := livePlanErr(pl.Plan); err != nil {
		return plan.Plan{}, err
	}
	started := false
	if c := pl.at(pl.Plan.Cursor); c != nil {
		started = c.State == "approved" || c.State == "running" || c.State == "failed"
	}
	ids := []string{}
	next := PlanInput{PlanID: pl.PlanID, Plan: pl.Plan, Outcomes: map[string]OutcomeState{}}
	for k, v := range pl.Outcomes {
		next.Outcomes[k] = v
	}
	next.Plan.Steps = append([]string{}, pl.Plan.Steps...)
	for i, id := range pl.Plan.Steps {
		x, ok := pl.Outcomes[id]
		if !ok || (i == pl.Plan.Cursor && started) {
			continue
		}
		if x.State == "proposed" || x.State == "revising" || x.State == "approved" {
			ids = append(ids, id)
			x.State = "rejected"
			next.Outcomes[id] = x
		}
	}
	if next.Plan.Cursor >= len(next.Plan.Steps) {
		next.Plan.State = "done"
	}
	data := map[string]any{"planId": pl.PlanID, "rejected": ids, "reason": w.words}
	for k, v := range decisionFacts(ctx, t, pl.Plan, nil, "Approve plan") {
		data[k] = v
	}
	var werr error
	pln, _ := onWordPlan(ctx, "plan.rejected", t, sp(pl.Plan.ThreadID), data, w, func(eventID string) []plan.Op {
		var ops []plan.Op
		for _, id := range ids {
			d := map[string]any{"state": "rejected", "decision": map[string]any{"byUid": ctx.Actor.ID, "at": ServerTime(), "edited": false, "reason": w.words}}
			if pl.Outcomes[id].State == "revising" {
				d["revise"] = nil
			}
			ops = append(ops, upd(model.Paths.InboxOutcome(ctx.WorkspaceID, id), d, eventID))
		}
		pw, err := planWrites(ctx, pl, next, "stopped", eventID)
		werr = err
		return append(ops, pw...)
	})
	return pln, werr
}
