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
	for _, o := range outcomes {
		if o.Data.Executor != nil && *o.Data.Executor == c.UID {
			toCarry = append(toCarry, map[string]any{"outcomeId": o.ID, "threadId": o.Data.ThreadID, "member": o.Data.MemberUID, "type": o.Data.Type, "fields": fieldsOf(o.Data.Fields)})
		}
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
	sort.SliceStable(ocs, func(i, j int) bool {
		a, b := ocs[i].Data.CreatedAt.UnixMilli(), ocs[j].Data.CreatedAt.UnixMilli()
		if a != b {
			return a < b
		}
		return ocs[i].ID < ocs[j].ID
	})
	outcomes := []any{}
	carry := false
	for _, d := range ocs {
		o := d.Data
		mine := o.Executor != nil && *o.Executor == c.UID
		carry = carry || (o.State == "approved" && mine)
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
	return map[string]any{
		"threadId": id, "member": t.MemberUID, "state": t.State, "waiting": waiting, "question": question,
		"title": t.Title, "subject": subject, "fetchedBy": t.FetchedBy, "fetchedByMe": t.FetchedBy == c.UID, "urgent": t.Urgent, "due": isoPtr(t.Due),
		"messages": messages, "outcomes": outcomes, "timeline": timeline, "next": next,
	}, nil
}

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
	in := actions.FinishInput{OutcomeID: id, Outcome: actions.OutcomeStateFrom(o), Thread: actions.ThreadStateFrom(t), Status: status}
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
	if status != "done" {
		note = "Reported as failed: the thread is back to investigating."
	}
	return map[string]any{"outcomeId": id, "state": status, "threadId": o.ThreadID, "threadState": after.State, "note": note}, nil
}

// ThreadWake wakes a snoozed thread whose date has come (thread_wake).
func (c *Client) ThreadWake(ctx context.Context, id string) (map[string]any, error) {
	err := c.threadAction(ctx, id, func(t actions.ThreadState) (plan.Plan, error) {
		return actions.WakeThread(c.actx(), actions.WakeInput{ThreadID: id, Thread: t, NowMs: time.Now().UnixMilli()})
	})
	if err != nil {
		return nil, err
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
