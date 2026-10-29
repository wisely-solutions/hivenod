package hive

// Inbox tools (item 4PEHrOW5IfXBQWgOK9wo): ported from the former TypeScript
// client; cli/e2e/test/go.test.ts checks the results against its golden files.
//
// Nothing here carries anything out by itself: an agent sends, books or hands over only for an
// outcome its person approved (state approved, with the approved fields), then reports
// outcome_done.

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// InboxDenied is the refusal when the rules turn an inbox write down.
const InboxDenied = "Hivenod refused this inbox change (permission denied): the thread may have changed since it was read (read it again with thread_read), or this agent was revoked."

const inboxReadDenied = "Hivenod refused to read the inbox (permission denied): this agent may have been revoked."

// CarryOut is what an agent with an approved outcome to carry out does next.
const CarryOut = "Carry out the approved outcome exactly as approved (its fields, as the person left them), then report it with outcome_done."

// InboxNext is NEXT in inbox.ts.
var InboxNext = map[string]string{
	"investigating": "Investigate: read the messages and the subject's other threads, note what you find (inbox_note), set the deadline a message states (thread_due), ask the person if you must (inbox_ask), then propose what should come of it (outcome_propose, with your confidence and what you checked).",
	"needsYou":      "Waiting for the person's answer to your question.",
	"yourCall":      "Waiting for the person to approve, edit or reject the proposed outcomes.",
	"waiting":       "Waiting. A new message from them reopens it.",
	"done":          "Done.",
	"ignored":       "The person ignored it: do nothing.",
}

var threadOpen = []string{"investigating", "needsYou", "yourCall", "waiting"}

func isoMs(t time.Time) string { return actions.ISOms(t) }

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

func (c *Client) inboxRead(err error) error {
	if err != nil && Denied(err) {
		return Errf(inboxReadDenied)
	}
	return err
}

func (c *Client) inboxWrite(ctx context.Context, p plan.Plan) error {
	if err := plan.Apply(ctx, c.DB, p); err != nil {
		if Denied(err) {
			return Errf(InboxDenied)
		}
		return err
	}
	return nil
}

// getDoc reads one inbox doc into out; false when it does not exist.
func (c *Client) getDoc(ctx context.Context, path string, out any) (bool, error) {
	snap, err := c.DB.Doc(path).Get(ctx)
	if err != nil {
		if NotFound(err) {
			return false, nil
		}
		return false, c.inboxRead(err)
	}
	if !snap.Exists() {
		return false, nil
	}
	return true, snap.DataTo(out)
}

type docOf[T any] struct {
	ID   string
	Data T
}

func listInbox[T any](ctx context.Context, c *Client, coll, field, op string, value any) ([]docOf[T], error) {
	docs, err := c.DB.Collection(model.Paths.InboxCollection(c.WorkspaceID, coll)).Where(field, op, value).Documents(ctx).GetAll()
	if err != nil {
		return nil, c.inboxRead(err)
	}
	out := make([]docOf[T], 0, len(docs))
	for _, d := range docs {
		var v T
		if err := d.DataTo(&v); err != nil {
			return nil, err
		}
		out = append(out, docOf[T]{d.Ref.ID, v})
	}
	return out, nil
}

func (c *Client) members(ctx context.Context) ([]string, error) {
	snap, err := c.DB.Doc(model.Paths.Workspace(c.WorkspaceID)).Get(ctx)
	if err != nil {
		return nil, c.inboxRead(err)
	}
	roles, _ := snap.Data()["memberRoles"].(map[string]any)
	out := make([]string, 0, len(roles))
	for k := range roles {
		out = append(out, k)
	}
	return out, nil
}

// inboxMember is the member it is for: the given uid, else whoever connected this agent.
func (c *Client) inboxMember(ctx context.Context, given string) (string, error) {
	members, err := c.members(ctx)
	if err != nil {
		return "", err
	}
	if given != "" {
		if !contains(members, given) {
			return "", Errf(given + " is not a member of this organization.")
		}
		return given, nil
	}
	a, err := c.RefreshAgent(ctx)
	if err != nil {
		return "", err
	}
	if !contains(members, a.CreatedBy) {
		return "", Errf("Name the member (member: their user id): the person who connected this agent is no longer in the organization.")
	}
	return a.CreatedBy, nil
}

func (c *Client) thread(ctx context.Context, id string) (model.InboxThread, error) {
	var t model.InboxThread
	ok, err := c.getDoc(ctx, model.Paths.InboxThread(c.WorkspaceID, id), &t)
	if err != nil {
		return t, err
	}
	if !ok {
		return t, Errf(fmt.Sprintf("Thread %s not found.", id))
	}
	return t, nil
}

func (c *Client) outcome(ctx context.Context, id string) (model.InboxOutcome, error) {
	var o model.InboxOutcome
	ok, err := c.getDoc(ctx, model.Paths.InboxOutcome(c.WorkspaceID, id), &o)
	if err != nil {
		return o, err
	}
	if !ok {
		return o, Errf(fmt.Sprintf("Outcome %s not found.", id))
	}
	return o, nil
}

// parseISO reads an ISO 8601 time the way Date.parse accepts the common forms.
func parseISO(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02"} {
		loc := time.UTC
		if layout == "2006-01-02T15:04:05.999999999" || layout == "2006-01-02T15:04" {
			loc = time.Local // Date.parse reads a date-time without an offset as local time
		}
		if t, err := time.ParseInLocation(layout, s, loc); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// InboxAddIn is inbox_add's input.
type InboxAddIn struct {
	Source      string
	SenderName  string
	Handle      *string
	Text        string
	ThreadRef   string
	ReceivedAt  string
	MessageID   *string
	Permalink   *string
	ReplyRef    *string
	Member      string
	Attachments []model.InboxAttachment
	Thread      string
	FromMember  bool
	Title       *string
}

// InboxAdd brings a message into its person's Inbox (inbox_add).
func (c *Client) InboxAdd(ctx context.Context, in InboxAddIn) (map[string]any, error) {
	at, ok := parseISO(in.ReceivedAt)
	if !ok {
		return nil, Errf("receivedAt is not a valid ISO 8601 time (e.g. 2026-10-28T09:00:00Z).")
	}
	at = time.UnixMilli(at.UnixMilli())
	member, err := c.inboxMember(ctx, in.Member)
	if err != nil {
		return nil, err
	}
	messageID := strconv.FormatInt(at.UnixMilli(), 10)
	if in.MessageID != nil {
		messageID = *in.MessageID
	}
	mid := "im" + actions.Digest24(actions.InboxMessageKey(member, in.Source, in.ThreadRef, messageID))
	ref := actions.Digest24(actions.InboxThreadKey(member, in.Source, in.ThreadRef))
	dup := func() (map[string]any, error) {
		var m model.InboxMessage
		ok, err := c.getDoc(ctx, model.Paths.InboxMessage(c.WorkspaceID, mid), &m)
		if err != nil || !ok {
			return nil, err
		}
		var t model.InboxThread
		var state any
		if ok, _ := c.getDoc(ctx, model.Paths.InboxThread(c.WorkspaceID, m.ThreadID), &t); ok {
			state = t.State
		}
		return map[string]any{
			"messageId": mid, "threadId": m.ThreadID, "newThread": false, "duplicate": true, "state": state, "member": m.MemberUID,
			"note": "Already in Inbox (same source, thread and message): nothing was added.",
		}, nil
	}
	if d, err := dup(); err != nil || d != nil {
		return d, err
	}
	attempt := func() (actions.AddResult, error) {
		ai := actions.InboxAddInput{MessageDocID: mid, Ref: ref, MemberUID: member, Source: in.Source, Text: in.Text, ThreadRef: in.ThreadRef, MessageID: messageID, Permalink: in.Permalink, ReplyRef: in.ReplyRef, ReceivedAt: at, Attachments: in.Attachments, Title: in.Title}
		ai.Sender.Name, ai.Sender.Handle = in.SenderName, in.Handle
		dir := "in"
		if in.FromMember {
			dir = "out"
		}
		ai.Direction = &dir
		if ai.Attachments == nil {
			ai.Attachments = []model.InboxAttachment{}
		}
		join := func(id string, t model.InboxThread) {
			ai.Thread = &struct {
				ThreadID string              `json:"threadId"`
				State    actions.ThreadState `json:"state"`
			}{id, actions.ThreadStateFrom(t)}
		}
		if in.Thread != "" {
			var t model.InboxThread
			ok, err := c.getDoc(ctx, model.Paths.InboxThread(c.WorkspaceID, in.Thread), &t)
			if err != nil {
				return actions.AddResult{}, err
			}
			if !ok || t.MemberUID != member {
				return actions.AddResult{}, Errf(fmt.Sprintf("Thread %s not found among this person's threads.", in.Thread))
			}
			join(in.Thread, t)
		} else {
			var own model.InboxThread
			ok, err := c.getDoc(ctx, model.Paths.InboxThread(c.WorkspaceID, "it"+ref), &own)
			if err != nil {
				return actions.AddResult{}, err
			}
			if ok {
				join("it"+ref, own)
			} else {
				hits, err := listInbox[model.InboxThread](ctx, c, "inboxThreads", "refs", "array-contains", ref)
				if err != nil {
					return actions.AddResult{}, err
				}
				sort.Slice(hits, func(i, j int) bool { return hits[i].ID < hits[j].ID })
				for _, h := range hits {
					if h.Data.MemberUID == member {
						join(h.ID, h.Data)
						break
					}
				}
			}
		}
		r, err := actions.AddInboxMessage(c.actx(), ai)
		if err != nil {
			return r, wrap(err)
		}
		return r, c.inboxWrite(ctx, r.Plan)
	}
	r, err := attempt()
	if err != nil {
		if Message(err) != InboxDenied {
			return nil, err
		}
		// Another agent brought the same message (or the same new thread) in a moment ago.
		if d, e := dup(); e == nil && d != nil {
			return d, nil
		}
		if r, err = attempt(); err != nil {
			return nil, err
		}
	}
	note := "Added to its thread."
	if r.NewThread {
		note = "Brought into Inbox as a new thread. File it under a subject (subject_list, then subject_assign) and investigate."
	}
	return map[string]any{
		"messageId": mid, "threadId": r.ThreadID, "newThread": r.NewThread, "duplicate": false,
		"state": r.State, "member": member, "note": note,
	}, nil
}

func threadRow(id string, t model.InboxThread) map[string]any {
	return map[string]any{
		"threadId": id, "member": t.MemberUID, "state": t.State, "title": t.Title,
		"subjectId": strOrNull(t.SubjectID), "lastMessageAt": isoMs(t.LastMessageAt),
		"summary": summaryRow(t),
	}
}

func fieldsOf(f map[string]any) map[string]any {
	if f == nil {
		return map[string]any{}
	}
	return f
}

// InboxList is what agents have to do (inbox_list).
func (c *Client) InboxList(ctx context.Context) (map[string]any, error) {
	threads, err := listInbox[model.InboxThread](ctx, c, "inboxThreads", "state", "in", []any{"investigating", "waiting"})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(threads, func(i, j int) bool {
		a, b := threads[i].Data.LastMessageAt.UnixMilli(), threads[j].Data.LastMessageAt.UnixMilli()
		if a != b {
			return a < b
		}
		return threads[i].ID < threads[j].ID
	})
	outcomes, err := listInbox[model.InboxOutcome](ctx, c, "inboxOutcomes", "state", "==", "approved")
	if err != nil {
		return nil, err
	}
	sort.SliceStable(outcomes, func(i, j int) bool {
		a, b := outcomes[i].Data.CreatedAt.UnixMilli(), outcomes[j].Data.CreatedAt.UnixMilli()
		if a != b {
			return a < b
		}
		return outcomes[i].ID < outcomes[j].ID
	})
	now := time.Now().UnixMilli()
	toWork, toCarry, toWake := []any{}, []any{}, []any{}
	for _, t := range threads {
		if t.Data.State == "investigating" {
			toWork = append(toWork, threadRow(t.ID, t.Data))
		}
		if t.Data.State == "waiting" && t.Data.Waiting != nil && t.Data.Waiting.Until != nil && t.Data.Waiting.Until.UnixMilli() <= now {
			toWake = append(toWake, threadRow(t.ID, t.Data))
		}
	}
	plans := map[string]actions.PlanState{}
	for _, o := range outcomes {
		if o.Data.Executor == nil || *o.Data.Executor != c.UID {
			continue
		}
		row := map[string]any{"outcomeId": o.ID, "threadId": o.Data.ThreadID, "member": o.Data.MemberUID, "type": o.Data.Type, "fields": fieldsOf(o.Data.Fields)}
		if pid := o.Data.PlanID; pid != nil {
			// A plan step only at its turn (the steps before it done, the plan running).
			p, ok := plans[*pid]
			if !ok {
				var d model.InboxPlan
				found, err := c.getDoc(ctx, model.Paths.InboxPlan(c.WorkspaceID, *pid), &d)
				if err != nil {
					return nil, err
				}
				if found {
					p = actions.PlanStateFrom(d)
				}
				plans[*pid] = p
			}
			if (p.State != "proposed" && p.State != "active") || p.Cursor >= len(p.Steps) || p.Steps[p.Cursor] != o.ID {
				continue
			}
			row["planId"], row["step"] = *pid, fmt.Sprintf("%d of %d", p.Cursor+1, len(p.Steps))
		}
		toCarry = append(toCarry, row)
	}
	return map[string]any{"toWork": toWork, "toCarryOut": toCarry, "toWake": toWake}, nil
}

// ThreadRead reads one thread in full (thread_read).
func (c *Client) ThreadRead(ctx context.Context, id string) (map[string]any, error) {
	t, err := c.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	var subject any
	if t.SubjectID != nil {
		var s model.InboxSubject
		ok, err := c.getDoc(ctx, model.Paths.InboxSubject(c.WorkspaceID, *t.SubjectID), &s)
		if err != nil {
			return nil, err
		}
		var name any
		if ok {
			name = s.Name
		}
		subject = map[string]any{"subjectId": *t.SubjectID, "name": name}
	}
	msgs, err := listInbox[model.InboxMessage](ctx, c, "inboxMessages", "threadId", "==", id)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(msgs, func(i, j int) bool {
		a, b := msgs[i].Data.ReceivedAt.UnixMilli(), msgs[j].Data.ReceivedAt.UnixMilli()
		if a != b {
			return a < b
		}
		return msgs[i].ID < msgs[j].ID
	})
	messages := []any{}
	for _, d := range msgs {
		m := d.Data
		atts := []any{}
		for _, a := range m.Attachments {
			atts = append(atts, map[string]any{"name": a.Name, "url": a.URL})
		}
		messages = append(messages, map[string]any{
			"messageId": d.ID, "direction": m.Direction, "source": m.Source,
			"sender": map[string]any{"name": m.Sender.Name, "handle": strOrNull(m.Sender.Handle)},
			"text":   m.Text, "threadRef": m.ThreadRef, "permalink": strOrNull(m.Permalink), "replyRef": strOrNull(m.ReplyRef),
			"receivedAt": isoMs(m.ReceivedAt), "attachments": atts,
		})
	}
	ocs, err := listInbox[model.InboxOutcome](ctx, c, "inboxOutcomes", "threadId", "==", id)
	if err != nil {
		return nil, err
	}
	plans, stepOf, err := c.planRows(ctx, id)
	if err != nil {
		return nil, err
	}
	// A plan's steps are made in one batch (same createdAt): they list in the plan's order.
	sort.SliceStable(ocs, func(i, j int) bool {
		a, b := ocs[i].Data.CreatedAt.UnixMilli(), ocs[j].Data.CreatedAt.UnixMilli()
		if a != b {
			return a < b
		}
		if si, sj := stepNumber(stepOf[ocs[i].ID]), stepNumber(stepOf[ocs[j].ID]); si != sj {
			return si < sj
		}
		return ocs[i].ID < ocs[j].ID
	})
	turn := map[string]bool{}
	for _, pr := range plans {
		r := pr.(map[string]any)
		for _, st := range r["steps"].([]any) {
			sr := st.(map[string]any)
			if sr["atCursor"] == true && (r["state"] == "proposed" || r["state"] == "active") {
				turn[sr["outcomeId"].(string)] = true
			}
		}
	}
	outcomes := []any{}
	carry := false
	for _, d := range ocs {
		o := d.Data
		mine := o.Executor != nil && *o.Executor == c.UID
		carry = carry || (o.State == "approved" && mine && (o.PlanID == nil || turn[d.ID]))
		var decision, result any
		if o.Decision != nil {
			decision = map[string]any{"edited": o.Decision.Edited, "reason": strOrNull(o.Decision.Reason)}
		}
		if o.Result != nil {
			result = map[string]any{"text": strOrNull(o.Result.Text), "permalink": strOrNull(o.Result.Permalink), "itemId": strOrNull(o.Result.ItemID), "error": strOrNull(o.Result.Error)}
		}
		checks := o.Checks
		if checks == nil {
			checks = []string{}
		}
		var revise any
		if o.State == "revising" && o.Revise != nil {
			chips := o.Revise.Chips
			if chips == nil {
				chips = []string{}
			}
			revise = map[string]any{"instruction": strOrNull(o.Revise.Instruction), "chips": chips}
		}
		row := map[string]any{
			"outcomeId": d.ID, "type": o.Type, "state": o.State, "fields": fieldsOf(o.Fields), "note": o.Note,
			"confidence": strOrNull(o.Confidence), "checks": checks,
			"executor": strOrNull(o.Executor), "executorIsMe": mine, "decision": decision, "result": result,
		}
		if o.PlanID != nil {
			row["planId"], row["step"] = *o.PlanID, stepOf[d.ID]
		}
		if o.CheckedAt != nil {
			row["checkedAt"] = isoPtr(o.CheckedAt)
		}
		// Ask for changes: how many versions, and what the person asks while revising.
		if len(o.Versions) > 0 || revise != nil {
			row["versions"] = max(len(o.Versions), 1)
			row["revise"] = revise
		}
		outcomes = append(outcomes, row)
	}
	evs, err := listInbox[model.InboxEvent](ctx, c, "inboxEvents", "threadId", "==", id)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(evs, func(i, j int) bool {
		a, b := evs[i].Data.At.UnixMilli(), evs[j].Data.At.UnixMilli()
		if a != b {
			return a < b
		}
		return evs[i].ID < evs[j].ID
	})
	timeline := []any{}
	for _, d := range evs {
		e := d.Data
		if !contains([]string{"thread.note", "thread.asked", "thread.answered", "outcome.rejected"}, e.Type) {
			continue
		}
		var text any
		for _, k := range []string{"text", "answer", "reason"} {
			if v, ok := e.Data[k]; ok && v != nil {
				text = v
				break
			}
		}
		timeline = append(timeline, map[string]any{"type": e.Type, "by": e.Actor.Type, "at": isoMs(e.At), "text": text})
	}
	var waiting, question any
	if t.Waiting != nil {
		waiting = map[string]any{"on": t.Waiting.On, "until": isoPtr(t.Waiting.Until)}
	}
	if t.Question != nil {
		opts := t.Question.Options
		if opts == nil {
			opts = []string{}
		}
		question = map[string]any{"text": t.Question.Text, "options": opts, "answer": strOrNull(t.Question.Answer)}
	}
	next := InboxNext[t.State]
	if carry {
		next = CarryOut
	}
	out := map[string]any{
		"threadId": id, "member": t.MemberUID, "state": t.State, "waiting": waiting, "question": question,
		"title": t.Title, "subject": subject, "fetchedBy": t.FetchedBy, "fetchedByMe": t.FetchedBy == c.UID, "urgent": t.Urgent, "due": isoPtr(t.Due),
		"messages": messages, "outcomes": outcomes, "plans": plans, "timeline": timeline, "next": next,
	}
	// Re-check (item bmNoIvvqKCdAorLSShE9): the person's last request, and what to do while it waits.
	if r := t.Recheck; r != nil {
		out["recheck"] = map[string]any{"state": r.State, "requestedAt": isoPtr(r.RequestedAt), "result": strOrNull(r.Result), "note": strOrNull(r.Note), "at": isoPtr(r.At)}
		if r.State == "pending" && t.FetchedBy == c.UID && !carry {
			out["next"] = RecheckNext
		}
	}
	// Ask the agent (item w6O2KOw4ys70TQv9I1xD): the person's requests, oldest first.
	if len(t.Instructions) > 0 {
		ids := make([]string, 0, len(t.Instructions))
		for k := range t.Instructions {
			ids = append(ids, k)
		}
		sort.Slice(ids, func(i, j int) bool {
			a, b := t.Instructions[ids[i]].At, t.Instructions[ids[j]].At
			if a != nil && b != nil && !a.Equal(*b) {
				return a.Before(*b)
			}
			return ids[i] < ids[j]
		})
		list := make([]map[string]any, 0, len(ids))
		pending := ""
		for _, k := range ids {
			in := t.Instructions[k]
			row := map[string]any{"instructionId": k, "text": strOrNull(in.Text), "chip": strOrNull(in.Chip), "at": isoPtr(in.At), "state": in.State}
			if in.Answer != nil {
				row["answer"] = map[string]any{"kind": in.Answer.Kind, "refId": strOrNull(in.Answer.RefID), "note": strOrNull(in.Answer.Note)}
			}
			if in.State == "pending" {
				pending = k
			}
			list = append(list, row)
		}
		out["instructions"] = list
		if pending != "" && t.FetchedBy == c.UID && !carry {
			out["next"] = fmt.Sprintf(InstructNext, pending)
		}
	}
	if len(t.SuggestedChips) > 0 {
		out["suggestedChips"] = t.SuggestedChips
	}
	// Summaries (item OE8FmrTaIxFVGcaeGG3N): the current one (its version is the baseVersion for
	// thread_summary), and whether it is fresh.
	doc, err := c.summaryDoc(ctx, id)
	if err != nil {
		return nil, err
	}
	state, base := summaryState(t), 0
	if doc == nil {
		out["summary"] = nil
		state = "none"
	} else {
		s := summaryOut(doc).(map[string]any)
		delete(s, "memberUid")
		delete(s, "threadId")
		s["state"] = state
		out["summary"] = s
		if v, ok := doc["version"].(int64); ok {
			base = int(v)
		}
	}
	if t.FetchedBy == c.UID && state != "fresh" {
		word := "missing"
		if state == "stale" {
			word = "out of date (the thread changed since)"
		}
		out["summaryNext"] = fmt.Sprintf(SummaryNext, word, base)
	}
	return out, nil
}

// InstructNext is thread_read's next while a request of the person's waits for this agent.
const InstructNext = "The person asked you something on this thread (instructions, %s): do it within the rules (investigate, then a note, a question, a proposal or a plan; nothing outward without their approval) and answer with thread_answer_instruction."

// labelList is the workspace's label list: the admin's document, else the defaults.
func (c *Client) labelList(ctx context.Context) ([]string, error) {
	var l model.InboxLabels
	ok, err := c.getDoc(ctx, model.Paths.InboxLabels(c.WorkspaceID), &l)
	if err != nil {
		return nil, err
	}
	if !ok || len(l.Labels) == 0 {
		return append([]string(nil), actions.DefaultInboxLabels...), nil
	}
	return l.Labels, nil
}

// SubjectList lists a person's subjects (subject_list).
func (c *Client) SubjectList(ctx context.Context, given string) (map[string]any, error) {
	member, err := c.inboxMember(ctx, given)
	if err != nil {
		return nil, err
	}
	subs, err := listInbox[model.InboxSubject](ctx, c, "inboxSubjects", "memberUid", "==", member)
	if err != nil {
		return nil, err
	}
	vs := make([]any, len(threadOpen))
	for i, s := range threadOpen {
		vs[i] = s
	}
	all, err := listInbox[model.InboxThread](ctx, c, "inboxThreads", "state", "in", vs)
	if err != nil {
		return nil, err
	}
	var open []docOf[model.InboxThread]
	unfiled := 0
	for _, t := range all {
		if t.Data.MemberUID == member {
			open = append(open, t)
			if t.Data.SubjectID == nil {
				unfiled++
			}
		}
	}
	count := func(sid string, states []string) int {
		n := 0
		for _, t := range open {
			if t.Data.SubjectID != nil && *t.Data.SubjectID == sid && contains(states, t.Data.State) {
				n++
			}
		}
		return n
	}
	type row struct {
		id, name     string
		area         *string
		label        *string
		suggested    bool
		forYou, open int
	}
	rows := make([]row, 0, len(subs))
	for _, s := range subs {
		rows = append(rows, row{s.ID, s.Data.Name, s.Data.Area, s.Data.Label, s.Data.Label != nil && s.Data.LabelSuggested, count(s.ID, []string{"needsYou", "yourCall"}), count(s.ID, threadOpen)})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.forYou != b.forYou {
			return a.forYou > b.forYou
		}
		if a.open != b.open {
			return a.open > b.open
		}
		if a.name != b.name {
			return a.name < b.name
		}
		return a.id < b.id
	})
	out := make([]any, len(rows))
	for i, r := range rows {
		out[i] = map[string]any{"subjectId": r.id, "name": r.name, "area": strOrNull(r.area), "label": strOrNull(r.label), "labelSuggested": r.suggested, "forYou": r.forYou, "open": r.open}
	}
	labels, err := c.labelList(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{"member": member, "subjects": out, "unfiled": unfiled, "labels": labels}, nil
}

// SubjectAssign files a thread under an existing or a new subject (subject_assign).
func (c *Client) SubjectAssign(ctx context.Context, id string, subjectID, name, area, label *string) (map[string]any, error) {
	if (subjectID == nil) == (name == nil) {
		return nil, Errf("Give either subjectId (an existing subject) or name (a new one).")
	}
	t, err := c.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	target := subjectID
	var existing *actions.ExistingLabel
	if target != nil {
		var s model.InboxSubject
		ok, err := c.getDoc(ctx, model.Paths.InboxSubject(c.WorkspaceID, *target), &s)
		if err != nil {
			return nil, err
		}
		if !ok || s.MemberUID != t.MemberUID {
			return nil, Errf(fmt.Sprintf("Subject %s not found among this person's subjects (see subject_list).", *target))
		}
		existing = &actions.ExistingLabel{Label: s.Label, LabelBy: s.LabelBy}
	} else {
		want := strings.ToLower(actions.Collapse(*name))
		subs, err := listInbox[model.InboxSubject](ctx, c, "inboxSubjects", "memberUid", "==", t.MemberUID)
		if err != nil {
			return nil, err
		}
		sort.Slice(subs, func(i, j int) bool { return subs[i].ID < subs[j].ID })
		for _, s := range subs {
			if strings.ToLower(s.Data.Name) == want {
				target = &s.ID
				existing = &actions.ExistingLabel{Label: s.Data.Label, LabelBy: s.Data.LabelBy}
				break
			}
		}
	}
	in := actions.AssignSubjectInput{ThreadID: id, Thread: actions.ThreadStateFrom(t), Area: area, Existing: existing}
	if label != nil {
		labels, err := c.labelList(ctx)
		if err != nil {
			return nil, err
		}
		in.Label, in.Labels = label, labels
	}
	if target != nil {
		in.SubjectID = target
	} else {
		in.NewName = name
	}
	res, err := actions.AssignSubject(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, res.Plan); err != nil {
		return nil, err
	}
	subjectName := ""
	if res.Created {
		subjectName = actions.Collapse(*name)
	} else {
		var s model.InboxSubject
		if ok, _ := c.getDoc(ctx, model.Paths.InboxSubject(c.WorkspaceID, res.SubjectID), &s); ok {
			subjectName = s.Name
		}
	}
	note := fmt.Sprintf("Filed under \"%s\".", subjectName)
	if res.Created {
		note = fmt.Sprintf("Filed under a new subject \"%s\".", subjectName)
	}
	out := map[string]any{"threadId": id, "subjectId": res.SubjectID, "name": subjectName, "created": res.Created, "note": note}
	if label != nil {
		out["labelApplied"] = res.LabelApplied
		if !res.LabelApplied {
			out["labelNote"] = "The subject already has a label, so yours was not applied."
		}
	}
	return out, nil
}

func (c *Client) threadAction(ctx context.Context, id string, build func(actions.ThreadState) (plan.Plan, error)) error {
	t, err := c.thread(ctx, id)
	if err != nil {
		return err
	}
	p, err := build(actions.ThreadStateFrom(t))
	if err != nil {
		return wrap(err)
	}
	return c.inboxWrite(ctx, p)
}

// InboxNote adds an investigation note (inbox_note).
func (c *Client) InboxNote(ctx context.Context, id, text string) (map[string]any, error) {
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.AddThreadNote(c.actx(), actions.ThreadTextInput{ThreadID: id, Thread: t, Text: text})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"threadId": id, "note": "Noted on the timeline."}, nil
}

// InboxAsk asks the person (inbox_ask), with up to 4 answer chips.
func (c *Client) InboxAsk(ctx context.Context, id, question string, options []string) (map[string]any, error) {
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.AskMember(c.actx(), actions.AskInput{ThreadID: id, Thread: t, Question: question, Options: options})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"threadId": id, "state": "needsYou", "note": "Asked. The thread waits in Needs you; the answer shows in thread_read."}, nil
}

// ProposeExtra is outcome_propose's optional confidence, checks and revises.
type ProposeExtra struct {
	Confidence *string
	Checks     []string
	// Revises is the outcome the person asked changes for: the proposal becomes its next version.
	Revises *string
}

// OutcomePropose proposes an outcome (outcome_propose), or with Revises the next version of one.
func (c *Client) OutcomePropose(ctx context.Context, id, typ string, fields map[string]any, note *string, x ProposeExtra) (map[string]any, error) {
	if x.Revises != nil && *x.Revises != "" {
		return c.outcomeRevise(ctx, id, typ, fields, note, x)
	}
	t, err := c.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	r, err := actions.ProposeOutcome(c.actx(), actions.ProposeInput{ThreadID: id, Thread: actions.ThreadStateFrom(t), Type: typ, Fields: fields, Note: note, Confidence: x.Confidence, Checks: x.Checks})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	return map[string]any{"outcomeId": r.OutcomeID, "threadId": id, "type": typ, "state": "proposed",
		"note": "Proposed. It waits for the person to approve, edit or reject it; nothing is carried out before."}, nil
}

// outcomeRevise writes the next version of an outcome the person asked changes for.
func (c *Client) outcomeRevise(ctx context.Context, id, typ string, fields map[string]any, note *string, x ProposeExtra) (map[string]any, error) {
	oid := *x.Revises
	o, err := c.outcome(ctx, oid)
	if err != nil {
		return nil, err
	}
	t, err := c.thread(ctx, o.ThreadID)
	if err != nil {
		return nil, err
	}
	in := actions.ReviseInput{OutcomeID: oid, Outcome: actions.OutcomeStateFrom(o), Thread: actions.ThreadStateFrom(t),
		Fields: fields, Note: note, Confidence: x.Confidence, Checks: x.Checks}
	if id != "" {
		in.ThreadID = &id
	}
	if typ != "" {
		in.Type = &typ
	}
	if o.PlanID != nil {
		// A re-check may revise an approved step that has not run: the action needs its plan.
		pl, _, err := c.planInput(ctx, *o.PlanID)
		if err != nil {
			return nil, err
		}
		in.Plan = &pl
	}
	r, err := actions.ReviseOutcome(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	return map[string]any{"outcomeId": oid, "threadId": o.ThreadID, "type": o.Type, "version": r.Version, "state": "proposed",
		"note": fmt.Sprintf("Version %d proposed in place of the earlier one. The person sees what changed and approves the version they want; nothing is carried out before.", r.Version)}, nil
}

// OutcomeResult is outcome_done's result.
type OutcomeResult struct{ Text, Permalink, ItemID, Error *string }

// OutcomeDone reports an approved outcome (outcome_done).
func (c *Client) OutcomeDone(ctx context.Context, id, status string, res OutcomeResult) (map[string]any, error) {
	o, err := c.outcome(ctx, id)
	if err != nil {
		return nil, err
	}
	t, err := c.thread(ctx, o.ThreadID)
	if err != nil {
		return nil, err
	}
	if status == "started" && o.PlanID != nil && res.ItemID != nil && strings.TrimSpace(*res.ItemID) != "" {
		// Build it (item qwFAWxZM5xkcE7PPjAzi): the item must exist; its link shows on the step and
		// tells the channel where to watch for Done.
		l, err := c.load(ctx, strings.TrimSpace(*res.ItemID), "")
		if err != nil {
			return nil, err
		}
		if res.Permalink == nil || strings.TrimSpace(*res.Permalink) == "" {
			link := ItemLink(c.WebURL, l.ProjectID, l.ItemID)
			res.Permalink = &link
		}
	}
	in := actions.FinishInput{OutcomeID: id, Outcome: actions.OutcomeStateFrom(o), Thread: actions.ThreadStateFrom(t), Status: status}
	if o.PlanID != nil {
		pl, _, err := c.planInput(ctx, *o.PlanID)
		if err != nil {
			return nil, err
		}
		in.Plan = &pl
	}
	in.Result = &struct {
		Text      *string `json:"text"`
		Permalink *string `json:"permalink"`
		ItemID    *string `json:"itemId"`
		Error     *string `json:"error"`
	}{res.Text, res.Permalink, res.ItemID, res.Error}
	p, err := actions.FinishOutcome(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		return nil, err
	}
	after, err := c.thread(ctx, o.ThreadID)
	if err != nil {
		return nil, err
	}
	note := "Reported as done."
	state := status
	switch {
	case status == "started":
		state, note = "running", "Started: the step waits until the item is Done; then report it done (outcome_done status done)."
	case o.PlanID != nil && status == "done" && in.Plan != nil && in.Plan.Plan.Cursor+1 >= len(in.Plan.Plan.Steps):
		note = "Reported as done: that was the plan's last step, the plan is done."
	case o.PlanID != nil && status == "done":
		note = "Reported as done: the plan moves to its next step (you get its carry_out once it is approved and its turn)."
	case o.PlanID != nil:
		note = "Reported as failed: the plan is blocked until the person retries, skips or stops it."
	case status != "done":
		note = "Reported as failed: the thread is back to investigating."
	}
	out := map[string]any{"outcomeId": id, "state": state, "threadId": o.ThreadID, "threadState": after.State, "note": note}
	if o.PlanID != nil {
		out["planId"] = *o.PlanID
	}
	return out, nil
}

// ThreadWake wakes a snoozed thread whose date has come (thread_wake).
func (c *Client) ThreadWake(ctx context.Context, id string) (map[string]any, error) {
	pl, err := c.livePlan(ctx, id)
	if err != nil {
		return nil, err
	}
	if pl != nil {
		// Only a plan waiting at a wait-until step moves on; any other plan is not this snooze's.
		if pl.Plan.Cursor >= len(pl.Plan.Steps) || pl.Outcomes[pl.Plan.Steps[pl.Plan.Cursor]].Type != "snooze" {
			pl = nil
		}
	}
	err = c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.WakeThread(c.actx(), actions.WakeInput{ThreadID: id, Thread: t, NowMs: time.Now().UnixMilli(), Plan: pl})
	})
	if err != nil {
		return nil, err
	}
	if pl != nil {
		after, err := c.thread(ctx, id)
		if err != nil {
			return nil, err
		}
		return map[string]any{"threadId": id, "state": after.State, "planId": pl.PlanID, "note": "The wait is over: the plan moves to its next step."}, nil
	}
	return map[string]any{"threadId": id, "state": "investigating", "note": "Awake: investigate it again."}, nil
}

// SearchFilters are subject_search's filters.
type SearchFilters struct {
	Member       string
	WaitingForMe *bool
	ActiveDays   *float64
	HasOpen      *bool
	Limit        *float64
}

// SubjectSearch is subject_search: a person's subjects by name, people, channel and thread text.
func (c *Client) SubjectSearch(ctx context.Context, q string, f SearchFilters) (map[string]any, error) {
	member, err := c.inboxMember(ctx, f.Member)
	if err != nil {
		return nil, err
	}
	subs, err := listInbox[model.InboxSubject](ctx, c, "inboxSubjects", "memberUid", "==", member)
	if err != nil {
		return nil, err
	}
	threads, err := listInbox[model.InboxThread](ctx, c, "inboxThreads", "memberUid", "==", member)
	if err != nil {
		return nil, err
	}
	msgs, err := listInbox[model.InboxMessage](ctx, c, "inboxMessages", "memberUid", "==", member)
	if err != nil {
		return nil, err
	}
	rels, err := listInbox[model.InboxRelation](ctx, c, "inboxRelations", "memberUid", "==", member)
	if err != nil {
		return nil, err
	}
	in := actions.SearchInput{Query: q, NowMs: time.Now().UnixMilli(),
		Filters:   actions.SearchFilters{WaitingForMe: f.WaitingForMe, ActiveDays: f.ActiveDays, HasOpen: f.HasOpen, Limit: f.Limit},
		Subjects:  []actions.SearchSubject{},
		Threads:   []actions.SearchThread{},
		Messages:  []actions.SearchMessage{},
		Relations: []actions.SearchRelation{}}
	for _, s := range subs {
		in.Subjects = append(in.Subjects, actions.SearchSubject{ID: s.ID, Name: s.Data.Name})
	}
	for _, t := range threads {
		in.Threads = append(in.Threads, actions.SearchThread{ID: t.ID, SubjectID: t.Data.SubjectID, State: t.Data.State, Title: t.Data.Title, LastMessageAtMs: t.Data.LastMessageAt.UnixMilli()})
	}
	for _, m := range msgs {
		in.Messages = append(in.Messages, actions.SearchMessage{ThreadID: m.Data.ThreadID, Direction: m.Data.Direction, Source: m.Data.Source, SenderName: m.Data.Sender.Name, SenderHandle: m.Data.Sender.Handle, Text: m.Data.Text})
	}
	for _, r := range rels {
		in.Relations = append(in.Relations, actions.SearchRelation{A: r.Data.A, B: r.Data.B, State: r.Data.State, Note: r.Data.Note})
	}
	r := actions.SearchSubjects(in)
	note := "No subject matches. Try fewer or other words, or make a new subject with subject_assign (name)."
	if r.Total > 0 {
		note = "Best matches first. File a thread under the subject it belongs to (subject_assign with subjectId); propose links between related subjects with subject_relate."
	}
	return map[string]any{"member": member, "query": q, "total": r.Total, "subjects": r.Subjects, "note": note}, nil
}

// SubjectRelate is subject_relate: proposes a link between two subjects; the person OKs it.
func (c *Client) SubjectRelate(ctx context.Context, a, b string, note *string) (map[string]any, error) {
	var sa, sb model.InboxSubject
	okA, err := c.getDoc(ctx, model.Paths.InboxSubject(c.WorkspaceID, a), &sa)
	if err != nil {
		return nil, err
	}
	okB, err := c.getDoc(ctx, model.Paths.InboxSubject(c.WorkspaceID, b), &sb)
	if err != nil {
		return nil, err
	}
	if !okA {
		return nil, Errf(fmt.Sprintf("Subject %s not found (see subject_search).", a))
	}
	if !okB {
		return nil, Errf(fmt.Sprintf("Subject %s not found (see subject_search).", b))
	}
	var ex model.InboxRelation
	found, err := c.getDoc(ctx, model.Paths.InboxRelation(c.WorkspaceID, actions.RelationID(a, b)), &ex)
	if err != nil {
		return nil, err
	}
	in := actions.ProposeRelationInput{A: a, B: b, SubjectA: actions.SubjectOf{MemberUID: sa.MemberUID}, SubjectB: actions.SubjectOf{MemberUID: sb.MemberUID}, Note: note}
	if found {
		in.Existing = &actions.RelationState{MemberUID: ex.MemberUID, A: ex.A, B: ex.B, Note: ex.Note, State: ex.State}
	}
	res, err := actions.ProposeRelation(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, res.Plan); err != nil {
		return nil, err
	}
	return map[string]any{"relationId": res.RelationID, "a": res.A, "b": res.B, "state": "proposed",
		"note": "Proposed. The person OKs or turns it down; until then it shows as a suggestion."}, nil
}

// ThreadDue sets or clears a thread's deadline (thread_due; due nil clears it).
func (c *Client) ThreadDue(ctx context.Context, id string, due, reason *string) (map[string]any, error) {
	var at *string
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		p, err := actions.DueThread(c.actx(), actions.DueInput{ThreadID: id, Thread: t, Due: due, Reason: reason})
		if err == nil && due != nil {
			if s, ok := p.Ops[len(p.Ops)-1].Data["data"].(map[string]any)["due"].(string); ok {
				at = &s
			}
		}
		return p, err
	})
	if err != nil {
		return nil, err
	}
	note := "No due date any more."
	if due != nil {
		note = "Due date set: the person sees it ranked by it in Today."
	}
	return map[string]any{"threadId": id, "due": strOrNull(at), "note": note}, nil
}

// RecheckNext is thread_read's next while the person's re-check request waits for this agent.
const RecheckNext = "The person asked you to check this thread again: re-read the messages (any new ones especially), calendar_free and the context, then for each open proposal and each plan step that has not run either keep it, or write its next version with outcome_propose revises=<outcomeId> (only what changed), or ask with inbox_ask; finish with thread_recheck_done (still_good, revised or asked)."

// ThreadRecheckDone answers the person's re-check request (thread_recheck_done).
func (c *Client) ThreadRecheckDone(ctx context.Context, id, result string, note *string) (map[string]any, error) {
	t, err := c.thread(ctx, id)
	if err != nil {
		return nil, err
	}
	ocs, err := listInbox[model.InboxOutcome](ctx, c, "inboxOutcomes", "threadId", "==", id)
	if err != nil {
		return nil, err
	}
	in := actions.RecheckDoneInput{ThreadID: id, Thread: actions.ThreadStateFrom(t), Result: result, Note: note,
		Outcomes: map[string]actions.OutcomeState{}, Plans: map[string]actions.PlanState{}}
	for _, d := range ocs {
		in.Outcomes[d.ID] = actions.OutcomeStateFrom(d.Data)
	}
	ps, err := c.threadPlans(ctx, id)
	if err != nil {
		return nil, err
	}
	for _, p := range ps {
		in.Plans[p.ID] = actions.PlanStateFrom(p.Data)
	}
	r, err := actions.RecheckDone(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	notes := map[string]string{
		"still_good": "Answered: the person sees \"Checked again\" on the open proposals.",
		"revised":    "Answered: the person sees the new versions and what changed.",
		"asked":      "Answered: the person sees your question.",
	}
	return map[string]any{"threadId": id, "result": result, "checked": r.Checked, "note": notes[result]}, nil
}

// ThreadAnswerInstruction answers the person's request on a thread (thread_answer_instruction).
// An outcome or plan answer must name one of this thread's.
func (c *Client) ThreadAnswerInstruction(ctx context.Context, id, instructionID, kind string, refID, note *string) (map[string]any, error) {
	if refID != nil && strings.TrimSpace(*refID) != "" && (kind == "outcome" || kind == "plan") {
		ref := strings.TrimSpace(*refID)
		if kind == "outcome" {
			o, err := c.outcome(ctx, ref)
			if err != nil {
				return nil, err
			}
			if o.ThreadID != id {
				return nil, Errf(fmt.Sprintf("Outcome %s is on thread %s, not %s.", ref, o.ThreadID, id))
			}
		} else {
			_, p, err := c.planInput(ctx, ref)
			if err != nil {
				return nil, err
			}
			if p.ThreadID != id {
				return nil, Errf(fmt.Sprintf("Plan %s is on thread %s, not %s.", ref, p.ThreadID, id))
			}
		}
	}
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.AnswerInstruction(c.actx(), actions.AnswerInstructionInput{ThreadID: id, Thread: t, InstructionID: instructionID, Kind: kind, RefID: refID, Note: note})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"threadId": id, "instructionId": instructionID, "kind": kind, "note": "Answered: the person sees your answer under their request."}, nil
}

// ThreadSuggestChips sets this agent's chips for a thread (thread_suggest_chips).
func (c *Client) ThreadSuggestChips(ctx context.Context, id string, chips []string) (map[string]any, error) {
	if chips == nil {
		chips = []string{}
	}
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.SuggestChips(c.actx(), actions.SuggestChipsInput{ThreadID: id, Thread: t, Chips: chips})
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"threadId": id, "chips": chips, "note": "Set: the person sees up to 3 chips, yours first."}, nil
}

// ThreadFlag marks a thread urgent or not (thread_flag).
func (c *Client) ThreadFlag(ctx context.Context, id string, urgent bool, reason *string) (map[string]any, error) {
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.FlagThread(c.actx(), actions.FlagInput{ThreadID: id, Thread: t, Urgent: urgent, Reason: reason})
	})
	if err != nil {
		return nil, err
	}
	note := "No longer urgent."
	if urgent {
		note = "Marked urgent: the person is pinged at once, whatever their quiet hours."
	}
	return map[string]any{"threadId": id, "urgent": urgent, "note": note}, nil
}

// stepNumber is 3 for "3 of 5" (0 for a single outcome).
func stepNumber(step string) int {
	n := 0
	fmt.Sscanf(step, "%d of", &n)
	return n
}

// ItemLink is an item's page on the Hivenod site: <site>/p/<project>?item=<item>.
func ItemLink(site, projectID, itemID string) string {
	if site == "" {
		site = "https://hivenod.com"
	}
	return site + "/p/" + url.PathEscape(projectID) + "?item=" + url.QueryEscape(itemID)
}

var itemLinkRE = regexp.MustCompile(`/p/([^/?#]+)\?item=([^&#]+)`)

// ItemLinkParts reads the project and item ids back from ItemLink ("" when it is not one).
func ItemLinkParts(link string) (projectID, itemID string) {
	m := itemLinkRE.FindStringSubmatch(link)
	if m == nil {
		return "", ""
	}
	p, err1 := url.PathUnescape(m[1])
	i, err2 := url.QueryUnescape(m[2])
	if err1 != nil || err2 != nil {
		return "", ""
	}
	return p, i
}
