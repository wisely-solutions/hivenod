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
	// Batchable: a tidy-up type (sends nothing, takes effect on approval) the member may approve
	// in one batch (item kt3E7u9EliL3q2veDDI0).
	Batchable bool `json:"batchable"`
	// Kind (item qwFAWxZM5xkcE7PPjAzi, plans): "agent" (an action, the default) or "human" (a
	// person-approval gate only the member decides).
	Kind string `json:"kind"`
	// Plan: allowed as a plan step; PlanOnly: never proposed alone (outcome_propose).
	Plan     bool `json:"plan"`
	PlanOnly bool `json:"planOnly"`
	// Retired (bookings, item OE8FmrTaIxFVGcaeGG3N slice 5): old records only, never proposed.
	Retired bool `json:"retired"`
}

// RetiredMessage is RETIRED_MESSAGE: the refusal for a retired outcome type.
func RetiredMessage(t string) string {
	return t + " was retired with Calendar: bookings are no longer made through Hivenod. Reject it, or propose a reply that suggests times."
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
		if t.Kind == "" {
			t.Kind = "agent"
		}
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

// SingleOutcomeTypes is SINGLE_TYPES: the types an agent may propose alone.
func SingleOutcomeTypes() []string {
	var ids []string
	for _, t := range Outcomes {
		if !t.PlanOnly {
			ids = append(ids, t.ID)
		}
	}
	return ids
}

// PlanOutcomeTypes is PLAN_TYPES: the types allowed as plan steps.
func PlanOutcomeTypes() []string {
	var ids []string
	for _, t := range Outcomes {
		if t.Plan {
			ids = append(ids, t.ID)
		}
	}
	return ids
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
	InboxMaxLabel          = 30
	InboxMaxLabels         = 12
	InboxMaxTitle          = 200
	InboxMaxNote           = 8000
	InboxMaxQuestion       = 4000
	InboxMaxOutcomeNote    = 2000
	InboxMaxReason         = 1000
	InboxMaxResultText     = 20000
	InboxMaxRefs           = 50
	InboxMaxChecks         = 6
	InboxMaxCheck          = 200
	InboxMaxOptions        = 4
	InboxMaxOption         = 80
	// Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the instruction, and the versions kept.
	InboxMaxReviseInstruction = 500
	InboxMaxVersions          = 10
)

// ReviseChips are REVISE_CHIPS, in order.
var ReviseChips = []string{"shorter", "formal", "warmer", "availability"}

// DefaultInboxLabels is DEFAULT_INBOX_LABELS: the labels a workspace offers until an admin edits
// the list (the contract cases and the rules keep the copies equal).
var DefaultInboxLabels = []string{"Sales", "Support", "Billing", "Partnership", "Internal", "Other"}

// OutcomeConfidence lists how sure an agent may be of an outcome (OUTCOME_CONFIDENCE).
var OutcomeConfidence = []string{"high", "medium", "low"}

// cleanLines is cleanLines: short lines trimmed, each 1..each characters, at most max of them.
func cleanLines(what string, v []string, max, each int) ([]string, error) {
	if len(v) > max {
		return nil, fail("At most " + strconv.Itoa(max) + " " + what + ".")
	}
	out := make([]string, 0, len(v))
	for _, e := range v {
		t := jsTrim(e)
		if jsLen(t) == 0 || jsLen(t) > each {
			return nil, fail("Each of the " + what + " is 1-" + strconv.Itoa(each) + " characters.")
		}
		out = append(out, t)
	}
	return out, nil
}

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
	// Recheck: the member's last re-check request (item bmNoIvvqKCdAorLSShE9); nil: none.
	Recheck *ThreadRecheck `json:"recheck,omitempty"`
	// Instructions and Instruct: Ask the agent (item w6O2KOw4ys70TQv9I1xD).
	Instructions map[string]ThreadInstruction `json:"instructions,omitempty"`
	Instruct     *ThreadInstruct              `json:"instruct,omitempty"`
}

// ThreadInstruction is what the actions need of an instruction.
type ThreadInstruction struct {
	State string     `json:"state"`
	At    *time.Time `json:"at,omitempty"`
}

// ThreadInstruct is what the actions need of a thread's latest instruction.
type ThreadInstruct struct {
	State string     `json:"state"`
	ID    string     `json:"id"`
	At    *time.Time `json:"at,omitempty"`
}

// ThreadRecheck is what the actions need of a thread's recheck.
type ThreadRecheck struct {
	State       string     `json:"state"`
	RequestedAt *time.Time `json:"requestedAt,omitempty"`
}

// OutcomeState is what an action needs of an outcome (OutcomeStateOf).
type OutcomeState struct {
	MemberUID string         `json:"memberUid"`
	ThreadID  string         `json:"threadId"`
	Type      string         `json:"type"`
	Fields    map[string]any `json:"fields"`
	State     string         `json:"state"`
	Executor  *string        `json:"executor"`
	// What a revision needs (item L7OzWKMYZ1O2dX33Xkrj); absent on older outcomes.
	ProposedBy *string          `json:"proposedBy,omitempty"`
	Note       *string          `json:"note,omitempty"`
	Confidence *string          `json:"confidence,omitempty"`
	Checks     []string         `json:"checks,omitempty"`
	Versions   []OutcomeVersion `json:"versions,omitempty"`
	Revise     *ReviseRequest   `json:"revise,omitempty"`
	// PlanID: a step of that plan (item qwFAWxZM5xkcE7PPjAzi); nil: a single outcome.
	PlanID *string `json:"planId,omitempty"`
}

// ReviseAsk, ReviseRequest and OutcomeVersion are the stored shapes (model).
type (
	ReviseAsk      = model.ReviseAsk
	ReviseRequest  = model.ReviseRequest
	OutcomeVersion = model.OutcomeVersion
)

func versionDoc(v OutcomeVersion) map[string]any {
	checks := v.Checks
	if checks == nil {
		checks = []string{}
	}
	var asked any
	if v.Asked != nil {
		chips := v.Asked.Chips
		if chips == nil {
			chips = []string{}
		}
		asked = map[string]any{"instruction": strOrNil(v.Asked.Instruction), "chips": chips}
	}
	return map[string]any{"n": v.N, "fields": v.Fields, "note": v.Note, "confidence": strOrNil(v.Confidence),
		"checks": checks, "by": v.By, "eventId": strOrNil(v.EventID), "asked": asked}
}

// ThreadStateFrom is the action state of a stored thread.
func ThreadStateFrom(t model.InboxThread) ThreadState {
	s := ThreadState{MemberUID: t.MemberUID, SubjectID: t.SubjectID, State: t.State, FetchedBy: t.FetchedBy, Refs: t.Refs}
	if t.Waiting != nil {
		s.Waiting = &Waiting{On: t.Waiting.On, Until: t.Waiting.Until}
	}
	if t.Recheck != nil {
		s.Recheck = &ThreadRecheck{State: t.Recheck.State, RequestedAt: t.Recheck.RequestedAt}
	}
	if len(t.Instructions) > 0 {
		s.Instructions = map[string]ThreadInstruction{}
		for id, in := range t.Instructions {
			s.Instructions[id] = ThreadInstruction{State: in.State, At: in.At}
		}
	}
	if t.Instruct != nil {
		s.Instruct = &ThreadInstruct{State: t.Instruct.State, ID: t.Instruct.ID, At: t.Instruct.At}
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
	s := OutcomeState{MemberUID: o.MemberUID, ThreadID: o.ThreadID, Type: o.Type, Fields: f, State: o.State, Executor: o.Executor,
		ProposedBy: sp(o.ProposedBy), Note: sp(o.Note), Confidence: o.Confidence, Checks: o.Checks, Versions: o.Versions, Revise: o.Revise, PlanID: o.PlanID}
	return s
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

// MatchLabel is matchLabel: the listed spelling of a label (matched ignoring case), or "" when
// it is not listed.
func MatchLabel(label string, list []string) string {
	w := strings.ToLower(Collapse(label))
	for _, l := range list {
		if strings.ToLower(l) == w {
			return l
		}
	}
	return ""
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
	// Label is the agent's suggested label (one of Labels, the workspace list; the defaults when
	// absent). Existing is the subject's current label state, when it already exists.
	Label    *string        `json:"label,omitempty"`
	Labels   []string       `json:"labels,omitempty"`
	Existing *ExistingLabel `json:"existing,omitempty"`
}

// ExistingLabel is the label state of a subject a thread is filed under.
type ExistingLabel struct {
	Label   *string `json:"label"`
	LabelBy *string `json:"labelBy"`
}

// AssignResult is the plan plus the subject it filed under.
type AssignResult struct {
	plan.Plan
	SubjectID    string `json:"subjectId"`
	Created      bool   `json:"created"`
	LabelApplied bool   `json:"labelApplied"`
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
	label := ""
	if in.Label != nil {
		list := in.Labels
		if list == nil {
			list = DefaultInboxLabels
		}
		label = MatchLabel(*in.Label, list)
		if err := need(label != "", "Unknown label. Use one of: "+strings.Join(list, ", ")+"."); err != nil {
			return AssignResult{}, err
		}
		if !created && in.Existing != nil && in.Existing.Label != nil && *in.Existing.Label != "" {
			label = ""
		}
	}
	labelFields := map[string]any{"label": label, "labelSuggested": true, "labelBy": "agent"}
	data := map[string]any{"created": false, "from": strOrNil(t.SubjectID)}
	if created {
		data = map[string]any{"name": name, "created": true, "from": strOrNil(t.SubjectID)}
	}
	if in.Area != nil {
		data["area"] = strOrNil(area)
	}
	if label != "" {
		data["label"] = label
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
			if label != "" {
				for k, v := range labelFields {
					d[k] = v
				}
			}
			ops = append(ops, plan.Op{Kind: "set", Path: model.Paths.InboxSubject(ctx.WorkspaceID, subjectID), Data: d})
		} else if in.Area != nil || label != "" {
			u := map[string]any{}
			if in.Area != nil {
				u["area"] = strOrNil(area)
			}
			if label != "" {
				for k, v := range labelFields {
					u[k] = v
				}
			}
			ops = append(ops, upd(model.Paths.InboxSubject(ctx.WorkspaceID, subjectID), u, eventID))
		}
		return append(ops, upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"subjectId": subjectID}, eventID))
	}, "")
	return AssignResult{Plan: p, SubjectID: subjectID, Created: created, LabelApplied: label != ""}, nil
}

// ThreadTextInput is the input of addThreadNote (Text) and retitleThread (Title).
type ThreadTextInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Text     string      `json:"text"`
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

// AskInput is askMember's input: the question plus up to 4 answer chips.
type AskInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Question string      `json:"question"`
	Options  []string    `json:"options"`
}

// AskMember is askMember: the thread goes to Needs you.
func AskMember(ctx Ctx, in AskInput) (plan.Plan, error) {
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
	options, err := cleanLines("options", in.Options, InboxMaxOptions, InboxMaxOption)
	if err != nil {
		return plan.Plan{}, err
	}
	data := map[string]any{"text": text}
	question := map[string]any{"text": text, "by": ctx.Actor.ID, "at": ServerTime(), "answer": nil, "answeredAt": nil}
	if len(options) > 0 {
		data["options"], question["options"] = options, options
	}
	return InboxPlan(ctx, "thread.asked", t.MemberUID, sp(in.ThreadID), t.SubjectID, data, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{
			"state":    "needsYou",
			"question": question,
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

// DueInput is dueThread's input: Due is an ISO 8601 time with its offset, or nil to clear.
type DueInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Due      *string     `json:"due"`
	Reason   *string     `json:"reason"`
}

// DueThread is dueThread: an agent sets or clears a thread's deadline (thread_due).
func DueThread(ctx Ctx, in DueInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	var due, dueISO any
	if in.Due != nil {
		s := jsTrim(*in.Due)
		at, err := time.Parse(time.RFC3339Nano, s)
		if err != nil || !isoRE.MatchString(s) {
			return plan.Plan{}, fail("The due date is an ISO 8601 time with its offset, e.g. 2026-11-03T12:00:00Z.")
		}
		due = map[string]any{"__hive": "timestamp", "ms": at.UnixMilli()}
		dueISO = ISOms(time.UnixMilli(at.UnixMilli()))
	}
	reason := trimOrNil(in.Reason)
	if err := need(reason == nil || jsLen(*reason) <= InboxMaxReason, tooLong("The reason", InboxMaxReason)); err != nil {
		return plan.Plan{}, err
	}
	return InboxPlan(ctx, "thread.due", in.Thread.MemberUID, sp(in.ThreadID), in.Thread.SubjectID, map[string]any{"due": dueISO, "reason": strOrNil(reason)}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"due": due}, eventID)}
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
	// Confidence is high, medium or low (nil: no meter); Checks what the agent verified.
	Confidence *string  `json:"confidence"`
	Checks     []string `json:"checks"`
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
		return ProposeResult{}, fail("Unknown outcome type " + in.Type + ". Types: " + strings.Join(SingleOutcomeTypes(), ", ") + ".")
	}
	if typ.Retired {
		return ProposeResult{}, fail(RetiredMessage(in.Type))
	}
	if typ.PlanOnly {
		return ProposeResult{}, fail(in.Type + " is only a step of a plan (plan_propose). Types alone: " + strings.Join(SingleOutcomeTypes(), ", ") + ".")
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
	if err := need(in.Confidence == nil || inList(*in.Confidence, OutcomeConfidence...), "The confidence is high, medium or low."); err != nil {
		return ProposeResult{}, err
	}
	checks, err := cleanLines("checks", in.Checks, InboxMaxChecks, InboxMaxCheck)
	if err != nil {
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
		doc := map[string]any{
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
		}
		if in.Confidence != nil {
			doc["confidence"] = *in.Confidence
		}
		if len(checks) > 0 {
			doc["checks"] = checks
		}
		return []plan.Op{
			{Kind: "set", Path: model.Paths.InboxOutcome(ctx.WorkspaceID, oid), Data: doc},
			upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "yourCall", "waiting": nil}, eventID),
		}
	}, "")
	return ProposeResult{Plan: p, OutcomeID: oid}, nil
}

// ReviseInput is reviseOutcome's input (outcome_propose with revises).
type ReviseInput struct {
	OutcomeID  string         `json:"outcomeId"`
	Outcome    OutcomeState   `json:"outcome"`
	Thread     ThreadState    `json:"thread"`
	Type       *string        `json:"type"`
	ThreadID   *string        `json:"threadId"`
	Fields     map[string]any `json:"fields"`
	Note       *string        `json:"note"`
	Confidence *string        `json:"confidence"`
	Checks     []string       `json:"checks"`
	// Plan: a plan step's plan (on a re-check an approved step that has not run may be revised).
	Plan *PlanInput `json:"plan,omitempty"`
}

// ReviseResult is the plan plus the new version's number.
type ReviseResult struct {
	plan.Plan
	Version int `json:"version"`
}

// ReviseOutcome is reviseOutcome: the proposing agent writes the next version of an outcome the
// member asked changes for; it is proposed again in the same slot.
func ReviseOutcome(ctx Ctx, in ReviseInput) (ReviseResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ReviseResult{}, err
	}
	o := in.Outcome
	if in.ThreadID != nil && *in.ThreadID != o.ThreadID {
		return ReviseResult{}, fail("Outcome " + in.OutcomeID + " is on thread " + o.ThreadID + ", not " + *in.ThreadID + ": propose a new outcome instead.")
	}
	if in.Type != nil && *in.Type != o.Type {
		return ReviseResult{}, fail("Outcome " + in.OutcomeID + " is a " + o.Type + "; a revision keeps the type: propose a new outcome instead.")
	}
	// Re-check (item bmNoIvvqKCdAorLSShE9): the home agent may revise an open proposal unasked.
	rechecking := in.Thread.Recheck != nil && in.Thread.Recheck.State == "pending" && in.Thread.FetchedBy == ctx.Actor.ID
	unasked := false
	if rechecking {
		if o.State == "proposed" {
			unasked = true
		} else if o.State == "approved" && o.PlanID != nil {
			pl, err := planFor(in.Plan, o, in.OutcomeID)
			if err != nil {
				return ReviseResult{}, err
			}
			unasked = Recheckable(in.OutcomeID, o, &pl.Plan)
		}
	}
	if o.State != "revising" && !unasked {
		if o.State == "proposed" {
			return ReviseResult{}, fail("Nobody asked for changes on this outcome (or the person cancelled the request).")
		}
		if o.State == "approved" && o.PlanID != nil && rechecking {
			return ReviseResult{}, fail("This step has started (it is its turn): it cannot be revised now.")
		}
		return ReviseResult{}, fail("This outcome was already decided (" + o.State + "): your revision is not needed.")
	}
	if o.ProposedBy == nil || *o.ProposedBy != ctx.Actor.ID {
		return ReviseResult{}, fail("Only the agent that proposed this outcome revises it.")
	}
	if t := OutcomeTypeOf(o.Type); t != nil && t.Retired {
		return ReviseResult{}, fail(RetiredMessage(o.Type))
	}
	if in.Fields == nil {
		in.Fields = map[string]any{}
	}
	fields, err := CleanOutcomeFields(o.Type, in.Fields)
	if err != nil {
		return ReviseResult{}, err
	}
	note := ""
	if in.Note != nil {
		note = jsTrim(*in.Note)
	}
	if err := need(jsLen(note) <= InboxMaxOutcomeNote, tooLong("The note", InboxMaxOutcomeNote)); err != nil {
		return ReviseResult{}, err
	}
	if err := need(in.Confidence == nil || inList(*in.Confidence, OutcomeConfidence...), "The confidence is high, medium or low."); err != nil {
		return ReviseResult{}, err
	}
	checks, err := cleanLines("checks", in.Checks, InboxMaxChecks, InboxMaxCheck)
	if err != nil {
		return ReviseResult{}, err
	}
	prior := append([]OutcomeVersion{}, o.Versions...)
	if len(prior) == 0 {
		v1 := OutcomeVersion{N: 1, Fields: o.Fields, Checks: o.Checks, Confidence: o.Confidence, By: ctx.Actor.ID}
		if o.Note != nil {
			v1.Note = *o.Note
		}
		if o.ProposedBy != nil {
			v1.By = *o.ProposedBy
		}
		prior = []OutcomeVersion{v1}
	}
	if len(prior) >= InboxMaxVersions {
		return ReviseResult{}, fail("This proposal has " + strconv.Itoa(InboxMaxVersions) + " versions already.")
	}
	version := len(prior) + 1
	var asked *ReviseAsk
	if o.State == "revising" && o.Revise != nil {
		asked = &ReviseAsk{Instruction: o.Revise.Instruction, Chips: o.Revise.Chips}
	}
	p := InboxPlan(ctx, "outcome.revised", o.MemberUID, sp(o.ThreadID), in.Thread.SubjectID, map[string]any{"outcomeId": in.OutcomeID, "type": o.Type, "version": version, "fields": fields}, func(eventID string) []plan.Op {
		list := make([]any, 0, version)
		for _, v := range prior {
			list = append(list, versionDoc(v))
		}
		list = append(list, versionDoc(OutcomeVersion{N: version, Fields: fields, Note: note, Confidence: in.Confidence, Checks: checks, By: ctx.Actor.ID, EventID: &eventID, Asked: asked}))
		d := map[string]any{
			"state": "proposed", "fields": fields, "note": note, "confidence": strOrNil(in.Confidence),
			"checks": checks, "versions": list, "revise": nil,
		}
		if o.State == "approved" {
			// An approved plan step revised on a re-check needs the member's approval again.
			d["decision"] = nil
		}
		return []plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, in.OutcomeID), d, eventID)}
	}, "")
	return ReviseResult{Plan: p, Version: version}, nil
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
	// Plan: the outcome's plan, when it is a plan step.
	Plan *PlanInput `json:"plan"`
}

// FinishOutcome is finishOutcome: the executor reports an approved outcome done or failed. A plan
// step is reported only at its turn: done moves the plan on, failed blocks it, and started (Build
// it: the item is made) leaves the step running until the item is Done.
func FinishOutcome(ctx Ctx, in FinishInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	o := in.Outcome
	planned := o.PlanID != nil
	msg := "This outcome is " + o.State + " already."
	if o.State == "proposed" || o.State == "revising" {
		msg = "Not approved: nothing is carried out before the person approves it."
	}
	if err := need(o.State == "approved" || (planned && o.State == "running" && in.Status != "started"), msg); err != nil {
		return plan.Plan{}, err
	}
	if err := need(o.Executor != nil && *o.Executor == ctx.Actor.ID, "Only the agent that carries this outcome out reports it."); err != nil {
		return plan.Plan{}, err
	}
	if err := need(in.Status != "started" || planned, "Only a plan step can be started (status started is for Build it)."); err != nil {
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
	result := map[string]any{"text": strOrNil(text), "permalink": strOrNil(permalink), "itemId": strOrNil(itemID), "error": strOrNil(errText), "by": ctx.Actor.ID, "at": ServerTime()}
	if planned {
		pl, err := planFor(in.Plan, o, in.OutcomeID)
		if err != nil {
			return plan.Plan{}, err
		}
		if err := need(pl.Plan.State == "proposed" || pl.Plan.State == "active", "This plan is "+pl.Plan.State+": its steps are not carried out."); err != nil {
			return plan.Plan{}, err
		}
		if err := need(pl.Plan.Cursor < len(pl.Plan.Steps) && pl.Plan.Steps[pl.Plan.Cursor] == in.OutcomeID, "Not its turn: a plan step is carried out only once the steps before it are done."); err != nil {
			return plan.Plan{}, err
		}
		state, typ, force := "failed", "outcome.failed", "blocked"
		switch in.Status {
		case "started":
			t := OutcomeTypeOf(o.Type)
			if err := need(t != nil && t.After.WaitingOn == "item", "A "+o.Type+" step is reported done or failed, not started."); err != nil {
				return plan.Plan{}, err
			}
			if err := need(itemID != nil, "Give the item you made (result.itemId)."); err != nil {
				return plan.Plan{}, err
			}
			state, typ, force = "running", "outcome.started", ""
		case "done":
			state, typ, force = "done", "outcome.done", ""
		}
		next := advance(pl, in.OutcomeID, state, in.Status == "done")
		data := map[string]any{"outcomeId": in.OutcomeID, "type": o.Type, "planId": pl.PlanID, "permalink": strOrNil(permalink), "itemId": strOrNil(itemID)}
		if errText != nil {
			data["error"] = *errText
		}
		var werr error
		p := InboxPlan(ctx, typ, o.MemberUID, sp(o.ThreadID), in.Thread.SubjectID, data, func(eventID string) []plan.Op {
			ops, err := planWrites(ctx, pl, next, force, eventID)
			werr = err
			return append([]plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, in.OutcomeID), map[string]any{"state": state, "result": result}, eventID)}, ops...)
		}, "")
		return p, werr
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
				"result": result,
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
	// Plan: the thread's live plan, if any; a wait-until step at its cursor is then done.
	Plan *PlanInput `json:"plan"`
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
	if pl := in.Plan; pl != nil {
		if step := pl.at(pl.Plan.Cursor); step != nil {
			sid := pl.Plan.Steps[pl.Plan.Cursor]
			if err := need(pl.Plan.ThreadID == in.ThreadID, "Plan "+pl.PlanID+" is not on this thread."); err != nil {
				return plan.Plan{}, err
			}
			if err := need((pl.Plan.State == "proposed" || pl.Plan.State == "active") && step.State == "approved" && step.Type == "snooze", "This plan is not waiting until a date."); err != nil {
				return plan.Plan{}, err
			}
			next := advance(*pl, sid, "done", true)
			var werr error
			p := InboxPlan(ctx, "thread.woke", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{"planId": pl.PlanID, "outcomeId": sid}, func(eventID string) []plan.Op {
				ops, err := planWrites(ctx, *pl, next, "", eventID)
				werr = err
				res := map[string]any{"text": nil, "permalink": nil, "itemId": nil, "error": nil, "by": ctx.Actor.ID, "at": ServerTime()}
				return append([]plan.Op{upd(model.Paths.InboxOutcome(ctx.WorkspaceID, sid), map[string]any{"state": "done", "result": res}, eventID)}, ops...)
			}, "")
			return p, werr
		}
	}
	return InboxPlan(ctx, "thread.woke", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{}, func(eventID string) []plan.Op {
		return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"state": "investigating", "waiting": nil}, eventID)}
	}, ""), nil
}

// ---------- Re-check (item bmNoIvvqKCdAorLSShE9) ----------

// RecheckResults are RECHECK_RESULTS.
var RecheckResults = []string{"still_good", "revised", "asked"}

// InboxMaxRecheckNote is INBOX_LIMITS.recheckNote.
const InboxMaxRecheckNote = 500

// Recheckable is recheckable: an open proposal, or an approved step of a live plan that has not
// run (not at the cursor, where it is being carried out).
func Recheckable(oid string, o OutcomeState, p *PlanState) bool {
	if o.State == "proposed" {
		return true
	}
	if o.State != "approved" || o.PlanID == nil || p == nil {
		return false
	}
	return inList(p.State, "proposed", "active", "blocked") && contains(p.Steps, oid) &&
		!(p.Cursor < len(p.Steps) && p.Steps[p.Cursor] == oid)
}

// RecheckDoneInput is recheckDone's input (thread_recheck_done).
type RecheckDoneInput struct {
	ThreadID string                  `json:"threadId"`
	Thread   ThreadState             `json:"thread"`
	Result   string                  `json:"result"`
	Note     *string                 `json:"note"`
	Outcomes map[string]OutcomeState `json:"outcomes"`
	Plans    map[string]PlanState    `json:"plans"`
}

// RecheckDoneResult is the plan plus the outcomes stamped still good.
type RecheckDoneResult struct {
	plan.Plan
	Checked []string `json:"checked"`
}

// RecheckDone is recheckDone: the home agent answers the member's re-check request; still_good
// stamps checkedAt on every open proposal and unrun live-plan step of the thread.
func RecheckDone(ctx Ctx, in RecheckDoneInput) (RecheckDoneResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return RecheckDoneResult{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return RecheckDoneResult{}, fail("Only the thread's home agent (the one that brought it in) answers a re-check.")
	}
	if t.Recheck == nil || t.Recheck.State != "pending" {
		return RecheckDoneResult{}, fail("Nobody asked to re-check this thread.")
	}
	if !inList(in.Result, RecheckResults...) {
		return RecheckDoneResult{}, fail("The result is " + strings.Join(RecheckResults, ", ") + ".")
	}
	var note *string
	if in.Note != nil {
		if n := jsTrim(*in.Note); n != "" {
			note = &n
		}
	}
	if note != nil && jsLen(*note) > InboxMaxRecheckNote {
		return RecheckDoneResult{}, fail(tooLong("The note", InboxMaxRecheckNote))
	}
	checked := []string{}
	if in.Result == "still_good" {
		ids := make([]string, 0, len(in.Outcomes))
		for id := range in.Outcomes {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		for _, id := range ids {
			o := in.Outcomes[id]
			if o.ThreadID != in.ThreadID {
				continue
			}
			var p *PlanState
			if o.PlanID != nil {
				if pl, ok := in.Plans[*o.PlanID]; ok {
					p = &pl
				}
			}
			if Recheckable(id, o, p) {
				checked = append(checked, id)
			}
		}
	}
	pl := InboxPlan(ctx, "thread.rechecked", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{"result": in.Result, "note": strOrNil(note), "checked": checked}, func(eventID string) []plan.Op {
		ops := []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{
			"recheck.state": "done", "recheck.result": in.Result, "recheck.note": strOrNil(note), "recheck.at": ServerTime(),
		}, eventID)}
		for _, id := range checked {
			ops = append(ops, upd(model.Paths.InboxOutcome(ctx.WorkspaceID, id), map[string]any{"checkedAt": ServerTime()}, eventID))
		}
		return ops
	}, "")
	return RecheckDoneResult{Plan: pl, Checked: checked}, nil
}

// ---------- Ask the agent (item w6O2KOw4ys70TQv9I1xD) ----------

// InstructChips are INSTRUCT_CHIPS; InstructAnswers are INSTRUCT_ANSWERS.
var (
	InstructChips   = []string{"prepare_meeting", "recheck", "follow_up", "summarize", "draft_reply"}
	InstructAnswers = []string{"note", "ask", "outcome", "plan"}
)

// InboxMaxInstructNote and InboxMaxSuggestedChips are INBOX_LIMITS.instructNote and .suggestedChips.
const (
	InboxMaxInstructNote   = 500
	InboxMaxSuggestedChips = 5
)

// AnswerInstructionInput is answerInstruction's input (thread_answer_instruction).
type AnswerInstructionInput struct {
	ThreadID      string      `json:"threadId"`
	Thread        ThreadState `json:"thread"`
	InstructionID string      `json:"instructionId"`
	Kind          string      `json:"kind"`
	RefID         *string     `json:"refId"`
	Note          *string     `json:"note"`
}

func trimmedOrNil(v *string) *string {
	if v == nil {
		return nil
	}
	if t := jsTrim(*v); t != "" {
		return &t
	}
	return nil
}

// AnswerInstruction is answerInstruction: the home agent answers the member's instruction once,
// with a note (its text), a question it asked, or the outcome or plan it proposed (refId).
func AnswerInstruction(ctx Ctx, in AnswerInstructionInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return plan.Plan{}, fail("Only the thread's home agent (the one that brought it in) answers the person's request.")
	}
	ins, ok := t.Instructions[in.InstructionID]
	if !ok {
		return plan.Plan{}, fail("There is no request " + in.InstructionID + " on this thread.")
	}
	if ins.State != "pending" {
		return plan.Plan{}, fail("This request was answered already.")
	}
	if !inList(in.Kind, InstructAnswers...) {
		return plan.Plan{}, fail("The kind is " + strings.Join(InstructAnswers, ", ") + ".")
	}
	ref := trimmedOrNil(in.RefID)
	note := trimmedOrNil(in.Note)
	if note != nil && jsLen(*note) > InboxMaxInstructNote {
		return plan.Plan{}, fail(tooLong("The note", InboxMaxInstructNote))
	}
	if in.Kind == "note" && note == nil {
		return plan.Plan{}, fail("Answer with a note: give its text.")
	}
	refKind := in.Kind == "outcome" || in.Kind == "plan"
	if refKind != (ref != nil) {
		if refKind {
			return plan.Plan{}, fail("Give the " + in.Kind + " id you proposed (refId).")
		}
		return plan.Plan{}, fail("Only an outcome or plan answer has a refId.")
	}
	latest := t.Instruct != nil && t.Instruct.ID == in.InstructionID
	id := in.InstructionID
	return InboxPlan(ctx, "thread.instruction_answered", t.MemberUID, sp(in.ThreadID), t.SubjectID,
		map[string]any{"instructionId": id, "kind": in.Kind, "refId": strOrNil(ref), "note": strOrNil(note)},
		func(eventID string) []plan.Op {
			d := map[string]any{
				"instructions." + id + ".state":  "answered",
				"instructions." + id + ".answer": map[string]any{"kind": in.Kind, "refId": strOrNil(ref), "note": strOrNil(note), "at": ServerTime()},
			}
			if latest {
				d["instruct.state"] = "done"
			}
			return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), d, eventID)}
		}, ""), nil
}

// SuggestChipsInput is suggestChips' input (thread_suggest_chips).
type SuggestChipsInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	Chips    []string    `json:"chips"`
}

// SuggestChips is suggestChips: the home agent sets the chips it suggests (0-5, once each).
func SuggestChips(ctx Ctx, in SuggestChipsInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return plan.Plan{}, fail("Only the thread's home agent (the one that brought it in) suggests its chips.")
	}
	if len(in.Chips) > InboxMaxSuggestedChips {
		return plan.Plan{}, fail("At most " + strconv.Itoa(InboxMaxSuggestedChips) + " chips.")
	}
	seen := map[string]bool{}
	for _, c := range in.Chips {
		if !inList(c, InstructChips...) {
			return plan.Plan{}, fail("A chip is one of " + strings.Join(InstructChips, ", ") + ".")
		}
	}
	for _, c := range in.Chips {
		if seen[c] {
			return plan.Plan{}, fail("Each chip is listed once.")
		}
		seen[c] = true
	}
	chips := append([]string{}, in.Chips...)
	return InboxPlan(ctx, "thread.chips_suggested", t.MemberUID, sp(in.ThreadID), t.SubjectID,
		map[string]any{"chips": chips}, func(eventID string) []plan.Op {
			return []plan.Op{upd(model.Paths.InboxThread(ctx.WorkspaceID, in.ThreadID), map[string]any{"suggestedChips": chips}, eventID)}
		}, ""), nil
}
