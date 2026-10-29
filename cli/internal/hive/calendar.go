package hive

// The calendar tools (Inbox item w9SAf; ported from the former TypeScript calendar.ts): calendar_upsert,
// calendar_delete and calendar_free, as the agent.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

var rfc3339 = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$`)

// jsonQuote is JSON.stringify of a string.
func jsonQuote(s string) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(s)
	return strings.TrimSuffix(b.String(), "\n")
}

// ParseTime reads an RFC 3339 time with a zone (seconds optional), as the TypeScript CLI does.
func ParseTime(v, what string) (time.Time, error) {
	bad := Errf(fmt.Sprintf("%s must be a time like 2026-11-02T09:00:00Z or 2026-11-02T10:00:00+01:00 (got %s).", what, jsonQuote(v)))
	if !rfc3339.MatchString(v) {
		return time.Time{}, bad
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t, nil
		}
	}
	return time.Time{}, bad
}

// CalendarEventArg is one event of calendar_upsert.
type CalendarEventArg struct {
	Source        string
	SourceEventID string
	Title         *string
	Start, End    string
	AllDay        *bool
	Attendees     []string
	BusyOnly      *bool
}

// ResolveMember is the uid of a member of this organization, from their uid, email or exact name.
func (c *Client) ResolveMember(ctx context.Context, member string) (string, error) {
	snap, err := c.DB.Doc(model.Paths.Workspace(c.WorkspaceID)).Get(ctx)
	if err != nil {
		return "", c.read(ctx, err)
	}
	var ws struct {
		MemberRoles map[string]string `firestore:"memberRoles"`
	}
	if err := snap.DataTo(&ws); err != nil {
		return "", err
	}
	uids := make([]string, 0, len(ws.MemberRoles))
	for u := range ws.MemberRoles {
		uids = append(uids, u)
	}
	sort.Strings(uids)
	want := jsTrim(member)
	if want == "" {
		if len(uids) == 1 {
			return uids[0], nil
		}
		return "", Errf("Name the member (their uid, email or name): this organization has more than one.")
	}
	for _, u := range uids {
		if u == want {
			return u, nil
		}
	}
	low := strings.ToLower(want)
	var hits []string
	for _, u := range uids {
		s, err := c.DB.Doc(model.Paths.Member(c.WorkspaceID, u)).Get(ctx)
		if err != nil {
			if NotFound(err) {
				continue
			}
			return "", c.read(ctx, err)
		}
		var card struct {
			Name  string `firestore:"name"`
			Email string `firestore:"email"`
		}
		_ = s.DataTo(&card)
		if strings.ToLower(card.Email) == low || strings.ToLower(card.Name) == low {
			hits = append(hits, u)
		}
	}
	if len(hits) == 1 {
		return hits[0], nil
	}
	if len(hits) > 1 {
		return "", Errf(fmt.Sprintf("More than one member is called %s: use their email or uid.", jsonQuote(want)))
	}
	return "", Errf(fmt.Sprintf("%s is not a member of this organization.", jsonQuote(want)))
}

// CalendarUpsertOut is calendar_upsert's answer.
type CalendarUpsertOut struct {
	Member   string   `json:"member"`
	IDs      []string `json:"ids"`
	Upserted int      `json:"upserted"`
	Note     string   `json:"note"`
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// CalendarUpsert saves events in a member's calendar here, with their busy blocks.
func (c *Client) CalendarUpsert(ctx context.Context, member string, events []CalendarEventArg) (CalendarUpsertOut, error) {
	uid, err := c.ResolveMember(ctx, member)
	if err != nil {
		return CalendarUpsertOut{}, err
	}
	in := make([]actions.CalendarEventInput, len(events))
	for i, e := range events {
		start, err := ParseTime(e.Start, fmt.Sprintf("Event %d: start", i+1))
		if err != nil {
			return CalendarUpsertOut{}, err
		}
		end, err := ParseTime(e.End, fmt.Sprintf("Event %d: end", i+1))
		if err != nil {
			return CalendarUpsertOut{}, err
		}
		in[i] = actions.CalendarEventInput{Source: e.Source, SourceEventID: e.SourceEventID, Title: e.Title, Start: start, End: end, AllDay: e.AllDay, Attendees: e.Attendees, BusyOnly: e.BusyOnly}
	}
	r, err := actions.CalendarUpsert(c.actx(), actions.CalendarUpsertInput{MemberUID: uid, Events: in})
	if err != nil {
		return CalendarUpsertOut{}, wrap(err)
	}
	if err := c.Write(ctx, r.Plan, nil); err != nil {
		return CalendarUpsertOut{}, err
	}
	n := len(r.IDs)
	return CalendarUpsertOut{Member: uid, IDs: r.IDs, Upserted: n, Note: fmt.Sprintf("Saved %d event%s in this organization's calendar of the member, with their busy time (no details) for the other organizations they are in. The same source event id updates the same event.", n, plural(n))}, nil
}

// CalendarDeleteOut is calendar_delete's answer.
type CalendarDeleteOut struct {
	Deleted  int      `json:"deleted"`
	IDs      []string `json:"ids"`
	NotFound []string `json:"notFound"`
	Note     string   `json:"note"`
}

// CalendarDelete removes events (by id, or by source and source event ids) and frees their time.
func (c *Client) CalendarDelete(ctx context.Context, ids []string, member, source string, sourceEventIDs []string) (CalendarDeleteOut, error) {
	all := append([]string{}, ids...)
	if len(sourceEventIDs) > 0 {
		if jsTrim(source) == "" {
			return CalendarDeleteOut{}, Errf("Give the source of the sourceEventIds (for example google).")
		}
		uid, err := c.ResolveMember(ctx, member)
		if err != nil {
			return CalendarDeleteOut{}, err
		}
		for _, s := range sourceEventIDs {
			all = append(all, actions.CalendarEventID(uid, jsTrim(source), s))
		}
	}
	if len(all) == 0 {
		return CalendarDeleteOut{}, Errf("Give ids, or source and sourceEventIds.")
	}
	out := CalendarDeleteOut{IDs: []string{}, NotFound: []string{}}
	var found []actions.CalendarRef
	seen := map[string]bool{}
	for _, id := range all {
		if seen[id] {
			continue
		}
		seen[id] = true
		s, err := c.DB.Doc(actions.CalendarPaths.Event(c.WorkspaceID, id)).Get(ctx)
		if err != nil && !NotFound(err) {
			return CalendarDeleteOut{}, c.read(ctx, err)
		}
		var d struct {
			MemberUID string `firestore:"memberUid"`
			Deleted   bool   `firestore:"deleted"`
		}
		if err == nil && s.Exists() {
			_ = s.DataTo(&d)
		}
		if d.MemberUID == "" || d.Deleted {
			out.NotFound = append(out.NotFound, id)
			continue
		}
		found = append(found, actions.CalendarRef{ID: id, MemberUID: d.MemberUID})
		out.IDs = append(out.IDs, id)
	}
	if len(found) > 0 {
		p, err := actions.CalendarDelete(c.actx(), actions.CalendarDeleteInput{Events: found})
		if err != nil {
			return CalendarDeleteOut{}, wrap(err)
		}
		if err := c.Write(ctx, p, nil); err != nil {
			return CalendarDeleteOut{}, err
		}
	}
	out.Deleted = len(found)
	if out.Deleted > 0 {
		out.Note = fmt.Sprintf("Removed %d event%s and freed the busy time.", out.Deleted, plural(out.Deleted))
	} else {
		out.Note = "Nothing to remove: no such events in this organization."
	}
	return out, nil
}

// ensureHome says once which organization this agent is in, so it may read its members' busy time.
func (c *Client) ensureHome(ctx context.Context) error {
	ref := c.DB.Doc(actions.CalendarPaths.AgentHome(c.UID))
	s, err := ref.Get(ctx)
	if err == nil && s.Exists() {
		return nil
	}
	if err != nil && !NotFound(err) {
		return c.read(ctx, err)
	}
	if _, err := ref.Create(ctx, map[string]any{"workspaceId": c.WorkspaceID}); err != nil {
		return c.read(ctx, err)
	}
	return nil
}

// FreeSlotOut is one free slot.
type FreeSlotOut struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// CalendarFreeOut is calendar_free's answer.
type CalendarFreeOut struct {
	Member     string        `json:"member"`
	From       string        `json:"from"`
	To         string        `json:"to"`
	MinMinutes float64       `json:"minMinutes"`
	Free       []FreeSlotOut `json:"free"`
	BusyBlocks int           `json:"busyBlocks"`
	Note       string        `json:"note"`
}

// CalendarFree is a member's free time across all their organizations (busy blocks only).
func (c *Client) CalendarFree(ctx context.Context, member, fromS, toS string, minMinutes *float64) (CalendarFreeOut, error) {
	uid, err := c.ResolveMember(ctx, member)
	if err != nil {
		return CalendarFreeOut{}, err
	}
	from, err := ParseTime(fromS, "from")
	if err != nil {
		return CalendarFreeOut{}, err
	}
	to, err := ParseTime(toS, "to")
	if err != nil {
		return CalendarFreeOut{}, err
	}
	min := float64(actions.DefaultFreeMinMinutes)
	if minMinutes != nil {
		min = *minMinutes
	}
	if _, err := actions.FreeSlots(actions.FreeSlotsInput{From: from, To: to, MinMinutes: &min}); err != nil {
		return CalendarFreeOut{}, wrap(err)
	}
	if err := c.ensureHome(ctx); err != nil {
		return CalendarFreeOut{}, err
	}
	docs, err := c.DB.Collection(actions.CalendarPaths.Busy(uid)).Where("end", ">", from).Documents(ctx).GetAll()
	if err != nil {
		return CalendarFreeOut{}, c.read(ctx, err)
	}
	var busy []actions.Slot
	for _, d := range docs {
		var b struct {
			Start   time.Time `firestore:"start"`
			End     time.Time `firestore:"end"`
			Deleted bool      `firestore:"deleted"`
		}
		if err := d.DataTo(&b); err != nil || b.Deleted || !b.Start.Before(to) {
			continue
		}
		busy = append(busy, actions.Slot{Start: b.Start, End: b.End})
	}
	slots, err := actions.FreeSlots(actions.FreeSlotsInput{From: from, To: to, Busy: busy, MinMinutes: &min})
	if err != nil {
		return CalendarFreeOut{}, wrap(err)
	}
	free := make([]FreeSlotOut, len(slots))
	for i, s := range slots {
		free[i] = FreeSlotOut{Start: iso(s.Start), End: iso(s.End)}
	}
	return CalendarFreeOut{Member: uid, From: iso(from), To: iso(to), MinMinutes: min, Free: free, BusyBlocks: len(busy), Note: "Free time across all the organizations the member is in (busy time only, never details). Times are UTC; propose slots in the member’s own time zone and working hours."}, nil
}
