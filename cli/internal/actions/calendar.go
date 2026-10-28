package actions

// The per-member Calendar (packages/shared/src/calendar.ts, Inbox item w9SAfpJGEf4OnAz37epg):
// events in the organization they came from, each mirrored to the member's busy store (no
// titles), soft deletes, and the free-slot calculation calendar_free uses.

import (
	"encoding/base64"
	"fmt"
	"sort"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

const (
	MaxCalendarEventsPerWrite = 100
	MaxCalendarTitleChars     = 300
	MaxCalendarAttendees      = 50
	MaxCalendarAttendeeChars  = 320
	MaxCalendarSourceChars    = 40
	MaxSourceEventIDBytes     = 600
	MaxCalendarEventMs        = 31 * 24 * 3_600_000
	MaxFreeRangeMs            = 62 * 24 * 3_600_000
	DefaultFreeMinMinutes     = 30
)

// CalendarPaths are the calendar's document paths.
var CalendarPaths = struct {
	Events    func(w string) string
	Event     func(w, e string) string
	Busy      func(u string) string
	BusyBlock func(u, b string) string
	AgentHome func(a string) string
}{
	Events:    func(w string) string { return "workspaces/" + w + "/calendar" },
	Event:     func(w, e string) string { return "workspaces/" + w + "/calendar/" + e },
	Busy:      func(u string) string { return "users/" + u + "/busy" },
	BusyBlock: func(u, b string) string { return "users/" + u + "/busy/" + b },
	AgentHome: func(a string) string { return "agentHomes/" + a },
}

// CalendarEventInput is one event to upsert.
type CalendarEventInput struct {
	Source        string    `json:"source"`
	SourceEventID string    `json:"sourceEventId"`
	Title         *string   `json:"title,omitempty"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	AllDay        *bool     `json:"allDay,omitempty"`
	Attendees     []string  `json:"attendees,omitempty"`
	BusyOnly      *bool     `json:"busyOnly,omitempty"`
}

// Timestamp is the placeholder of a Timestamp value in a plan.
func Timestamp(t time.Time) map[string]any {
	return map[string]any{"__hive": "timestamp", "ms": t.UnixMilli()}
}

// CalendarEventID is the document id of a member's event from a source.
func CalendarEventID(memberUID, source, sourceEventID string) string {
	return memberUID + "_" + base64.RawURLEncoding.EncodeToString([]byte(source+"\n"+sourceEventID))
}

// BusyBlockID is the busy block mirroring event eventID of organization workspaceID.
func BusyBlockID(workspaceID, eventID string) string { return workspaceID + "_" + eventID }

func requireCalendarWriter(ctx Ctx, memberUID string) error {
	if memberUID == "" {
		return fail("Name the member whose calendar this is")
	}
	if ctx.Actor.Type == "human" && memberUID != ctx.Actor.ID {
		return fail("People change only their own calendar")
	}
	return nil
}

func checkCalendarCount(n int) error {
	if n == 0 {
		return fail("No events given")
	}
	if n > MaxCalendarEventsPerWrite {
		return fail(fmt.Sprintf("At most %d events per call; send the rest in another call", MaxCalendarEventsPerWrite))
	}
	return nil
}

type cleanCalendarEvent struct {
	id         string
	doc        map[string]any
	start, end time.Time
}

func cleanEvent(ctx Ctx, memberUID string, e CalendarEventInput, n int) (cleanCalendarEvent, error) {
	at := fmt.Sprintf("Event %d", n)
	source := jsTrim(e.Source)
	if source == "" {
		return cleanCalendarEvent{}, fail(at + ": source is required (for example google or outlook)")
	}
	if jsLen(source) > MaxCalendarSourceChars {
		return cleanCalendarEvent{}, fail(fmt.Sprintf("%s: source is at most %d characters", at, MaxCalendarSourceChars))
	}
	if jsTrim(e.SourceEventID) == "" {
		return cleanCalendarEvent{}, fail(at + ": sourceEventId is required")
	}
	if len(e.SourceEventID) > MaxSourceEventIDBytes {
		return cleanCalendarEvent{}, fail(fmt.Sprintf("%s: sourceEventId is at most %d bytes", at, MaxSourceEventIDBytes))
	}
	if e.Start.IsZero() || e.End.IsZero() {
		return cleanCalendarEvent{}, fail(at + ": start and end must be valid times")
	}
	l := e.End.UnixMilli() - e.Start.UnixMilli()
	if l <= 0 {
		return cleanCalendarEvent{}, fail(at + ": end must be after start")
	}
	if l > MaxCalendarEventMs {
		return cleanCalendarEvent{}, fail(at + ": an event lasts at most 31 days")
	}
	busyOnly := e.BusyOnly != nil && *e.BusyOnly
	attendees := []any{}
	if !busyOnly {
		for _, a := range e.Attendees {
			a = jsSlice(jsTrim(a), MaxCalendarAttendeeChars)
			if a != "" && len(attendees) < MaxCalendarAttendees {
				attendees = append(attendees, a)
			}
		}
	}
	title := ""
	if !busyOnly && e.Title != nil {
		title = jsSlice(jsTrim(*e.Title), MaxCalendarTitleChars)
	}
	id := CalendarEventID(memberUID, source, e.SourceEventID)
	return cleanCalendarEvent{id: id, start: e.Start, end: e.End, doc: map[string]any{
		"memberUid":     memberUID,
		"title":         title,
		"start":         Timestamp(e.Start),
		"end":           Timestamp(e.End),
		"allDay":        e.AllDay != nil && *e.AllDay,
		"attendees":     attendees,
		"source":        source,
		"sourceEventId": e.SourceEventID,
		"busyOnly":      busyOnly,
		"deleted":       false,
		"updatedBy":     map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
		"updatedAt":     ServerTime(),
	}}, nil
}

// CalendarUpsertInput is calendarUpsert's input.
type CalendarUpsertInput struct {
	MemberUID string               `json:"memberUid"`
	Events    []CalendarEventInput `json:"events"`
}

// CalendarUpsertResult is the plan plus the event ids, in input order.
type CalendarUpsertResult struct {
	plan.Plan
	IDs []string `json:"ids"`
}

// CalendarUpsert adds or replaces events of one member's calendar in this organization, each
// mirrored to the member's busy store.
func CalendarUpsert(ctx Ctx, in CalendarUpsertInput) (CalendarUpsertResult, error) {
	if err := requireCalendarWriter(ctx, in.MemberUID); err != nil {
		return CalendarUpsertResult{}, err
	}
	if err := checkCalendarCount(len(in.Events)); err != nil {
		return CalendarUpsertResult{}, err
	}
	clean := make([]cleanCalendarEvent, 0, len(in.Events))
	for i, e := range in.Events {
		c, err := cleanEvent(ctx, in.MemberUID, e, i+1)
		if err != nil {
			return CalendarUpsertResult{}, err
		}
		clean = append(clean, c)
	}
	seen := map[string]bool{}
	ids := make([]string, len(clean))
	for i, c := range clean {
		if seen[c.id] {
			return CalendarUpsertResult{}, fail(fmt.Sprintf("Event %d: the same source event is given twice", i+1))
		}
		seen[c.id] = true
		ids[i] = c.id
	}
	p := Plan(ctx, "calendar.changed", Scope{},
		map[string]any{"memberUids": []any{in.MemberUID}, "upserted": int64(len(clean)), "deleted": int64(0)},
		func(eventID string) []plan.Op {
			ops := make([]plan.Op, 0, 2*len(clean))
			for _, c := range clean {
				d := merge(c.doc, map[string]any{"lastEventId": eventID})
				ops = append(ops,
					plan.Op{Kind: "set", Path: CalendarPaths.Event(ctx.WorkspaceID, c.id), Data: d},
					plan.Op{Kind: "set", Path: CalendarPaths.BusyBlock(in.MemberUID, BusyBlockID(ctx.WorkspaceID, c.id)), Data: map[string]any{
						"workspaceId": ctx.WorkspaceID,
						"start":       Timestamp(c.start),
						"end":         Timestamp(c.end),
						"deleted":     false,
						"updatedAt":   ServerTime(),
						"lastEventId": eventID,
					}})
			}
			return ops
		}, "")
	return CalendarUpsertResult{Plan: p, IDs: ids}, nil
}

// CalendarRef is an existing event and its member.
type CalendarRef struct {
	ID        string `json:"id"`
	MemberUID string `json:"memberUid"`
}

// CalendarDeleteInput is calendarDelete's input.
type CalendarDeleteInput struct {
	Events []CalendarRef `json:"events"`
}

// CalendarDelete soft-deletes events: details cleared, busy blocks freed.
func CalendarDelete(ctx Ctx, in CalendarDeleteInput) (plan.Plan, error) {
	if err := checkCalendarCount(len(in.Events)); err != nil {
		return plan.Plan{}, err
	}
	members := []any{}
	have := map[string]bool{}
	seen := map[string]bool{}
	for _, e := range in.Events {
		if err := requireCalendarWriter(ctx, e.MemberUID); err != nil {
			return plan.Plan{}, err
		}
		if e.ID == "" {
			return plan.Plan{}, fail("An event id is missing")
		}
		if seen[e.ID] {
			return plan.Plan{}, fail(fmt.Sprintf("The event %s is given twice", e.ID))
		}
		seen[e.ID] = true
		if !have[e.MemberUID] {
			have[e.MemberUID] = true
			members = append(members, e.MemberUID)
		}
	}
	return Plan(ctx, "calendar.changed", Scope{},
		map[string]any{"memberUids": members, "upserted": int64(0), "deleted": int64(len(in.Events))},
		func(eventID string) []plan.Op {
			ops := make([]plan.Op, 0, 2*len(in.Events))
			for _, e := range in.Events {
				ops = append(ops,
					plan.Op{Kind: "update", Path: CalendarPaths.Event(ctx.WorkspaceID, e.ID), Data: map[string]any{
						"title":       "",
						"attendees":   []any{},
						"deleted":     true,
						"updatedBy":   map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID},
						"updatedAt":   ServerTime(),
						"lastEventId": eventID,
					}},
					plan.Op{Kind: "update", Path: CalendarPaths.BusyBlock(e.MemberUID, BusyBlockID(ctx.WorkspaceID, e.ID)), Data: map[string]any{
						"deleted":     true,
						"updatedAt":   ServerTime(),
						"lastEventId": eventID,
					}})
			}
			return ops
		}, ""), nil
}

// Slot is a span of time.
type Slot struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}

// FreeSlotsInput is freeSlots' input.
type FreeSlotsInput struct {
	From       time.Time `json:"from"`
	To         time.Time `json:"to"`
	Busy       []Slot    `json:"busy"`
	MinMinutes *float64  `json:"minMinutes,omitempty"`
}

// FreeSlots is the free time of [From, To) around busy blocks, at least MinMinutes long.
func FreeSlots(in FreeSlotsInput) ([]Slot, error) {
	if in.From.IsZero() || in.To.IsZero() {
		return nil, fail("from and to must be valid times")
	}
	lo, hi := in.From.UnixMilli(), in.To.UnixMilli()
	if hi-lo <= 0 {
		return nil, fail("to must be after from")
	}
	if hi-lo > MaxFreeRangeMs {
		return nil, fail("Look at most 62 days ahead at once")
	}
	min := float64(DefaultFreeMinMinutes)
	if in.MinMinutes != nil {
		min = *in.MinMinutes
	}
	if min != float64(int64(min)) || min < 1 || min > 1440 {
		return nil, fail("minMinutes is a whole number from 1 to 1440")
	}
	type span struct{ s, e int64 }
	var blocks []span
	for _, b := range in.Busy {
		s, e := b.Start.UnixMilli(), b.End.UnixMilli()
		if s < lo {
			s = lo
		}
		if e > hi {
			e = hi
		}
		if e > s {
			blocks = append(blocks, span{s, e})
		}
	}
	sort.SliceStable(blocks, func(i, j int) bool {
		if blocks[i].s != blocks[j].s {
			return blocks[i].s < blocks[j].s
		}
		return blocks[i].e < blocks[j].e
	})
	out := []Slot{}
	minMs := int64(min) * 60_000
	push := func(s, e int64) {
		if e-s >= minMs {
			out = append(out, Slot{time.UnixMilli(s).UTC(), time.UnixMilli(e).UTC()})
		}
	}
	cursor := lo
	for _, b := range blocks {
		if b.s > cursor {
			push(cursor, b.s)
		}
		if b.e > cursor {
			cursor = b.e
		}
	}
	if hi > cursor {
		push(cursor, hi)
	}
	return out, nil
}
