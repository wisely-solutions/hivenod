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
  hivenod logout           forgets the token saved by pairing
  hivenod mcp              MCP stdio server for Claude Code
  hivenod mcp --channel [--project P] [--step S] [--max-items N]
                           the same, as a Claude Code channel: a live session gets its work
                           pushed in, claimed, up to N items at a time (default 1, or
                           HIVENOD_MAX_ITEMS)
  hivenod update           installs the latest release (checks its SHA-256 checksum)
  hivenod version          the installed version (matches the Hivenod release)

  whoami and mcp use HIVENOD_TOKEN, or the token saved by connect or pair (~/.hivenod/agent.json).
  --json prints machine-readable output.`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

type opts struct {
	json, channel, help, version, force, noStart bool
	project, step, maxItems                      string
}

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
	cfg := hive.FromEnv()
	say := func(s string) { fmt.Fprintln(stdout, s) }
	switch pos[0] {
	case "connect":
		if err := connect(ctx, cfg, say, o.noStart); err != nil {
			return fail(err)
		}
		return 0
	case "pair":
		if err := pair(ctx, cfg, say); err != nil {
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
		u := &update.Updater{Site: cfg.WebURL, Say: say}
		msg, err := u.Run(ctx, o.force)
		if err != nil {
			return fail(err)
		}
		say(msg)
		return 0
	case "whoami":
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
	case "mcp":
		if err := runMCP(ctx, cfg, o, stdin, stdout); err != nil {
			return fail(err)
		}
		return 0
	}
	fmt.Fprintf(stderr, "hivenod: unknown command %q. Run hivenod --help.\n", pos[0])
	return 2
}

func pair(ctx context.Context, cfg hive.Config, say func(string)) error {
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
