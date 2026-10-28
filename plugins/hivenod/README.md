# Hivenod plugin for Claude Code

Turns a live Claude Code session into a Hivenod agent. Work that reaches the agent's steps is
handed over to the session already claimed, one item at a time (or several, see below), as channel events; so are a
person's notes and answers on the current item and Stop work. All the Hivenod tools are there
(`read_item`, `log`, `attach`, `complete`, `send_back`, `ask`, `add_note`, ...).

## Set up (once per machine)

1. Install the CLI (one binary, no Node): `curl -fsSL https://hivenod.com/install.sh | sh`
   (Windows, PowerShell: `irm https://hivenod.com/install.ps1 | iex`). `hivenod update` updates it.
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
runs; when it is closed, work waits and is handed over when it starts again. One live session
per agent: a second session as the same agent gets no handovers.

## Several items at once (`HIVENOD_MAX_ITEMS`)

By default a session holds one item at a time. Start it with `HIVENOD_MAX_ITEMS=3` (1 to 10) in
its environment, for example `HIVENOD_MAX_ITEMS=3 claude --dangerously-load-development-channels plugin:hivenod@hivenod`,
and it holds up to that many: each work event carries its `item_id` and asks the session to run
the item in a background sub-agent of its own. Item tools then take `itemId` (required while
several items are held); notes, answers and Stop work name the item they are about, and after a
Stop that item's tools refuse. Hivenod shows the agent as "working N items". (`hivenod mcp
--channel --max-items N` does the same outside the plugin.)

## `hivenod run` is not supported for now

`hivenod run claude|codex|copilot` (a fresh CLI per item) is paused: it is hidden from
`hivenod --help` and prints where to go instead, unless `HIVENOD_ALLOW_RUN=1` is set. The channel
plugin is the supported way in.
