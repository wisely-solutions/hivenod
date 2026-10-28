package hive

// calendar_mirror (Inbox item fJnu6; packages/agent/src/calendar.ts mirrorBooking): an approved
// booking becomes its copy in the member's own calendar.

import (
	"context"
	"fmt"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

// MirrorArgs are calendar_mirror's arguments.
type MirrorArgs struct {
	OutcomeID, SourceEventID, Source string
	Start, End                       string
	Title                            *string
}

// CalendarMirrorOut is calendar_mirror's answer.
type CalendarMirrorOut struct {
	Member   string `json:"member"`
	ID       string `json:"id"`
	Replaced string `json:"replaced"`
	Mirrored bool   `json:"mirrored"`
	Note     string `json:"note"`
}

// CalendarMirror turns the booking of an approved reply_book outcome into the member's own calendar's event.
func (c *Client) CalendarMirror(ctx context.Context, a MirrorArgs) (CalendarMirrorOut, error) {
	source := "google"
	if a.Source != "" {
		source = a.Source
	}
	source = jsTrim(source)
	if a.OutcomeID == "" {
		return CalendarMirrorOut{}, Errf("Give the outcome id of the booking.")
	}
	if jsTrim(a.SourceEventID) == "" {
		s := source
		if s == "" {
			s = "source"
		}
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("Give the event's id in the %s calendar.", s))
	}
	o, err := c.outcome(ctx, a.OutcomeID)
	if err != nil {
		return CalendarMirrorOut{}, err
	}
	if o.MemberUID == "" {
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("Outcome %s not found.", a.OutcomeID))
	}
	if o.Type != "reply_book" {
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("Outcome %s is not a booking (reply_book).", a.OutcomeID))
	}
	if o.State != "approved" && o.State != "done" {
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("Outcome %s is not approved (it is %s).", a.OutcomeID, o.State))
	}
	m := o.MemberUID
	replaced := actions.CalendarEventID(m, "hivenod", a.OutcomeID)
	mirror := actions.CalendarEventID(m, source, a.SourceEventID)
	var b struct {
		Title     string    `firestore:"title"`
		Start     time.Time `firestore:"start"`
		End       time.Time `firestore:"end"`
		AllDay    bool      `firestore:"allDay"`
		Attendees []string  `firestore:"attendees"`
		Deleted   bool      `firestore:"deleted"`
	}
	ok, err := c.getDoc(ctx, actions.CalendarPaths.Event(c.WorkspaceID, replaced), &b)
	if err != nil {
		return CalendarMirrorOut{}, err
	}
	if !ok {
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("No booking in the calendar for outcome %s.", a.OutcomeID))
	}
	if b.Deleted {
		var mm struct {
			Deleted bool `firestore:"deleted"`
		}
		ok, err := c.getDoc(ctx, actions.CalendarPaths.Event(c.WorkspaceID, mirror), &mm)
		if err != nil {
			return CalendarMirrorOut{}, err
		}
		if ok && !mm.Deleted {
			return CalendarMirrorOut{Member: m, ID: mirror, Replaced: replaced, Mirrored: false, Note: "Already mirrored: the booking is that event."}, nil
		}
		return CalendarMirrorOut{}, Errf(fmt.Sprintf("The booking of outcome %s was removed from the calendar.", a.OutcomeID))
	}
	start, end := b.Start, b.End
	if a.Start != "" {
		if start, err = ParseTime(a.Start, "start"); err != nil {
			return CalendarMirrorOut{}, err
		}
	}
	if a.End != "" {
		if end, err = ParseTime(a.End, "end"); err != nil {
			return CalendarMirrorOut{}, err
		}
	}
	title := b.Title
	if a.Title != nil {
		title = *a.Title
	}
	allDay := b.AllDay
	r, err := actions.CalendarMirror(c.actx(), actions.CalendarMirrorInput{MemberUID: m, ReplacedID: replaced, Event: actions.CalendarEventInput{Source: source, SourceEventID: a.SourceEventID, Title: &title, Start: time.UnixMilli(start.UnixMilli()).UTC(), End: time.UnixMilli(end.UnixMilli()).UTC(), AllDay: &allDay, Attendees: b.Attendees}})
	if err != nil {
		return CalendarMirrorOut{}, wrap(err)
	}
	if err := c.Write(ctx, r.Plan, nil); err != nil {
		return CalendarMirrorOut{}, err
	}
	return CalendarMirrorOut{Member: m, ID: r.ID, Replaced: replaced, Mirrored: true, Note: fmt.Sprintf("The booking is now the %s event %s: the next sync updates it, never adds it twice. Report the outcome with outcome_done.", source, a.SourceEventID)}, nil
}
