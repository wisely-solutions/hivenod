package actions

// Inbox plans (item qwFAWxZM5xkcE7PPjAzi): the agent side of packages/shared/src/plans.ts and
// the plan parts of inbox.ts. An agent proposes an ordered list of steps (each an inboxOutcomes
// doc with planId) in one batch; the steps run strictly in order. The member's plan actions
// (approve, reject, edit, retry, skip, stop) are web-only and stay in TypeScript.

import (
	"strconv"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Plan limits (PLAN_LIMITS).
const (
	PlanMaxSteps = 8
	PlanMaxNote  = 2000
)

// PlanState is what an action needs of a plan (PlanOf).
type PlanState struct {
	MemberUID string   `json:"memberUid"`
	ThreadID  string   `json:"threadId"`
	Steps     []string `json:"steps"`
	Cursor    int      `json:"cursor"`
	State     string   `json:"state"`
	// Development plans (slice 6): the gates' send-back targets and the last send back.
	SendBackTo map[string]string `json:"sendBackTo,omitempty"`
	SentBack   *struct {
		N int `json:"n"`
	} `json:"sentBack,omitempty"`
}

// PlanInput is a plan with its steps' outcomes (by id), as the plan actions take it.
type PlanInput struct {
	PlanID   string                  `json:"planId"`
	Plan     PlanState               `json:"plan"`
	Outcomes map[string]OutcomeState `json:"outcomes"`
}

// PlanStateFrom is the action state of a stored plan.
func PlanStateFrom(p model.InboxPlan) PlanState {
	steps := p.Steps
	if steps == nil {
		steps = []string{}
	}
	ps := PlanState{MemberUID: p.MemberUID, ThreadID: p.ThreadID, Steps: steps, Cursor: p.Cursor, State: p.State, SendBackTo: p.SendBackTo}
	if p.SentBack != nil {
		ps.SentBack = &struct {
			N int `json:"n"`
		}{p.SentBack.N}
	}
	return ps
}

// OutcomeKind is outcomeKind: "human" for a person-approval gate, else "agent".
func OutcomeKind(typeID string) string {
	if t := OutcomeTypeOf(typeID); t != nil && t.Kind == "human" {
		return "human"
	}
	return "agent"
}

func (pl PlanInput) at(i int) *OutcomeState {
	if i < 0 || i >= len(pl.Plan.Steps) {
		return nil
	}
	if o, ok := pl.Outcomes[pl.Plan.Steps[i]]; ok {
		return &o
	}
	return nil
}

// PlanThreadState is planThreadState: the thread's {state, waiting} for a plan, set in every
// batch that changes the plan.
func PlanThreadState(p PlanState, outcomes map[string]OutcomeState) (map[string]any, error) {
	yourCall := map[string]any{"state": "yourCall", "waiting": nil}
	if p.State == "stopped" {
		return map[string]any{"state": "investigating", "waiting": nil}, nil
	}
	// Blocked (a failed step, or the third send back): the person decides.
	if p.State == "blocked" {
		return yourCall, nil
	}
	pl := PlanInput{Plan: p, Outcomes: outcomes}
	before := func(end int) (map[string]any, error) {
		for i := min(end, len(p.Steps)) - 1; i >= 0; i-- {
			o := pl.at(i)
			if o != nil && o.State == "done" {
				if t := OutcomeTypeOf(o.Type); t != nil && t.Executor == "agent" {
					return ThreadAfter(o.Type, o.Fields)
				}
			}
		}
		return nil, nil
	}
	if p.Cursor >= len(p.Steps) {
		after, err := before(len(p.Steps))
		if after == nil && err == nil {
			after = map[string]any{"state": "done", "waiting": nil}
		}
		return after, err
	}
	o := pl.at(p.Cursor)
	if o == nil {
		return yourCall, nil
	}
	if o.State == "running" {
		// Their reply (theirreply.go): a draft to approve, a message to send, or their answer.
		on := "item"
		if o.Type == TheirReply {
			switch extAskState(o.Ext) {
			case "proposed":
				return yourCall, nil
			case "approved":
				return map[string]any{"state": "waiting", "waiting": map[string]any{"on": "agent", "until": nil}}, nil
			}
			on = "them"
		}
		return map[string]any{"state": "waiting", "waiting": map[string]any{"on": on, "until": nil}}, nil
	}
	if o.State != "approved" || OutcomeKind(o.Type) == "human" {
		return yourCall, nil
	}
	if t := OutcomeTypeOf(o.Type); t != nil && t.Executor == "none" && t.After.WaitingOn == "date" {
		return ThreadAfter(o.Type, o.Fields)
	}
	// Approved, its turn, not started yet: the agent picks it up. Your call only while an agent
	// step still waits for approval ahead (Approve plan).
	for _, id := range p.Steps {
		if s, ok := outcomes[id]; ok && s.State == "proposed" && OutcomeKind(s.Type) == "agent" {
			return yourCall, nil
		}
	}
	return map[string]any{"state": "waiting", "waiting": map[string]any{"on": "agent", "until": nil}}, nil
}

// PlanStepView is one step as planView shows it.
type PlanStepView struct {
	Number    int     `json:"number"`
	OutcomeID string  `json:"outcomeId"`
	Type      *string `json:"type"`
	Kind      string  `json:"kind"`
	Label     string  `json:"label"`
	UI        string  `json:"ui"`
	AtCursor  bool    `json:"atCursor"`
}

// PlanViewOf is what planView gives (the parts an agent reads).
type PlanViewOf struct {
	State    string         `json:"state"`
	Cursor   int            `json:"cursor"`
	Total    int            `json:"total"`
	Through  int            `json:"through"`
	Progress string         `json:"progress"`
	Steps    []PlanStepView `json:"steps"`
}

func stepUI(o *OutcomeState, atCursor bool, planState string) string {
	if o == nil {
		return "proposed"
	}
	if planState == "stopped" && o.State != "done" && o.State != "failed" {
		return "stopped"
	}
	switch o.State {
	case "done":
		return "done"
	case "failed":
		return "blocked"
	case "rejected":
		if planState == "stopped" {
			return "stopped"
		}
		return "skipped"
	case "running", "revising":
		// Their reply: a drafted message waits for the person's approval.
		if o.State == "running" && extAskState(o.Ext) == "proposed" {
			return "waitingForYou"
		}
		return o.State
	case "approved":
		if atCursor && planState == "blocked" {
			return "blocked"
		}
		if atCursor {
			return "running"
		}
		return "approved"
	}
	if atCursor {
		return "waitingForYou"
	}
	return "proposed"
}

// PlanView is planView: what each step shows, and the plan's progress.
func PlanView(p PlanState, outcomes map[string]OutcomeState) PlanViewOf {
	live := p.State != "stopped" && p.State != "done"
	pl := PlanInput{Plan: p, Outcomes: outcomes}
	v := PlanViewOf{State: p.State, Cursor: p.Cursor, Total: len(p.Steps), Steps: []PlanStepView{}}
	var current *PlanStepView
	for i, oid := range p.Steps {
		o := pl.at(i)
		s := PlanStepView{Number: i + 1, OutcomeID: oid, Kind: "agent", Label: "…", AtCursor: live && i == p.Cursor}
		if o != nil {
			s.Type, s.Kind, s.Label = sp(o.Type), OutcomeKind(o.Type), o.Type
			if t := OutcomeTypeOf(o.Type); t != nil {
				s.Label = t.Label
			}
		}
		s.UI = stepUI(o, s.AtCursor, p.State)
		if s.UI == "done" || s.UI == "skipped" {
			v.Through++
		}
		v.Steps = append(v.Steps, s)
	}
	for i := range v.Steps {
		if v.Steps[i].AtCursor {
			current = &v.Steps[i]
		}
	}
	switch {
	case p.State == "stopped":
		v.Progress = "Stopped"
	case current != nil:
		v.Progress = "Step " + strconv.Itoa(current.Number) + " of " + strconv.Itoa(v.Total)
	default:
		v.Progress = "Done"
	}
	return v
}

// planFor is planFor: the plan of a plan step, checked against the step.
func planFor(pl *PlanInput, o OutcomeState, oid string) (PlanInput, error) {
	if pl == nil {
		return PlanInput{}, fail("This outcome is a step of a plan: give its plan.")
	}
	if o.PlanID == nil || pl.PlanID != *o.PlanID {
		have := ""
		if o.PlanID != nil {
			have = *o.PlanID
		}
		return PlanInput{}, fail("Outcome " + oid + " is a step of plan " + have + ", not " + pl.PlanID + ".")
	}
	if pl.Plan.ThreadID != o.ThreadID || !contains(pl.Plan.Steps, oid) {
		return PlanInput{}, fail("Outcome " + oid + " is not a step of plan " + pl.PlanID + ".")
	}
	return *pl, nil
}

func contains(list []string, s string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}

// advance is advance: step oid takes state; through moves the cursor on.
func advance(pl PlanInput, oid, state string, through bool) PlanInput {
	next := PlanInput{PlanID: pl.PlanID, Plan: pl.Plan, Outcomes: map[string]OutcomeState{}}
	for k, v := range pl.Outcomes {
		next.Outcomes[k] = v
	}
	o := next.Outcomes[oid]
	o.State = state
	next.Outcomes[oid] = o
	next.Plan.Steps = append([]string{}, pl.Plan.Steps...)
	if through {
		next.Plan.Cursor = pl.Plan.Cursor + 1
	}
	switch {
	case next.Plan.Cursor >= len(next.Plan.Steps):
		next.Plan.State = "done"
	case next.Plan.Cursor != pl.Plan.Cursor && pl.Plan.State == "proposed":
		next.Plan.State = "active"
	}
	return next
}

// planWrites is planWrites: the plan (when it changed) and the thread's state.
func planWrites(ctx Ctx, pl, next PlanInput, forceState, eventID string) ([]plan.Op, error) {
	p := next.Plan
	if forceState != "" {
		p.State = forceState
	}
	d := map[string]any{}
	if p.Cursor != pl.Plan.Cursor {
		d["cursor"] = p.Cursor
		d["cursorAt"] = ServerTime()
	}
	if p.State != pl.Plan.State {
		d["state"] = p.State
	}
	if strings.Join(p.Steps, "\x00") != strings.Join(pl.Plan.Steps, "\x00") {
		d["steps"] = p.Steps
	}
	th, err := PlanThreadState(p, next.Outcomes)
	if err != nil {
		return nil, err
	}
	var ops []plan.Op
	if len(d) > 0 {
		ops = append(ops, upd(model.Paths.InboxPlan(ctx.WorkspaceID, pl.PlanID), d, eventID))
	}
	return append(ops, upd(model.Paths.InboxThread(ctx.WorkspaceID, pl.Plan.ThreadID), th, eventID)), nil
}

// PlanStepInput is one step of a proposed plan.
type PlanStepInput struct {
	Type       string         `json:"type"`
	Fields     map[string]any `json:"fields"`
	Note       *string        `json:"note"`
	Confidence *string        `json:"confidence"`
	Checks     []string       `json:"checks"`
}

// ProposePlanInput is proposePlan's input.
type ProposePlanInput struct {
	ThreadID   string          `json:"threadId"`
	Thread     ThreadState     `json:"thread"`
	Note       *string         `json:"note"`
	Confidence *string         `json:"confidence"`
	Steps      []PlanStepInput `json:"steps"`
	PlanID     *string         `json:"planId"`
	StepIDs    []string        `json:"stepIds"`
	// Template (slice 6): the plan is the template's steps, Steps giving their fields over the
	// defaults, in order.
	Template *string `json:"template"`
}

// ProposePlanResult is the plan plus the new plan's and steps' ids.
type ProposePlanResult struct {
	plan.Plan
	PlanID  string   `json:"planId"`
	StepIDs []string `json:"stepIds"`
}

type cleanStep struct {
	typ    string
	fields map[string]any
	note   string
	conf   *string
	checks []string
}

// ProposePlan is proposePlan: 1-8 ordered steps, the plan and one plan.proposed event in one
// batch, so the person never sees half a plan. The thread goes to Your call.
func ProposePlan(ctx Ctx, in ProposePlanInput) (ProposePlanResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ProposePlanResult{}, err
	}
	t := in.Thread
	if err := liveThread(t); err != nil {
		return ProposePlanResult{}, err
	}
	tpl := ""
	if in.Template != nil {
		tpl = *in.Template
	}
	if err := need((tpl != "" || len(in.Steps) >= 1) && len(in.Steps) <= PlanMaxSteps, "A plan has 1 to "+strconv.Itoa(PlanMaxSteps)+" steps."); err != nil {
		return ProposePlanResult{}, err
	}
	note := ""
	if in.Note != nil {
		note = jsTrim(*in.Note)
	}
	if err := need(jsLen(note) <= PlanMaxNote, tooLong("The note", PlanMaxNote)); err != nil {
		return ProposePlanResult{}, err
	}
	if err := need(in.Confidence == nil || inList(*in.Confidence, OutcomeConfidence...), "The confidence is high, medium or low."); err != nil {
		return ProposePlanResult{}, err
	}
	raw := in.Steps
	if tpl != "" {
		var err error
		if raw, err = fromTemplate(tpl, in.Steps); err != nil {
			return ProposePlanResult{}, err
		}
	}
	steps, err := cleanPlanSteps(raw)
	if err != nil {
		return ProposePlanResult{}, err
	}
	planID := ""
	if in.PlanID != nil {
		planID = *in.PlanID
	} else {
		planID = ctx.nid()
	}
	stepIDs := append([]string{}, in.StepIDs...)
	if in.StepIDs == nil {
		stepIDs = make([]string, len(steps))
		for i := range steps {
			stepIDs[i] = ctx.nid()
		}
	}
	distinct := map[string]bool{}
	for _, id := range stepIDs {
		distinct[id] = true
	}
	if err := need(len(stepIDs) == len(steps) && len(distinct) == len(stepIDs), "One distinct id per step."); err != nil {
		return ProposePlanResult{}, err
	}
	types := make([]string, len(steps))
	for i, st := range steps {
		types[i] = st.typ
	}
	p := InboxPlan(ctx, "plan.proposed", t.MemberUID, sp(in.ThreadID), t.SubjectID, evData(planID, stepIDs, types, tpl), func(eventID string) []plan.Op {
		var ops []plan.Op
		for i, st := range steps {
			var executor any
			if OutcomeTypeOf(st.typ).Executor == "agent" {
				executor = t.FetchedBy
			}
			doc := map[string]any{
				"memberUid": t.MemberUID, "threadId": in.ThreadID, "type": st.typ, "fields": st.fields,
				"state": "proposed", "note": st.note, "proposedBy": ctx.Actor.ID, "executor": executor,
				"decision": nil, "result": nil, "planId": planID,
				"createdAt": ServerTime(), "updatedAt": ServerTime(), "lastEventId": eventID,
			}
			if st.conf != nil {
				doc["confidence"] = *st.conf
			}
			if len(st.checks) > 0 {
				doc["checks"] = st.checks
			}
			ops = append(ops, plan.Op{Kind: "set", Path: model.Paths.InboxOutcome(ctx.WorkspaceID, stepIDs[i]), Data: doc})
		}
		pd := map[string]any{
			"memberUid": t.MemberUID, "threadId": in.ThreadID, "proposedBy": ctx.Actor.ID, "steps": stepIDs,
			"cursor": 0, "state": "proposed", "note": note,
			"createdAt": ServerTime(), "updatedAt": ServerTime(), "lastEventId": eventID,
		}
		if in.Confidence != nil {
			pd["confidence"] = *in.Confidence
		}
		if tpl != "" {
			pd["templateId"], pd["sendBackTo"] = tpl, TemplateSendBack(tpl, stepIDs)
		}
		return append(ops,
			plan.Op{Kind: "set", Path: model.Paths.InboxPlan(ctx.WorkspaceID, planID), Data: pd},
			upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "yourCall", "waiting": nil}, eventID),
		)
	}, "")
	return ProposePlanResult{Plan: p, PlanID: planID, StepIDs: stepIDs}, nil
}

// cleanPlanSteps is cleanPlanSteps: 1-8 plan steps, their types, fields, note, confidence, checks.
func cleanPlanSteps(raw []PlanStepInput) ([]cleanStep, error) {
	if err := need(len(raw) >= 1 && len(raw) <= PlanMaxSteps, "A plan has 1 to "+strconv.Itoa(PlanMaxSteps)+" steps."); err != nil {
		return nil, err
	}
	steps := make([]cleanStep, len(raw))
	for i, st := range raw {
		n := "Step " + strconv.Itoa(i+1)
		if !inList(st.Type, PlanOutcomeTypes()...) {
			return nil, fail(n + ": " + st.Type + " is not a plan step. Plan steps: " + strings.Join(PlanOutcomeTypes(), ", ") + ".")
		}
		f := st.Fields
		if f == nil {
			f = map[string]any{}
		}
		fields, err := CleanOutcomeFields(st.Type, f)
		if err != nil {
			return nil, fail(n + ": " + err.Error())
		}
		sn := ""
		if st.Note != nil {
			sn = jsTrim(*st.Note)
		}
		if err := need(jsLen(sn) <= InboxMaxOutcomeNote, n+": "+tooLong("the note", InboxMaxOutcomeNote)); err != nil {
			return nil, err
		}
		if err := need(st.Confidence == nil || inList(*st.Confidence, OutcomeConfidence...), n+": the confidence is high, medium or low."); err != nil {
			return nil, err
		}
		checks, err := cleanLines("checks", st.Checks, InboxMaxChecks, InboxMaxCheck)
		if err != nil {
			return nil, err
		}
		steps[i] = cleanStep{st.Type, fields, sn, st.Confidence, checks}
	}
	return steps, nil
}

func evData(planID string, stepIDs, types []string, tpl string) map[string]any {
	d := map[string]any{"planId": planID, "steps": stepIDs, "types": types}
	if tpl != "" {
		d["templateId"] = tpl
	}
	return d
}
