package hive

import (
	"context"
	"errors"
	"fmt"
	"sync"

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

func asMap(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// Run is a tool's work with a connected client.
type Run func(ctx context.Context, c *Client, a Args) (any, error)

// ToolRuns are the agent operations by tool name (ported from the former TypeScript tools.ts).
// Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 11): only thread tools are left.
var ToolRuns = map[string]Run{
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
		return c.SubjectAssign(ctx, a.S("threadId"), a.SP("subjectId"), a.SP("name"), a.SP("area"), a.SP("label"))
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
	"thread_due": func(ctx context.Context, c *Client, a Args) (any, error) {
		due := a.SP("due")
		if due == nil && a["due"] != nil {
			return nil, Errf("due is an ISO 8601 time with its offset, or null to clear it.")
		}
		return c.ThreadDue(ctx, a.S("threadId"), due, a.SP("reason"))
	},
	"thread_recheck_done": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ThreadRecheckDone(ctx, a.S("threadId"), a.S("result"), a.SP("note"))
	},
	"thread_answer_instruction": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ThreadAnswerInstruction(ctx, a.S("threadId"), a.S("instructionId"), a.S("kind"), a.SP("refId"), a.SP("note"))
	},
	"thread_attach": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ThreadAttach(ctx, a.S("threadId"), a.S("source"), a.S("name"))
	},
	"thread_summary": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ThreadSummary(ctx, a.S("threadId"), a["summary"], a.F("baseVersion"))
	},
	"thread_suggest_chips": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.ThreadSuggestChips(ctx, a.S("threadId"), a.Strings("chips"))
	},
	"subject_relate": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.SubjectRelate(ctx, a.S("a"), a.S("b"), a.SP("note"))
	},
	"inbox_note": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.InboxNote(ctx, a.S("threadId"), a.S("text"))
	},
	"inbox_ask": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.InboxAsk(ctx, a.S("threadId"), a.S("question"), a.Strings("options"))
	},
	"outcome_propose": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.OutcomePropose(ctx, a.S("threadId"), a.S("type"), asMap(a["fields"]), a.SP("note"), ProposeExtra{Confidence: a.SP("confidence"), Checks: a.Strings("checks"), Revises: a.SP("revises")})
	},
	"outcome_done": func(ctx context.Context, c *Client, a Args) (any, error) {
		r := Args(asMap(a["result"]))
		u := Args(asMap(a["usage"]))
		return c.OutcomeDone(ctx, a.S("outcomeId"), a.S("status"), OutcomeResult{Text: r.SP("text"), Permalink: r.SP("permalink"), ItemID: r.SP("itemId"), Error: r.SP("error"), Tokens: u.F("tokens"), CostEur: u.F("costEur")})
	},
	"step_progress": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.StepProgress(ctx, a.S("outcomeId"), a.S("line"), a.F("percent"), a.SP("check"))
	},
	"plan_propose": func(ctx context.Context, c *Client, a Args) (any, error) {
		var steps []PlanStepArg
		arr, ok := a["steps"].([]any)
		if !ok && a.S("template") == "" {
			return nil, Errf("steps is a list of 1 to 8 steps: {type, fields, note?, confidence?, checks?}.")
		}
		for _, e := range arr {
			m := Args(asMap(e))
			f := asMap(m["fields"])
			if f == nil {
				f = map[string]any{}
			}
			steps = append(steps, PlanStepArg{Type: m.S("type"), Fields: f, Note: m.SP("note"), Confidence: m.SP("confidence"), Checks: m.Strings("checks")})
		}
		return c.PlanPropose(ctx, a.S("threadId"), a.SP("note"), a.SP("confidence"), steps, a.SP("template"))
	},
	"plan_send_back": func(ctx context.Context, c *Client, a Args) (any, error) {
		return c.PlanSendBack(ctx, a.S("threadId"), a.S("reason"), a.F("toStep"))
	},
	"thread_wake": func(ctx context.Context, c *Client, a Args) (any, error) { return c.ThreadWake(ctx, a.S("threadId")) },
	// Scheduled tasks, slice 5
	"schedule_propose": func(ctx context.Context, c *Client, a Args) (any, error) {
		in := ScheduleProposeIn{ThreadID: a.S("threadId"), Title: a.S("title"), What: a.S("what"), Rule: asMap(a["rule"]),
			Template: a.SP("template"), RunTitle: a.SP("runTitle"), Note: a.SP("note"), Confidence: a.SP("confidence"),
			Checks: a.Strings("checks"), Revises: a.SP("revises"), Replaces: a.SP("replaces")}
		if a.Has("subjectId") {
			in.SubjectID = actions.OptString{Set: true, Val: a.SP("subjectId")}
		}
		arr, _ := a["steps"].([]any)
		if arr == nil && a.S("template") == "" {
			return nil, Errf("steps is a list of 1 to 8 plan steps {type, fields}, or give a template.")
		}
		for _, e := range arr {
			m := Args(asMap(e))
			f := asMap(m["fields"])
			if f == nil {
				f = map[string]any{}
			}
			in.Steps = append(in.Steps, PlanStepArg{Type: m.S("type"), Fields: f})
		}
		return c.SchedulePropose(ctx, in)
	},
	"schedule_list": func(ctx context.Context, c *Client, a Args) (any, error) { return c.ScheduleList(ctx, a.S("member")) },
}

// PlainTools are the tools of `hivenod mcp` (no channel).
func PlainTools(lazy *Lazy) []mcpserver.Tool {
	return tools(lazy, mcpserver.LoadSurface().Plain.Tools)
}

func tools(lazy *Lazy, specs []mcpserver.ToolSpec) []mcpserver.Tool {
	out := make([]mcpserver.Tool, 0, len(specs))
	for _, spec := range specs {
		run, ok := ToolRuns[spec.Name]
		if !ok {
			panic(fmt.Sprintf("hive: no Go handler for tool %s", spec.Name))
		}
		out = append(out, mcpserver.Tool{Spec: spec, Run: func(ctx context.Context, args map[string]any) (any, error) {
			c, err := lazy.Get(ctx)
			if err != nil {
				return nil, err
			}
			res, err := run(ctx, c, Args(args))
			if err != nil {
				return nil, errors.New(Message(err))
			}
			return res, nil
		}})
	}
	return out
}
