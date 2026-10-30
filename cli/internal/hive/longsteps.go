package hive

// Long steps (item OE8FmrTaIxFVGcaeGG3N, slice 6b): step_progress, and the heartbeat this
// session sends every 5 minutes for a running long step it holds (inboxfeed.go).

import (
	"context"
	"fmt"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// StepProgress is step_progress: where a running long step stands (line, percent?).
func (c *Client) StepProgress(ctx context.Context, id, line string, percent *float64) (map[string]any, error) {
	if id == "" {
		return nil, Errf("Give the step (outcomeId).")
	}
	o, err := c.outcome(ctx, id)
	if err != nil {
		return nil, err
	}
	t, err := c.thread(ctx, o.ThreadID)
	if err != nil {
		return nil, err
	}
	in := actions.StepProgressInput{OutcomeID: id, Outcome: actions.OutcomeStateFrom(o), Thread: actions.ThreadStateFrom(t), Line: line, Percent: percent}
	if o.PlanID != nil {
		pl, _, err := c.planInput(ctx, *o.PlanID)
		if err != nil {
			return nil, err
		}
		in.Plan = &pl
	}
	p, err := actions.StepProgress(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		return nil, err
	}
	return map[string]any{"outcomeId": id, "threadId": o.ThreadID, "note": "Progress noted: the person sees it on the thread. Report again at least every 10 minutes, then outcome_done."}, nil
}

// StepHeartbeat stamps a running long step with its last progress line (or "Working on it").
func (c *Client) StepHeartbeat(ctx context.Context, id string) error {
	var raw struct {
		Progress *struct {
			Line    string `firestore:"line"`
			Percent *int64 `firestore:"percent"`
		} `firestore:"progress"`
	}
	if _, err := c.getDoc(ctx, model.Paths.InboxOutcome(c.WorkspaceID, id), &raw); err != nil {
		return err
	}
	line, percent := "Working on it", (*float64)(nil)
	if raw.Progress != nil && raw.Progress.Line != "" {
		line = raw.Progress.Line
		if raw.Progress.Percent != nil {
			v := float64(*raw.Progress.Percent)
			percent = &v
		}
	}
	_, err := c.StepProgress(ctx, id, line, percent)
	if err != nil {
		return fmt.Errorf("heartbeat %s: %w", id, err)
	}
	return nil
}
