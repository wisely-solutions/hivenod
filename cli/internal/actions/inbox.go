package actions

// Inbox (item 4PEHrOW5IfXBQWgOK9wo): the agent actions of packages/shared/src/inbox.ts and the
// outcome registry of packages/shared/src/outcomes.ts (embedded as outcomes.json, kept equal by
// scripts/inbox-outcomes.test.mjs). The member's actions (answer, approve, reject, ignore, close,
// restore, move, rename, merge, split) are web-only and stay in TypeScript.

import (
	"bytes"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// ---------- the outcome registry ----------

//go:embed outcomes.json
var outcomesJSON []byte

// OutcomeField is one field of an outcome type.
type OutcomeField struct {
	Name     string `json:"-"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	Required bool   `json:"required"`
	Max      int    `json:"max"`
	Help     string `json:"help"`
}

// OutcomeType is one entry of OUTCOMES (fields in registry order).
type OutcomeType struct {
	ID          string         `json:"-"`
	Label       string         `json:"label"`
	Approve     string         `json:"approve"`
	Description string         `json:"description"`
	Fields      []OutcomeField `json:"-"`
	Executor    string         `json:"executor"`
	After       struct {
		State     string `json:"state"`
		WaitingOn string `json:"waitingOn"`
	} `json:"after"`
	UntilField string `json:"untilField"`
}

// Outcomes is the registry, in its order.
var Outcomes = loadOutcomes()

// orderedKeys lists an object's keys in document order.
func orderedKeys(raw json.RawMessage) []string {
	d := json.NewDecoder(bytes.NewReader(raw))
	if _, err := d.Token(); err != nil {
		panic(err)
	}
	var keys []string
	for d.More() {
		t, err := d.Token()
		if err != nil {
			panic(err)
		}
		keys = append(keys, t.(string))
		var skip json.RawMessage
		if err := d.Decode(&skip); err != nil {
			panic(err)
		}
	}
	return keys
}

func loadOutcomes() []OutcomeType {
	var byID map[string]json.RawMessage
	if err := json.Unmarshal(outcomesJSON, &byID); err != nil {
		panic(err)
	}
	var out []OutcomeType
	for _, id := range orderedKeys(outcomesJSON) {
		var t OutcomeType
		if err := json.Unmarshal(byID[id], &t); err != nil {
			panic(err)
		}
		t.ID = id
		var parts struct {
			Fields json.RawMessage `json:"fields"`
		}
		_ = json.Unmarshal(byID[id], &parts)
		var fs map[string]OutcomeField
		_ = json.Unmarshal(parts.Fields, &fs)
		for _, n := range orderedKeys(parts.Fields) {
			f := fs[n]
			f.Name = n
			t.Fields = append(t.Fields, f)
		}
		out = append(out, t)
	}
	return out
}

// OutcomeTypeOf is outcomeType(id).
func OutcomeTypeOf(id string) *OutcomeType {
	for i := range Outcomes {
		if Outcomes[i].ID == id {
			return &Outcomes[i]
		}
	}
	return nil
}

func outcomeIDs() string {
	ids := make([]string, len(Outcomes))
	for i, t := range Outcomes {
		ids[i] = t.ID
	}
	return strings.Join(ids, ", ")
}

var isoRE = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$`)

// ISOms is Date.prototype.toISOString.
func ISOms(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// CleanOutcomeFields is cleanOutcomeFields.
func CleanOutcomeFields(typeID string, fields map[string]any) (map[string]any, error) {
	t := OutcomeTypeOf(typeID)
	if t == nil {
		return nil, fail("Unknown outcome type " + typeID + ". Types: " + outcomeIDs() + ".")
	}
	keys := make([]string, 0, len(fields))
	for k := range fields {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	names := make([]string, len(t.Fields))
	for i, f := range t.Fields {
		names[i] = f.Name
	}
	for _, k := range keys {
		known := false
		for _, n := range names {
			known = known || n == k
		}
		if !known {
			return nil, fail(typeID + " has no field " + k + ". Its fields: " + strings.Join(names, ", ") + ".")
		}
	}
	out := map[string]any{}
	for _, f := range t.Fields {
		v, has := fields[f.Name]
		s, isStr := v.(string)
		if !has || v == nil || (isStr && jsTrim(s) == "") {
			if f.Required {
				return nil, fail(typeID + " needs " + f.Name + ".")
			}
			continue
		}
		if f.Kind == "boolean" {
			b, ok := v.(bool)
			if !ok {
				return nil, fail(f.Name + " is true or false.")
			}
			out[f.Name] = b
			continue
		}
		if !isStr {
			return nil, fail(f.Name + " is text.")
		}
		s = jsTrim(s)
		if f.Kind == "datetime" {
			at, err := time.Parse(time.RFC3339Nano, s)
			if err != nil || !isoRE.MatchString(s) {
				return nil, fail(f.Name + " is an ISO 8601 time with its offset, e.g. 2026-11-03T09:00:00Z.")
			}
			out[f.Name] = ISOms(time.UnixMilli(at.UnixMilli()))
			continue
		}
		max := f.Max
		if max == 0 {
			max = 300
			if f.Kind == "text" {
				max = 20000
			}
		}
		if jsLen(s) > max {
			return nil, fail(f.Name + " is at most " + strconv.Itoa(max) + " characters.")
		}
		out[f.Name] = s
	}
	return out, nil
}

// ThreadAfter is threadAfter: the thread's fields once an outcome of the type is done.
func ThreadAfter(typeID string, fields map[string]any) (map[string]any, error) {
	t := OutcomeTypeOf(typeID)
	if t == nil {
		return nil, fail("Unknown outcome type " + typeID + ".")
	}
	if t.After.State != "waiting" {
		return map[string]any{"state": t.After.State, "waiting": nil}, nil
	}
	var until any
	if t.UntilField != "" {
		if s, ok := fields[t.UntilField].(string); ok {
			if at, err := time.Parse(time.RFC3339Nano, s); err == nil {
				until = map[string]any{"__hive": "timestamp", "ms": at.UnixMilli()}
			}
		}
	}
	return map[string]any{"state": "waiting", "waiting": map[string]any{"on": t.After.WaitingOn, "until": until}}, nil
}

// ---------- shapes ----------

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
	InboxMaxSubjectName    = 120
	InboxMaxArea           = 60
	InboxMaxTitle          = 200
	InboxMaxNote           = 8000
	InboxMaxQuestion       = 4000
	InboxMaxOutcomeNote    = 2000
	InboxMaxReason         = 1000
	InboxMaxResultText     = 20000
	InboxMaxRefs           = 50
)

var sourceRE = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,39}$`)

func inList(s string, list ...string) bool {
	for _, e := range list {
		if e == s {
			return true
		}
	}
	return false
}

// Waiting is a thread's waiting {on, until}.
type Waiting struct {
	On    string     `json:"on"`
	Until *time.Time `json:"until"`
}

// ThreadState is what an action needs of a thread (ThreadStateOf).
type ThreadState struct {
	MemberUID string   `json:"memberUid"`
	SubjectID *string  `json:"subjectId"`
	State     string   `json:"state"`
	FetchedBy string   `json:"fetchedBy"`
	Refs      []string `json:"refs"`
	Waiting   *Waiting `json:"waiting"`
}

// OutcomeState is what an action needs of an outcome (OutcomeStateOf).
type OutcomeState struct {
	MemberUID string         `json:"memberUid"`
	ThreadID  string         `json:"threadId"`
	Type      string         `json:"type"`
	Fields    map[string]any `json:"fields"`
	State     string         `json:"state"`
	Executor  *string        `json:"executor"`
}

// ThreadStateFrom is the action state of a stored thread.
func ThreadStateFrom(t model.InboxThread) ThreadState {
	s := ThreadState{MemberUID: t.MemberUID, SubjectID: t.SubjectID, State: t.State, FetchedBy: t.FetchedBy, Refs: t.Refs}
	if t.Waiting != nil {
		s.Waiting = &Waiting{On: t.Waiting.On, Until: t.Waiting.Until}
	}
	if s.Refs == nil {
		s.Refs = []string{}
	}
	return s
}

// OutcomeStateFrom is the action state of a stored outcome.
func OutcomeStateFrom(o model.InboxOutcome) OutcomeState {
	f := o.Fields
	if f == nil {
		f = map[string]any{}
	}
	return OutcomeState{MemberUID: o.MemberUID, ThreadID: o.ThreadID, Type: o.Type, Fields: f, State: o.State, Executor: o.Executor}
}

// ---------- ids ----------

// InboxMessageKey is inboxMessageKey.
func InboxMessageKey(member, source, threadRef, messageID string) string {
	return strings.Join([]string{member, source, threadRef, messageID}, "\x00")
}

// InboxThreadKey is inboxThreadKey.
func InboxThreadKey(member, source, threadRef string) string {
	return strings.Join([]string{member, source, threadRef}, "\x00")
}

// Digest24 is the first 24 hex digits of SHA-256(key).
func Digest24(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:24]
}

// ---------- plan ----------

// InboxPlan is inboxPlan: the change plus one inbox event.
func InboxPlan(ctx Ctx, typ, memberUID string, threadID, subjectID *string, data map[string]any, build func(eventID string) []plan.Op, eventID string) plan.Plan {
	if eventID == "" {
		eventID = ctx.nid()
	}
	event := plan.Op{
		Kind: "set",
		Path: model.Paths.InboxEvent(ctx.WorkspaceID, eventID),
		Data: map[string]any{
			"actor":     map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID, "name": ctx.Actor.Name},
			"memberUid": memberUID,
			"threadId":  strOrNil(threadID),
			"subjectId": strOrNil(subjectID),
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

// Collapse is s.trim().replace(/\s+/g, ' ').
func Collapse(s string) string { return strings.Join(strings.FieldsFunc(s, jsSpace), " ") }

func cleanText(what, v string, max int) (string, error) {
	t := jsTrim(v)
	if t == "" {
		return "", fail(what + " is empty.")
	}
	return t, need(jsLen(t) <= max, tooLong(what, max))
}

func cleanSubjectName(name string) (string, error) {
	n := Collapse(name)
	if err := need(n != "", "A subject needs a name."); err != nil {
		return "", err
	}
	return n, need(jsLen(n) <= InboxMaxSubjectName, tooLong("A subject name", InboxMaxSubjectName))
}

// cleanArea is cleanArea: collapsed spaces; empty means no area (nil).
func cleanArea(area string) (*string, error) {
	n := Collapse(area)
	if err := need(jsLen(n) <= InboxMaxArea, tooLong("An area", InboxMaxArea)); err != nil {
		return nil, err
	}
	if n == "" {
		return nil, nil
	}
	return &n, nil
}

// TitleFrom is titleFrom: the first non-empty line, at most 120 characters.
func TitleFrom(text string) string {
	for _, l := range strings.Split(text, "\n") {
		if jsTrim(l) != "" {
			return jsSlice(Collapse(l), 120)
		}
	}
	return ""
}

func liveThread(t ThreadState) error {
	return need(t.State != "ignored", "This thread was ignored: bring it back first.")
}

func upd(path string, data map[string]any, eventID string) plan.Op {
	d := map[string]any{"updatedAt": ServerTime(), "lastEventId": eventID}
	for k, v := range data {
		d[k] = v
	}
	return plan.Op{Kind: "update", Path: path, Data: d}
}

func first(errs ...func() error) error {
	for _, f := range errs {
		if err := f(); err != nil {
			return err
		}
	}
	return nil
}

// ---------- agents ----------

// InboxAddInput is addInboxMessage's input.
type InboxAddInput struct {
	MessageDocID string  `json:"messageDocId"`
	Ref          string  `json:"ref"`
	MemberUID    string  `json:"memberUid"`
	Direction    *string `json:"direction"`
	Source       string  `json:"source"`
	Sender       struct {
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
	Thread      *struct {
		ThreadID string      `json:"threadId"`
		State    ThreadState `json:"state"`
	} `json:"thread"`
	NewThreadID *string `json:"newThreadId"`
	Title       *string `json:"title"`
}

// AddResult is addInboxMessage's plan plus where the message went.
type AddResult struct {
	plan.Plan
	ThreadID  string `json:"threadId"`
	NewThread bool   `json:"newThread"`
	State     string `json:"state"`
}

// AddInboxMessage is addInboxMessage: an agent brings a message in.
func AddInboxMessage(ctx Ctx, in InboxAddInput) (AddResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return AddResult{}, err
	}
	direction := "in"
	if in.Direction != nil {
		direction = *in.Direction
	}
	name := jsTrim(in.Sender.Name)
	handle := trimOrNil(in.Sender.Handle)
	permalink := trimOrNil(in.Permalink)
	replyRef := trimOrNil(in.ReplyRef)
	attachments := []any{}
	ex := in.Thread
	if err := first(
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
		func() error { return need(jsTrim(in.Text) != "", "The message has no text.") },
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
		func() error {
			if ex != nil && !inList(in.Ref, ex.State.Refs...) {
				return need(len(ex.State.Refs) < InboxMaxRefs, "A thread gathers at most "+strconv.Itoa(InboxMaxRefs)+" source threads.")
			}
			return nil
		},
	); err != nil {
		return AddResult{}, err
	}
	memberUID := in.MemberUID
	if ex != nil {
		memberUID = ex.State.MemberUID
	}
	if err := need(memberUID == in.MemberUID, "That thread is for someone else."); err != nil {
		return AddResult{}, err
	}
	threadID := "it" + in.Ref
	if ex != nil {
		threadID = ex.ThreadID
	} else if in.NewThreadID != nil {
		threadID = *in.NewThreadID
	}
	var title string
	if ex == nil {
		t := ""
		if in.Title != nil {
			t = Collapse(*in.Title)
		}
		if t == "" {
			t = TitleFrom(in.Text)
		}
		title = jsSlice(t, InboxMaxTitle)
	}
	state, before := "investigating", ""
	if ex != nil {
		before = ex.State.State
		state = before
		if direction == "in" && inList(before, "waiting", "done", "ignored") {
			state = "investigating"
		}
	}
	var subjectID *string
	if ex != nil {
		subjectID = ex.State.SubjectID
	}
	data := map[string]any{"messageDocId": in.MessageDocID, "source": in.Source, "sender": name, "direction": direction, "newThread": ex == nil}
	if ex != nil && state != before {
		data["reopened"] = true
	}
	var handleV any
	if handle != nil {
		handleV = *handle
	}
	p := InboxPlan(ctx, "inbox.added", memberUID, sp(threadID), subjectID, data, func(eventID string) []plan.Op {
		ops := []plan.Op{{Kind: "set", Path: model.Paths.InboxMessage(ctx.WorkspaceID, in.MessageDocID), Data: map[string]any{
			"memberUid":   memberUID,
			"threadId":    threadID,
			"direction":   direction,
			"source":      in.Source,
			"sender":      map[string]any{"name": name, "handle": handleV},
			"text":        in.Text,
			"threadRef":   in.ThreadRef,
			"messageId":   in.MessageID,
			"permalink":   strOrNil(permalink),
			"replyRef":    strOrNil(replyRef),
			"receivedAt":  map[string]any{"__hive": "timestamp", "ms": in.ReceivedAt.UnixMilli()},
			"attachments": attachments,
			"fetchedBy":   ctx.Actor.ID,
			"createdAt":   ServerTime(),
			"lastEventId": eventID,
		}}}
		if ex != nil {
			d := map[string]any{"lastMessageAt": ServerTime()}
			if !inList(in.Ref, ex.State.Refs...) {
				d["refs"] = ArrayUnion(in.Ref)
			}
			if state != before {
				d["state"], d["waiting"] = state, nil
			}
			return append(ops, upd(model.Paths.InboxThread(ctx.WorkspaceID, threadID), d, eventID))
		}
		return append(ops, plan.Op{Kind: "set", Path: model.Paths.InboxThread(ctx.WorkspaceID, threadID), Data: map[string]any{
			"memberUid":     memberUID,
			"subjectId":     nil,
			"state":         state,
			"waiting":       nil,
			"question":      nil,
			"title":         title,
			"refs":          []any{in.Ref},
			"lastMessageAt": ServerTime(),
			"fetchedBy":     ctx.Actor.ID,
			"createdAt":     ServerTime(),
			"updatedAt":     ServerTime(),
			"lastEventId":   eventID,
		}})
	}, "")
	return AddResult{Plan: p, ThreadID: threadID, NewThread: ex == nil, State: state}, nil
}

// AssignSubjectInput is assignSubject's input: SubjectID or NewName.
type AssignSubjectInput struct {
	ThreadID  string      `json:"threadId"`
	Thread    ThreadState `json:"thread"`
	SubjectID *string     `json:"subjectId,omitempty"`
	NewName   *string     `json:"newName,omitempty"`
	Area      *string     `json:"area,omitempty"`
}

// AssignResult is the plan plus the subject it filed under.
type AssignResult struct {
	plan.Plan
	SubjectID string `json:"subjectId"`
	Created   bool   `json:"created"`
}

// AssignSubject is assignSubject: files a thread under an existing or a new subject.
func AssignSubject(ctx Ctx, in AssignSubjectInput) (AssignResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return AssignResult{}, err
	}
	t := in.Thread
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
	var area *string
	if in.Area != nil {
		var err error
		if area, err = cleanArea(*in.Area); err != nil {
			return AssignResult{}, err
		}
	}
	subjectID := ""
	if in.SubjectID != nil {
		subjectID = *in.SubjectID
	} else {
		subjectID = ctx.nid()
	}
	data := map[string]any{"created": false, "from": strOrNil(t.SubjectID)}
	if created {
		data = map[string]any{"name": name, "created": true, "from": strOrNil(t.SubjectID)}
	}
	if in.Area != nil {
		data["area"] = strOrNil(area)
	}
	p := InboxPlan(ctx, "thread.filed", t.MemberUID, sp(in.ThreadID), sp(subjectID), data, func(eventID string) []plan.Op {
		var ops []plan.Op
		if created {
			d := map[string]any{
				"memberUid":   t.MemberUID,
				"name":        name,
				"createdBy":   map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
				"createdAt":   ServerTime(),
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}
			if area != nil {
				d["area"] = *area
			}
			ops = append(ops, plan.Op{Kind: "set", Path: model.Paths.InboxSubject(ctx.WorkspaceID, subjectID), Data: d})
		} else if in.Area != nil {
			ops = append(ops, upd(model.Paths.InboxSubject(ctx.WorkspaceID, subjectID), map[string]any{"area": strOrNil(area)}, eventID))
		}
		return append(ops, upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"subjectId": subjectID}, eventID))
	}, "")
	return AssignResult{Plan: p, SubjectID: subjectID, Created: created}, nil
}

// ThreadTextInput is the input of addThreadNote (Text), askMember (Question) and retitleThread (Title).
type ThreadTextInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Text     string      `json:"text"`
	Question string      `json:"question"`
	Title    string      `json:"title"`
}

// AddThreadNote is addThreadNote: an investigation note on the timeline.
func AddThreadNote(ctx Ctx, in ThreadTextInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	text, err := cleanText("The note", in.Text, InboxMaxNote)
	if err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.note", in.Thread.MemberUID, sp(in.ThreadID), in.Thread.SubjectID, map[string]any{"text": text},
		func(string) []plan.Op { return nil }, ""), nil
}

// AskMember is askMember: the thread goes to Needs you.
func AskMember(ctx Ctx, in ThreadTextInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	t := in.Thread
	if err := liveThread(t); err != nil {
		return plan.Plan{}, err
	}
	text, err := cleanText("The question", in.Question, InboxMaxQuestion)
	if err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.asked", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{"text": text}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{
			"state":    "needsYou",
			"question": map[string]any{"text": text, "by": ctx.Actor.ID, "at": ServerTime(), "answer": nil, "answeredAt": nil},
		}, eventID)}
	}, ""), nil
}

// RetitleThread is retitleThread, as an agent.
func RetitleThread(ctx Ctx, in ThreadTextInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	title, err := cleanText("The title", Collapse(in.Title), InboxMaxTitle)
	if err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.titled", in.Thread.MemberUID, sp(in.ThreadID), in.Thread.SubjectID, map[string]any{"title": title}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"title": title}, eventID)}
	}, ""), nil
}

// FlagInput is flagThread's input.
type FlagInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Urgent   bool        `json:"urgent"`
	Reason   *string     `json:"reason"`
}

// FlagThread is flagThread: an agent marks a thread urgent, or not.
func FlagThread(ctx Ctx, in FlagInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	reason := trimOrNil(in.Reason)
	if err := need(reason == nil || jsLen(*reason) <= InboxMaxReason, tooLong("The reason", InboxMaxReason)); err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.flagged", in.Thread.MemberUID, sp(in.ThreadID), in.Thread.SubjectID, map[string]any{"urgent": in.Urgent, "reason": strOrNil(reason)}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"urgent": in.Urgent}, eventID)}
	}, ""), nil
}

// ProposeInput is proposeOutcome's input.
type ProposeInput struct {
	ThreadID  string         `json:"threadId"`
	Thread    ThreadState    `json:"thread"`
	Type      string         `json:"type"`
	Fields    map[string]any `json:"fields"`
	Note      *string        `json:"note"`
	OutcomeID *string        `json:"outcomeId"`
}

// ProposeResult is the plan plus the new outcome's id.
type ProposeResult struct {
	plan.Plan
	OutcomeID string `json:"outcomeId"`
}

// ProposeOutcome is proposeOutcome: the thread goes to Your call.
func ProposeOutcome(ctx Ctx, in ProposeInput) (ProposeResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ProposeResult{}, err
	}
	t := in.Thread
	if err := liveThread(t); err != nil {
		return ProposeResult{}, err
	}
	typ := OutcomeTypeOf(in.Type)
	if typ == nil {
		return ProposeResult{}, fail("Unknown outcome type " + in.Type + ". Types: " + outcomeIDs() + ".")
	}
	if in.Fields == nil {
		in.Fields = map[string]any{}
	}
	fields, err := CleanOutcomeFields(in.Type, in.Fields)
	if err != nil {
		return ProposeResult{}, err
	}
	note := ""
	if in.Note != nil {
		note = jsTrim(*in.Note)
	}
	if err := need(jsLen(note) <= InboxMaxOutcomeNote, tooLong("The note", InboxMaxOutcomeNote)); err != nil {
		return ProposeResult{}, err
	}
	oid := ""
	if in.OutcomeID != nil {
		oid = *in.OutcomeID
	} else {
		oid = ctx.nid()
	}
	var executor any
	if typ.Executor == "agent" {
		executor = t.FetchedBy
	}
	p := InboxPlan(ctx, "outcome.proposed", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{"outcomeId": oid, "type": in.Type, "fields": fields}, func(eventID string) []plan.Op {
		return []plan.Op{
			{Kind: "set", Path: model.Paths.InboxOutcome(ctx.WorkspaceID, oid), Data: map[string]any{
				"memberUid":   t.MemberUID,
				"threadId":    in.ThreadID,
				"type":        in.Type,
				"fields":      fields,
				"state":       "proposed",
				"note":        note,
				"proposedBy":  ctx.Actor.ID,
				"executor":    executor,
				"decision":    nil,
				"result":      nil,
				"createdAt":   ServerTime(),
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}},
			upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "yourCall", "waiting": nil}, eventID),
		}
	}, "")
	return ProposeResult{Plan: p, OutcomeID: oid}, nil
}

// FinishInput is finishOutcome's input.
type FinishInput struct {
	OutcomeID string       `json:"outcomeId"`
	Outcome   OutcomeState `json:"outcome"`
	Thread    ThreadState  `json:"thread"`
	Status    string       `json:"status"`
	Result    *struct {
		Text      *string `json:"text"`
		Permalink *string `json:"permalink"`
		ItemID    *string `json:"itemId"`
		Error     *string `json:"error"`
	} `json:"result"`
}

// FinishOutcome is finishOutcome: the executor reports an approved outcome done or failed.
func FinishOutcome(ctx Ctx, in FinishInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	o := in.Outcome
	msg := "This outcome is " + o.State + " already."
	if o.State == "proposed" {
		msg = "Not approved: nothing is carried out before the person approves it."
	}
	if err := need(o.State == "approved", msg); err != nil {
		return plan.Plan{}, err
	}
	if err := need(o.Executor != nil && *o.Executor == ctx.Actor.ID, "Only the agent that carries this outcome out reports it."); err != nil {
		return plan.Plan{}, err
	}
	var text, permalink, itemID, errText *string
	if r := in.Result; r != nil {
		text, permalink, itemID, errText = trimOrNil(r.Text), trimOrNil(r.Permalink), trimOrNil(r.ItemID), trimOrNil(r.Error)
	}
	if err := first(
		func() error {
			return need(text == nil || jsLen(*text) <= InboxMaxResultText, tooLong("The result", InboxMaxResultText))
		},
		func() error {
			return need(permalink == nil || (jsLen(*permalink) <= InboxMaxPermalink && httpLink(*permalink)), "The permalink is an http(s) link.")
		},
		func() error {
			return need(itemID == nil || jsLen(*itemID) <= 128, "The item id is at most 128 characters.")
		},
		func() error {
			return need(errText == nil || jsLen(*errText) <= InboxMaxReason, tooLong("The error", InboxMaxReason))
		},
		func() error {
			if in.Status == "failed" {
				return need(errText != nil, "Say what went wrong (result.error).")
			}
			return nil
		},
	); err != nil {
		return plan.Plan{}, err
	}
	after := map[string]any{"state": "investigating", "waiting": nil}
	typ := "outcome.failed"
	if in.Status == "done" {
		typ = "outcome.done"
		var err error
		if after, err = ThreadAfter(o.Type, o.Fields); err != nil {
			return plan.Plan{}, err
		}
	}
	data := map[string]any{"outcomeId": in.OutcomeID, "type": o.Type, "permalink": strOrNil(permalink), "itemId": strOrNil(itemID)}
	if errText != nil {
		data["error"] = *errText
	}
	return InboxPlan(ctx, typ, o.MemberUID, sp(o.ThreadID), in.Thread.SubjectID, data, func(eventID string) []plan.Op {
		return []plan.Op{
			upd(model.Paths.InboxOutcome(ctx.WorkspaceID, in.OutcomeID), map[string]any{
				"state":  in.Status,
				"result": map[string]any{"text": strOrNil(text), "permalink": strOrNil(permalink), "itemId": strOrNil(itemID), "error": strOrNil(errText), "by": ctx.Actor.ID, "at": ServerTime()},
			}, eventID),
			upd(model.Paths.InboxThread(ctx.WorkspaceID, o.ThreadID), after, eventID),
		}
	}, ""), nil
}

// WakeInput is wakeThread's input.
type WakeInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	NowMs    int64       `json:"nowMs"`
}

// WakeThread is wakeThread: a snoozed thread whose date has come.
func WakeThread(ctx Ctx, in WakeInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	t := in.Thread
	var until *time.Time
	if t.State == "waiting" && t.Waiting != nil {
		until = t.Waiting.Until
	}
	if err := need(until != nil, "This thread is not waiting for a date."); err != nil {
		return plan.Plan{}, err
	}
	if err := need(until.UnixMilli() <= in.NowMs, "Not yet: it waits until its date."); err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.woke", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "investigating", "waiting": nil}, eventID)}
	}, ""), nil
}
