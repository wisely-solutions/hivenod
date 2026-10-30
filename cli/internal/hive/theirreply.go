package hive

// Their reply (packages/shared/src/theirreply.ts): step_ask and step_sent, and the message
// lookups outcome_done's evidence and a follow-up's quote need.

import (
	"context"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// extMessage reads a message as the Their reply actions check it (nil when it does not exist).
func (c *Client) extMessage(ctx context.Context, id string) (*actions.ExtMessage, error) {
	var m model.InboxMessage
	ok, err := c.getDoc(ctx, model.Paths.InboxMessage(c.WorkspaceID, id), &m)
	if err != nil || !ok {
		return nil, err
	}
	return &actions.ExtMessage{ThreadID: m.ThreadID, Direction: m.Direction, CreatedAtMs: m.CreatedAt.UnixMilli()}, nil
}

// extStep reads a Their reply step with its thread and plan.
func (c *Client) extStep(ctx context.Context, id string) (model.InboxOutcome, actions.ThreadState, *actions.PlanInput, error) {
	if id == "" {
		return model.InboxOutcome{}, actions.ThreadState{}, nil, Errf("Give the step (outcomeId).")
	}
	o, err := c.outcome(ctx, id)
	if err != nil {
		return o, actions.ThreadState{}, nil, err
	}
	t, err := c.thread(ctx, o.ThreadID)
	if err != nil {
		return o, actions.ThreadState{}, nil, err
	}
	if o.PlanID == nil {
		return o, actions.ThreadStateFrom(t), nil, nil
	}
	pl, _, err := c.planInput(ctx, *o.PlanID)
	if err != nil {
		return o, actions.ThreadState{}, nil, err
	}
	return o, actions.ThreadStateFrom(t), &pl, nil
}

func (c *Client) extWrite(ctx context.Context, p plan.Plan) error { return c.inboxWrite(ctx, p) }

// StepAsk drafts the next message of a Their reply step for the person's approval (step_ask).
func (c *Client) StepAsk(ctx context.Context, id, kind, text string, replyID, quote *string) (map[string]any, error) {
	o, t, pl, err := c.extStep(ctx, id)
	if err != nil {
		return nil, err
	}
	in := actions.StepAskInput{OutcomeID: id, Outcome: actions.OutcomeStateFrom(o), Thread: t, Plan: pl, Kind: kind, Text: text}
	if replyID != nil {
		in.Reply = &actions.ExtReplyIn{MessageDocID: *replyID}
		if quote != nil {
			in.Reply.Quote = *quote
		}
		if in.ReplyMessage, err = c.extMessage(ctx, *replyID); err != nil {
			return nil, err
		}
	}
	r, err := actions.StepAsk(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.extWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	return map[string]any{"outcomeId": id, "threadId": o.ThreadID, "n": r.N, "state": "proposed",
		"note": "Drafted: it waits for the person's approval (nothing is sent before). Once approved you get ask_approved: send it exactly as approved, then step_sent."}, nil
}

// StepSent reports the approved message of a Their reply step sent (step_sent).
func (c *Client) StepSent(ctx context.Context, id string) (map[string]any, error) {
	o, t, pl, err := c.extStep(ctx, id)
	if err != nil {
		return nil, err
	}
	p, err := actions.StepSent(c.actx(), actions.StepSentInput{OutcomeID: id, Outcome: actions.OutcomeStateFrom(o), Thread: t, Plan: pl})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.extWrite(ctx, p); err != nil {
		return nil, err
	}
	return map[string]any{"outcomeId": id, "threadId": o.ThreadID, "state": "waiting",
		"note": "Sent: the step waits on them. Their reply wakes you (external_reply); with no reply, one reminder is due after the step's working days (nudge_due)."}, nil
}
