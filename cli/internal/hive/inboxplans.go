package hive

// Inbox plans (item qwFAWxZM5xkcE7PPjAzi): plan_propose, and reading a plan with its steps for
// outcome_done, thread_wake, thread_read and inbox_list. See docs/INBOX.md ("Plans").

import (
	"context"
	"fmt"
	"sort"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

var livePlanStates = []string{"proposed", "active", "blocked"}

// planInput reads a plan and its steps' outcomes.
func (c *Client) planInput(ctx context.Context, pid string) (actions.PlanInput, model.InboxPlan, error) {
	var p model.InboxPlan
	ok, err := c.getDoc(ctx, model.Paths.InboxPlan(c.WorkspaceID, pid), &p)
	if err != nil {
		return actions.PlanInput{}, p, err
	}
	if !ok {
		return actions.PlanInput{}, p, Errf(fmt.Sprintf("Plan %s not found.", pid))
	}
	in := actions.PlanInput{PlanID: pid, Plan: actions.PlanStateFrom(p), Outcomes: map[string]actions.OutcomeState{}}
	for _, oid := range p.Steps {
		var o model.InboxOutcome
		ok, err := c.getDoc(ctx, model.Paths.InboxOutcome(c.WorkspaceID, oid), &o)
		if err != nil {
			return in, p, err
		}
		if ok {
			in.Outcomes[oid] = actions.OutcomeStateFrom(o)
		}
	}
	return in, p, nil
}

type planDoc = docOf[model.InboxPlan]

// threadPlans lists a thread's plans, oldest first.
func (c *Client) threadPlans(ctx context.Context, threadID string) ([]planDoc, error) {
	ps, err := listInbox[model.InboxPlan](ctx, c, "inboxPlans", "threadId", "==", threadID)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(ps, func(i, j int) bool {
		a, b := ps[i].Data.CreatedAt.UnixMilli(), ps[j].Data.CreatedAt.UnixMilli()
		if a != b {
			return a < b
		}
		return ps[i].ID < ps[j].ID
	})
	return ps, nil
}

// livePlan is the thread's newest live plan with its steps (nil when it has none).
func (c *Client) livePlan(ctx context.Context, threadID string) (*actions.PlanInput, error) {
	ps, err := c.threadPlans(ctx, threadID)
	if err != nil {
		return nil, err
	}
	for i := len(ps) - 1; i >= 0; i-- {
		if contains(livePlanStates, ps[i].Data.State) {
			in, _, err := c.planInput(ctx, ps[i].ID)
			if err != nil {
				return nil, err
			}
			return &in, nil
		}
	}
	return nil, nil
}

// PlanStepArg is one step of plan_propose.
type PlanStepArg = actions.PlanStepInput

// PlanPropose proposes a plan (plan_propose): 1-8 ordered steps in one batch.
func (c *Client) PlanPropose(ctx context.Context, threadID string, note, confidence *string, steps []PlanStepArg, template *string) (map[string]any, error) {
	t, err := c.thread(ctx, threadID)
	if err != nil {
		return nil, err
	}
	if steps == nil {
		steps = []PlanStepArg{}
	}
	r, err := actions.ProposePlan(c.actx(), actions.ProposePlanInput{ThreadID: threadID, Thread: actions.ThreadStateFrom(t), Note: note, Confidence: confidence, Steps: steps, Template: template})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	types := make([]string, len(r.StepIDs))
	for i := range r.StepIDs {
		if template != nil && *template != "" {
			types[i] = actions.PlanTemplateOf(*template).Steps[i].Type
		} else {
			types[i] = steps[i].Type
		}
	}
	rows := make([]any, len(r.StepIDs))
	for i, ty := range types {
		rows[i] = map[string]any{"step": i + 1, "outcomeId": r.StepIDs[i], "type": ty, "kind": actions.OutcomeKind(ty)}
	}
	return map[string]any{
		"planId": r.PlanID, "threadId": threadID, "state": "proposed", "stepIds": r.StepIDs, "steps": rows,
		"note": "Plan proposed. The person approves the whole plan or step by step; each step is carried out only once it is approved and the steps before it are done (you get a carry_out per step). An approval step waits for the person.",
	}, nil
}

// planRows is thread_read's plans: each with its steps' numbers, kinds and states.
func (c *Client) planRows(ctx context.Context, threadID string) ([]any, map[string]string, error) {
	ps, err := c.threadPlans(ctx, threadID)
	if err != nil {
		return nil, nil, err
	}
	rows := []any{}
	stepOf := map[string]string{}
	for _, d := range ps {
		in, p, err := c.planInput(ctx, d.ID)
		if err != nil {
			return nil, nil, err
		}
		v := actions.PlanView(in.Plan, in.Outcomes)
		steps := make([]any, len(v.Steps))
		for i, s := range v.Steps {
			steps[i] = map[string]any{"step": s.Number, "outcomeId": s.OutcomeID, "type": s.Type, "kind": s.Kind, "label": s.Label, "ui": s.UI, "atCursor": s.AtCursor}
			// A running long step (slice 6b): where it stands, as last reported.
			if s.UI == "running" && s.Type != nil && isLong(*s.Type) {
				if o, err := c.outcome(ctx, s.OutcomeID); err == nil && o.Progress != nil {
					steps[i].(map[string]any)["progress"] = map[string]any{"line": o.Progress.Line, "percent": o.Progress.Percent}
				}
			}
			stepOf[s.OutcomeID] = fmt.Sprintf("%d of %d", s.Number, v.Total)
		}
		row := map[string]any{
			"planId": d.ID, "state": p.State, "cursor": p.Cursor, "progress": v.Progress, "note": p.Note,
			"confidence": strOrNull(p.Confidence), "steps": steps,
		}
		// Development plans (slice 6): the template, and the last send back (to which step, why).
		if p.TemplateID != nil {
			row["templateId"] = *p.TemplateID
		}
		if p.SentBack != nil {
			row["sentBack"] = map[string]any{"n": p.SentBack.N, "toStep": stepOf[p.SentBack.To], "reason": p.SentBack.Reason, "by": p.SentBack.By}
		}
		rows = append(rows, row)
	}
	return rows, stepOf, nil
}

// PlanSendBack is plan_send_back (item OE8FmrTaIxFVGcaeGG3N, slice 6): from the plan step this
// agent carries out, back to an earlier agent step (toStep, 1-based; default the nearest), with
// the reason. The third send back leaves the plan blocked for the person.
func (c *Client) PlanSendBack(ctx context.Context, threadID, reason string, toStep *float64) (map[string]any, error) {
	if threadID == "" {
		return nil, Errf("Give the thread (threadId).")
	}
	pl, err := c.livePlan(ctx, threadID)
	if err != nil {
		return nil, err
	}
	if pl == nil {
		return nil, Errf("This thread has no live plan.")
	}
	t, err := c.thread(ctx, threadID)
	if err != nil {
		return nil, err
	}
	var to *int
	if toStep != nil {
		n := int(*toStep) - 1
		to = &n
	}
	r, err := actions.SendBackPlan(c.actx(), actions.SendBackPlanInput{PlanInput: *pl, Thread: actions.ThreadStateFrom(t), Reason: reason, ToStep: to})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	note := fmt.Sprintf("Sent back to step %d of %d: you get carry_out for it again (why sent_back, with the reason).", r.ToStep+1, len(pl.Plan.Steps))
	if r.Blocked {
		note = fmt.Sprintf("Sent back to step %d of %d, the third time: the plan is blocked until the person retries or stops it.", r.ToStep+1, len(pl.Plan.Steps))
	}
	return map[string]any{"planId": pl.PlanID, "threadId": threadID, "toStep": r.ToStep + 1, "blocked": r.Blocked, "note": note}, nil
}
