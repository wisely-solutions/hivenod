// hivenod: the Hivenod agent CLI (item zLwtX2WEEg3mER4CR74g), one binary, no Node.js.
//
//	hivenod connect | claude | pair | whoami | logout | mcp [--channel ...] | update | version
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
	"github.com/wisely-solutions/hivenod/cli/internal/update"
)

const help = `hivenod: work in Hivenod as an agent, through the Claude Code channel plugin.

  hivenod connect          connects this machine to Hivenod: opens your browser, where you
                           confirm it with one click (any member, for their own projects),
                           and saves the token; then sets up the hivenod plugin in Claude Code
                           and starts it (--no-start: only set up)
  hivenod claude [args]    starts Claude Code with the Hivenod channel (args go to claude)
  hivenod pair             pairs this machine with Hivenod (shows a code an admin confirms) and
                           saves the token; then install the hivenod plugin in Claude Code
  hivenod whoami           the agent this machine works as
  hivenod create-item --project P --title "title" [--description "brief"] [--attach file|url]...
                           creates an item (work at the first step) where the project lets
                           agents create items; at most 30 an hour
  hivenod inbox …, thread …, subject …, outcome …
                           a person's Inbox: bring messages in, file, note, ask, propose
                           outcomes, report them done
                           (hivenod inbox --help)
  hivenod calendar upsert <events.json|-> [--member M]
                           adds or updates a member's events in this organization (a JSON
                           array like calendar_upsert's events; same source id = same event)
  hivenod calendar delete <id>... | --source S [--member M] <sourceEventId>...
  hivenod calendar free --from T --to T [--member M] [--min N]
                           free time across all the member's organizations (busy time only)
  hivenod logout           forgets the token saved by pairing
  hivenod mcp              MCP stdio server for Claude Code
  hivenod mcp --channel [--project P] [--step S] [--max-items N]
                           the same, as a Claude Code channel: a live session gets its work
                           pushed in, claimed, up to N items at a time (default 1, or
                           HIVENOD_MAX_ITEMS); [--max-inbox N]: Inbox threads sent at once,
                           outside max_items (0-10, default 3, 0 is off; or HIVENOD_MAX_INBOX)
  hivenod update           installs the latest release (checks its SHA-256 checksum)
  hivenod version          the installed version (matches the Hivenod release)

  whoami and mcp use HIVENOD_TOKEN, or the token saved by connect or pair (~/.hivenod/agent.json).
  --server https://your.host   connect or pair with a self-hosted Hivenod (saved with the token;
                           HIVENOD_WEB_URL does the same); the default is https://hivenod.com
  --json prints machine-readable output.`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

type opts struct {
	json, channel, help, version, force, noStart bool
	project, step, maxItems, maxInbox, server    string
	title, description                           string
	member, source, from, to, min                string
	attach                                       multi
}

// multi is a flag that may be given several times.
type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

func parse(args []string) (opts, []string, error) {
	var o opts
	fs := flag.NewFlagSet("hivenod", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.BoolVar(&o.json, "json", false, "")
	fs.BoolVar(&o.channel, "channel", false, "")
	fs.BoolVar(&o.help, "help", false, "")
	fs.BoolVar(&o.help, "h", false, "")
	fs.BoolVar(&o.version, "version", false, "")
	fs.BoolVar(&o.version, "v", false, "")
	fs.BoolVar(&o.force, "force", false, "")
	fs.BoolVar(&o.noStart, "no-start", false, "")
	fs.StringVar(&o.project, "project", "", "")
	fs.StringVar(&o.step, "step", "", "")
	fs.StringVar(&o.maxItems, "max-items", "", "")
	fs.StringVar(&o.maxInbox, "max-inbox", "", "")
	fs.StringVar(&o.server, "server", "", "")
	fs.StringVar(&o.title, "title", "", "")
	fs.StringVar(&o.description, "description", "", "")
	fs.Var(&o.attach, "attach", "")
	fs.StringVar(&o.member, "member", "", "")
	fs.StringVar(&o.source, "source", "", "")
	fs.StringVar(&o.from, "from", "", "")
	fs.StringVar(&o.to, "to", "", "")
	fs.StringVar(&o.min, "min", "", "")
	// Flags may come before or after the command words.
	var pos []string
	for len(args) > 0 {
		if err := fs.Parse(args); err != nil {
			return o, nil, err
		}
		args = fs.Args()
		if len(args) > 0 {
			pos = append(pos, args[0])
			args = args[1:]
		}
	}
	return o, pos, nil
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	// `hivenod claude …`: everything after the word belongs to claude, not to these flags.
	if len(args) > 0 && args[0] == "claude" {
		argv, err := claudeCommand(args[1:])
		if err == nil {
			err = runClaude(argv)
		}
		fmt.Fprintf(stderr, "hivenod: %v\n", err)
		return 1
	}
	// `hivenod inbox|subject …` have flags of their own (item 4PEHrOW5IfXBQWgOK9wo).
	if len(args) > 0 && (args[0] == "inbox" || args[0] == "thread" || args[0] == "subject" || args[0] == "outcome") {
		return runInbox(args, stdout, stderr)
	}
	o, pos, err := parse(args)
	if err != nil {
		fmt.Fprintf(stderr, "hivenod: %v\n", err)
		return 2
	}
	if o.version || (len(pos) > 0 && pos[0] == "version") {
		fmt.Fprintln(stdout, update.Line())
		return 0
	}
	if o.help || len(pos) == 0 {
		fmt.Fprintln(stdout, help)
		return 0
	}
	fail := func(err error) int {
		msg := hive.Message(err)
		if o.json {
			b, _ := json.Marshal(map[string]string{"error": msg})
			fmt.Fprintln(stderr, string(b))
		} else {
			fmt.Fprintf(stderr, "hivenod: %s\n", msg)
		}
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer stop()
	say := func(s string) { fmt.Fprintln(stdout, s) }
	if o.server != "" && pos[0] != "connect" && pos[0] != "pair" {
		fmt.Fprintln(stderr, "hivenod: --server goes with connect or pair; the other commands use the server saved with the token.")
		return 2
	}
	// The server saved with the token belongs to that token: HIVENOD_TOKEN ignores it.
	saved := (*credentials.Stored)(nil)
	if os.Getenv("HIVENOD_TOKEN") == "" {
		saved = credentials.Read()
	}
	resolve := func() (hive.Config, error) { return hive.Resolve(ctx, o.server, saved) }
	switch pos[0] {
	case "connect":
		if err := connect(ctx, resolve, say, o.noStart); err != nil {
			return fail(err)
		}
		return 0
	case "pair":
		if err := pair(ctx, resolve, say); err != nil {
			return fail(err)
		}
		return 0
	case "logout":
		had, err := credentials.Clear()
		if err != nil {
			return fail(err)
		}
		if had {
			say(fmt.Sprintf("Removed the saved token (%s). The agent still exists in Hivenod; revoke it there if it should stop for good.", credentials.Path()))
		} else {
			say("No saved token on this machine.")
		}
		return 0
	case "update":
		site, err := hive.Site("", saved)
		if err != nil {
			return fail(err)
		}
		u := &update.Updater{Site: site, Say: say}
		msg, err := u.Run(ctx, o.force)
		if err != nil {
			return fail(err)
		}
		say(msg)
		return 0
	case "whoami":
		cfg, err := resolve()
		if err != nil {
			return fail(err)
		}
		c, err := hive.Connect(ctx, cfg, "")
		if err != nil {
			return fail(err)
		}
		defer c.Close()
		w, err := c.Whoami(ctx)
		if err != nil {
			return fail(err)
		}
		if o.json {
			say(hive.JSON(w))
		} else {
			say(w.Text())
		}
		return 0
	case "create-item":
		title := o.title
		if title == "" && len(pos) > 1 {
			title = pos[1]
		}
		if o.project == "" || title == "" {
			fmt.Fprintln(stderr, `hivenod: Usage: hivenod create-item --project P --title "title" [--description "brief"] [--attach file|url]...`)
			return 2
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
		r, err := c.CreateItem(ctx, o.project, title, o.description, o.attach)
		if err != nil {
			return fail(err)
		}
		if o.json {
			say(hive.JSON(r))
			return 0
		}
		say(fmt.Sprintf("Created item %s. %s", r.ItemID, r.Note))
		for _, f := range r.Attachments {
			say("  attached " + f.Name)
		}
		for _, e := range r.AttachErrors {
			say("  not attached: " + e)
		}
		return 0
	case "calendar":
		return calendarCmd(ctx, o, pos, resolve, stdin, say, fail, stderr)
	case "mcp":
		cfg, err := resolve()
		if err != nil {
			return fail(err)
		}
		if err := runMCP(ctx, cfg, o, stdin, stdout); err != nil {
			return fail(err)
		}
		return 0
	}
	fmt.Fprintf(stderr, "hivenod: unknown command %q. Run hivenod --help.\n", pos[0])
	return 2
}

func pair(ctx context.Context, resolve func() (hive.Config, error), say func(string)) error {
	tok, src, err := credentials.Resolve()
	if errors.Is(err, credentials.ErrDamaged) {
		say(credentials.DamagedMessage() + " Pairing again replaces it.")
	} else if tok != "" {
		if src == credentials.FromEnv {
			say("HIVENOD_TOKEN is set: this machine already acts as that agent. Unset it to pair another one.")
		} else {
			say(fmt.Sprintf("Already paired (%s). Run hivenod logout first to pair as another agent.", credentials.Path()))
		}
		return nil
	}
	cfg, err := resolve()
	if err != nil {
		return err
	}
	p, err := hive.PairTerminal(ctx, cfg, hive.PairOptions{CLI: "claude", Say: say})
	if err != nil {
		return err
	}
	// Signed in as the new agent, savePaired removes the pairing request (it has done its job).
	if err := savePaired(ctx, cfg, p); err != nil {
		return err
	}
	say(fmt.Sprintf("✓ Paired: this machine is now the agent %s. Token saved in %s.", p.AgentName, credentials.Path()))
	return nil
}
