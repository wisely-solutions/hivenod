# Real-Claude smoke test (`pnpm smoke:claude`)

Card ZY6KC56r. Verifies the `hivenod` Claude Code channel plugin end to end in **real interactive
Claude Code sessions** (model: haiku, a few cents) against the Firebase emulators.

**Manual only. Never in CI, never in `pnpm e2e` / `test:rules`.** It needs a signed-in `claude` on the
machine, spends model usage, drives a terminal UI through tmux (slow, timing dependent) and keeps its
own emulators busy for several minutes. The vitest file
(`cli/e2e/test/claude.channel.smoke.test.ts`) skips itself unless the wrapper set its
environment, so `pnpm test:rules` never runs it.

## Run

```
pnpm smoke:claude
```

Needs `claude`, `tmux`, `shred` and the emulator toolchain on PATH, and `~/.claude/.credentials.json`.
Its emulators run on ports of their own (`scripts/emu-exec.mjs`), so it never collides with a running e2e.

## Why a wrapper (the danger)

Starting an extra `claude` with the everyday config loads the user-level channel plugins and MCP
servers: the Telegram plugin SIGTERMs the live poller (the orchestrator loses Telegram) and a second
agent-mail server can take mail meant for the live session. So the wrapper (`scripts/smoke-claude.mjs`):

1. makes a temp dir `T`, with `CLAUDE_CONFIG_DIR=$T/cfg` holding only a copy of `.credentials.json`
   (mode 600) and a minimal `.claude.json` (onboarding done, no MCP servers); claude runs with
   `env -i`, `HOME=$T/home` and cwd in `T` (no project `.mcp.json`);
2. installs the plugin from this repo's marketplace into that config (`claude plugin marketplace add`,
   `claude plugin install hivenod@hivenod`, local scope) with a `hivenod` stub on PATH pointing at the
   emulators with an emulator agent token;
3. **guard**: before any claude starts it snapshots `pgrep -u $USER -af 'agent-mail/server.ts|agent-telegram|telegram'`
   and compares every second, after the start and at the end. Any new pid aborts at once, kills what
   the smoke started and exits non-zero (3 at the end). It never kills a process it did not start (it
   only kills its own tmux server, its own process group and processes whose environment has its
   private `CLAUDE_CONFIG_DIR`). A transient process with "telegram" in its command line started by
   someone else during the run also trips it: just run again;
4. **always cleans up** (exit, error, SIGINT/SIGTERM, timeout): kills tmux and everything it started,
   `shred`s the copied credentials and removes `T`.

Credentials are copied, not shared: if Claude Code refreshes the OAuth token inside the copy, the copy
is discarded with `T`.

## What it checks

Work arrives as Inbox threads only (projects and items were removed). Each check is printed as
`[smoke] CHECK ... PASS`.

It first runs the connect flow (item EJ2Cxq4k): `hivenod connect --no-start`
with no token and no browser shows a code; a plain member confirms it (what the /connect page does);
connect saves the token and installs the plugin into the private config itself (marketplace: this
repo, through `HIVENOD_PLUGIN_MARKETPLACE`); then `hivenod claude` starts the session, which gets an
Inbox thread, investigates it and proposes an outcome.

| Check   | How                                                                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| connect | a plain member confirms the code, the token is saved and the plugin installed; the connected agent investigates a thread                            |
| thread  | a sub-agent (from the plugin's `hivenod` skill) reads the thread and proposes an outcome                                                            |
| busy    | a second `claude` as the same agent (another machine, `HIVENOD_HOST_ID`) shows "already running in another terminal"                                |
| restart | `/exit` the first session, add a thread nobody works on, start a new session: the thread is sent on reconnect and investigated                      |
| inbox   | a sub-agent proposes an outcome; once the person approves it the carry-out event reaches the session and a sub-agent reports it with `outcome_done` |

`hivenod` is the Go CLI binary (`cli/`, built with Go once per run), the only agent client. The later
parts reuse the plugin install of the connect part.

`pnpm smoke:claude --only connect`, `--only basic` or `--only inbox` runs one part. `HIVE_SMOKE_MODEL`
picks the model (default haiku).

Waits are bounded (60 s start-up, 90-180 s per model step, 15 min per part, 35 min overall).
The `pnpm test:scripts` suite covers the guard helpers only (`scripts/smoke-claude.test.mjs`).
