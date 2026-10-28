package main

// `hivenod inbox|thread|subject|outcome …` (item 4PEHrOW5IfXBQWgOK9wo): the inbox tools from a
// shell, for scripts and cron jobs that bring requests in. Each runs the MCP tool of the same
// name and prints its JSON result.

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
)

var inboxHelp = `hivenod inbox / thread / subject / outcome: a person's Hivenod Inbox, as this agent (JSON output).

  hivenod inbox add --source S --sender NAME [--handle H] --thread-ref REF --received-at ISO
                    (--text T | --text-file F) [--message-id M] [--permalink URL]
                    [--reply-ref R] [--member UID] [--thread ID] [--from-member] [--title T]
                           brings a message in, into its thread (the same message only once)
  hivenod inbox list       what agents have to do: threads to work, approved outcomes, snoozes due
  hivenod thread read ID   one thread in full: messages, subject, outcomes, notes, what next
  hivenod thread wake ID   wakes a snoozed thread whose date has come
  hivenod subject list [--member UID]
                           the person's subjects, with threads waiting for them and open
  hivenod subject assign THREAD (--subject-id S | --name "Topic (client)")
                           files a thread under an existing or a new subject
  hivenod inbox note THREAD --text T      an investigation note on the timeline
  hivenod inbox ask THREAD --text Q       asks the person (the thread waits in Needs you)
  hivenod outcome propose THREAD --type T [--field name=value]... [--note N]
                           proposes an outcome (types: ` + outcomeTypeList() + `)
  hivenod outcome done OUTCOME --status done|failed [--text T] [--permalink URL] [--item-id I] [--error E]
                           after carrying out an outcome the person approved

  Nothing is carried out before the person approves it in Hivenod.`

func outcomeTypeList() string {
	ids := make([]string, len(actions.Outcomes))
	for i, t := range actions.Outcomes {
		ids[i] = t.ID
	}
	return strings.Join(ids, ", ")
}

func runInbox(args []string, stdout, stderr io.Writer) int {
	if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
		fmt.Fprintln(stdout, inboxHelp)
		return 0
	}
	group, verb := args[0], args[1]
	fs := flag.NewFlagSet("hivenod "+group+" "+verb, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	str := map[string]*string{}
	for _, f := range []string{"source", "sender", "handle", "thread-ref", "received-at", "text", "text-file", "message-id", "permalink", "reply-ref", "member", "thread", "title", "subject-id", "name", "type", "note", "status", "item-id", "error"} {
		str[f] = fs.String(f, "", "")
	}
	fromMember := fs.Bool("from-member", false, "")
	var fields multi
	fs.Var(&fields, "field", "")
	fs.Bool("json", true, "")
	var pos []string
	rest := args[2:]
	for len(rest) > 0 {
		if err := fs.Parse(rest); err != nil {
			fmt.Fprintf(stderr, "hivenod: %v\n", err)
			return 2
		}
		rest = fs.Args()
		if len(rest) > 0 {
			pos = append(pos, rest[0])
			rest = rest[1:]
		}
	}
	set := map[string]bool{}
	fs.Visit(func(f *flag.Flag) { set[f.Name] = true })
	a := hive.Args{}
	opt := func(m hive.Args, key, flagName string) {
		if set[flagName] {
			m[key] = *str[flagName]
		}
	}
	id := ""
	if len(pos) > 0 {
		id = pos[0]
	}
	usage := func() int { fmt.Fprintln(stderr, inboxHelp); return 2 }
	var tool string
	switch group + " " + verb {
	case "inbox add":
		tool = "inbox_add"
		text := *str["text"]
		if set["text-file"] {
			b, err := os.ReadFile(*str["text-file"])
			if err != nil {
				fmt.Fprintf(stderr, "hivenod: %v\n", err)
				return 1
			}
			text = string(b)
		}
		if *str["source"] == "" || *str["sender"] == "" || *str["thread-ref"] == "" || *str["received-at"] == "" || text == "" {
			return usage()
		}
		sender := map[string]any{"name": *str["sender"]}
		if set["handle"] {
			sender["handle"] = *str["handle"]
		}
		a["source"], a["sender"], a["text"], a["threadRef"], a["receivedAt"] = *str["source"], sender, text, *str["thread-ref"], *str["received-at"]
		for k, f := range map[string]string{"messageId": "message-id", "permalink": "permalink", "replyRef": "reply-ref", "member": "member", "thread": "thread", "title": "title"} {
			opt(a, k, f)
		}
		if *fromMember {
			a["fromMember"] = true
		}
	case "inbox list":
		tool = "inbox_list"
	case "inbox note", "inbox ask":
		if id == "" || *str["text"] == "" {
			return usage()
		}
		a["threadId"] = id
		if verb == "note" {
			tool, a["text"] = "inbox_note", *str["text"]
		} else {
			tool, a["question"] = "inbox_ask", *str["text"]
		}
	case "thread read", "thread wake":
		if id == "" {
			return usage()
		}
		tool, a["threadId"] = "thread_"+verb, id
	case "subject list":
		tool = "subject_list"
		opt(a, "member", "member")
	case "subject assign":
		tool = "subject_assign"
		if id == "" || set["subject-id"] == set["name"] {
			return usage()
		}
		a["threadId"] = id
		opt(a, "subjectId", "subject-id")
		opt(a, "name", "name")
	case "outcome propose":
		tool = "outcome_propose"
		t := actions.OutcomeTypeOf(*str["type"])
		if id == "" || *str["type"] == "" {
			return usage()
		}
		f := map[string]any{}
		for _, p := range fields {
			k, v, ok := strings.Cut(p, "=")
			if !ok || k == "" {
				fmt.Fprintf(stderr, "hivenod: --field wants name=value, got %s\n", p)
				return 2
			}
			f[k] = v
			if t != nil && (v == "true" || v == "false") {
				for _, fd := range t.Fields {
					if fd.Name == k && fd.Kind == "boolean" {
						f[k] = v == "true"
					}
				}
			}
		}
		a["threadId"], a["type"], a["fields"] = id, *str["type"], f
		opt(a, "note", "note")
	case "outcome done":
		tool = "outcome_done"
		if id == "" || (*str["status"] != "done" && *str["status"] != "failed") {
			return usage()
		}
		r := hive.Args{}
		for k, f := range map[string]string{"text": "text", "permalink": "permalink", "itemId": "item-id", "error": "error"} {
			opt(r, k, f)
		}
		a["outcomeId"], a["status"], a["result"] = id, *str["status"], map[string]any(r)
	default:
		return usage()
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	saved := (*credentials.Stored)(nil)
	if os.Getenv("HIVENOD_TOKEN") == "" {
		saved = credentials.Read()
	}
	fail := func(err error) int {
		fmt.Fprintf(stderr, "hivenod: %s\n", hive.Message(err))
		return 1
	}
	cfg, err := hive.Resolve(ctx, "", saved)
	if err != nil {
		return fail(err)
	}
	c, err := hive.Connect(ctx, cfg, "")
	if err != nil {
		return fail(err)
	}
	defer c.Close()
	res, err := hive.ToolRuns[tool](ctx, c, a)
	if err != nil {
		return fail(err)
	}
	fmt.Fprintln(stdout, hive.JSON(res))
	return 0
}
