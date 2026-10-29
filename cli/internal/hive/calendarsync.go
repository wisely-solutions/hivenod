package hive

// calendar sync (Inbox item fJnu6; ported from the former TypeScript calendar.ts syncEvents): a calendar the
// agent reads itself, synced into this organization.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

// SyncFeed is what the agent read from the source with its own access.
type SyncFeed struct {
	Items         []actions.GoogleEvent
	NextSyncToken *string
}

// ParseFeed reads `{"items": [...], "nextSyncToken": "…"}` or `[...]`.
func ParseFeed(b []byte, name string) (SyncFeed, error) {
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		return SyncFeed{}, Errf(name + ": not JSON.")
	}
	var items json.RawMessage
	var token *string
	switch x := v.(type) {
	case []any:
		items = b
	case map[string]any:
		if _, ok := x["items"].([]any); !ok {
			return SyncFeed{}, Errf(name + `: give a Google Calendar events list ({"items": [...]}) or an array of events.`)
		}
		var o struct {
			Items json.RawMessage `json:"items"`
		}
		_ = json.Unmarshal(b, &o)
		items = o.Items
		if t, ok := x["nextSyncToken"].(string); ok {
			token = &t
		}
	default:
		return SyncFeed{}, Errf(name + `: give a Google Calendar events list ({"items": [...]}) or an array of events.`)
	}
	var raw []json.RawMessage
	if err := json.Unmarshal(items, &raw); err != nil {
		return SyncFeed{}, Errf(name + ": not JSON.")
	}
	out := SyncFeed{Items: make([]actions.GoogleEvent, 0, len(raw)), NextSyncToken: token}
	for _, r := range raw {
		var e actions.GoogleEvent
		// Fields of another type are left out, as the TypeScript CLI ignores what it does not use.
		_ = json.Unmarshal(r, &e)
		out.Items = append(out.Items, e)
	}
	return out, nil
}

// SyncArgs are calendar sync's arguments.
type SyncArgs struct {
	Member, Source        string
	Incremental, BusyOnly bool
	From, To              string
	Feed                  SyncFeed
	Now                   *time.Time
}

// CalendarSyncOut is calendar sync's answer.
type CalendarSyncOut struct {
	Member        string             `json:"member"`
	Source        string             `json:"source"`
	Mode          string             `json:"mode"`
	From          string             `json:"from"`
	To            string             `json:"to"`
	Upserted      int                `json:"upserted"`
	Deleted       int                `json:"deleted"`
	Unchanged     int                `json:"unchanged"`
	Skipped       []actions.SyncSkip `json:"skipped"`
	NextSyncToken *string            `json:"nextSyncToken"`
	Note          string             `json:"note"`
}

// CalendarSync syncs a member's calendar from a source into this organization.
func (c *Client) CalendarSync(ctx context.Context, a SyncArgs) (CalendarSyncOut, error) {
	uid, err := c.ResolveMember(ctx, a.Member)
	if err != nil {
		return CalendarSyncOut{}, err
	}
	source := "google"
	if a.Source != "" {
		source = a.Source
	}
	source = jsTrim(source)
	now := time.Now()
	if a.Now != nil {
		now = *a.Now
	}
	from := now.Add(-actions.SyncPastMs * time.Millisecond)
	to := now.Add(actions.SyncAheadMs * time.Millisecond)
	if a.From != "" {
		if from, err = ParseTime(a.From, "from"); err != nil {
			return CalendarSyncOut{}, err
		}
	}
	if a.To != "" {
		if to, err = ParseTime(a.To, "to"); err != nil {
			return CalendarSyncOut{}, err
		}
	}
	from = time.UnixMilli(from.UnixMilli()).UTC()
	to = time.UnixMilli(to.UnixMilli()).UTC()
	mode := "full"
	if a.Incremental {
		mode = "incremental"
	}
	if _, err := actions.PlanCalendarSync(actions.SyncPlanInput{Source: source, Mode: mode, From: from, To: to}); err != nil {
		return CalendarSyncOut{}, wrap(err)
	}
	docs, err := c.DB.Collection(actions.CalendarPaths.Events(c.WorkspaceID)).Where("memberUid", "==", uid).Where("end", ">", from).Documents(ctx).GetAll()
	if err != nil {
		return CalendarSyncOut{}, c.read(ctx, err)
	}
	existing := []actions.SyncedEvent{}
	for _, d := range docs {
		var e struct {
			Source        string    `firestore:"source"`
			SourceEventID string    `firestore:"sourceEventId"`
			Title         string    `firestore:"title"`
			Start         time.Time `firestore:"start"`
			End           time.Time `firestore:"end"`
			AllDay        bool      `firestore:"allDay"`
			Attendees     []string  `firestore:"attendees"`
			BusyOnly      bool      `firestore:"busyOnly"`
			Deleted       bool      `firestore:"deleted"`
		}
		if err := d.DataTo(&e); err != nil || e.Source != source {
			continue
		}
		if e.Attendees == nil {
			e.Attendees = []string{}
		}
		existing = append(existing, actions.SyncedEvent{SourceEventID: e.SourceEventID, Title: e.Title, Start: e.Start, End: e.End, AllDay: e.AllDay, Attendees: e.Attendees, BusyOnly: e.BusyOnly, Deleted: e.Deleted})
	}
	sort.SliceStable(existing, func(i, j int) bool { return existing[i].SourceEventID < existing[j].SourceEventID })
	busyOnly := a.BusyOnly
	p, err := actions.PlanCalendarSync(actions.SyncPlanInput{Source: source, Mode: mode, From: from, To: to, BusyOnly: &busyOnly, Existing: existing, Items: a.Feed.Items})
	if err != nil {
		return CalendarSyncOut{}, wrap(err)
	}
	n := actions.MaxCalendarEventsPerWrite
	for i := 0; i < len(p.Upserts); i += n {
		j := min(i+n, len(p.Upserts))
		in := make([]actions.CalendarEventInput, 0, j-i)
		for _, u := range p.Upserts[i:j] {
			title, allDay, busy := u.Title, u.AllDay, u.BusyOnly
			in = append(in, actions.CalendarEventInput{Source: u.Source, SourceEventID: u.SourceEventID, Title: &title, Start: u.Start, End: u.End, AllDay: &allDay, Attendees: u.Attendees, BusyOnly: &busy})
		}
		r, err := actions.CalendarUpsert(c.actx(), actions.CalendarUpsertInput{MemberUID: uid, Events: in})
		if err != nil {
			return CalendarSyncOut{}, wrap(err)
		}
		if err := c.Write(ctx, r.Plan, nil); err != nil {
			return CalendarSyncOut{}, err
		}
	}
	for i := 0; i < len(p.Deletes); i += n {
		j := min(i+n, len(p.Deletes))
		refs := make([]actions.CalendarRef, 0, j-i)
		for _, sid := range p.Deletes[i:j] {
			refs = append(refs, actions.CalendarRef{ID: actions.CalendarEventID(uid, source, sid), MemberUID: uid})
		}
		pl, err := actions.CalendarDelete(c.actx(), actions.CalendarDeleteInput{Events: refs})
		if err != nil {
			return CalendarSyncOut{}, wrap(err)
		}
		if err := c.Write(ctx, pl, nil); err != nil {
			return CalendarSyncOut{}, err
		}
	}
	note := fmt.Sprintf("Synced %s (%s): %d added or updated, %d removed, %d unchanged", source, mode, len(p.Upserts), len(p.Deletes), p.Unchanged)
	if len(p.Skipped) > 0 {
		note += fmt.Sprintf(", %d skipped", len(p.Skipped))
	}
	return CalendarSyncOut{Member: uid, Source: source, Mode: mode, From: iso(from), To: iso(to), Upserted: len(p.Upserts), Deleted: len(p.Deletes), Unchanged: p.Unchanged, Skipped: p.Skipped, NextSyncToken: a.Feed.NextSyncToken, Note: note + "."}, nil
}

// SaveSyncState keeps the source's sync token for the next incremental run (mode 600).
func SaveSyncState(file string, r CalendarSyncOut) error {
	if r.NextSyncToken == nil || *r.NextSyncToken == "" {
		return nil
	}
	b, _ := json.MarshalIndent(map[string]any{"source": r.Source, "member": r.Member, "syncToken": *r.NextSyncToken, "syncedAt": iso(time.Now())}, "", "  ")
	if err := os.WriteFile(file, append(b, '\n'), 0o600); err != nil {
		return Errf(file + ": cannot write the sync state.")
	}
	return nil
}
