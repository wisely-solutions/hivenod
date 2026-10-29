package hive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// Lazy connects on the first tool call, so Claude Code can list the tools before the token works;
// a failed sign-in is tried again on the next call.
type Lazy struct {
	Connect func(ctx context.Context) (*Client, error)
	mu      sync.Mutex
	c       *Client
}

// Get returns the client, connecting first if needed.
func (l *Lazy) Get(ctx context.Context) (*Client, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.c != nil {
		return l.c, nil
	}
	c, err := l.Connect(ctx)
	if err != nil {
		return nil, err
	}
	l.c = c
	return c, nil
}

// Current is the connected client, or nil.
func (l *Lazy) Current() *Client {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.c
}

// Args reads tool arguments (already checked against the schema).
type Args map[string]any

// S is a string argument ("" when absent).
func (a Args) S(k string) string {
	s, _ := a[k].(string)
	return s
}

// Strings is a string-array argument (nil when absent).
func (a Args) Strings(k string) []string {
	arr, _ := a[k].([]any)
	var out []string
	for _, e := range arr {
		if s, ok := e.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// Has reports whether an argument was given.
func (a Args) Has(k string) bool { _, ok := a[k]; return ok }

// F is a number argument (nil when absent).
func (a Args) F(k string) *float64 {
	if v, ok := a[k].(float64); ok {
		return &v
	}
	return nil
}

// BP is an optional boolean argument.
func (a Args) BP(k string) *bool {
	if v, ok := a[k].(bool); ok {
		return &v
	}
	return nil
}

// SP is an optional string argument.
func (a Args) SP(k string) *string {
	if v, ok := a[k].(string); ok {
		return &v
	}
	return nil
}

func (a Args) outcome() Outcome {
	o := Outcome{CostEur: a.F("costEur"), TokensIn: a.F("tokensIn"), TokensOut: a.F("tokensOut"), TokensCached: a.F("tokensCached"), Summary: a.SP("summary")}
	if a.Has("model") {
		o.ModelSet, o.Model = true, a.SP("model")
	}
	return o
}

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// Run is a tool's work with a connected client.
type Run func(ctx context.Context, c *Client, a Args) (any, error)

// ToolRuns are the agent operations by tool name (packages/agent/src/tools.ts).
var ToolRuns = map[string]Run{
	"list_work": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ListWork(ctx, Filter{ProjectID: a.S("project"), StepID: a.S("step")})
	},
	"wait_for_work": func(ctx context.Context, c *Client, a Args) (any, error) {
		secs := 300.0
		if v := a.F("timeoutSeconds"); v != nil {
			secs = *v
		}
		return c.WaitForWork(ctx, Filter{ProjectID: a.S("project"), StepID: a.S("step")}, time.Duration(secs*float64(time.Second)), nil)
	},
	"claim": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Claim(ctx, a.S("itemId"), a.S("project"))
	},
	"read_item": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ReadItem(ctx, a.S("itemId"), a.S("project"))
	},
	"log": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Log(ctx, a.S("runId"), a.S("text"), a.S("level"))
	},
	"attach": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Attach(ctx, a.S("itemId"), a.S("source"), a.S("name"), a.S("project"))
	},
	"ask": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Ask(ctx, a.S("itemId"), a.S("question"), a.S("project"))
	},
	"progress": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Progress(ctx, a.S("itemId"), *a.F("done"), *a.F("total"), a.S("project"))
	},
	"status": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Status(ctx, a.S("itemId"), a.S("text"), a.F("pct"), a.S("project"))
	},
	"raise_finding": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.RaiseFinding(ctx, a.S("itemId"), a.S("title"), a.S("details"), a.S("project"))
	},
	"create_item": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.CreateItem(ctx, a.S("project"), a.S("title"), a.S("description"), a.Strings("attachments"))
	},
	// Inbox (item 4PEHrOW5IfXBQWgOK9wo)
	"inbox_add": func(ctx context.Context, c *Client, a Args) (any, error) {
		in := InboxAddIn{Source: a.S("source"), Text: a.S("text"), ThreadRef: a.S("threadRef"), ReceivedAt: a.S("receivedAt"), MessageID: a.SP("messageId"), Permalink: a.SP("permalink"), ReplyRef: a.SP("replyRef"), Member: a.S("member"), Thread: a.S("thread"), Title: a.SP("title")}
		in.FromMember, _ = a["fromMember"].(bool)
		if snd, ok := a["sender"].(map[string]any); ok {
			sa := Args(snd)
			in.SenderName, in.Handle = sa.S("name"), sa.SP("handle")
		}
		if arr, ok := a["attachments"].([]any); ok {
			for _, e := range arr {
				m := Args(asMap(e))
				in.Attachments = append(in.Attachments, model.InboxAttachment{Name: m.S("name"), URL: m.S("url")})
			}
		}
		return c.InboxAdd(ctx, in)
	},
	"inbox_list":  func(ctx context.Context, c *Client, a Args) (any, error) { return c.InboxList(ctx) },
	"thread_read": func(ctx context.Context, c *Client, a Args) (any, error) { return c.ThreadRead(ctx, a.S("threadId")) },
	"subject_list": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SubjectList(ctx, a.S("member"))
	},
	"subject_assign": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SubjectAssign(ctx, a.S("threadId"), a.SP("subjectId"), a.SP("name"), a.SP("area"))
	},
	"subject_search": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SubjectSearch(ctx, a.S("query"), SearchFilters{Member: a.S("member"), WaitingForMe: a.BP("waitingForMe"), ActiveDays: a.F("activeDays"), HasOpen: a.BP("hasOpen"), Limit: a.F("limit")})
	},
	"thread_flag": func(ctx context.Context, c *Client, a Args) (any, error) {
		urgent := true
		if v := a.BP("urgent"); v != nil {
			urgent = *v
		}
		return c.ThreadFlag(ctx, a.S("threadId"), urgent, a.SP("reason"))
	},
	"subject_relate": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SubjectRelate(ctx, a.S("a"), a.S("b"), a.SP("note"))
	},
	"inbox_note": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.InboxNote(ctx, a.S("threadId"), a.S("text"))
	},
	"inbox_ask": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.InboxAsk(ctx, a.S("threadId"), a.S("question"))
	},
	"outcome_propose": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.OutcomePropose(ctx, a.S("threadId"), a.S("type"), asMap(a["fields"]), a.SP("note"))
	},
	"outcome_done": func(ctx context.Context, c *Client, a Args) (any, error) {
		r := Args(asMap(a["result"]))
		return c.OutcomeDone(ctx, a.S("outcomeId"), a.S("status"), OutcomeResult{r.SP("text"), r.SP("permalink"), r.SP("itemId"), r.SP("error")})
	},
	"thread_wake": func(ctx context.Context, c *Client, a Args) (any, error) { return c.ThreadWake(ctx, a.S("threadId")) },
	// park / unpark exist in channel sessions only (ChannelTools gives them the session).
	"park":   func(context.Context, *Client, Args) (any, error) { return nil, Errf(parkNoSession) },
	"unpark": func(context.Context, *Client, Args) (any, error) { return nil, Errf(parkNoSession) },
	"release": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Release(ctx, a.S("itemId"), a.S("project"))
	},
	"end_run": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.EndRun(ctx, a.S("runId"), a.S("status"), a.outcome())
	},
	"complete": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.Complete(ctx, a.S("itemId"), a.S("runId"), a.outcome(), a.S("project"))
	},
	"send_back": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SendBack(ctx, a.S("itemId"), a.S("runId"), a.S("toStep"), a.S("reason"), a.outcome(), a.S("project"))
	},
	"add_note": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.AddNote(ctx, a.S("itemId"), a.S("text"), a.S("project"))
	},
	"shape_item": func(ctx context.Context, c *Client, a Args) (any, error) {
		var skips []Skip
		if arr, ok := a["skips"].([]any); ok {
			for _, e := range arr {
				m, _ := e.(map[string]any)
				id, _ := m["stepId"].(string)
				r, _ := m["reason"].(string)
				skips = append(skips, Skip{id, r})
			}
		}
		return c.Shape(ctx, a.S("itemId"), a.S("runId"), skips, a.S("note"), Outcome{}, a.S("project"))
	},
	"skip_step": func(ctx context.Context, c *Client, a Args) (any, error) {
		skip, _ := a["skip"].(bool)
		return c.SkipStep(ctx, a.S("itemId"), a.S("stepId"), skip, a.S("reason"), a.S("project"))
	},
	"ask_path_change": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.AskPathChange(ctx, a.S("itemId"), a.S("stepId"), a.S("reason"), a.S("project"))
	},
	"propose_step": func(ctx context.Context, c *Client, a Args) (any, error) {
		p := actions.ProposalInput{Name: a.S("name"), Kind: a.S("kind"), Description: a.S("description"), Instructions: a.SP("instructions"), AfterStepID: a.S("afterStepId"), Reason: a.S("reason")}
		if arr, ok := a["outputs"].([]any); ok {
			p.Outputs = []string{}
			for _, e := range arr {
				if s, ok := e.(string); ok {
					p.Outputs = append(p.Outputs, s)
				}
			}
		}
		return c.ProposeStep(ctx, a.S("itemId"), p, a.S("project"))
	},
	"calendar_upsert": func(ctx context.Context, c *Client, a Args) (any, error) {
		var events []CalendarEventArg
		if arr, ok := a["events"].([]any); ok {
			for _, e := range arr {
				m, _ := e.(map[string]any)
				ea := Args(m)
				ev := CalendarEventArg{Source: ea.S("source"), SourceEventID: ea.S("sourceEventId"), Title: ea.SP("title"), Start: ea.S("start"), End: ea.S("end"), Attendees: ea.Strings("attendees")}
				if v, ok := m["allDay"].(bool); ok {
					ev.AllDay = &v
				}
				if v, ok := m["busyOnly"].(bool); ok {
					ev.BusyOnly = &v
				}
				events = append(events, ev)
			}
		}
		return c.CalendarUpsert(ctx, a.S("member"), events)
	},
	"calendar_delete": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.CalendarDelete(ctx, a.Strings("ids"), a.S("member"), a.S("source"), a.Strings("sourceEventIds"))
	},
	"calendar_free": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.CalendarFree(ctx, a.S("member"), a.S("from"), a.S("to"), a.F("minMinutes"))
	},
	"calendar_sync": func(ctx context.Context, c *Client, a Args) (any, error) {
		b, _ := json.Marshal(map[string]any{"items": a["events"]})
		feed, err := ParseFeed(b, "events")
		if err != nil {
			return nil, err
		}
		if t := a.S("nextSyncToken"); t != "" {
			feed.NextSyncToken = &t
		}
		inc, _ := a["incremental"].(bool)
		busy, _ := a["busyOnly"].(bool)
		return c.CalendarSync(ctx, SyncArgs{Member: a.S("member"), Source: a.S("source"), From: a.S("from"), To: a.S("to"), Incremental: inc, BusyOnly: busy, Feed: feed})
	},
	"calendar_mirror": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.CalendarMirror(ctx, MirrorArgs{OutcomeID: a.S("outcomeId"), SourceEventID: a.S("sourceEventId"), Source: a.S("source"), Start: a.S("start"), End: a.S("end"), Title: a.SP("title")})
	},
	"report_usage": func(ctx context.Context, c *Client, a Args) (any, error) {
		u := Usage{TokensIn: *a.F("tokensIn"), TokensOut: *a.F("tokensOut"), TokensCached: a.F("tokensCached")}
		if a.Has("model") {
			u.ModelSet, u.Model = true, a.SP("model")
		}
		return c.ReportUsage(ctx, a.S("runId"), u)
	},
}

// PlainTools are the tools of `hivenod mcp` (no channel), in the TypeScript order.
func PlainTools(lazy *Lazy) []mcpserver.Tool {
	sf := mcpserver.LoadSurface()
	out := make([]mcpserver.Tool, 0, len(sf.Plain.Tools))
	for _, spec := range sf.Plain.Tools {
		run, ok := ToolRuns[spec.Name]
		if !ok {
			panic(fmt.Sprintf("hive: no Go handler for tool %s", spec.Name))
		}
		out = append(out, mcpserver.Tool{Spec: spec, Run: func(ctx context.Context, args map[string]any) (any, error) {
			c, err := lazy.Get(ctx)
			if err != nil {
				return nil, err
			}
			res, err := scoped(spec.Name, run)(ctx, c, Args(args))
			if err != nil {
				return nil, errors.New(Message(err))
			}
			return res, nil
		}})
	}
	return out
}
