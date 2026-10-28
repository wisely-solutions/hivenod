package hive

// Inbox tools (item 4PEHrOW5IfXBQWgOK9wo): the Go side of packages/agent/src/inbox.ts. The
// results must equal the TypeScript ones (packages/agent/test/go.integration.test.ts).
//
// Nothing here sends anything: an agent posts a reply in the source channel only for a request
// its person pressed Send on (status "sending", approved.reply), and then calls inbox_sent.

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// InboxDenied is the refusal when the rules turn an inbox write down.
const InboxDenied = "Hivenod refused this inbox change (permission denied): the request may have changed since it was read (read it again with inbox_read), or this agent was revoked."

const inboxReadDenied = "Hivenod refused to read the inbox (permission denied): this agent may have been revoked."

var inboxActive = []string{"new", "drafting", "yourCall", "sending"}

// InboxNext is what the agent does next, by status (NEXT in inbox.ts).
func InboxNext(status string, byMe bool) string {
	switch status {
	case "new":
		return "File it under a subject: subject_list, then subject_assign."
	case "drafting":
		return "Draft the reply in the person's voice with inbox_draft (it waits for their Send; nothing is sent before)."
	case "yourCall":
		return "Waiting for the person to Send, Edit or Ignore it in Hivenod. You may revise the draft with inbox_draft."
	case "sending":
		if byMe {
			return "The person pressed Send: post approved.reply exactly as written in the source thread, as them, then call inbox_sent."
		}
		return "The person pressed Send; the agent that brought it in posts it."
	case "done":
		return "Done: the reply was sent."
	case "ignored":
		return "The person ignored it: do nothing."
	}
	return ""
}

func isoMs(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

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

// inboxMember is the member a request is for: the given uid, else whoever connected this agent.
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

type inboxDoc struct {
	ID   string
	Data model.InboxRequest
}

func (c *Client) inboxRequest(ctx context.Context, id string) (*model.InboxRequest, error) {
	snap, err := c.DB.Doc(model.Paths.InboxRequest(c.WorkspaceID, id)).Get(ctx)
	if err != nil && !NotFound(err) {
		return nil, c.inboxRead(err)
	}
	if err != nil || !snap.Exists() {
		return nil, nil
	}
	var r model.InboxRequest
	if err := snap.DataTo(&r); err != nil {
		return nil, err
	}
	return &r, nil
}

func (c *Client) mustRequest(ctx context.Context, id string) (model.InboxRequest, error) {
	r, err := c.inboxRequest(ctx, id)
	if err != nil {
		return model.InboxRequest{}, err
	}
	if r == nil {
		return model.InboxRequest{}, Errf(fmt.Sprintf("Inbox request %s not found.", id))
	}
	return *r, nil
}

func (c *Client) inboxSubject(ctx context.Context, id string) (*model.InboxSubject, error) {
	snap, err := c.DB.Doc(model.Paths.InboxSubject(c.WorkspaceID, id)).Get(ctx)
	if err != nil && !NotFound(err) {
		return nil, c.inboxRead(err)
	}
	if err != nil || !snap.Exists() {
		return nil, nil
	}
	var s model.InboxSubject
	if err := snap.DataTo(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

type subjectDoc struct {
	ID   string
	Data model.InboxSubject
}

func (c *Client) subjectsOf(ctx context.Context, member string) ([]subjectDoc, error) {
	docs, err := c.DB.Collection(model.Paths.InboxSubjects(c.WorkspaceID)).Where("memberUid", "==", member).Documents(ctx).GetAll()
	if err != nil {
		return nil, c.inboxRead(err)
	}
	out := make([]subjectDoc, 0, len(docs))
	for _, d := range docs {
		var s model.InboxSubject
		if err := d.DataTo(&s); err != nil {
			return nil, err
		}
		out = append(out, subjectDoc{d.Ref.ID, s})
	}
	return out, nil
}

func (c *Client) inboxQuery(ctx context.Context, q firestore.Query) ([]inboxDoc, error) {
	docs, err := q.Documents(ctx).GetAll()
	if err != nil {
		return nil, c.inboxRead(err)
	}
	out := make([]inboxDoc, 0, len(docs))
	for _, d := range docs {
		var r model.InboxRequest
		if err := d.DataTo(&r); err != nil {
			return nil, err
		}
		out = append(out, inboxDoc{d.Ref.ID, r})
	}
	return out, nil
}

func (c *Client) activeRequests(ctx context.Context) ([]inboxDoc, error) {
	vs := make([]any, len(inboxActive))
	for i, s := range inboxActive {
		vs[i] = s
	}
	return c.inboxQuery(ctx, c.DB.Collection(model.Paths.InboxRequests(c.WorkspaceID)).Where("status", "in", vs))
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

// InboxAdd brings a request into its person's Inbox (inbox_add).
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
	rid := actions.InboxRequestID(actions.InboxRequestKey(in.Source, in.ThreadRef, messageID))
	dup := func() (map[string]any, error) {
		r, err := c.inboxRequest(ctx, rid)
		if err != nil || r == nil {
			return nil, err
		}
		return map[string]any{
			"requestId": rid, "duplicate": true, "status": r.Status, "member": r.MemberUID,
			"note": "Already in Inbox (same source, thread and message): nothing was added.",
		}, nil
	}
	if d, err := dup(); err != nil || d != nil {
		return d, err
	}
	ai := actions.InboxAddInput{RequestID: rid, MemberUID: member, Source: in.Source, Text: in.Text, ThreadRef: in.ThreadRef, MessageID: messageID, Permalink: in.Permalink, ReplyRef: in.ReplyRef, ReceivedAt: at, Attachments: in.Attachments}
	ai.Sender.Name, ai.Sender.Handle = in.SenderName, in.Handle
	if ai.Attachments == nil {
		ai.Attachments = []model.InboxAttachment{}
	}
	p, err := actions.AddInboxRequest(c.actx(), ai)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		if d, e := dup(); e == nil && d != nil {
			return d, nil
		}
		return nil, err
	}
	return map[string]any{
		"requestId": rid, "duplicate": false, "status": "new", "member": member,
		"note": "Brought into Inbox. File it under a subject next: subject_list, then subject_assign.",
	}, nil
}

func inboxRow(d inboxDoc) map[string]any {
	return map[string]any{
		"requestId":  d.ID,
		"member":     d.Data.MemberUID,
		"status":     d.Data.Status,
		"source":     d.Data.Source,
		"sender":     d.Data.Sender.Name,
		"receivedAt": isoMs(d.Data.ReceivedAt),
		"subjectId":  strOrNull(d.Data.SubjectID),
		"excerpt":    actions.JSSlice(d.Data.Text, 200),
	}
}

func strOrNull(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// InboxList lists the requests waiting for agents (inbox_list).
func (c *Client) InboxList(ctx context.Context) (map[string]any, error) {
	all, err := c.activeRequests(ctx)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool {
		a, b := all[i].Data.ReceivedAt.UnixMilli(), all[j].Data.ReceivedAt.UnixMilli()
		if a != b {
			return a < b
		}
		return all[i].ID < all[j].ID
	})
	toFile, toDraft, toSend := []any{}, []any{}, []any{}
	for _, d := range all {
		switch {
		case d.Data.Status == "new":
			toFile = append(toFile, inboxRow(d))
		case d.Data.Status == "drafting":
			toDraft = append(toDraft, inboxRow(d))
		case d.Data.Status == "sending" && d.Data.FetchedBy == c.UID:
			toSend = append(toSend, inboxRow(d))
		}
	}
	return map[string]any{"toFile": toFile, "toDraft": toDraft, "toSend": toSend}, nil
}

func actionsOrEmpty(a []string) []any {
	out := make([]any, len(a))
	for i, s := range a {
		out[i] = s
	}
	return out
}

// InboxRead reads one request in full (inbox_read).
func (c *Client) InboxRead(ctx context.Context, id string) (map[string]any, error) {
	r, err := c.mustRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	var subject any
	related := []any{}
	if r.SubjectID != nil {
		s, err := c.inboxSubject(ctx, *r.SubjectID)
		if err != nil {
			return nil, err
		}
		var name any
		if s != nil {
			name = s.Name
		}
		subject = map[string]any{"subjectId": *r.SubjectID, "name": name}
		docs, err := c.inboxQuery(ctx, c.DB.Collection(model.Paths.InboxRequests(c.WorkspaceID)).Where("subjectId", "==", *r.SubjectID))
		if err != nil {
			return nil, err
		}
		var others []inboxDoc
		for _, d := range docs {
			if d.ID != id {
				others = append(others, d)
			}
		}
		sort.SliceStable(others, func(i, j int) bool {
			a, b := others[i].Data.ReceivedAt.UnixMilli(), others[j].Data.ReceivedAt.UnixMilli()
			if a != b {
				return a > b
			}
			return others[i].ID < others[j].ID
		})
		if len(others) > 10 {
			others = others[:10]
		}
		for _, d := range others {
			var sent any
			if d.Data.Status == "done" && d.Data.Approved != nil {
				sent = d.Data.Approved.Reply
			}
			related = append(related, map[string]any{
				"requestId":  d.ID,
				"status":     d.Data.Status,
				"source":     d.Data.Source,
				"sender":     d.Data.Sender.Name,
				"receivedAt": isoMs(d.Data.ReceivedAt),
				"excerpt":    actions.JSSlice(d.Data.Text, 500),
				"sentReply":  sent,
			})
		}
	}
	atts := []any{}
	for _, a := range r.Attachments {
		atts = append(atts, map[string]any{"name": a.Name, "url": a.URL})
	}
	var draft, approved, sent any
	if r.Draft != nil {
		draft = map[string]any{"reply": r.Draft.Reply, "actions": actionsOrEmpty(r.Draft.Actions), "by": r.Draft.By.Type}
	}
	if r.Approved != nil {
		approved = map[string]any{"reply": r.Approved.Reply, "actions": actionsOrEmpty(r.Approved.Actions)}
	}
	if r.Sent != nil {
		sent = map[string]any{"permalink": strOrNull(r.Sent.Permalink)}
	}
	byMe := r.FetchedBy == c.UID
	return map[string]any{
		"requestId":   id,
		"member":      r.MemberUID,
		"status":      r.Status,
		"source":      r.Source,
		"sender":      map[string]any{"name": r.Sender.Name, "handle": strOrNull(r.Sender.Handle)},
		"text":        r.Text,
		"threadRef":   r.ThreadRef,
		"messageId":   r.MessageID,
		"permalink":   strOrNull(r.Permalink),
		"replyRef":    strOrNull(r.ReplyRef),
		"receivedAt":  isoMs(r.ReceivedAt),
		"attachments": atts,
		"fetchedBy":   r.FetchedBy,
		"fetchedByMe": byMe,
		"subject":     subject,
		"draft":       draft,
		"approved":    approved,
		"sent":        sent,
		"related":     related,
		"next":        InboxNext(r.Status, byMe),
	}, nil
}

// SubjectList lists a person's subjects with their waiting and open requests (subject_list).
func (c *Client) SubjectList(ctx context.Context, given string) (map[string]any, error) {
	member, err := c.inboxMember(ctx, given)
	if err != nil {
		return nil, err
	}
	subs, err := c.subjectsOf(ctx, member)
	if err != nil {
		return nil, err
	}
	all, err := c.activeRequests(ctx)
	if err != nil {
		return nil, err
	}
	var reqs []inboxDoc
	for _, r := range all {
		if r.Data.MemberUID == member {
			reqs = append(reqs, r)
		}
	}
	count := func(sid string, statuses []string) int {
		n := 0
		for _, r := range reqs {
			if r.Data.SubjectID != nil && *r.Data.SubjectID == sid && contains(statuses, r.Data.Status) {
				n++
			}
		}
		return n
	}
	type row struct {
		id, name      string
		waiting, open int
	}
	rows := make([]row, 0, len(subs))
	for _, s := range subs {
		rows = append(rows, row{s.ID, s.Data.Name, count(s.ID, []string{"yourCall"}), count(s.ID, inboxActive)})
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.waiting != b.waiting {
			return a.waiting > b.waiting
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
		out[i] = map[string]any{"subjectId": r.id, "name": r.name, "waiting": r.waiting, "open": r.open}
	}
	unfiled := 0
	for _, r := range reqs {
		if r.Data.SubjectID == nil && r.Data.Status == "new" {
			unfiled++
		}
	}
	return map[string]any{"member": member, "subjects": out, "unfiled": unfiled}, nil
}

func collapse(s string) string { return strings.Join(strings.FieldsFunc(s, actions.JSSpace), " ") }

// SubjectAssign files a request under an existing or a new subject (subject_assign).
func (c *Client) SubjectAssign(ctx context.Context, id string, subjectID, name *string) (map[string]any, error) {
	if (subjectID == nil) == (name == nil) {
		return nil, Errf("Give either subjectId (an existing subject) or name (a new one).")
	}
	r, err := c.mustRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	target := subjectID
	if target != nil {
		s, err := c.inboxSubject(ctx, *target)
		if err != nil {
			return nil, err
		}
		if s == nil || s.MemberUID != r.MemberUID {
			return nil, Errf(fmt.Sprintf("Subject %s not found among this person's subjects (see subject_list).", *target))
		}
	} else {
		want := strings.ToLower(collapse(*name))
		subs, err := c.subjectsOf(ctx, r.MemberUID)
		if err != nil {
			return nil, err
		}
		sort.Slice(subs, func(i, j int) bool { return subs[i].ID < subs[j].ID })
		for _, s := range subs {
			if strings.ToLower(s.Data.Name) == want {
				target = &s.ID
				break
			}
		}
	}
	in := actions.AssignSubjectInput{RequestID: id, Request: actions.StateOf(r)}
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
		subjectName = collapse(*name)
	} else if s, err := c.inboxSubject(ctx, res.SubjectID); err == nil && s != nil {
		subjectName = s.Name
	}
	status := r.Status
	if status == "new" {
		status = "drafting"
	}
	note := fmt.Sprintf("Filed under \"%s\". Draft the reply next: inbox_draft.", subjectName)
	if res.Created {
		note = fmt.Sprintf("Filed under a new subject \"%s\". Draft the reply next: inbox_draft.", subjectName)
	}
	return map[string]any{"requestId": id, "subjectId": res.SubjectID, "name": subjectName, "created": res.Created, "status": status, "note": note}, nil
}

// InboxDraft writes the proposed answer (inbox_draft).
func (c *Client) InboxDraft(ctx context.Context, id, reply string, acts []string) (map[string]any, error) {
	r, err := c.mustRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	if acts == nil {
		acts = []string{}
	}
	p, err := actions.DraftReply(c.actx(), actions.DraftReplyInput{RequestID: id, Request: actions.StateOf(r), Reply: reply, Actions: acts})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		return nil, err
	}
	return map[string]any{"requestId": id, "status": "yourCall", "note": "Drafted. It waits for the person to Send, Edit or Ignore it in Hivenod; nothing is sent before."}, nil
}

// InboxSent marks an approved request as posted (inbox_sent).
func (c *Client) InboxSent(ctx context.Context, id string, permalink *string) (map[string]any, error) {
	r, err := c.mustRequest(ctx, id)
	if err != nil {
		return nil, err
	}
	p, err := actions.MarkSent(c.actx(), actions.MarkSentInput{RequestID: id, Request: actions.StateOf(r), Permalink: permalink})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		return nil, err
	}
	return map[string]any{"requestId": id, "status": "done", "note": "Marked as sent. It shows as Done in the timeline."}, nil
}
