package actions

// Long steps (item OE8FmrTaIxFVGcaeGG3N, slice 6b): stepProgress of packages/shared/src/inbox.ts.
// The agent carrying out a running long step (Build, Release) reports where it stands; the
// same write is the heartbeat the CLI sends every 5 minutes while its session holds the step.

import (
	"regexp"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// InboxMaxProgressLine is INBOX_LIMITS.progressLine.
const InboxMaxProgressLine = 140

var spaces = regexp.MustCompile(`\s+`)

// StepProgressInput is stepProgress's input.
type StepProgressInput struct {
	OutcomeID string       `json:"outcomeId"`
	Outcome   OutcomeState `json:"outcome"`
	Thread    ThreadState  `json:"thread"`
	Line      string       `json:"line"`
	Percent   *float64     `json:"percent"`
	Plan      *PlanInput   `json:"plan"`
}

// StepProgress is stepProgress: the step's progress {line, percent, at} and one step.progress
// event; the thread is not touched.
func StepProgress(ctx Ctx, in StepProgressInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	o := in.Outcome
	if err := need(o.Executor != nil && *o.Executor == ctx.Actor.ID, "Only the agent that carries this step out reports its progress."); err != nil {
		return plan.Plan{}, err
	}
	t := OutcomeTypeOf(o.Type)
	if err := need(o.State == "running" && t != nil && t.Long, "Progress is for a long step you started (outcome_done status started first)."); err != nil {
		return plan.Plan{}, err
	}
	pl, err := planFor(in.Plan, o, in.OutcomeID)
	if err != nil {
		return plan.Plan{}, err
	}
	if err := need((pl.Plan.State == "active" || pl.Plan.State == "proposed") && pl.Plan.Cursor < len(pl.Plan.Steps) && pl.Plan.Steps[pl.Plan.Cursor] == in.OutcomeID, "Not its turn: this step is not the one the plan runs now."); err != nil {
		return plan.Plan{}, err
	}
	line := spaces.ReplaceAllString(jsTrim(in.Line), " ")
	if err := need(line != "", "Say where it stands (line)."); err != nil {
		return plan.Plan{}, err
	}
	if err := need(jsLen(line) <= InboxMaxProgressLine, tooLong("The line", InboxMaxProgressLine)); err != nil {
		return plan.Plan{}, err
	}
	var percent any
	if in.Percent != nil {
		p := *in.Percent
		if err := need(p == float64(int(p)) && p >= 0 && p <= 100, "The percent is a whole number from 0 to 100."); err != nil {
			return plan.Plan{}, err
		}
		percent = int(p)
	}
	data := map[string]any{"planId": pl.PlanID, "outcomeId": in.OutcomeID, "line": line, "percent": percent}
	return InboxPlan(ctx, "step.progress", o.MemberUID, sp(o.ThreadID), in.Thread.SubjectID, data, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, in.OutcomeID), map[string]any{
			"progress": map[string]any{"line": line, "percent": percent, "at": ServerTime()},
		}, eventID)}
	}, ""), nil
}
