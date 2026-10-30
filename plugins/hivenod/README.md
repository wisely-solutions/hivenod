# Hivenod plugin for Claude Code

Turns a live Claude Code session into a Hivenod agent. Work arrives as Inbox threads: a thread
that needs agent work, an approved outcome or plan step to carry out, a person's request on a
thread, as channel events. All the Hivenod tools are there (`thread_read`, `outcome_propose`,
`plan_propose`, `outcome_done`, `step_progress`, `thread_summary`, ...). Projects were removed from
Hivenod: there are no items to claim and no item tools any more (an older CLI that still lists
them is refused: run `hivenod update`).

## Set up (once per machine)

1. Install the CLI (one binary, no Node): `curl -fsSL https://hivenod.com/install.sh | sh`
   (Windows, PowerShell: `irm https://hivenod.com/install.ps1 | iex`). `hivenod update` updates it.
   Keep it current: a CLI older than an event kind silently misses those events (for example a
   person's request to revise a proposal). A running session writes its version to the agent
   (shown on the agent's page, with "Update available" when a newer one is published) and tells you
   once a day, as an info event, when a newer hivenod exists: run `hivenod update`, then restart
   the session. `HIVENOD_NO_UPDATE_CHECK=1` turns the daily check off.
2. Pair this machine as an agent: `hivenod pair`, then confirm the code in Hivenod (Agents).
   The token is saved in `~/.hivenod/agent.json` (or set `HIVENOD_TOKEN`); it never enters the
   session.
3. Add the marketplace and install the plugin:
   ```
   claude plugin marketplace add wisely-solutions/hivenod     # or a local clone: ./path/to/hivenod
   claude plugin install hivenod@hivenod
   ```

Already run other channel sessions on this machine? Give this one a Claude config of its own: run
`export CLAUDE_CONFIG_DIR=~/.claude-hivenod` before the plugin commands above and the start command
below, in each terminal.

## Start a session

Hivenod is not on Claude Code's approved channels list yet, so start the session with:

```
claude --dangerously-load-development-channels plugin:hivenod@hivenod
```

Confirm "I am using this for local development". The session shows online in Hivenod while it
runs; when it is closed, work waits and is sent when it starts again. One live session per
agent: a second session as the same agent gets no events.

## Several long steps at once (`HIVENOD_MAX_ITEMS`)

Build and Release steps of a Development plan are long steps. By default a session runs one at a
time; start it with `HIVENOD_MAX_ITEMS=3` (1 to 10) in its environment, for example
`HIVENOD_MAX_ITEMS=3 claude --dangerously-load-development-channels plugin:hivenod@hivenod`, and
it runs up to that many (`hivenod mcp --channel --max-items N`, alias `--max-steps`, does the
same outside the plugin). Other Inbox events do not count toward it (`--max-inbox`, default 3,
caps the threads sent at once). The limit is per session: to do more work at once, connect
another machine with its own agent. See [Many agents, many machines](../../docs/SCALING.md).

The channel protocol only states the contract. How the session organises the work is the plugin's
`hivenod` skill (`skills/hivenod/SKILL.md`, new in 0.2.0; threads only since 0.3.8): the main
session stays a thin orchestrator and runs each Inbox thread in a background sub-agent of its own,
and routes the thread's follow-up events to it. Other agent hosts get the contract only. Update the plugin
(`claude plugin update hivenod@hivenod`) to get the skill.

## No `hivenod run`

`hivenod run claude|codex|copilot` (a fresh CLI per item) belonged to the old TypeScript CLI and
was removed with it. The channel plugin is the way in.
