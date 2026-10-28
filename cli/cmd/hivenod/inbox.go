package main

// `hivenod inbox …` and `hivenod subject …` (item 4PEHrOW5IfXBQWgOK9wo): the inbox tools from a
// shell, for scripts and cron jobs that bring requests in. Each runs the MCP tool of the same
// name and prints its JSON result.

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
)

const inboxHelp = `hivenod inbox / subject: a person's Hivenod Inbox, as this agent (JSON output).

  hivenod inbox add --source S --sender NAME [--handle H] --thread REF --received-at ISO
                    (--text T | --text-file F) [--message-id M] [--permalink URL]
                    [--reply-ref R] [--member UID]
                           brings a request in (the same source, thread and message only once)
  hivenod inbox list       requests waiting for agents: to file, to draft, to send
  hivenod inbox read ID    one request in full, with its subject and what to do next
  hivenod subject list [--member UID]
                           the person's subjects, with waiting and open requests
  hivenod subject assign ID (--subject-id S | --name "Topic (client)")
                           files a request under an existing or a new subject
  hivenod inbox draft ID --reply TEXT [--action A]...
                           the proposed answer; it waits for the person's Send
  hivenod inbox sent ID [--permalink URL]
                           after posting the reply the person approved

  Nothing is sent before the person presses Send in Hivenod.`

func runInbox(args []string, stdout, stderr io.Writer) int {
	if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
		fmt.Fprintln(stdout, inboxHelp)
		return 0
	}
	group, verb := args[0], args[1]
	fs := flag.NewFlagSet("hivenod "+group+" "+verb, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	str := map[string]*string{}
	for _, f := range []string{"source", "sender", "handle", "thread", "received-at", "text", "text-file", "message-id", "permalink", "reply-ref", "member", "reply", "subject-id", "name"} {
		str[f] = fs.String(f, "", "")
	}
	var acts multi
	fs.Var(&acts, "action", "")
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
	opt := func(key, flagName string) {
		if set[flagName] {
			a[key] = *str[flagName]
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
		if *str["source"] == "" || *str["sender"] == "" || *str["thread"] == "" || *str["received-at"] == "" || text == "" {
			return usage()
		}
		sender := map[string]any{"name": *str["sender"]}
		if set["handle"] {
			sender["handle"] = *str["handle"]
		}
		a["source"], a["sender"], a["text"], a["threadRef"], a["receivedAt"] = *str["source"], sender, text, *str["thread"], *str["received-at"]
		opt("messageId", "message-id")
		opt("permalink", "permalink")
		opt("replyRef", "reply-ref")
		opt("member", "member")
	case "inbox list":
		tool = "inbox_list"
	case "inbox read":
		tool = "inbox_read"
		if id == "" {
			return usage()
		}
		a["requestId"] = id
	case "inbox draft":
		tool = "inbox_draft"
		if id == "" || *str["reply"] == "" {
			return usage()
		}
		a["requestId"], a["reply"] = id, *str["reply"]
		if len(acts) > 0 {
			list := make([]any, len(acts))
			for i, s := range acts {
				list[i] = s
			}
			a["actions"] = list
		}
	case "inbox sent":
		tool = "inbox_sent"
		if id == "" {
			return usage()
		}
		a["requestId"] = id
		opt("permalink", "permalink")
	case "subject list":
		tool = "subject_list"
		opt("member", "member")
	case "subject assign":
		tool = "subject_assign"
		if id == "" || set["subject-id"] == set["name"] {
			return usage()
		}
		a["requestId"] = id
		opt("subjectId", "subject-id")
		opt("name", "name")
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
