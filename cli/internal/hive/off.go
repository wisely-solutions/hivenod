package hive

// The Off switch (scheduled tasks, slice 7; design 6.2): a member turns all agents, or some, Off
// in an organization (workspaces/{w}/agentsOff/{memberUid}). While Off for this agent, the feed
// holds what the agent would act on by itself (carry_out of steps approved before Off, messages
// brought in from outside, nudges, wakes, summaries, resumes) and still delivers what the member
// does himself (a thread he writes, Ask the agent, answers, Ask for changes, a re-check, a step he
// approves after turning Off). The tools refuse automated writes for that member (refuseOff).
// One listener on the organization's Off docs, no polling.

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// FeedOff is a member whose Off doc silences this agent, since SinceMs.
type FeedOff struct {
	MemberUID string
	SinceMs   int64
}

// offSilences reads an Off doc: whether it silences agent uid, and since when (ms).
func offSilences(m map[string]any, uid string) (int64, bool) {
	since := feedMs(m["since"])
	if since == 0 {
		return 0, false
	}
	if all, _ := m["all"].(bool); all {
		return since, true
	}
	agents, _ := m["agents"].([]any)
	for _, a := range agents {
		if s, _ := a.(string); s == uid {
			return since, true
		}
	}
	return 0, false
}

// WatchOff listens to the organization's Off docs (agents read them all; one listener).
func (s firestoreInbox) WatchOff(ctx context.Context, on func([]FeedOff)) {
	q := s.c.DB.Collection(model.Paths.InboxCollection(s.c.WorkspaceID, "agentsOff")).Query
	go listenQuery(ctx, s.c.recon, q, func(docs []*firestore.DocumentSnapshot) {
		rows := make([]FeedOff, 0, len(docs))
		for _, d := range docs {
			if since, off := offSilences(d.Data(), s.c.UID); off {
				rows = append(rows, FeedOff{MemberUID: d.Ref.ID, SinceMs: since})
			}
		}
		s.c.setOff(rows)
		on(rows)
	}, nil)
}

// setOff keeps the listener's view for the tools (refuseOff reads it instead of the doc).
func (c *Client) setOff(rows []FeedOff) {
	m := make(map[string]int64, len(rows))
	for _, r := range rows {
		m[r.MemberUID] = r.SinceMs
	}
	c.mu.Lock()
	c.off = m
	c.mu.Unlock()
}

// offSince is when member turned this agent Off (0: on). From the channel's listener when there
// is one, else one read of the member's Off doc.
func (c *Client) offSince(ctx context.Context, member string) (int64, error) {
	c.mu.Lock()
	live, off := c.off != nil, c.off[member]
	c.mu.Unlock()
	if live {
		return off, nil
	}
	snap, err := c.DB.Doc(model.Paths.InboxCollection(c.WorkspaceID, "agentsOff") + "/" + member).Get(ctx)
	if err != nil {
		if NotFound(err) {
			return 0, nil
		}
		return 0, c.inboxRead(err)
	}
	since, _ := offSilences(snap.Data(), c.UID)
	return since, nil
}

// OffLine is what an agent is told (and the tools answer) while its member has it Off.
func OffLine(member string, sinceMs int64) string {
	at := time.UnixMilli(sinceMs).UTC().Format("2006-01-02 15:04 UTC")
	return fmt.Sprintf("Member %s turned agents Off at %s: start nothing on your own for them: no routines, no fetching, no carry_out, until they turn them on; answer only what they ask (their own threads, Ask the agent, answers, steps they approve now).", member, at)
}

// refuseOff refuses an automated write for member while Off (nil when on). touched: the member
// did something on the thread since Off (wrote it, asked, answered): replies to that go through.
func (c *Client) refuseOff(ctx context.Context, member string, touched func(sinceMs int64) bool) error {
	since, err := c.offSince(ctx, member)
	if err != nil || since == 0 {
		return err
	}
	if touched != nil && touched(since) {
		return nil
	}
	return Errf(OffLine(member, since) + " Refused while Off.")
}

// touchedSince says whether the member acted on thread t after sinceMs: a message on it (his own
// New thread or reply; agents Off bring nothing in), Ask the agent, a re-check or an answer.
func touchedSince(t model.InboxThread, sinceMs int64) bool {
	after := func(at *time.Time) bool { return at != nil && at.UnixMilli() > sinceMs }
	if t.LastMessageAt.UnixMilli() > sinceMs {
		return true
	}
	for _, in := range t.Instructions {
		if in.By == t.MemberUID && after(in.At) {
			return true
		}
	}
	if t.Recheck != nil && after(t.Recheck.RequestedAt) {
		return true
	}
	return t.Question != nil && after(t.Question.AnsweredAt)
}

// ---------- the feed ----------

// OnOff takes a snapshot of the members who have this agent Off: tells each change once (info
// off / on) and evaluates again (held events go out once On).
func (f *InboxFeed) OnOff(rows []FeedOff) {
	f.mu.Lock()
	next := make(map[string]int64, len(rows))
	for _, r := range rows {
		next[r.MemberUID] = r.SinceMs
	}
	var events []Event
	members := make([]string, 0, len(next))
	for m := range next {
		members = append(members, m)
	}
	sort.Strings(members)
	for _, m := range members {
		if f.off[m] != next[m] {
			events = append(events, f.offInfo(m, next[m]))
		}
	}
	gone := make([]string, 0)
	for m := range f.off {
		if _, ok := next[m]; !ok {
			gone = append(gone, m)
		}
	}
	sort.Strings(gone)
	for _, m := range gone {
		events = append(events, Event{
			Content: fmt.Sprintf("Member %s turned agents On again: work for them as usual. What waited while Off comes now (approved steps at their turn, messages, nudges).", m),
			Meta:    map[string]string{"kind": "info", "code": "on", "member": m},
		})
	}
	f.off = next
	f.mu.Unlock()
	f.send(events)
	f.Evaluate()
}

// offInfo is the info event of member turning this agent Off, naming the work already in its
// hands (stop it at a safe point and report it). Call with f.mu held.
func (f *InboxFeed) offInfo(member string, since int64) Event {
	var busy, ids []string
	for _, id := range f.norder {
		if r := f.running[id]; r.Long && f.mine[id] && r.MemberUID == member {
			busy = append(busy, fmt.Sprintf("%s (outcome %s) on thread %s", r.Type, id, r.ThreadID))
			ids = append(ids, id)
		}
	}
	for _, id := range f.oorder {
		if o := f.outcomes[id]; o.MemberUID == member && f.carried[f.round(o)] && f.running[id].ID == "" {
			busy = append(busy, fmt.Sprintf("%s (outcome %s) on thread %s", o.Type, id, o.ThreadID))
			ids = append(ids, id)
		}
	}
	text := OffLine(member, since)
	if len(busy) > 0 {
		text += " Off: stop at a safe point and report: " + strings.Join(busy, "; ") + ". step_progress and outcome_done still work, so the result is reported, not lost."
	}
	meta := map[string]string{"kind": "info", "code": "off", "member": member}
	if len(ids) > 0 {
		meta["outcome_ids"] = strings.Join(ids, ",")
	}
	return Event{Content: text, Meta: meta}
}

// held says whether a due event waits while its member has this agent Off: what the agent would
// act on by itself waits; what the member did himself goes out. Call with f.mu held.
func (f *InboxFeed) held(d *feedDue) bool {
	since, off := f.off[d.memberUID]
	if !off {
		return false
	}
	switch d.reason {
	case "carry_out":
		// A step the member approved after turning Off is his saying something.
		return d.outcome == nil || d.outcome.DecidedAtMs <= since
	case "instruct", "revise", "recheck":
		return false
	}
	return !d.byMember
}
