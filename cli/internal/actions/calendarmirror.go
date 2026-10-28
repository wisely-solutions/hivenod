package actions

// calendarMirror (packages/shared/src/calendar.ts, Inbox item fJnu6): an approved booking becomes
// its copy in the member's own calendar, in one batch.

import "github.com/wisely-solutions/hivenod/cli/internal/plan"

// CalendarMirrorInput is calendarMirror's input.
type CalendarMirrorInput struct {
	MemberUID  string             `json:"memberUid"`
	ReplacedID string             `json:"replacedId"`
	Event      CalendarEventInput `json:"event"`
}

// CalendarMirrorResult is the plan plus the new event's id.
type CalendarMirrorResult struct {
	plan.Plan
	ID string `json:"id"`
}

// CalendarMirror replaces one event by its copy in another calendar: the copy is upserted, the
// replaced event soft-deleted and its busy block freed.
func CalendarMirror(ctx Ctx, in CalendarMirrorInput) (CalendarMirrorResult, error) {
	if err := requireCalendarWriter(ctx, in.MemberUID); err != nil {
		return CalendarMirrorResult{}, err
	}
	if in.ReplacedID == "" {
		return CalendarMirrorResult{}, fail("Name the event it replaces")
	}
	c, err := cleanEvent(ctx, in.MemberUID, in.Event, 1)
	if err != nil {
		return CalendarMirrorResult{}, err
	}
	if c.id == in.ReplacedID {
		return CalendarMirrorResult{}, fail("That is the same event: give the other calendar's event id")
	}
	p := Plan(ctx, "calendar.changed", Scope{},
		map[string]any{"memberUids": []any{in.MemberUID}, "upserted": int64(1), "deleted": int64(1)},
		func(eventID string) []plan.Op {
			return []plan.Op{
				{Kind: "set", Path: CalendarPaths.Event(ctx.WorkspaceID, c.id), Data: merge(c.doc, map[string]any{"lastEventId": eventID})},
				{Kind: "set", Path: CalendarPaths.BusyBlock(in.MemberUID, BusyBlockID(ctx.WorkspaceID, c.id)), Data: map[string]any{
					"workspaceId": ctx.WorkspaceID,
					"start":       Timestamp(c.start),
					"end":         Timestamp(c.end),
					"deleted":     false,
					"updatedAt":   ServerTime(),
					"lastEventId": eventID,
				}},
				{Kind: "update", Path: CalendarPaths.Event(ctx.WorkspaceID, in.ReplacedID), Data: map[string]any{
					"title":       "",
					"attendees":   []any{},
					"deleted":     true,
					"updatedBy":   map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
					"updatedAt":   ServerTime(),
					"lastEventId": eventID,
				}},
				{Kind: "update", Path: CalendarPaths.BusyBlock(in.MemberUID, BusyBlockID(ctx.WorkspaceID, in.ReplacedID)), Data: map[string]any{
					"deleted":     true,
					"updatedAt":   ServerTime(),
					"lastEventId": eventID,
				}},
			}
		}, "")
	return CalendarMirrorResult{Plan: p, ID: c.id}, nil
}
