package actions

// Plan templates and send back (item OE8FmrTaIxFVGcaeGG3N, slice 6): the agent side of
// packages/shared/src/planTemplates.ts (embedded as plantemplates.json, kept equal by
// scripts/inbox-outcomes.test.mjs) and of sendBackPlan in inbox.ts. The member's New thread and
// Ask for changes on a gate are web-only and stay in TypeScript.

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

//go:embed plantemplates.json
var planTemplatesJSON []byte

// PlanTemplateStep is one step of a template.
type PlanTemplateStep struct {
	Type       string            `json:"type"`
	Fields     map[string]string `json:"fields"`
	SendBackTo *int              `json:"sendBackTo"`
}

// PlanTemplate is a plan template.
type PlanTemplate struct {
	ID          string             `json:"id"`
	Name        string             `json:"name"`
	Description string             `json:"description"`
	Steps       []PlanTemplateStep `json:"steps"`
}

// PlanTemplates are PLAN_TEMPLATES, in order.
var PlanTemplates = loadPlanTemplates()

func loadPlanTemplates() []PlanTemplate {
	var byID map[string]PlanTemplate
	if err := json.Unmarshal(planTemplatesJSON, &byID); err != nil {
		panic(err)
	}
	var out []PlanTemplate
	for _, id := range orderedKeys(planTemplatesJSON) {
		out = append(out, byID[id])
	}
	return out
}

// PlanTemplateOf is planTemplate(id).
func PlanTemplateOf(id string) *PlanTemplate {
	for i := range PlanTemplates {
		if PlanTemplates[i].ID == id {
			return &PlanTemplates[i]
		}
	}
	return nil
}

func templateIDs() string {
	ids := make([]string, len(PlanTemplates))
	for i, t := range PlanTemplates {
		ids[i] = t.ID
	}
	return strings.Join(ids, ", ")
}

// fromTemplate is fromTemplate: the template's steps with the caller's steps over them.
func fromTemplate(id string, over []PlanStepInput) ([]PlanStepInput, error) {
	t := PlanTemplateOf(id)
	if t == nil {
		return nil, fail("Unknown template " + id + ". Templates: " + templateIDs() + ".")
	}
	if len(over) > len(t.Steps) {
		return nil, fail("The " + t.Name + " template has " + strconv.Itoa(len(t.Steps)) + " steps.")
	}
	out := make([]PlanStepInput, len(t.Steps))
	for i, s := range t.Steps {
		fields := map[string]any{}
		for k, v := range s.Fields {
			fields[k] = v
		}
		var o PlanStepInput
		if i < len(over) {
			o = over[i]
			for k, v := range o.Fields {
				fields[k] = v
			}
			if o.Type != "" && o.Type != s.Type {
				return nil, fail("Step " + strconv.Itoa(i+1) + " of the " + t.Name + " template is " + s.Type + ", not " + o.Type + ".")
			}
		}
		o.Type, o.Fields = s.Type, fields
		out[i] = o
	}
	return out, nil
}

// TemplateSendBack is templateSendBack: {person step id: target step id}.
func TemplateSendBack(id string, stepIDs []string) map[string]any {
	out := map[string]any{}
	t := PlanTemplateOf(id)
	if t == nil {
		return out
	}
	for i, s := range t.Steps {
		if s.SendBackTo != nil && i < len(stepIDs) && *s.SendBackTo < len(stepIDs) {
			out[stepIDs[i]] = stepIDs[*s.SendBackTo]
		}
	}
	return out
}

// SendBackTarget is sendBackTarget: the plan's target for the step at index when it is an
// earlier agent step, else the nearest earlier agent step; -1 when there is none.
func SendBackTarget(steps []string, types map[string]string, index int, m map[string]string) int {
	agentAt := func(i int) bool {
		if i < 0 || i >= index {
			return false
		}
		ty := types[steps[i]]
		return OutcomeTypeOf(ty) != nil && OutcomeKind(ty) == "agent"
	}
	if named, ok := m[steps[index]]; ok {
		at := -1
		for i, s := range steps {
			if s == named {
				at = i
				break
			}
		}
		if agentAt(at) {
			return at
		}
	}
	for i := index - 1; i >= 0; i-- {
		if agentAt(i) {
			return i
		}
	}
	return -1
}

// MaxPlanSendBacks is MAX_PLAN_SEND_BACKS.
const MaxPlanSendBacks = 3

// SendBackPlanInput is sendBackPlan's input (the agent's plan_send_back).
type SendBackPlanInput struct {
	PlanInput
	Thread ThreadState `json:"thread"`
	Reason string      `json:"reason"`
	ToStep *int        `json:"toStep"`
}

// SendBackPlanResult is the plan plus the target and whether the plan is now blocked.
type SendBackPlanResult struct {
	plan.Plan
	ToStep  int  `json:"toStep"`
	Blocked bool `json:"blocked"`
}

// SendBackPlan is sendBackPlan for an agent (plan_send_back): from the agent step at the cursor
// it carries out, back to an earlier agent step that is done.
func SendBackPlan(ctx Ctx, in SendBackPlanInput) (SendBackPlanResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return SendBackPlanResult{}, err
	}
	p := in.Plan
	if p.State != "active" && p.State != "proposed" {
		if p.State == "blocked" {
			return SendBackPlanResult{}, fail("This plan is blocked: retry or stop it first.")
		}
		return SendBackPlanResult{}, fail("This plan is " + p.State + ".")
	}
	reason := jsTrim(in.Reason)
	if err := need(reason != "", "Say what should change."); err != nil {
		return SendBackPlanResult{}, err
	}
	if err := need(jsLen(reason) <= InboxMaxReason, tooLong("The reason", InboxMaxReason)); err != nil {
		return SendBackPlanResult{}, err
	}
	o := in.at(p.Cursor)
	if o == nil {
		return SendBackPlanResult{}, fail("No step is at its turn.")
	}
	if OutcomeKind(o.Type) == "human" || o.Executor == nil || *o.Executor != ctx.Actor.ID {
		return SendBackPlanResult{}, fail("Only the agent carrying out the step at its turn sends the plan back.")
	}
	if o.State != "approved" && o.State != "running" {
		return SendBackPlanResult{}, fail("This step is " + o.State + ": nothing to send back.")
	}
	types := map[string]string{}
	for _, id := range p.Steps {
		if x, ok := in.Outcomes[id]; ok {
			types[id] = x.Type
		}
	}
	to := -1
	if in.ToStep != nil {
		to = *in.ToStep
	} else {
		to = SendBackTarget(p.Steps, types, p.Cursor, p.SendBackTo)
		if to < 0 {
			return SendBackPlanResult{}, fail("No earlier agent step to send it back to.")
		}
	}
	t := in.at(to)
	if to < 0 || to >= p.Cursor || t == nil || OutcomeKind(t.Type) != "agent" || t.State != "done" {
		return SendBackPlanResult{}, fail("Send it back to an earlier agent step that is done.")
	}
	reset := []string{}
	next := PlanInput{PlanID: in.PlanID, Plan: p, Outcomes: map[string]OutcomeState{}}
	for k, v := range in.Outcomes {
		next.Outcomes[k] = v
	}
	back := func(id string) string {
		if OutcomeKind(in.Outcomes[id].Type) == "human" {
			return "proposed"
		}
		return "approved"
	}
	for _, id := range p.Steps[to : p.Cursor+1] {
		if x, ok := in.Outcomes[id]; ok && (x.State == "done" || x.State == "running") {
			reset = append(reset, id)
			x.State = back(id)
			next.Outcomes[id] = x
		}
	}
	n := 1
	if p.SentBack != nil {
		n = p.SentBack.N + 1
	}
	blocked := n >= MaxPlanSendBacks
	next.Plan.Steps = append([]string{}, p.Steps...)
	next.Plan.Cursor = to
	next.Plan.State = "active"
	if blocked {
		next.Plan.State = "blocked"
	}
	th, err := PlanThreadState(next.Plan, next.Outcomes)
	if err != nil {
		return SendBackPlanResult{}, err
	}
	target := p.Steps[to]
	data := map[string]any{"planId": in.PlanID, "outcomeId": target, "from": p.Cursor, "to": to, "reset": reset, "reason": reason, "n": n}
	pl := InboxPlan(ctx, "plan.sent_back", p.MemberUID, sp(p.ThreadID), in.Thread.SubjectID, data, func(eventID string) []plan.Op {
		var ops []plan.Op
		for _, id := range reset {
			d := map[string]any{"state": "approved"}
			if back(id) == "proposed" {
				d = map[string]any{"state": "proposed", "decision": nil}
			}
			ops = append(ops, upd(model.Paths.InboxOutcome(ctx.WorkspaceID, id), d, eventID))
		}
		return append(ops,
			upd(model.Paths.InboxPlan(ctx.WorkspaceID, in.PlanID), map[string]any{
				"cursor": to, "cursorAt": ServerTime(), "state": next.Plan.State,
				"sentBack": map[string]any{"n": n, "to": target, "reason": reason, "by": ctx.Actor.ID, "at": ServerTime()},
			}, eventID),
			upd(model.Paths.InboxThread(ctx.WorkspaceID, p.ThreadID), th, eventID),
		)
	}, "")
	return SendBackPlanResult{Plan: pl, ToStep: to, Blocked: blocked}, nil
}
