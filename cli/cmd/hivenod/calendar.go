package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/hive"
)

// calendarCmd is `hivenod calendar upsert|delete|free` (Inbox item w9SAf), like the MCP tools.
func calendarCmd(ctx context.Context, o opts, pos []string, resolve func() (hive.Config, error), stdin io.Reader, say func(string), fail func(error) int, stderr io.Writer) int {
	usage := func() int {
		fmt.Fprintln(stderr, "hivenod: Usage: hivenod calendar upsert <events.json|-> [--member M] | delete <id>... | delete --source S [--member M] <sourceEventId>... | free --from T --to T [--member M] [--min N] | sync <events.json|-> [--source S] [--member M] [--from T --to T] [--incremental] [--busy-only] [--state FILE]")
		return 2
	}
	if len(pos) < 2 {
		return usage()
	}
	var events []hive.CalendarEventArg
	var min *float64
	var feed hive.SyncFeed
	switch pos[1] {
	case "sync":
		if len(pos) < 3 {
			return usage()
		}
		var b []byte
		var err error
		if pos[2] == "-" {
			b, err = io.ReadAll(stdin)
		} else {
			b, err = os.ReadFile(pos[2])
		}
		if err != nil {
			return fail(hive.Errf(pos[2] + ": cannot read it."))
		}
		if feed, err = hive.ParseFeed(b, pos[2]); err != nil {
			return fail(err)
		}
	case "upsert":
		if len(pos) < 3 {
			return usage()
		}
		var b []byte
		var err error
		if pos[2] == "-" {
			b, err = io.ReadAll(stdin)
		} else {
			b, err = os.ReadFile(pos[2])
		}
		var raw []map[string]any
		if err == nil {
			err = json.Unmarshal(b, &raw)
		}
		if err != nil {
			return fail(hive.Errf(pos[2] + ": not a JSON array of events."))
		}
		for _, m := range raw {
			a := hive.Args(m)
			ev := hive.CalendarEventArg{Source: a.S("source"), SourceEventID: a.S("sourceEventId"), Title: a.SP("title"), Start: a.S("start"), End: a.S("end"), Attendees: a.Strings("attendees")}
			if v, ok := m["allDay"].(bool); ok {
				ev.AllDay = &v
			}
			if v, ok := m["busyOnly"].(bool); ok {
				ev.BusyOnly = &v
			}
			events = append(events, ev)
		}
	case "delete":
	case "free":
		if o.from == "" || o.to == "" {
			return usage()
		}
		if o.min != "" {
			n, err := strconv.ParseFloat(o.min, 64)
			if err != nil || n < 0 {
				return fail(hive.Errf("--min must be a number >= 0"))
			}
			min = &n
		}
	default:
		return usage()
	}
	cfg, err := resolve()
	if err != nil {
		return fail(err)
	}
	c, err := hive.Connect(ctx, cfg, "")
	if err != nil {
		return fail(err)
	}
	defer c.Close()
	out := func(v any, text string) int {
		if o.json {
			say(hive.JSON(v))
		} else {
			say(text)
		}
		return 0
	}
	switch pos[1] {
	case "sync":
		r, err := c.CalendarSync(ctx, hive.SyncArgs{Member: o.member, Source: o.source, Incremental: o.incremental, BusyOnly: o.busyOnly, From: o.from, To: o.to, Feed: feed})
		if err != nil {
			return fail(err)
		}
		if o.state != "" {
			if err := hive.SaveSyncState(o.state, r); err != nil {
				return fail(err)
			}
		}
		lines := []string{r.Note}
		for _, k := range r.Skipped {
			id := k.SourceEventID
			if id == "" {
				id = "(no id)"
			}
			lines = append(lines, "  skipped "+id+": "+k.Reason)
		}
		return out(r, strings.Join(lines, "\n"))
	case "upsert":
		r, err := c.CalendarUpsert(ctx, o.member, events)
		if err != nil {
			return fail(err)
		}
		return out(r, r.Note)
	case "delete":
		ids := pos[2:]
		var r hive.CalendarDeleteOut
		if o.source != "" {
			r, err = c.CalendarDelete(ctx, nil, o.member, o.source, ids)
		} else {
			r, err = c.CalendarDelete(ctx, ids, o.member, "", nil)
		}
		if err != nil {
			return fail(err)
		}
		lines := []string{r.Note}
		for _, id := range r.NotFound {
			lines = append(lines, "  not found: "+id)
		}
		return out(r, strings.Join(lines, "\n"))
	default:
		r, err := c.CalendarFree(ctx, o.member, o.from, o.to, min)
		if err != nil {
			return fail(err)
		}
		if len(r.Free) == 0 {
			return out(r, "No free time in that range.")
		}
		lines := make([]string, len(r.Free))
		for i, f := range r.Free {
			lines[i] = f.Start + "  to  " + f.End
		}
		return out(r, strings.Join(lines, "\n"))
	}
}
