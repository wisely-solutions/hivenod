package actions

// Inbox (item 4PEHrOW5IfXBQWgOK9wo): the agent actions of packages/shared/src/inbox.ts
// (addInboxRequest, assignSubject, draftReply, markSent, inboxRequestKey). The member's actions
// (edit, Send, ignore, rename, merge, split) are web-only and stay in TypeScript.

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Inbox limits (INBOX_LIMITS).
const (
	InboxMaxText           = 50000
	InboxMaxSenderName     = 200
	InboxMaxSenderHandle   = 320
	InboxMaxThreadRef      = 1000
	InboxMaxMessageID      = 500
	InboxMaxPermalink      = 2048
	InboxMaxReplyRef       = 2000
	InboxMaxAttachments    = 20
	InboxMaxAttachmentName = 200
	InboxMaxReply          = 20000
	InboxMaxActions        = 10
	InboxMaxAction         = 500
	InboxMaxSubjectName    = 120
)

var sourceRE = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

// InboxOpen are the statuses an agent may still work; InboxWaiting wait for the member.
var (
	InboxOpen    = []string{"new", "drafting", "yourCall"}
	InboxWaiting = []string{"yourCall"}
)

func inList(s string, list []string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}

var openMsg = map[string]string{
	"sending": "This request is being sent already.",
	"done":    "This request is done: it was sent.",
	"ignored": "This request was ignored.",
}

// InboxRequestKey is inboxRequestKey: the dedup key source + thread + message.
func InboxRequestKey(source, threadRef, messageID string) string {
	return source + "\x00" + threadRef + "\x00" + messageID
}

// InboxRequestID is the request id of a dedup key: "rq" + 24 hex digits of SHA-256.
func InboxRequestID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return "rq" + hex.EncodeToString(sum[:])[:24]
}

// InboxPlan is inboxPlan: the change plus one inbox event.
func InboxPlan(ctx Ctx, typ, memberUID string, requestID, subjectID *string, data map[string]any, build func(eventID string) []plan.Op, eventID string) plan.Plan {
	if eventID == "" {
		eventID = ctx.nid()
	}
	ptr := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	event := plan.Op{
		Kind: "set",
		Path: model.Paths.InboxEvent(ctx.WorkspaceID, eventID),
		Data: map[string]any{
			"actor":     map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID, "name": ctx.Actor.Name},
			"memberUid": memberUID,
			"requestId": ptr(requestID),
			"subjectId": ptr(subjectID),
			"type":      typ,
			"data":      data,
			"at":        ServerTime(),
		},
	}
	return plan.Plan{EventID: eventID, Ops: append(build(eventID), event)}
}

func need(cond bool, msg string) error {
	if !cond {
		return fail(msg)
	}
	return nil
}

func tooLong(what string, max int) string {
	return what + " is at most " + strconv.Itoa(max) + " characters."
}

// httpLink is /^https?:\/\/\S+$/.
func httpLink(s string) bool {
	rest, ok := strings.CutPrefix(s, "https://")
	if !ok {
		if rest, ok = strings.CutPrefix(s, "http://"); !ok {
			return false
		}
	}
	return rest != "" && !strings.ContainsFunc(rest, jsSpace)
}

// trimOrNil is `s?.trim() || null`.
func trimOrNil(s *string) *string {
	if s == nil {
		return nil
	}
	t := jsTrim(*s)
	if t == "" {
		return nil
	}
	return &t
}

func strOrNil(s *string) any {
	if s == nil {
		return nil
	}
	return *s
}

// cleanSubjectName trims and collapses whitespace (/\s+/g → " ").
func cleanSubjectName(name string) (string, error) {
	n := strings.Join(strings.FieldsFunc(name, jsSpace), " ")
	if err := need(n != "", "A subject needs a name."); err != nil {
		return "", err
	}
	return n, need(jsLen(n) <= InboxMaxSubjectName, tooLong("A subject name", InboxMaxSubjectName))
}

func cleanReply(reply string) (string, error) {
	r := jsTrim(reply)
	if err := need(r != "", "The reply is empty."); err != nil {
		return "", err
	}
	return r, need(jsLen(r) <= InboxMaxReply, tooLong("A reply", InboxMaxReply))
}

func cleanActions(actions []string) ([]any, error) {
	if err := need(len(actions) <= InboxMaxActions, "At most "+strconv.Itoa(InboxMaxActions)+" actions."); err != nil {
		return nil, err
	}
	out := make([]any, 0, len(actions))
	for _, a := range actions {
		t := jsTrim(a)
		if err := need(t != "" && jsLen(t) <= InboxMaxAction, "An action is 1 to "+strconv.Itoa(InboxMaxAction)+" characters."); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

// InboxRequestState is what an action needs of a request.
type InboxRequestState struct {
	MemberUID string            `json:"memberUid"`
	SubjectID *string           `json:"subjectId"`
	Status    string            `json:"status"`
	FetchedBy string            `json:"fetchedBy"`
	Draft     *model.InboxDraft `json:"draft"`
}

// StateOf is the action state of a stored request.
func StateOf(r model.InboxRequest) InboxRequestState {
	return InboxRequestState{MemberUID: r.MemberUID, SubjectID: r.SubjectID, Status: r.Status, FetchedBy: r.FetchedBy, Draft: r.Draft}
}

// InboxAddInput is addInboxRequest's input.
type InboxAddInput struct {
	RequestID string `json:"requestId"`
	MemberUID string `json:"memberUid"`
	Source    string `json:"source"`
	Sender    struct {
		Name   string  `json:"name"`
		Handle *string `json:"handle"`
	} `json:"sender"`
	Text        string                  `json:"text"`
	ThreadRef   string                  `json:"threadRef"`
	MessageID   string                  `json:"messageId"`
	Permalink   *string                 `json:"permalink"`
	ReplyRef    *string                 `json:"replyRef"`
	ReceivedAt  time.Time               `json:"receivedAt"`
	Attachments []model.InboxAttachment `json:"attachments"`
}

// AddInboxRequest is addInboxRequest: an agent brings in a request it saw.
func AddInboxRequest(ctx Ctx, in InboxAddInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	name := jsTrim(in.Sender.Name)
	handle := trimOrNil(in.Sender.Handle)
	permalink := trimOrNil(in.Permalink)
	replyRef := trimOrNil(in.ReplyRef)
	attachments := make([]any, 0, len(in.Attachments))
	checks := []func() error{
		func() error {
			return need(sourceRE.MatchString(in.Source), "The source is one lowercase word, like teams, mail or jira.")
		},
		func() error { return need(name != "", "Say who sent it (sender name).") },
		func() error {
			return need(jsLen(name) <= InboxMaxSenderName, tooLong("The sender name", InboxMaxSenderName))
		},
		func() error {
			return need(handle == nil || jsLen(*handle) <= InboxMaxSenderHandle, tooLong("The sender handle", InboxMaxSenderHandle))
		},
		func() error { return need(jsTrim(in.Text) != "", "The request has no text.") },
		func() error { return need(jsLen(in.Text) <= InboxMaxText, tooLong("The text", InboxMaxText)) },
		func() error {
			return need(in.ThreadRef != "" && jsLen(in.ThreadRef) <= InboxMaxThreadRef, "The thread reference is 1 to "+strconv.Itoa(InboxMaxThreadRef)+" characters.")
		},
		func() error {
			return need(in.MessageID != "" && jsLen(in.MessageID) <= InboxMaxMessageID, "The message id is 1 to "+strconv.Itoa(InboxMaxMessageID)+" characters.")
		},
		func() error {
			return need(permalink == nil || (jsLen(*permalink) <= InboxMaxPermalink && httpLink(*permalink)), "The permalink is an http(s) link.")
		},
		func() error {
			return need(replyRef == nil || jsLen(*replyRef) <= InboxMaxReplyRef, tooLong("The reply reference", InboxMaxReplyRef))
		},
		func() error {
			return need(len(in.Attachments) <= InboxMaxAttachments, "At most "+strconv.Itoa(InboxMaxAttachments)+" attachments.")
		},
		func() error {
			for _, a := range in.Attachments {
				n, u := jsTrim(a.Name), jsTrim(a.URL)
				if err := need(n != "" && jsLen(n) <= InboxMaxAttachmentName && jsLen(u) <= 2048 && httpLink(u), "Each attachment is a name and an http(s) link."); err != nil {
					return err
				}
				attachments = append(attachments, map[string]any{"name": n, "url": u})
			}
			return nil
		},
	}
	for _, c := range checks {
		if err := c(); err != nil {
			return plan.Plan{}, err
		}
	}
	rid := in.RequestID
	var handleV any
	if handle != nil {
		handleV = *handle
	}
	return InboxPlan(ctx, "inbox.added", in.MemberUID, sp(rid), nil,
		map[string]any{"source": in.Source, "sender": name},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: model.Paths.InboxRequest(ctx.WorkspaceID, rid), Data: map[string]any{
				"memberUid":   in.MemberUID,
				"subjectId":   nil,
				"status":      "new",
				"source":      in.Source,
				"sender":      map[string]any{"name": name, "handle": handleV},
				"text":        in.Text,
				"threadRef":   in.ThreadRef,
				"messageId":   in.MessageID,
				"permalink":   strOrNil(permalink),
				"replyRef":    strOrNil(replyRef),
				"receivedAt":  map[string]any{"__hive": "timestamp", "ms": in.ReceivedAt.UnixMilli()},
				"attachments": attachments,
				"draft":       nil,
				"approved":    nil,
				"sent":        nil,
				"fetchedBy":   ctx.Actor.ID,
				"createdAt":   ServerTime(),
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}}}
		}, ""), nil
}

// AssignSubjectInput is assignSubject's input: SubjectID or NewName.
type AssignSubjectInput struct {
	RequestID string            `json:"requestId"`
	Request   InboxRequestState `json:"request"`
	SubjectID *string           `json:"subjectId,omitempty"`
	NewName   *string           `json:"newName,omitempty"`
}

// AssignResult is the plan plus the subject it filed under.
type AssignResult struct {
	plan.Plan
	SubjectID string `json:"subjectId"`
	Created   bool   `json:"created"`
}

// AssignSubject is assignSubject: files a request under an existing or a new subject.
func AssignSubject(ctx Ctx, in AssignSubjectInput) (AssignResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return AssignResult{}, err
	}
	r := in.Request
	if err := need(inList(r.Status, InboxOpen), openMsg[r.Status]); err != nil {
		return AssignResult{}, err
	}
	if err := need((in.SubjectID == nil) != (in.NewName == nil), "Give either an existing subject id or a new subject name."); err != nil {
		return AssignResult{}, err
	}
	created := in.NewName != nil
	var name string
	if created {
		var err error
		if name, err = cleanSubjectName(*in.NewName); err != nil {
			return AssignResult{}, err
		}
	}
	subjectID := ""
	if in.SubjectID != nil {
		subjectID = *in.SubjectID
	} else {
		subjectID = ctx.nid()
	}
	status := r.Status
	if status == "new" {
		status = "drafting"
	}
	data := map[string]any{"created": false}
	if created {
		data = map[string]any{"name": name, "created": true}
	}
	p := InboxPlan(ctx, "inbox.filed", r.MemberUID, sp(in.RequestID), sp(subjectID), data,
		func(eventID string) []plan.Op {
			var ops []plan.Op
			if created {
				ops = append(ops, plan.Op{Kind: "set", Path: model.Paths.InboxSubject(ctx.WorkspaceID, subjectID), Data: map[string]any{
					"memberUid":   r.MemberUID,
					"name":        name,
					"createdBy":   map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
					"createdAt":   ServerTime(),
					"updatedAt":   ServerTime(),
					"lastEventId": eventID,
				}})
			}
			return append(ops, plan.Op{Kind: "update", Path: model.Paths.InboxRequest(ctx.WorkspaceID, in.RequestID), Data: map[string]any{
				"subjectId": subjectID, "status": status, "updatedAt": ServerTime(), "lastEventId": eventID,
			}})
		}, "")
	return AssignResult{Plan: p, SubjectID: subjectID, Created: created}, nil
}

// DraftReplyInput is draftReply's input.
type DraftReplyInput struct {
	RequestID string            `json:"requestId"`
	Request   InboxRequestState `json:"request"`
	Reply     string            `json:"reply"`
	Actions   []string          `json:"actions"`
}

// DraftReply is draftReply: the agent's proposed answer; the request waits for its member.
func DraftReply(ctx Ctx, in DraftReplyInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	r := in.Request
	if err := need(inList(r.Status, InboxOpen), openMsg[r.Status]); err != nil {
		return plan.Plan{}, err
	}
	if err := need(r.SubjectID != nil, "File the request under a subject first (subject_assign)."); err != nil {
		return plan.Plan{}, err
	}
	reply, err := cleanReply(in.Reply)
	if err != nil {
		return plan.Plan{}, err
	}
	acts, err := cleanActions(in.Actions)
	if err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "inbox.drafted", r.MemberUID, sp(in.RequestID), r.SubjectID,
		map[string]any{"reply": reply, "actions": acts},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "update", Path: model.Paths.InboxRequest(ctx.WorkspaceID, in.RequestID), Data: map[string]any{
				"status":      "yourCall",
				"draft":       map[string]any{"reply": reply, "actions": acts, "by": map[string]any{"type": "agent", "id": ctx.Actor.ID}, "at": ServerTime()},
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}}}
		}, ""), nil
}

// MarkSentInput is markSent's input.
type MarkSentInput struct {
	RequestID string            `json:"requestId"`
	Request   InboxRequestState `json:"request"`
	Permalink *string           `json:"permalink"`
}

// MarkSent is markSent: the fetching agent posted the approved reply.
func MarkSent(ctx Ctx, in MarkSentInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	r := in.Request
	msg := "Not approved: only a request its person pressed Send on can be sent."
	if r.Status == "done" {
		msg = openMsg["done"]
	}
	if err := need(r.Status == "sending", msg); err != nil {
		return plan.Plan{}, err
	}
	if err := need(r.FetchedBy == ctx.Actor.ID, "Only the agent that brought this request in sends its reply."); err != nil {
		return plan.Plan{}, err
	}
	permalink := trimOrNil(in.Permalink)
	if err := need(permalink == nil || (jsLen(*permalink) <= InboxMaxPermalink && httpLink(*permalink)), "The permalink is an http(s) link."); err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "inbox.sent", r.MemberUID, sp(in.RequestID), r.SubjectID,
		map[string]any{"permalink": strOrNil(permalink)},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "update", Path: model.Paths.InboxRequest(ctx.WorkspaceID, in.RequestID), Data: map[string]any{
				"status":      "done",
				"sent":        map[string]any{"permalink": strOrNil(permalink), "by": ctx.Actor.ID, "at": ServerTime()},
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}}}
		}, ""), nil
}
