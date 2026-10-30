package hive

// Thread summaries (item OE8FmrTaIxFVGcaeGG3N): thread_summary writes the thread's summary (the
// home agent, after every change it made); thread_read and inbox_list show it.

import (
	"context"
	"fmt"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// SummaryNext is thread_read's hint when this agent's summary of the thread is missing or stale.
const SummaryNext = "Your summary of this thread is %s: when you are done with it, write it with thread_summary (baseVersion %d)."

// summaryDoc reads the thread's current summary (nil: none yet), as stored.
func (c *Client) summaryDoc(ctx context.Context, threadID string) (map[string]any, error) {
	snap, err := c.DB.Doc(actions.SummaryPath(c.WorkspaceID, threadID)).Get(ctx)
	if err != nil {
		if NotFound(err) {
			return nil, nil
		}
		return nil, c.inboxRead(err)
	}
	if !snap.Exists() {
		return nil, nil
	}
	return snap.Data(), nil
}

// summaryOut is the summary as thread_read shows it: times as ISO texts, numbers as they are.
func summaryOut(v any) any {
	switch x := v.(type) {
	case time.Time:
		return isoMs(x)
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = summaryOut(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = summaryOut(e)
		}
		return out
	}
	return v
}

// summaryState is none, fresh or stale (summaryFreshness).
func summaryState(t model.InboxThread) string {
	if t.Summary == nil {
		return "none"
	}
	if t.Summary.At == nil || t.UpdatedAt == nil || !t.Summary.At.Before(*t.UpdatedAt) {
		return "fresh"
	}
	return "stale"
}

// summaryRow is the summary's top line for inbox_list rows (nil: none).
func summaryRow(t model.InboxThread) any {
	if t.Summary == nil {
		return nil
	}
	return map[string]any{"version": t.Summary.Version, "headline": t.Summary.Headline, "state": summaryState(t)}
}

// ThreadSummary writes the thread's summary (thread_summary). baseVersion is the version read
// (0 when there was none); a summary that moved on is refused.
func (c *Client) ThreadSummary(ctx context.Context, id string, summary any, baseVersion *float64) (map[string]any, error) {
	t, err := c.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	doc, err := c.summaryDoc(ctx, id)
	if err != nil {
		return nil, err
	}
	var cur *actions.SummaryCurrent
	if doc != nil {
		v, _ := doc["version"].(int64)
		cur = &actions.SummaryCurrent{Version: int(v)}
	}
	basis := &actions.SummaryBasis{}
	if t.LastEventID != "" {
		ev := t.LastEventID
		basis.LastEventID = &ev
	}
	live, err := c.livePlan(ctx, id)
	if err != nil {
		return nil, err
	}
	if live != nil {
		cursor := live.Plan.Cursor
		basis.PlanCursor = &cursor
	}
	atts, err := c.threadAttachmentKinds(ctx, id)
	if err != nil {
		return nil, err
	}
	r, err := actions.WriteSummary(c.actx(), actions.WriteSummaryInput{
		ThreadID: id, Thread: actions.ThreadStateFrom(t), Current: cur, BaseVersion: baseVersion, Summary: summary, Basis: basis,
		Attachments: atts,
	})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan()); err != nil {
		return nil, err
	}
	return map[string]any{"threadId": id, "version": r.Version, "note": fmt.Sprintf("Summary v%d written: the person sees it on the thread and in Today.", r.Version)}, nil
}
