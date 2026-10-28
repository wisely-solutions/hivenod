package actions

import (
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// AgentCreateOffMessage is the refusal when a project does not let agents create items (item DhsO9).
const AgentCreateOffMessage = `This project does not let agents create items. An admin or the project creator can switch on "Agents may create items" in Settings, Projects.`

// AgentsMayCreateItems is agentsMayCreateItems(project) (absent = off).
func AgentsMayCreateItems(p model.Project) bool {
	return p.AgentsMayCreateItems != nil && *p.AgentsMayCreateItems
}

// Source is an item's source {kind, label}.
type Source struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
}

// CreateItemInput is createItem's input.
type CreateItemInput struct {
	Project   model.Project `json:"project"`
	ProjectID string        `json:"projectId"`
	// ItemID defaults to a new id.
	ItemID       string  `json:"itemId,omitempty"`
	Title        string  `json:"title"`
	Type         string  `json:"type"`
	Summary      *string `json:"summary,omitempty"`
	Source       *Source `json:"source,omitempty"`
	Order        *int64  `json:"order,omitempty"`
	ParentItemID *string `json:"parentItemId,omitempty"`
	// Unshaped: the item waits to be shaped (card st5INNZj).
	Unshaped bool `json:"unshaped,omitempty"`
}

// UnshapedArrival is unshapedArrival(project): a new item waiting to be shaped at the first step.
func UnshapedArrival(project model.Project) (map[string]any, error) {
	if len(project.Steps) == 0 {
		return nil, fail("This project has no steps")
	}
	return map[string]any{
		"stepId": project.Steps[0].ID,
		"status": "queued",
		"claim":  nil,
		"gate":   nil,
		"shape":  nil,
		"stepAt": ServerTime(),
	}, nil
}

// CreateItem is createItem: a new item at the project's first step, by a person or (when the
// project allows it) an agent.
func CreateItem(ctx Ctx, in CreateItemInput) (ItemResult, error) {
	byAgent := ctx.Actor.Type == "agent"
	if byAgent && !AgentsMayCreateItems(in.Project) {
		return ItemResult{}, fail(AgentCreateOffMessage)
	}
	itemID := in.ItemID
	if itemID == "" {
		itemID = ctx.nid()
	}
	if len(in.Project.Steps) == 0 {
		return ItemResult{}, fail("This project has no steps")
	}
	first := in.Project.Steps[0]
	var at map[string]any
	if in.Unshaped {
		var err error
		if at, err = UnshapedArrival(in.Project); err != nil {
			return ItemResult{}, err
		}
	} else {
		at = Arrival(first)
	}
	source := map[string]any{"kind": "manual", "label": jsSlice(ctx.Actor.Name, 200)}
	if byAgent {
		source["kind"] = "agent"
	}
	if in.Source != nil {
		source = map[string]any{"kind": in.Source.Kind, "label": in.Source.Label}
	}
	summary := ""
	if in.Summary != nil {
		summary = *in.Summary
	}
	order := ctx.now().UnixMilli()
	if in.Order != nil {
		order = *in.Order
	}
	p := Plan(ctx, "item.created", Scope{sp(in.ProjectID), sp(itemID), nil},
		map[string]any{"title": in.Title},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, itemID), Data: merge(map[string]any{
				"title":           in.Title,
				"type":            in.Type,
				"summary":         summary,
				"source":          source,
				"createdBy":       map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
				"parentItemId":    orNull(in.ParentItemID),
				"sourceRunId":     nil,
				"progress":        nil,
				"triage":          nil,
				"sendBackCount":   int64(0),
				"attachmentCount": int64(0),
				"costEur":         int64(0),
				"order":           order,
				"updatedAt":       ServerTime(),
				"lastEventId":     eventID,
			}, at)}}
		}, "")
	return ItemResult{Plan: p, ItemID: itemID}, nil
}
