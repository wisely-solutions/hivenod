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

One real session (`s1`), then more, each printed as `[smoke] CHECK ... PASS`:

| Check                                | How                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Work is handed over, already claimed | an item reaches the agent's step; its claim is seen in Firestore with no claim call (the channel offers none)                                    |
| Complete                             | the model adds a note and calls `complete`; the item moves to Review, claim released                                                             |
| A note and Stop work arrive          | on a held item a person's note and then Stop work are pushed; the model answers `ACKNOTE` / `ACKSTOP`                                            |
| A second session is told busy        | a second `claude` as the same agent shows "already running in another terminal"                                                                  |
| Quit, then restart                   | `/exit` the first session, add a waiting item (nobody online: unclaimed), start a new session: the item is handed over on reconnect and finished |

Then (card cGSENsRF; item xkQd9: the standing prompt never mentions sub-agents, the hint comes only from the plugin's `hivenod` skill) one session with `HIVENOD_MAX_ITEMS=3` and four items (two finish at once, two
hold with a note until a person says to finish):

| Check                 | How                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| max_items             | three items are claimed at once, the 4th stays unclaimed; never more than 3 held while the session runs                                                  |
| 4th                   | the waiting item is handed over after one of the first three ends                                                                                        |
| Sub-agents            | the session transcripts (in the private config) show each item's `add_note` / `complete` made by a sub-agent (sidechain), a different sub-agent per item |
| Stop stops only that  | Stop work on one held item: the session answers `ACKSTOP <id>`, that run is stopped, the other held item keeps its claim and open run                    |
| Note to the sub-agent | a person's note on the other held item reaches a sub-agent for that item, which completes it                                                             |

Then (item QjTTL) one session with max_items 1: the model parks its item with the reason "release
batch"; it stays claimed and parked, the next item is handed over and finished meanwhile, and a
person's note on the parked item reaches the session (`ACKNOTE`) and wakes it (`parked` cleared).

`hivenod` is the Go CLI binary (`cli/`, built with Go once per run), the only agent client.

It first runs the connect flow (item EJ2Cxq4k): `hivenod connect --no-start`
with no token and no browser shows a code; a plain member confirms it (what the /connect page does);
connect saves the token and installs the plugin into the private config itself (marketplace: this
repo, through `HIVENOD_PLUGIN_MARKETPLACE`); then `hivenod claude` starts the session, which gets an
item and finishes it. The later parts reuse that plugin install.

Then (item 4PEHr) one session with max_items 1 holding an item: an Inbox thread the agent brought
in arrives as an `inbox` event although max_items is full, a sub-agent (from the skill) investigates it and
proposes an outcome (the item stays held), and once the person approves it the carry-out event
reaches the session and a sub-agent reports it with `outcome_done`.

`pnpm smoke:claude --only connect`, `--only basic`, `--only max-items`, `--only park` or `--only inbox` runs one part. `HIVE_SMOKE_MODEL` picks the model
(default haiku).

Waits are bounded (60 s start-up, 90-180 s per model step, 15 min per part, 35 min overall).
The `pnpm test:scripts` suite covers the guard helpers only (`scripts/smoke-claude.test.mjs`).
