package main

// `hivenod inbox|thread|subject|outcome …` (item 4PEHrOW5IfXBQWgOK9wo): the inbox tools from a
// shell, for scripts and cron jobs that bring requests in. Each runs the MCP tool of the same
// name and prints its JSON result.

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
)

var inboxHelp = `hivenod inbox / thread / subject / outcome / plan: a person's Hivenod Inbox, as this agent (JSON output).

  hivenod inbox add --source S --sender NAME [--handle H] --thread-ref REF --received-at ISO
                    (--text T | --text-file F) [--message-id M] [--permalink URL]
                    [--reply-ref R] [--member UID] [--thread ID] [--from-member] [--title T]
                           brings a message in, into its thread (the same message only once)
  hivenod inbox list       what agents have to do: threads to work, approved outcomes, snoozes due
  hivenod thread read ID   one thread in full: messages, subject, outcomes, notes, what next
  hivenod thread wake ID   wakes a snoozed thread whose date has come
  hivenod thread flag ID [--off] [--reason R]
                           marks a thread urgent (the person is pinged at once), or not with --off
  hivenod thread due ID ISO [--reason R] | hivenod thread due ID --clear
                           sets the deadline a message states (ISO 8601 with its offset), or clears it
  hivenod thread recheck-done ID still_good|revised|asked [--note N]
                           answers the person's re-check request (after outcome propose
                           --revises or inbox ask, for revised and asked)
  hivenod thread answer-instruction ID INSTRUCTION note|ask|outcome|plan [--ref R] [--note N]
                           answers the person's request on the thread (--ref: the outcome or
                           plan you proposed; --note: your answer, required for note)
  hivenod thread suggest-chips ID [CHIP]...
                           sets your quick chips for the thread (prepare_meeting, recheck,
                           follow_up, summarize, draft_reply; none clears them)
  hivenod thread summary ID --file F|- [--base-version N]
                           writes the thread's summary (you are its home agent) from a JSON
                           file (- reads stdin): {headline, ask?, answer?, recommendation?,
                           confidence?, bullets, details?, visuals?, noVisualWhy?, refs?};
                           --base-version (or "baseVersion" in the file) is the version
                           thread read showed, 0 for none
  hivenod thread attach ID FILE|URL [--name N]
                           attaches a file (png, jpg, webp, html, md, txt, pdf; up to 900 KB)
                           or an https link to the thread (you are its home agent); name the
                           attachmentId in a summary's image or image_pair visual
  hivenod subject list [--member UID]
                           the person's subjects, with threads waiting for them and open
  hivenod subject assign THREAD (--subject-id S | --name "Topic (client)") [--area "Client A"] [--label Sales]
                           files a thread under an existing or a new subject; --area sets
                           its area or tag ("" clears it); --label suggests one of the
                           workspace's labels (see subject list)
  hivenod subject search ["words"] [--member UID] [--waiting] [--active-days N] [--has-open] [--limit N]
                           finds subjects by name, people, channel and thread text
  hivenod subject relate SUBJECT SUBJECT [--note "how"]
                           proposes two related subjects (the person OKs it)
  hivenod inbox note THREAD --text T      an investigation note on the timeline
  hivenod inbox ask THREAD --text Q [--option O]...
                           asks the person (the thread waits in Needs you); up to 4
                           --option answer chips
  hivenod outcome propose THREAD --type T [--field name=value]... [--note N]
                          [--confidence high|medium|low] [--check C]... [--revises OUTCOME]
                           proposes an outcome (types: ` + outcomeTypeList() + `);
                           --check: what you verified, up to 6; --revises: the person
                           asked for changes (or a re-check found it changed), so this is
                           that outcome's next version
  hivenod plan propose THREAD --steps-file F|- [--note N] [--confidence high|medium|low]
                           proposes a plan: 1-8 ordered steps from a JSON file (- reads
                           stdin), either [{type, fields, note?, confidence?, checks?}, ...]
                           or {"steps": [...], "note": ..., "confidence": ...}; step types:
                           ` + strings.Join(actions.PlanOutcomeTypes(), ", ") + `
  hivenod outcome done OUTCOME --status done|failed|started [--text T] [--permalink URL] [--item-id I] [--error E]
                           after carrying out an outcome the person approved; started (with
                           --item-id) is for a Build it plan step whose item is made

  Nothing is carried out before the person approves it in Hivenod.`

func outcomeTypeList() string {
	return strings.Join(actions.SingleOutcomeTypes(), ", ")
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
	for _, f := range []string{"source", "sender", "handle", "thread-ref", "received-at", "text", "text-file", "message-id", "permalink", "reply-ref", "member", "thread", "title", "subject-id", "name", "area", "label", "type", "note", "status", "item-id", "error", "active-days", "limit", "reason", "confidence", "revises", "steps-file", "ref", "file", "base-version"} {
		str[f] = fs.String(f, "", "")
	}
	fromMember := fs.Bool("from-member", false, "")
	waiting := fs.Bool("waiting", false, "")
	hasOpen := fs.Bool("has-open", false, "")
	off := fs.Bool("off", false, "")
	clear := fs.Bool("clear", false, "")
	var fields, checks, options multi
	fs.Var(&fields, "field", "")
	fs.Var(&checks, "check", "")
	fs.Var(&options, "option", "")
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
			if len(options) > 0 {
				a["options"] = anyList(options)
			}
		}
	case "thread read", "thread wake":
		if id == "" {
			return usage()
		}
		tool, a["threadId"] = "thread_"+verb, id
	case "subject list":
		tool = "subject_list"
		opt(a, "member", "member")
	case "thread flag":
		if id == "" {
			return usage()
		}
		tool, a["threadId"], a["urgent"] = "thread_flag", id, !*off
		opt(a, "reason", "reason")
	case "thread due":
		if id == "" || (len(pos) == 2) == *clear || len(pos) > 2 {
			return usage()
		}
		tool, a["threadId"] = "thread_due", id
		if *clear {
			a["due"] = nil
		} else {
			a["due"] = pos[1]
		}
		opt(a, "reason", "reason")
	case "thread recheck-done":
		if id == "" || len(pos) != 2 {
			return usage()
		}
		tool, a["threadId"], a["result"] = "thread_recheck_done", id, pos[1]
		opt(a, "note", "note")
	case "thread answer-instruction":
		if id == "" || len(pos) != 3 {
			return usage()
		}
		tool, a["threadId"], a["instructionId"], a["kind"] = "thread_answer_instruction", id, pos[1], pos[2]
		opt(a, "refId", "ref")
		opt(a, "note", "note")
	case "thread suggest-chips":
		if id == "" {
			return usage()
		}
		tool, a["threadId"], a["chips"] = "thread_suggest_chips", id, anyList(pos[1:])
	case "subject search":
		tool = "subject_search"
		a["query"] = strings.Join(pos, " ")
		opt(a, "member", "member")
		if *waiting {
			a["waitingForMe"] = true
		}
		if *hasOpen {
			a["hasOpen"] = true
		}
		for k, f := range map[string]string{"activeDays": "active-days", "limit": "limit"} {
			if set[f] {
				n, err := strconv.Atoi(*str[f])
				if err != nil || n < 1 {
					fmt.Fprintf(stderr, "hivenod: --%s must be a whole number >= 1\n", f)
					return 2
				}
				a[k] = float64(n)
			}
		}
	case "subject relate":
		tool = "subject_relate"
		if len(pos) < 2 {
			return usage()
		}
		a["a"], a["b"] = pos[0], pos[1]
		opt(a, "note", "note")
	case "subject assign":
		tool = "subject_assign"
		if id == "" || set["subject-id"] == set["name"] {
			return usage()
		}
		a["threadId"] = id
		opt(a, "subjectId", "subject-id")
		opt(a, "name", "name")
		opt(a, "area", "area")
		opt(a, "label", "label")
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
		opt(a, "confidence", "confidence")
		opt(a, "revises", "revises")
		if len(checks) > 0 {
			a["checks"] = anyList(checks)
		}
	case "thread attach":
		if id == "" || len(pos) != 2 {
			return usage()
		}
		tool, a["threadId"], a["source"] = "thread_attach", id, pos[1]
		opt(a, "name", "name")
	case "thread summary":
		tool = "thread_summary"
		if id == "" || *str["file"] == "" {
			return usage()
		}
		var b []byte
		var err error
		if *str["file"] == "-" {
			b, err = io.ReadAll(os.Stdin)
		} else {
			b, err = os.ReadFile(*str["file"])
		}
		if err != nil {
			fmt.Fprintf(stderr, "hivenod: %v\n", err)
			return 1
		}
		var sum map[string]any
		if err := json.Unmarshal(b, &sum); err != nil {
			fmt.Fprintf(stderr, "hivenod: the summary file is not a JSON object: %v\n", err)
			return 2
		}
		a["threadId"] = id
		if bv, ok := sum["baseVersion"]; ok {
			a["baseVersion"] = bv
			delete(sum, "baseVersion")
		}
		if set["base-version"] {
			n, err := strconv.Atoi(*str["base-version"])
			if err != nil {
				fmt.Fprintf(stderr, "hivenod: --base-version is a number\n")
				return 2
			}
			a["baseVersion"] = float64(n)
		}
		a["summary"] = sum
	case "plan propose":
		tool = "plan_propose"
		if id == "" || *str["steps-file"] == "" {
			return usage()
		}
		var b []byte
		var err error
		if *str["steps-file"] == "-" {
			b, err = io.ReadAll(os.Stdin)
		} else {
			b, err = os.ReadFile(*str["steps-file"])
		}
		if err != nil {
			fmt.Fprintf(stderr, "hivenod: %v\n", err)
			return 1
		}
		var v any
		if err := json.Unmarshal(b, &v); err != nil {
			fmt.Fprintf(stderr, "hivenod: the steps file is not JSON: %v\n", err)
			return 2
		}
		switch x := v.(type) {
		case []any:
			a["steps"] = x
		case map[string]any:
			a["steps"] = x["steps"]
			for _, k := range []string{"note", "confidence"} {
				if e, ok := x[k]; ok {
					a[k] = e
				}
			}
		default:
			fmt.Fprintln(stderr, "hivenod: the steps file is a list of steps, or an object with steps")
			return 2
		}
		a["threadId"] = id
		opt(a, "note", "note")
		opt(a, "confidence", "confidence")
	case "outcome done":
		tool = "outcome_done"
		if id == "" || (*str["status"] != "done" && *str["status"] != "failed" && *str["status"] != "started") {
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

// anyList is a repeated flag as a JSON array argument.
func anyList(m multi) []any {
	out := make([]any, len(m))
	for i, v := range m {
		out[i] = v
	}
	return out
}
