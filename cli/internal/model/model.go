// Package model holds the Firestore documents the agent reads (packages/shared/src/schema.ts), with
// `firestore` tags for (*firestore.DocumentSnapshot).DataTo and `json` tags for the contract test.
// Unknown fields are ignored and missing ones read as zero values; optional fields are pointers
// where the shared logic tells "absent" or null from a value. Item.HasShape keeps the one place
// where absent and null differ (shape: absent = an item from before paths, null = unshaped).
package model

import (
	"encoding/json"
	"time"

	"cloud.google.com/go/firestore"
)

// Constants from schema.ts.
const (
	MaxAttachmentBytes     = 900 * 1024
	MaxLogLines            = 500
	StaleClaimMinutes      = 10
	HeartbeatEventMinutes  = 5
	MinReasonChars         = 10
	MaxAgentSendBacks      = 3
	MaxSendBackReasonChars = 2000
	MaxSendBackSpan        = 12
	DefaultMaxFailedRuns   = 3
	MaxFailedRunsLimit     = 20
	MaxSteps               = 30
	MaxStopReasonChars     = 500
	MaxPathNoteChars       = 300
	MaxPathReasonChars     = 1000
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
	Name  string `firestore:"name" json:"name"`
	Color string `firestore:"color" json:"color"`
	// ProjectIDs is a []any of ids or the string "*" (every project).
	ProjectIDs       any         `firestore:"projectIds" json:"projectIds"`
	CreatedBy        string      `firestore:"createdBy" json:"createdBy"`
	CreatedAt        time.Time   `firestore:"createdAt" json:"createdAt"`
	RevokedAt        *time.Time  `firestore:"revokedAt" json:"revokedAt"`
	LastSeenAt       *time.Time  `firestore:"lastSeenAt" json:"lastSeenAt"`
	SignedOutAt      *time.Time  `firestore:"signedOutAt" json:"signedOutAt"`
	SeenHost         *string     `firestore:"seenHost" json:"seenHost"`
	TokenHint        string      `firestore:"tokenHint" json:"tokenHint"`
	PreviousAgentUID *string     `firestore:"previousAgentUid" json:"previousAgentUid"`
	Guardrails       *Guardrails `firestore:"guardrails" json:"guardrails"`
	FailStreak       int64       `firestore:"failStreak" json:"failStreak"`
	PausedAt         *time.Time  `firestore:"pausedAt" json:"pausedAt"`
	PausedReason     *string     `firestore:"pausedReason" json:"pausedReason"`
	LastEventID      string      `firestore:"lastEventId" json:"lastEventId"`
}

// AllProjects is true when the agent may work on every project ('*').
func (a Agent) AllProjects() bool { s, ok := a.ProjectIDs.(string); return ok && s == "*" }

// ProjectList is the agent's allowed project ids (nil for '*').
func (a Agent) ProjectList() []string {
	var out []string
	switch v := a.ProjectIDs.(type) {
	case []any:
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
	case []string:
		out = v
	}
	return out
}

// Gate of a people step.
type Gate struct {
	DeciderUIDs      []string `firestore:"deciderUids" json:"deciderUids"`
	GroupIDs         []string `firestore:"groupIds" json:"groupIds"`
	Rule             string   `firestore:"rule" json:"rule"`
	N                int64    `firestore:"n" json:"n"`
	MustInclude      []string `firestore:"mustInclude" json:"mustInclude"`
	RejectPolicy     string   `firestore:"rejectPolicy" json:"rejectPolicy"`
	RemindAfterHours float64  `firestore:"remindAfterHours" json:"remindAfterHours"`
}

// Step of a project's library. Kind is "agent" or "human" (human steps have a Gate).
type Step struct {
	ID           string   `firestore:"id" json:"id"`
	Name         string   `firestore:"name" json:"name"`
	Kind         string   `firestore:"kind" json:"kind"`
	Description  string   `firestore:"description" json:"description"`
	Instructions *string  `firestore:"instructions" json:"instructions,omitempty"`
	Outputs      []string `firestore:"outputs" json:"outputs,omitempty"`
	Gate         *Gate    `firestore:"gate" json:"gate,omitempty"`
}

// Project is workspaces/{w}/projects/{p}.
type Project struct {
	Name          string              `firestore:"name" json:"name"`
	Emoji         string              `firestore:"emoji" json:"emoji"`
	Color         string              `firestore:"color" json:"color"`
	Description   *string             `firestore:"description" json:"description"`
	TemplateID    string              `firestore:"templateId" json:"templateId"`
	Steps         []Step              `firestore:"steps" json:"steps"`
	StepIndex     map[string]int64    `firestore:"stepIndex" json:"stepIndex"`
	MemberUIDs    []string            `firestore:"memberUids" json:"memberUids"`
	StepAgents    map[string][]string `firestore:"stepAgents" json:"stepAgents"`
	ShapeNewItems *bool               `firestore:"shapeNewItems" json:"shapeNewItems"`
	CreatedBy     string              `firestore:"createdBy" json:"createdBy"`
	CreatedAt     time.Time           `firestore:"createdAt" json:"createdAt"`
	ArchivedAt    *time.Time          `firestore:"archivedAt" json:"archivedAt"`
	LastEventID   string              `firestore:"lastEventId" json:"lastEventId"`
}

// DecisionMark is one approval or rejection at a gate.
type DecisionMark struct {
	At        time.Time `firestore:"at" json:"at"`
	Rationale string    `firestore:"rationale" json:"rationale"`
}

// ItemGate is the open gate of an item waiting at a people step.
type ItemGate struct {
	StepID     string                  `firestore:"stepId" json:"stepId"`
	Approvals  map[string]DecisionMark `firestore:"approvals" json:"approvals"`
	Rejections map[string]DecisionMark `firestore:"rejections" json:"rejections"`
}

// Claim of an item by an agent's run.
type Claim struct {
	RunID       string    `firestore:"runId" json:"runId"`
	AgentUID    string    `firestore:"agentUid" json:"agentUid"`
	HeartbeatAt time.Time `firestore:"heartbeatAt" json:"heartbeatAt"`
}

// Hold: the item waits for people's answer to QuestionID.
type Hold struct {
	QuestionID string    `firestore:"questionId" json:"questionId"`
	AgentUID   string    `firestore:"agentUid" json:"agentUid"`
	At         time.Time `firestore:"at" json:"at"`
	Reason     *string   `firestore:"reason" json:"reason"`
}

// WorkStop: a person stopped the agent's work (Mode "back" or "cancel").
type WorkStop struct {
	Mode   string    `firestore:"mode" json:"mode"`
	ByUID  string    `firestore:"byUid" json:"byUid"`
	At     time.Time `firestore:"at" json:"at"`
	Reason string    `firestore:"reason" json:"reason"`
	RunID  string    `firestore:"runId" json:"runId"`
}

// Triage of a suggestion.
type Triage struct {
	Outcome string    `firestore:"outcome" json:"outcome"`
	Reason  string    `firestore:"reason" json:"reason"`
	ByUID   string    `firestore:"byUid" json:"byUid"`
	At      time.Time `firestore:"at" json:"at"`
}

// ItemShape: who shaped the item, when, and their note.
type ItemShape struct {
	By   ActorRef  `firestore:"by" json:"by"`
	At   time.Time `firestore:"at" json:"at"`
	Note string    `firestore:"note" json:"note"`
}

// PathRequest is a pending change of a people step on an item's path (Op "add" or "drop").
type PathRequest struct {
	Op     string    `firestore:"op" json:"op"`
	By     ActorRef  `firestore:"by" json:"by"`
	Reason string    `firestore:"reason" json:"reason"`
	At     time.Time `firestore:"at" json:"at"`
}

// Progress of the step.
type Progress struct {
	Done  int64 `firestore:"done" json:"done"`
	Total int64 `firestore:"total" json:"total"`
}

// Source of an item.
type Source struct {
	Kind  string `firestore:"kind" json:"kind"`
	Label string `firestore:"label" json:"label"`
}

// Item is workspaces/{w}/projects/{p}/items/{i}.
type Item struct {
	Title           string     `firestore:"title" json:"title"`
	Type            string     `firestore:"type" json:"type"`
	StepID          string     `firestore:"stepId" json:"stepId"`
	Status          string     `firestore:"status" json:"status"`
	Summary         string     `firestore:"summary" json:"summary"`
	Source          Source     `firestore:"source" json:"source"`
	CreatedBy       ActorRef   `firestore:"createdBy" json:"createdBy"`
	ParentItemID    *string    `firestore:"parentItemId" json:"parentItemId"`
	SourceRunID     *string    `firestore:"sourceRunId" json:"sourceRunId"`
	Claim           *Claim     `firestore:"claim" json:"claim"`
	Progress        *Progress  `firestore:"progress" json:"progress"`
	Gate            *ItemGate  `firestore:"gate" json:"gate"`
	Triage          *Triage    `firestore:"triage" json:"triage"`
	SendBackCount   int64      `firestore:"sendBackCount" json:"sendBackCount"`
	AgentSendBacks  int64      `firestore:"agentSendBacks" json:"agentSendBacks"`
	AttachmentCount int64      `firestore:"attachmentCount" json:"attachmentCount"`
	CostEur         float64    `firestore:"costEur" json:"costEur"`
	Order           float64    `firestore:"order" json:"order"`
	AwaitingAnswer  *Hold      `firestore:"awaitingAnswer" json:"awaitingAnswer"`
	WorkStopped     *WorkStop  `firestore:"workStopped" json:"workStopped"`
	ArchivedAt      *time.Time `firestore:"archivedAt" json:"archivedAt"`
	// Shape is nil both when absent and when null: HasShape tells them apart.
	Shape *ItemShape `firestore:"shape" json:"shape"`
	// HasShape: the document has a shape field (null or not). Set by DecodeItem / UnmarshalJSON;
	// set it yourself when you build an Item by hand.
	HasShape     bool                   `firestore:"-" json:"-"`
	PathSkips    map[string]string      `firestore:"pathSkips" json:"pathSkips"`
	GateSkips    map[string]string      `firestore:"gateSkips" json:"gateSkips"`
	PathRequests map[string]PathRequest `firestore:"pathRequests" json:"pathRequests"`
	PathRefused  []string               `firestore:"pathRefused" json:"pathRefused"`
	PathRev      int64                  `firestore:"pathRev" json:"pathRev"`
	UpdatedAt    time.Time              `firestore:"updatedAt" json:"updatedAt"`
	LastEventID  string                 `firestore:"lastEventId" json:"lastEventId"`
}

// Unshaped returns a copy with shape: null (a new item waiting to be shaped).
func (it Item) Unshaped() Item { it.Shape, it.HasShape = nil, true; return it }

// DecodeItem reads an item snapshot, keeping whether `shape` is present.
func DecodeItem(snap *firestore.DocumentSnapshot) (Item, error) {
	var it Item
	if err := snap.DataTo(&it); err != nil {
		return Item{}, err
	}
	_, it.HasShape = snap.Data()["shape"]
	return it, nil
}

// UnmarshalJSON decodes an item, keeping whether `shape` is present.
func (it *Item) UnmarshalJSON(b []byte) error {
	type plain Item
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	var keys map[string]json.RawMessage
	if err := json.Unmarshal(b, &keys); err != nil {
		return err
	}
	*it = Item(p)
	_, it.HasShape = keys["shape"]
	return nil
}

// RunRemote is the Remote Control session of an interactive run.
type RunRemote struct {
	URL       string `firestore:"url" json:"url"`
	SessionID string `firestore:"sessionId" json:"sessionId"`
}

// StoppedBy names who pressed Stop work.
type StoppedBy struct {
	UID  string `firestore:"uid" json:"uid"`
	Name string `firestore:"name" json:"name"`
}

// Run is workspaces/{w}/runs/{r}.
type Run struct {
	AgentUID         string     `firestore:"agentUid" json:"agentUid"`
	ProjectID        string     `firestore:"projectId" json:"projectId"`
	ItemID           string     `firestore:"itemId" json:"itemId"`
	StepID           string     `firestore:"stepId" json:"stepId"`
	StartedAt        time.Time  `firestore:"startedAt" json:"startedAt"`
	HeartbeatAt      time.Time  `firestore:"heartbeatAt" json:"heartbeatAt"`
	HeartbeatEventAt time.Time  `firestore:"heartbeatEventAt" json:"heartbeatEventAt"`
	EndedAt          *time.Time `firestore:"endedAt" json:"endedAt"`
	Status           string     `firestore:"status" json:"status"`
	CostEur          float64    `firestore:"costEur" json:"costEur"`
	Job              *string    `firestore:"job" json:"job"`
	TokensIn         int64      `firestore:"tokensIn" json:"tokensIn"`
	TokensOut        int64      `firestore:"tokensOut" json:"tokensOut"`
	TokensCached     *int64     `firestore:"tokensCached" json:"tokensCached"`
	Model            *string    `firestore:"model" json:"model"`
	Summary          *string    `firestore:"summary" json:"summary"`
	LastEventID      string     `firestore:"lastEventId" json:"lastEventId"`
	StoppedBy        *StoppedBy `firestore:"stoppedBy" json:"stoppedBy"`
	Remote           *RunRemote `firestore:"remote" json:"remote"`
}

// Message is workspaces/{w}/projects/{p}/items/{i}/messages/{m}.
type Message struct {
	WorkspaceID string    `firestore:"workspaceId" json:"workspaceId"`
	ProjectID   string    `firestore:"projectId" json:"projectId"`
	ItemID      string    `firestore:"itemId" json:"itemId"`
	By          ActorRef  `firestore:"by" json:"by"`
	Kind        string    `firestore:"kind" json:"kind"`
	Text        string    `firestore:"text" json:"text"`
	At          time.Time `firestore:"at" json:"at"`
	Answered    bool      `firestore:"answered" json:"answered"`
	ReplyTo     *string   `firestore:"replyTo" json:"replyTo"`
	LastEventID string    `firestore:"lastEventId" json:"lastEventId"`
}

// Attachment is workspaces/{w}/projects/{p}/items/{i}/attachments/{a}.
type Attachment struct {
	Kind        string    `firestore:"kind" json:"kind"`
	Name        string    `firestore:"name" json:"name"`
	Content     *string   `firestore:"content" json:"content"`
	URL         *string   `firestore:"url" json:"url"`
	Bytes       int64     `firestore:"bytes" json:"bytes"`
	RunID       *string   `firestore:"runId" json:"runId"`
	By          ActorRef  `firestore:"by" json:"by"`
	At          time.Time `firestore:"at" json:"at"`
	LastEventID string    `firestore:"lastEventId" json:"lastEventId"`
}

// Decision is workspaces/{w}/projects/{p}/decisions/{d}.
type Decision struct {
	WorkspaceID string    `firestore:"workspaceId" json:"workspaceId"`
	ProjectID   string    `firestore:"projectId" json:"projectId"`
	ItemID      string    `firestore:"itemId" json:"itemId"`
	ItemTitle   string    `firestore:"itemTitle" json:"itemTitle"`
	StepID      string    `firestore:"stepId" json:"stepId"`
	Outcome     string    `firestore:"outcome" json:"outcome"`
	ToStepID    *string   `firestore:"toStepId" json:"toStepId"`
	ByUID       string    `firestore:"byUid" json:"byUid"`
	Rationale   string    `firestore:"rationale" json:"rationale"`
	Tags        []string  `firestore:"tags" json:"tags"`
	WaitMs      *int64    `firestore:"waitMs" json:"waitMs"`
	Via         *string   `firestore:"via" json:"via"`
	At          time.Time `firestore:"at" json:"at"`
	LastEventID string    `firestore:"lastEventId" json:"lastEventId"`
}
