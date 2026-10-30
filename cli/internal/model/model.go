// Package model holds the Firestore documents the agent reads (packages/shared/src/schema.ts), with
// `firestore` tags for (*firestore.DocumentSnapshot).DataTo and `json` tags for the contract test.
// Unknown fields are ignored and missing ones read as zero values; optional fields are pointers
// where the shared logic tells "absent" or null from a value. Projects, items and runs went with
// projects (item OE8FmrTaIxFVGcaeGG3N, slice 11): only agents and Inbox documents are left.
package model

import (
	"time"
)

// Constants from schema.ts.
const (
	MaxAttachmentBytes   = 900 * 1024
	DefaultMaxFailedRuns = 3
	MaxFailedRunsLimit   = 20
)

// ActorRef is `{type, id}` of whoever wrote something.
type ActorRef struct {
	Type string `firestore:"type" json:"type"`
	ID   string `firestore:"id" json:"id"`
}

// Guardrails of an agent; absent on older agents (see actions.GuardrailsOf).
type Guardrails struct {
	MaxFailedRuns *int64 `firestore:"maxFailedRuns" json:"maxFailedRuns"`
}

// Agent is workspaces/{w}/agents/{uid}.
type Agent struct {
	Name        string     `firestore:"name" json:"name"`
	Color       string     `firestore:"color" json:"color"`
	CreatedBy   string     `firestore:"createdBy" json:"createdBy"`
	CreatedAt   time.Time  `firestore:"createdAt" json:"createdAt"`
	RevokedAt   *time.Time `firestore:"revokedAt" json:"revokedAt"`
	LastSeenAt  *time.Time `firestore:"lastSeenAt" json:"lastSeenAt"`
	SignedOutAt *time.Time `firestore:"signedOutAt" json:"signedOutAt"`
	SeenHost    *string    `firestore:"seenHost" json:"seenHost"`
	// SeenSession and SeenHostID (item N0biX): the channel session that last stamped presence, and
	// a stable id of its machine and user, so a restart on the same machine takes over at once.
	SeenSession      *string     `firestore:"seenSession" json:"seenSession"`
	SeenHostID       *string     `firestore:"seenHostId" json:"seenHostId"`
	CLIVersion       *string     `firestore:"cliVersion" json:"cliVersion"`
	TokenHint        string      `firestore:"tokenHint" json:"tokenHint"`
	PreviousAgentUID *string     `firestore:"previousAgentUid" json:"previousAgentUid"`
	Guardrails       *Guardrails `firestore:"guardrails" json:"guardrails"`
	FailStreak       int64       `firestore:"failStreak" json:"failStreak"`
	PausedAt         *time.Time  `firestore:"pausedAt" json:"pausedAt"`
	PausedReason     *string     `firestore:"pausedReason" json:"pausedReason"`
	LastEventID      string      `firestore:"lastEventId" json:"lastEventId"`
}

// InboxSender is who sent a message.
type InboxSender struct {
	Name   string  `firestore:"name" json:"name"`
	Handle *string `firestore:"handle" json:"handle"`
}

// InboxAttachment is a link a message carries.
type InboxAttachment struct {
	Name string `firestore:"name" json:"name"`
	URL  string `firestore:"url" json:"url"`
}

// InboxMessage is workspaces/{w}/inboxMessages/{mid}.
type InboxMessage struct {
	MemberUID   string            `firestore:"memberUid" json:"memberUid"`
	ThreadID    string            `firestore:"threadId" json:"threadId"`
	Direction   string            `firestore:"direction" json:"direction"`
	Source      string            `firestore:"source" json:"source"`
	Sender      InboxSender       `firestore:"sender" json:"sender"`
	Text        string            `firestore:"text" json:"text"`
	ThreadRef   string            `firestore:"threadRef" json:"threadRef"`
	MessageID   string            `firestore:"messageId" json:"messageId"`
	Permalink   *string           `firestore:"permalink" json:"permalink"`
	ReplyRef    *string           `firestore:"replyRef" json:"replyRef"`
	ReceivedAt  time.Time         `firestore:"receivedAt" json:"receivedAt"`
	Attachments []InboxAttachment `firestore:"attachments" json:"attachments"`
	FetchedBy   string            `firestore:"fetchedBy" json:"fetchedBy"`
}

// InboxWaiting is what a waiting thread waits on.
type InboxWaiting struct {
	On    string     `firestore:"on" json:"on"`
	Until *time.Time `firestore:"until" json:"until"`
}

// InboxQuestion is the agent's question to the member.
type InboxQuestion struct {
	Text       string     `firestore:"text" json:"text"`
	By         string     `firestore:"by" json:"by"`
	Answer     *string    `firestore:"answer" json:"answer"`
	AnsweredAt *time.Time `firestore:"answeredAt" json:"answeredAt"`
	// Options are the answer chips (nil on older questions).
	Options []string `firestore:"options" json:"options"`
}

// InboxThread is workspaces/{w}/inboxThreads/{tid}.
type InboxThread struct {
	MemberUID     string         `firestore:"memberUid" json:"memberUid"`
	SubjectID     *string        `firestore:"subjectId" json:"subjectId"`
	State         string         `firestore:"state" json:"state"`
	Waiting       *InboxWaiting  `firestore:"waiting" json:"waiting"`
	Question      *InboxQuestion `firestore:"question" json:"question"`
	Title         string         `firestore:"title" json:"title"`
	Refs          []string       `firestore:"refs" json:"refs"`
	LastMessageAt time.Time      `firestore:"lastMessageAt" json:"lastMessageAt"`
	FetchedBy     string         `firestore:"fetchedBy" json:"fetchedBy"`
	Urgent        bool           `firestore:"urgent" json:"urgent"`
	// Due is the deadline set with thread_due (nil: none).
	Due *time.Time `firestore:"due" json:"due"`
	// Recheck is the member's last re-check request and its answer (nil: never asked).
	Recheck *InboxRecheck `firestore:"recheck" json:"recheck"`
	// Instructions are the member's requests by id (Ask the agent, item w6O2KOw4ys70TQv9I1xD),
	// at most 20; Instruct is the latest one and whether it waits; SuggestedChips are this
	// agent's chips for the thread.
	Instructions   map[string]InboxInstruction `firestore:"instructions" json:"instructions"`
	Instruct       *InboxInstruct              `firestore:"instruct" json:"instruct"`
	SuggestedChips []string                    `firestore:"suggestedChips" json:"suggestedChips"`
	// Summary is the top line of the thread's summary (item OE8FmrTaIxFVGcaeGG3N), mirrored by
	// thread_summary; nil until the home agent writes one.
	Summary *InboxThreadSummary `firestore:"summary" json:"summary"`
	// UpdatedAt and LastEventID: the thread's last change (a summary is fresh when written at or
	// after it).
	UpdatedAt   *time.Time `firestore:"updatedAt" json:"updatedAt"`
	LastEventID string     `firestore:"lastEventId" json:"lastEventId"`
}

// InboxThreadSummary is a thread's mirror of its summary (inboxSummaries/{tid}).
type InboxThreadSummary struct {
	Version    int64      `firestore:"version" json:"version"`
	At         *time.Time `firestore:"at" json:"at"`
	Headline   string     `firestore:"headline" json:"headline"`
	Ask        *string    `firestore:"ask" json:"ask"`
	Answer     *string    `firestore:"answer" json:"answer"`
	RecAction  *string    `firestore:"recAction" json:"recAction"`
	Confidence *string    `firestore:"confidence" json:"confidence"`
}

// InboxInstruction is one of a thread's instructions: a text or a chip, pending until the home
// agent answers with thread_answer_instruction.
type InboxInstruction struct {
	Text   *string                 `firestore:"text" json:"text"`
	Chip   *string                 `firestore:"chip" json:"chip"`
	By     string                  `firestore:"by" json:"by"`
	At     *time.Time              `firestore:"at" json:"at"`
	State  string                  `firestore:"state" json:"state"`
	Answer *InboxInstructionAnswer `firestore:"answer" json:"answer"`
}

// InboxInstructionAnswer is how the home agent answered: kind note, ask, outcome or plan.
type InboxInstructionAnswer struct {
	Kind  string     `firestore:"kind" json:"kind"`
	RefID *string    `firestore:"refId" json:"refId"`
	Note  *string    `firestore:"note" json:"note"`
	At    *time.Time `firestore:"at" json:"at"`
}

// InboxInstruct is a thread's latest instruction: pending until answered.
type InboxInstruct struct {
	State string     `firestore:"state" json:"state"`
	ID    string     `firestore:"id" json:"id"`
	At    *time.Time `firestore:"at" json:"at"`
}

// InboxRecheck is a thread's recheck (item bmNoIvvqKCdAorLSShE9): pending until the home agent
// answers with thread_recheck_done (result still_good, revised or asked).
type InboxRecheck struct {
	State       string     `firestore:"state" json:"state"`
	By          string     `firestore:"by" json:"by"`
	RequestedAt *time.Time `firestore:"requestedAt" json:"requestedAt"`
	Result      *string    `firestore:"result" json:"result"`
	Note        *string    `firestore:"note" json:"note"`
	At          *time.Time `firestore:"at" json:"at"`
}

// InboxDecision is the member's approval or rejection of an outcome.
type InboxDecision struct {
	ByUID  string  `firestore:"byUid" json:"byUid"`
	Edited bool    `firestore:"edited" json:"edited"`
	Reason *string `firestore:"reason" json:"reason"`
	// Version is the version approved (nil: never revised).
	Version *int `firestore:"version" json:"version"`
}

// ReviseAsk is what the member asked for (a version's `asked`).
type ReviseAsk struct {
	Instruction *string  `json:"instruction" firestore:"instruction"`
	Chips       []string `json:"chips" firestore:"chips"`
}

// ReviseRequest is an outcome's `revise` while the agent revises.
type ReviseRequest struct {
	Instruction *string    `json:"instruction" firestore:"instruction"`
	Chips       []string   `json:"chips" firestore:"chips"`
	ByUID       string     `json:"byUid" firestore:"byUid"`
	At          *time.Time `json:"at" firestore:"at"`
}

// OutcomeVersion is one entry of an outcome's versions.
type OutcomeVersion struct {
	N          int            `json:"n" firestore:"n"`
	Fields     map[string]any `json:"fields" firestore:"fields"`
	Note       string         `json:"note" firestore:"note"`
	Confidence *string        `json:"confidence" firestore:"confidence"`
	Checks     []string       `json:"checks" firestore:"checks"`
	By         string         `json:"by" firestore:"by"`
	EventID    *string        `json:"eventId" firestore:"eventId"`
	Asked      *ReviseAsk     `json:"asked" firestore:"asked"`
}

// InboxResult is what the executor reported.
type InboxResult struct {
	Text      *string `firestore:"text" json:"text"`
	Permalink *string `firestore:"permalink" json:"permalink"`
	ItemID    *string `firestore:"itemId" json:"itemId"`
	Error     *string `firestore:"error" json:"error"`
	By        string  `firestore:"by" json:"by"`
}

// InboxOutcome is workspaces/{w}/inboxOutcomes/{oid}.
type InboxOutcome struct {
	MemberUID  string         `firestore:"memberUid" json:"memberUid"`
	ThreadID   string         `firestore:"threadId" json:"threadId"`
	Type       string         `firestore:"type" json:"type"`
	Fields     map[string]any `firestore:"fields" json:"fields"`
	State      string         `firestore:"state" json:"state"`
	Note       string         `firestore:"note" json:"note"`
	Confidence *string        `firestore:"confidence" json:"confidence"`
	Checks     []string       `firestore:"checks" json:"checks"`
	ProposedBy string         `firestore:"proposedBy" json:"proposedBy"`
	Executor   *string        `firestore:"executor" json:"executor"`
	Decision   *InboxDecision `firestore:"decision" json:"decision"`
	Result     *InboxResult   `firestore:"result" json:"result"`
	CreatedAt  time.Time      `firestore:"createdAt" json:"createdAt"`
	// Versions and Revise: Ask for changes (item L7OzWKMYZ1O2dX33Xkrj).
	Versions []OutcomeVersion `firestore:"versions" json:"versions"`
	Revise   *ReviseRequest   `firestore:"revise" json:"revise"`
	// PlanID: a step of that plan (item qwFAWxZM5xkcE7PPjAzi); nil: a single outcome.
	PlanID *string `firestore:"planId" json:"planId"`
	// Progress (slice 6b): a running long step's last progress line, percent and time.
	Progress *InboxProgress `firestore:"progress" json:"progress"`
	// CheckedAt: when the home agent last re-checked it and found it still good (nil: never).
	CheckedAt *time.Time `firestore:"checkedAt" json:"checkedAt"`
	// Ext: a Their reply step (packages/shared/src/theirreply.ts); nil before its first message.
	Ext *InboxExt `firestore:"ext" json:"ext"`
	// RemindDue: the ask number its reminder fired for (the notifier writes it).
	RemindDue *int `firestore:"remindDue" json:"remindDue"`
}

// InboxExt is a Their reply step's state: the message in hand, the last send, their reply quoted.
type InboxExt struct {
	Ask   *InboxExtAsk   `firestore:"ask" json:"ask"`
	OutAt *time.Time     `firestore:"outAt" json:"outAt"`
	Sent  int            `firestore:"sent" json:"sent"`
	Reply *InboxExtReply `firestore:"reply" json:"reply"`
}

// InboxExtAsk is the message to them: drafted (proposed), approved by the person, or sent.
type InboxExtAsk struct {
	N     int        `firestore:"n" json:"n"`
	Kind  string     `firestore:"kind" json:"kind"`
	Text  string     `firestore:"text" json:"text"`
	State string     `firestore:"state" json:"state"`
	By    string     `firestore:"by" json:"by"`
	At    *time.Time `firestore:"at" json:"at"`
}

// InboxExtReply is their reply the agent quoted on the step.
type InboxExtReply struct {
	MessageDocID string `firestore:"messageDocId" json:"messageDocId"`
	Quote        string `firestore:"quote" json:"quote"`
}

// InboxPlan is workspaces/{w}/inboxPlans/{pid}: the order of a plan's steps (outcome ids) and
// whose turn it is (cursor; len(steps) once every step is through).
type InboxPlan struct {
	MemberUID  string    `firestore:"memberUid" json:"memberUid"`
	ThreadID   string    `firestore:"threadId" json:"threadId"`
	ProposedBy string    `firestore:"proposedBy" json:"proposedBy"`
	Steps      []string  `firestore:"steps" json:"steps"`
	Cursor     int       `firestore:"cursor" json:"cursor"`
	State      string    `firestore:"state" json:"state"`
	Note       string    `firestore:"note" json:"note"`
	Confidence *string   `firestore:"confidence" json:"confidence"`
	CreatedAt  time.Time `firestore:"createdAt" json:"createdAt"`
	// Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6).
	TemplateID *string           `firestore:"templateId" json:"templateId"`
	SendBackTo map[string]string `firestore:"sendBackTo" json:"sendBackTo"`
	SentBack   *InboxSentBack    `firestore:"sentBack" json:"sentBack"`
}

// InboxSentBack is a plan's last send back: how many so far, to which step, why, by whom.
type InboxSentBack struct {
	N      int       `firestore:"n" json:"n"`
	To     string    `firestore:"to" json:"to"`
	Reason string    `firestore:"reason" json:"reason"`
	By     string    `firestore:"by" json:"by"`
	At     time.Time `firestore:"at" json:"at"`
}

// InboxRelation is workspaces/{w}/inboxRelations/{rid}: two related subjects (a < b).
type InboxRelation struct {
	MemberUID string `firestore:"memberUid" json:"memberUid"`
	A         string `firestore:"a" json:"a"`
	B         string `firestore:"b" json:"b"`
	Note      string `firestore:"note" json:"note"`
	State     string `firestore:"state" json:"state"`
}

// InboxSubject is workspaces/{w}/inboxSubjects/{sid}.
type InboxSubject struct {
	MemberUID string `firestore:"memberUid" json:"memberUid"`
	Name      string `firestore:"name" json:"name"`
	// Area is the optional area or tag (nil: none).
	Area *string `firestore:"area" json:"area"`
	// Label is the optional label (the kind of request); LabelSuggested is true while it is the
	// agent's guess; LabelBy is "agent" or "member".
	Label          *string `firestore:"label" json:"label"`
	LabelSuggested bool    `firestore:"labelSuggested" json:"labelSuggested"`
	LabelBy        *string `firestore:"labelBy" json:"labelBy"`
}

// InboxLabels is workspaces/{w}/inboxConfig/labels: the workspace's label list.
type InboxLabels struct {
	Labels []string `firestore:"labels" json:"labels"`
}

// InboxEvent is workspaces/{w}/inboxEvents/{eid}.
type InboxEvent struct {
	Actor struct {
		Type string `firestore:"type" json:"type"`
		ID   string `firestore:"id" json:"id"`
		Name string `firestore:"name" json:"name"`
	} `firestore:"actor" json:"actor"`
	Type string         `firestore:"type" json:"type"`
	Data map[string]any `firestore:"data" json:"data"`
	At   time.Time      `firestore:"at" json:"at"`
}

// InboxProgress is a running long step's last step_progress.
type InboxProgress struct {
	Line    string `firestore:"line" json:"line"`
	Percent *int64 `firestore:"percent" json:"percent"`
	// Check (Keep green, slice 6c): rechecking, green or blocked; absent on a plain line.
	Check *string   `firestore:"check,omitempty" json:"check,omitempty"`
	At    time.Time `firestore:"at" json:"at"`
}
