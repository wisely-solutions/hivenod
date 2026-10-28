package actions

// Syncing a calendar the agent reads itself (packages/shared/src/calendarSync.ts, Inbox item
// fJnu6): plans which events to add or update, remove, keep and skip.

import (
	"regexp"
	"time"
)

const (
	MaxSyncItems    = 2500
	SyncPastMs      = 24 * 3_600_000
	SyncAheadMs     = 30 * 24 * 3_600_000
	MaxSyncWindowMs = 62 * 24 * 3_600_000
)

// GoogleTime is a Google Calendar start or end.
type GoogleTime struct {
	DateTime *string `json:"dateTime,omitempty"`
	Date     *string `json:"date,omitempty"`
}

// GoogleAttendee is one attendee of a Google event.
type GoogleAttendee struct {
	Email          *string `json:"email,omitempty"`
	Self           *bool   `json:"self,omitempty"`
	Resource       *bool   `json:"resource,omitempty"`
	ResponseStatus *string `json:"responseStatus,omitempty"`
}

// GoogleEvent is the part of a Google Calendar API v3 Event that matters here.
type GoogleEvent struct {
	ID           *string          `json:"id,omitempty"`
	Status       *string          `json:"status,omitempty"`
	Summary      *string          `json:"summary,omitempty"`
	Start        *GoogleTime      `json:"start,omitempty"`
	End          *GoogleTime      `json:"end,omitempty"`
	Attendees    []GoogleAttendee `json:"attendees,omitempty"`
	Transparency *string          `json:"transparency,omitempty"`
	EventType    *string          `json:"eventType,omitempty"`
}

// SyncedEvent is a synced event of this member and source as stored in Hivenod.
type SyncedEvent struct {
	SourceEventID string    `json:"sourceEventId"`
	Title         string    `json:"title"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	AllDay        bool      `json:"allDay"`
	Attendees     []string  `json:"attendees"`
	BusyOnly      bool      `json:"busyOnly"`
	Deleted       bool      `json:"deleted"`
}

// SyncPlanInput is planCalendarSync's input.
type SyncPlanInput struct {
	Source   string        `json:"source"`
	Mode     string        `json:"mode"`
	From     time.Time     `json:"from"`
	To       time.Time     `json:"to"`
	BusyOnly *bool         `json:"busyOnly,omitempty"`
	Existing []SyncedEvent `json:"existing"`
	Items    []GoogleEvent `json:"items"`
}

// SyncUpsert is one event to add or update (every field set).
type SyncUpsert struct {
	Source        string    `json:"source"`
	SourceEventID string    `json:"sourceEventId"`
	Title         string    `json:"title"`
	Start         time.Time `json:"start"`
	End           time.Time `json:"end"`
	AllDay        bool      `json:"allDay"`
	Attendees     []string  `json:"attendees"`
	BusyOnly      bool      `json:"busyOnly"`
}

// SyncSkip is an event left out, and why.
type SyncSkip struct {
	SourceEventID string `json:"sourceEventId"`
	Reason        string `json:"reason"`
}

// SyncPlan is what one sync writes.
type SyncPlan struct {
	Upserts   []SyncUpsert `json:"upserts"`
	Deletes   []string     `json:"deletes"`
	Unchanged int          `json:"unchanged"`
	Skipped   []SyncSkip   `json:"skipped"`
}

var (
	rfc3339Re = regexp.MustCompile(`(?i)^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$`)
	dayRe     = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
)

// ParseRFC3339 reads a time the way JavaScript's Date does for RFC 3339 with a zone (ms precision).
func ParseRFC3339(s string) (time.Time, bool) {
	if !rfc3339Re.MatchString(s) {
		return time.Time{}, false
	}
	layouts := []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00"}
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return time.UnixMilli(t.UnixMilli()).UTC(), true
		}
	}
	return time.Time{}, false
}

func googleTime(t *GoogleTime) (time.Time, bool, bool) {
	if t == nil {
		return time.Time{}, false, false
	}
	if t.DateTime != nil {
		at, ok := ParseRFC3339(*t.DateTime)
		return at, false, ok
	}
	if t.Date == nil {
		return time.Time{}, false, false
	}
	m := dayRe.FindStringSubmatch(*t.Date)
	if m == nil {
		return time.Time{}, false, false
	}
	d, err := time.Parse("2006-01-02", *t.Date)
	if err != nil {
		return time.Time{}, false, false
	}
	return d.UTC(), true, true
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func notBusy(e GoogleEvent) bool {
	if str(e.Status) == "cancelled" || str(e.EventType) == "workingLocation" || str(e.Transparency) == "transparent" {
		return true
	}
	for _, a := range e.Attendees {
		if a.Self != nil && *a.Self && str(a.ResponseStatus) == "declined" {
			return true
		}
	}
	return false
}

type syncNormal struct {
	kind   string // busy, gone, skip
	event  SyncUpsert
	reason string
}

func normalizeSync(e GoogleEvent, in SyncPlanInput, source string) syncNormal {
	if notBusy(e) {
		return syncNormal{kind: "gone"}
	}
	start, sAll, ok1 := googleTime(e.Start)
	end, eAll, ok2 := googleTime(e.End)
	if !ok1 || !ok2 {
		return syncNormal{kind: "skip", reason: "no valid start and end"}
	}
	if !end.After(start) {
		return syncNormal{kind: "skip", reason: "ends before it starts"}
	}
	if end.UnixMilli()-start.UnixMilli() > MaxCalendarEventMs {
		if in.From.After(start) {
			start = in.From
		}
		if in.To.Before(end) {
			end = in.To
		}
		if !end.After(start) {
			return syncNormal{kind: "skip", reason: "longer than 31 days and outside the window"}
		}
		if end.UnixMilli()-start.UnixMilli() > MaxCalendarEventMs {
			return syncNormal{kind: "skip", reason: "longer than 31 days"}
		}
	}
	busyOnly := in.BusyOnly != nil && *in.BusyOnly
	attendees := []string{}
	title := ""
	if !busyOnly {
		for _, a := range e.Attendees {
			if a.Resource != nil && *a.Resource {
				continue
			}
			s := jsSlice(jsTrim(str(a.Email)), MaxCalendarAttendeeChars)
			if s == "" {
				continue
			}
			if len(attendees) < MaxCalendarAttendees {
				attendees = append(attendees, s)
			}
		}
		title = jsSlice(jsTrim(str(e.Summary)), MaxCalendarTitleChars)
	}
	return syncNormal{kind: "busy", event: SyncUpsert{Source: source, SourceEventID: str(e.ID), Title: title, Start: start, End: end, AllDay: sAll && eAll, Attendees: attendees, BusyOnly: busyOnly}}
}

func sameSynced(a SyncedEvent, b SyncUpsert) bool {
	if a.Deleted || a.Title != b.Title || !a.Start.Equal(b.Start) || !a.End.Equal(b.End) || a.AllDay != b.AllDay || a.BusyOnly != b.BusyOnly || len(a.Attendees) != len(b.Attendees) {
		return false
	}
	for i := range a.Attendees {
		if a.Attendees[i] != b.Attendees[i] {
			return false
		}
	}
	return true
}

// PlanCalendarSync plans one sync of a member's calendar from a source.
func PlanCalendarSync(in SyncPlanInput) (SyncPlan, error) {
	source := jsTrim(in.Source)
	if source == "" {
		return SyncPlan{}, fail("Give the source (for example google)")
	}
	if in.Mode != "full" && in.Mode != "incremental" {
		return SyncPlan{}, fail("The mode is full or incremental")
	}
	if in.From.IsZero() || in.To.IsZero() {
		return SyncPlan{}, fail("from and to must be valid times")
	}
	from, to := in.From.UnixMilli(), in.To.UnixMilli()
	if to <= from {
		return SyncPlan{}, fail("to must be after from")
	}
	if to-from > MaxSyncWindowMs {
		return SyncPlan{}, fail("Sync at most 62 days at once")
	}
	if len(in.Items) > MaxSyncItems {
		return SyncPlan{}, fail("At most 2500 events per sync")
	}
	have := map[string]SyncedEvent{}
	for _, e := range in.Existing {
		have[e.SourceEventID] = e
	}
	order := []string{}
	latest := map[string]syncNormal{}
	out := SyncPlan{Upserts: []SyncUpsert{}, Deletes: []string{}, Skipped: []SyncSkip{}}
	for _, e := range in.Items {
		id := str(e.ID)
		if jsTrim(id) == "" {
			out.Skipped = append(out.Skipped, SyncSkip{SourceEventID: "", Reason: "no id"})
			continue
		}
		if _, seen := latest[id]; !seen {
			order = append(order, id)
		}
		latest[id] = normalizeSync(e, in, source)
	}
	deleting := map[string]bool{}
	for _, id := range order {
		n := latest[id]
		old, had := have[id]
		switch {
		case n.kind == "skip":
			out.Skipped = append(out.Skipped, SyncSkip{SourceEventID: id, Reason: n.reason})
		case n.kind == "gone":
			if had && !old.Deleted {
				out.Deletes = append(out.Deletes, id)
				deleting[id] = true
			}
		case had && sameSynced(old, n.event):
			out.Unchanged++
		default:
			out.Upserts = append(out.Upserts, n.event)
		}
	}
	if in.Mode == "full" {
		for _, e := range in.Existing {
			if _, listed := latest[e.SourceEventID]; e.Deleted || listed || deleting[e.SourceEventID] {
				continue
			}
			if e.End.UnixMilli() > from && e.Start.UnixMilli() < to {
				out.Deletes = append(out.Deletes, e.SourceEventID)
				deleting[e.SourceEventID] = true
			}
		}
	}
	return out, nil
}
