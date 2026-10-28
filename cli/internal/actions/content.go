package actions

import (
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Attachments, messages, findings (actions.ts).

// AttachInput is attach's input (the action only; reading files is the caller's job).
type AttachInput struct {
	ProjectID string `json:"projectId"`
	ItemID    string `json:"itemId"`
	// AttachmentID defaults to a new id.
	AttachmentID string `json:"attachmentId,omitempty"`
	// Kind: html, markdown, text, image, pdf or link.
	Kind    string  `json:"kind"`
	Name    string  `json:"name"`
	Content *string `json:"content,omitempty"`
	URL     *string `json:"url,omitempty"`
	RunID   *string `json:"runId,omitempty"`
}

// AttachResult is the plan and the attachment's id.
type AttachResult struct {
	plan.Plan
	AttachmentID string `json:"attachmentId"`
}

// Attach adds an attachment (inline content, or a link) and bumps the item's attachmentCount.
func Attach(ctx Ctx, in AttachInput) (AttachResult, error) {
	attachmentID := in.AttachmentID
	if attachmentID == "" {
		attachmentID = ctx.nid()
	}
	isLink := in.Kind == "link"
	if isLink && (in.URL == nil || *in.URL == "") {
		return AttachResult{}, fail("A link needs a URL")
	}
	if !isLink && in.Content == nil {
		return AttachResult{}, fail("Attachment content missing")
	}
	bytes := 0
	if !isLink {
		bytes = len(strings.ToValidUTF8(*in.Content, "�"))
	}
	if bytes > model.MaxAttachmentBytes {
		return AttachResult{}, fail("Attachments over 900 KB must be attached as a link")
	}
	runID := orNull(in.RunID)
	p := Plan(ctx, "attachment.added", Scope{sp(in.ProjectID), sp(in.ItemID), in.RunID},
		map[string]any{"attachmentId": attachmentID, "name": in.Name, "kind": in.Kind},
		func(eventID string) []plan.Op {
			var content, url any
			if isLink {
				url = *in.URL
			} else {
				content = *in.Content
			}
			var docRun any
			if ctx.Actor.Type == "agent" {
				docRun = runID
			}
			return []plan.Op{
				{Kind: "set", Path: model.Paths.Attachment(ctx.WorkspaceID, in.ProjectID, in.ItemID, attachmentID), Data: map[string]any{
					"kind":        in.Kind,
					"name":        in.Name,
					"content":     content,
					"url":         url,
					"bytes":       int64(bytes),
					"runId":       docRun,
					"by":          map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
					"at":          ServerTime(),
					"lastEventId": eventID,
				}},
				{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: map[string]any{
					"attachmentCount": Increment(1), "lastEventId": eventID,
				}},
			}
		}, "")
	return AttachResult{Plan: p, AttachmentID: attachmentID}, nil
}

// MessageDoc is a message document (kind question, answer or note; replyTo nil for none).
func MessageDoc(ctx Ctx, projectID, itemID, kind, text string, replyTo *string, eventID string) map[string]any {
	return map[string]any{
		"workspaceId": ctx.WorkspaceID,
		"projectId":   projectID,
		"itemId":      itemID,
		"by":          map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
		"kind":        kind,
		"text":        text,
		"at":          ServerTime(),
		"answered":    false,
		"replyTo":     orNull(replyTo),
		"lastEventId": eventID,
	}
}

// PostMessageInput is postMessage's input.
type PostMessageInput struct {
	ProjectID string `json:"projectId"`
	ItemID    string `json:"itemId"`
	// Kind "question" (agents only) or "note".
	Kind string `json:"kind"`
	Text string `json:"text"`
	// MessageID defaults to a new id.
	MessageID string  `json:"messageId,omitempty"`
	RunID     *string `json:"runId,omitempty"`
}

// MessageResult is the plan and the message's id.
type MessageResult struct {
	plan.Plan
	MessageID string `json:"messageId"`
}

// PostMessage posts a question (agents) or a note.
func PostMessage(ctx Ctx, in PostMessageInput) (MessageResult, error) {
	if in.Kind == "question" {
		if err := RequireAgent(ctx); err != nil {
			return MessageResult{}, err
		}
	}
	messageID := in.MessageID
	if messageID == "" {
		messageID = ctx.nid()
	}
	p := Plan(ctx, "message.posted", Scope{sp(in.ProjectID), sp(in.ItemID), in.RunID},
		map[string]any{"messageId": messageID, "kind": in.Kind},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: model.Paths.Message(ctx.WorkspaceID, in.ProjectID, in.ItemID, messageID),
				Data: MessageDoc(ctx, in.ProjectID, in.ItemID, in.Kind, in.Text, nil, eventID)}}
		}, "")
	return MessageResult{Plan: p, MessageID: messageID}, nil
}

// RaiseFindingInput is raiseFinding's input. Parent needs only Title and Claim.
type RaiseFindingInput struct {
	Project      model.Project `json:"project"`
	ProjectID    string        `json:"projectId"`
	ParentItemID string        `json:"parentItemId"`
	Parent       model.Item    `json:"parent"`
	Title        string        `json:"title"`
	Details      string        `json:"details"`
	// ItemID defaults to a new id.
	ItemID string `json:"itemId,omitempty"`
}

// ItemResult is the plan and the new item's id.
type ItemResult struct {
	plan.Plan
	ItemID string `json:"itemId"`
}

// RaiseFinding raises a finding as a suggestion for people, at the project's first step.
func RaiseFinding(ctx Ctx, in RaiseFindingInput) (ItemResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ItemResult{}, err
	}
	title := jsTrim(in.Title)
	if title == "" {
		return ItemResult{}, fail("A finding needs a title")
	}
	if len(in.Project.Steps) == 0 {
		return ItemResult{}, fail("This project has no steps")
	}
	first := in.Project.Steps[0]
	var runID *string
	if in.Parent.Claim != nil && in.Parent.Claim.AgentUID == ctx.Actor.ID {
		runID = sp(in.Parent.Claim.RunID)
	}
	itemID := in.ItemID
	if itemID == "" {
		itemID = ctx.nid()
	}
	p := Plan(ctx, "finding.raised", Scope{sp(in.ProjectID), sp(itemID), runID},
		map[string]any{"parentItemId": in.ParentItemID, "title": jsSlice(title, 300)},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, itemID), Data: map[string]any{
				"title":           jsSlice(title, 300),
				"type":            "finding",
				"stepId":          first.ID,
				"status":          "suggested",
				"summary":         jsSlice(in.Details, 20000),
				"source":          map[string]any{"kind": "finding", "label": jsSlice(ctx.Actor.Name+" on "+in.Parent.Title, 200)},
				"createdBy":       map[string]any{"type": "agent", "id": ctx.Actor.ID},
				"parentItemId":    in.ParentItemID,
				"sourceRunId":     orNull(runID),
				"claim":           nil,
				"progress":        nil,
				"gate":            nil,
				"triage":          nil,
				"sendBackCount":   int64(0),
				"attachmentCount": int64(0),
				"costEur":         int64(0),
				"order":           ctx.now().UnixMilli(),
				"updatedAt":       ServerTime(),
				"lastEventId":     eventID,
			}}}
		}, "")
	return ItemResult{Plan: p, ItemID: itemID}, nil
}
