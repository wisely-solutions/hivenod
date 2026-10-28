# @hive/agent: the Hivenod agent client

Lets an agent (a Claude Code session with the channel plugin) work in Hivenod with its token. Every action goes through the
same batched write and event as the web app, so everything an agent does is tracked, and the
Firestore rules stop it from approving or moving anything at a human gate.

## Connect an agent: the Claude Code channel plugin

Set up (the same steps the New agent dialog in Hivenod shows, with copy buttons):

1. **Install the Hivenod CLI** (one command, served from Hivenod's own hosting; no npm account needed;
   Node 20 or newer, and Claude Code installed and logged in,
   [install guide](https://docs.claude.com/en/docs/claude-code/setup)):
   ```sh
   npm install -g https://hivenod.com/cli/hivenod-latest.tgz
   hivenod --version        # check: prints the version and the release commit
   ```
   Versioned files stay next to it (`/cli/hivenod-<version>.tgz`, list in `/cli/versions.json`).
2. **Pair the machine**, once:
   ```sh
   hivenod pair
   ```
   It shows a code; confirm it in Hivenod (Agents, New agent).
3. **Add the plugin:**
   ```sh
   claude plugin marketplace add wisely-solutions/hivenod
   claude plugin install hivenod@hivenod
   ```
4. **Start the session** in the folder the agent should work in:
   ```sh
   claude --dangerously-load-development-channels plugin:hivenod@hivenod
   ```
   Already run other channel sessions? Give this one its own Claude config first
   (`export CLAUDE_CONFIG_DIR=~/.claude-hivenod`). Details: `plugins/hivenod/README.md`.

Troubleshooting: `hivenod: command not found` means npm's global bin folder is not on your `PATH`
(`npm prefix -g`, add its `bin`). "Folder not trusted": run `claude` once there. A pairing code
expires after 15 minutes: run `hivenod pair` again.

Moving from the old `hive` command (Hive is now Hivenod, card wQ7ZfmYr): install `hivenod` as above
and pair again with `hivenod pair`. `hive` now only prints how to do that and exits 1; the
old `HIVE_TOKEN`, `HIVE_HOME` and `~/.hive` are not read (use `HIVENOD_TOKEN`, `HIVENOD_HOME`,
`~/.hivenod`). Remove the old folder yourself (`rm -rf ~/.hive`) and revoke the old agent in
Hivenod if it is no longer used; uninstall with `npm uninstall -g hive-cli`.

## Not supported for now: `hivenod run`

`hivenod run claude|codex|copilot` (card Ul32d6Ee: paused) starts a fresh CLI per item. It is hidden
from `hivenod --help` and prints "hivenod run is paused for now; use the Claude Code channel plugin"
unless `HIVENOD_ALLOW_RUN=1` is set. The code, its tests and the past runs' history, cost and activity
stay. What follows describes the paused engine, for reference.

1. **Pairing (first time only).** It prints a link and a code like `K7QX-29PD`. An admin opens the
   link (or Agents, New agent, and types the code), checks it is the same code, picks a
   name and projects, and presses Connect. Hivenod creates the agent and hands its token to the
   waiting terminal, encrypted for a key only that terminal has; nobody sees the token. It is
   saved to `~/.hivenod/agent.json` (mode 0600; `HIVENOD_HOME` moves the folder) and reused next time.
   `hivenod logout` shreds it (overwrites, then deletes). `HIVENOD_TOKEN` still works and wins over
   the file.
2. **The loop.** It waits for AI work (live, no model tokens while waiting), claims an item and
   opens Claude Code for that one item with a Hivenod MCP server bound to it (`read_item`, `log`,
   `progress`, `attach`, `ask`, `raise_finding`, `finish`), heartbeats, reads tokens and model,
   then completes the step (stopping at a human gate) and waits again. It stays on until Ctrl+C.
   `--once` does one item; `--project P` (id or name) limits it to one project, and a project
   the agent may not use is an error at once; `--model M` picks the model. While it waits the
   agent shows as Online in Hivenod; when it stops (Ctrl+C, `--once`, exit) it shows Offline.
   - _Interactive (the default in a terminal, card OPpbi0MS)._ Each item opens a real, fresh
     Claude Code session in this terminal: you can type to it any time. Remote Control is on, so
     the same session shows on claude.ai/code and in the Claude app; the link is in Claude's
     footer, in the run's log and on the run in Hivenod ("Open in Claude"). Your own Claude setup
     loads (skills, MCP servers, plugins, CLAUDE.md) plus the Hivenod item tools; `--clean` loads
     only the Hivenod MCP server. When the model calls `finish`, Hivenod closes the session (once Claude
     has stopped talking) and waits for the next item. Inside Claude, Ctrl+C is Claude's: closing
     Claude yourself before the item is finished gives the item back and stops `hivenod run`.
     Tokens, model and cost come from Claude's session log (`~/.claude/projects/…/<session>.jsonl`);
     if it cannot be read, the run says so and the model shows as "unknown". Remote Control needs
     a claude.ai login with Remote Control; without it the session runs in the terminal only and
     the run log says so. The folder must be one Claude trusts (run `claude` there once).
   - _Headless_ (`--headless`, or when no terminal is attached): `claude -p … --output-format
stream-json`, nobody at the keyboard, today's Build B behaviour.
3. **Guardrails, enforced by `hivenod run`, not by the model:**
   - _Permissions are yours._ What Claude may do on your machine is decided by your own Claude Code
     config (`~/.claude/settings.json` or the project's `.claude/settings.json`: `permissions.allow` /
     `permissions.deny`, default mode; see the
     [permissions docs](https://docs.claude.com/en/docs/claude-code/iam)). Hivenod does not set,
     store or force any of it: an interactive run uses your default mode and your allow rules (a
     prompt shows in the terminal and via Remote Control). A `PermissionRequest` hook
     (`hivenod run`, no credential, over the run bridge) denies a prompt nobody answers within 10
     minutes; the run log shows the wait. A headless run uses `--permission-mode dontAsk`, so
     whatever your settings do not allow is denied, never asked, unless you pass a permission flag
     after `--` (`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`,
     `--permission-mode`): then Hivenod forces no mode and yours applies. The folders below stay denied
     (`--disallowedTools`) and the token stays out of Claude's reach even with bypass. Hivenod only allows its own tools and
     reading up front. (Older agents may still store an allow-list or token limit in Hivenod: ignored.)
   - _Tokens are tracked, never limited._ New tokens (cache reads shown apart), model and cost show
     on each run and item, live while it runs; no run is ever stopped, failed or held over tokens.
   - _60 minutes per run_ (`--max-minutes`), then the CLI is stopped and the run fails.
   - _3 failed runs in a row_ pause the agent; the session stops (exit code 4).
   - _Revoke_ in Hivenod stops the CLI within about a minute (exit code 3). The revoke itself ends
     the agent's open runs and gives their items back; an agent taking over a stale claim ends
     the old run too, so no run stays "running" forever.
   - _Questions._ The model asks with `ask` and finishes with `needs_answer`: the item goes back
     at once and nobody takes it until people answer; then it is picked up again with the answer.
   - _Gates._ The CLI gets no tool that claims, completes or decides; only `hivenod run` completes,
     one step forward.

The token stays inside `hivenod run` in both modes. Claude's MCP server (`hivenod mcp --run R --bridge S`) has no
credential at all: it forwards each tool call over a local socket (in a 0700 temp folder) to
`hivenod run`, which runs it bound to the one item. Nothing in Claude's arguments or environment
leads to the token, Claude's file tools are denied on `~/.hivenod` and on the run's own temp folder (`--disallowedTools
Read(//…/.hivenod/**),Edit(//…/.hivenod/**)`, same for the run folder), and `attach` refuses files from
those folders (each with its own message). Note that if your Claude Code settings allow `Bash`, the
model has a full shell, which can read any file you can.

## `hivenod run codex` and `hivenod run copilot`: EXPERIMENTAL, untested

> These two have **never been run against a real OpenAI or GitHub account**. They were built from
> each CLI's help output, docs and package source, and are tested only with recorded-style
> fixtures and fake CLIs. Watch the first items closely, and report what breaks.

```sh
node /path/to/hivenod/packages/agent/dist/cli.js run codex     # OpenAI Codex CLI (checked: 0.164.0)
node /path/to/hivenod/packages/agent/dist/cli.js run copilot   # GitHub Copilot CLI (checked: 1.0.103)
node /path/to/hivenod/packages/agent/dist/cli.js run codex --help   # what is and is not verified
```

Pairing, the loop, the one-item Hivenod MCP server and every guardrail (time limit, failure streak,
revoke, questions, gates) are the same as `hivenod run claude`; tokens are tracked, never limited. Differences:

- **Always headless** (one `codex exec --json` or `copilot -p --output-format json` per item):
  there is no interactive mode, no Remote Control and no `--clean`.
- **Sign in to the CLI yourself first** (`codex login`; Copilot `/login` or `COPILOT_GITHUB_TOKEN`).
  Hivenod never asks for, stores or routes that login.
- **Before the loop** Hivenod reads the CLI's version and help: a flag Hivenod needs that is missing
  stops it with a clear message; a version other than the checked one prints a warning.
  `HIVENOD_CODEX_BIN` / `HIVENOD_COPILOT_BIN` pick another executable.
- **Codex: fixed, coarse permissions.** Codex does not read your Claude Code settings and has no
  per-command rules, so Hivenod uses fixed defaults (edit files, run tests, git commit) as its sandbox:
  `workspace-write` (edits in this folder), network off. Commands always run, inside the sandbox, and can read files outside the folder,
  including the token saved by pairing (`~/.hivenod/agent.json`). So **`hivenod run codex` requires
  `HIVENOD_TOKEN` and refuses a saved token** (and pairing, which would save one): it stops with a
  message before doing anything. Codex 0.164.0 does have a per-path `none` access in permission
  profiles (`deny_read`), and the config parses, but its enforcement could not be observed
  offline, so Hivenod does not rely on it. Your `config.toml` is not loaded
  (`--ignore-user-config`; the login still is), so only the Hivenod MCP server is there; `--model`
  picks the model. `--full-auto` was removed from Codex and is never used.
- **Copilot: every item spends AI Credits** from your GitHub Copilot plan. Copilot does not read your Claude Code settings either: Hivenod's fixed defaults become
  `--allow-tool` rules (`write`, `shell(git commit)`, `shell(npm test:*)`, …) and a kind
  with no rule at all (`url`) is denied; `--allow-all-*` / `--yolo` are never
  passed and `COPILOT_ALLOW_ALL` is removed from its environment. File tools stay inside the
  folder. The built-in GitHub MCP servers are off; your own `~/.copilot` MCP servers still load.
- **Tokens and model**: Codex from `turn.completed` (running totals and the model from its session
  file in `~/.codex/sessions`); Copilot from OpenTelemetry spans while it runs and its
  `--usage-output-file` at the end. Input includes cached input (shown apart). No cost is recorded
  for either (cost logic is out of scope).

### Verified or not

|                                          | Codex 0.164.0                                                                                       | GitHub Copilot CLI 1.0.103                                                                                                |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Flags Hivenod passes exist (help output) | verified                                                                                            | verified                                                                                                                  |
| Config / MCP wiring parses               | verified (`-c mcp_servers.hivenod.*`, `approval_policy`, approval mode values via `codex mcp list`) | verified (MCP config shape via `copilot mcp list`; the full command line parses up to the login check)                    |
| Output field names                       | event and token field names found in the binary                                                     | final `result` line and usage-file shape from the package source; usage-file top level written by a real (signed-out) run |
| A real run end to end                    | **not verified**                                                                                    | **not verified**                                                                                                          |
| Event shapes other than the above        | **not verified**                                                                                    | **not verified**                                                                                                          |
| Running totals + model while it runs     | **not verified** (session file)                                                                     | **not verified** (OpenTelemetry file format and attribute names)                                                          |
| Permissions behave as intended           | **not verified** (MCP calls without a prompt; `git commit` inside workspace-write)                  | **not verified** (`-p` with explicit rules and no `--allow-all-tools`; multi-word `shell(npm test:*)`)                    |

Gemini CLI is not supported: since June 2026 it no longer works with personal Google accounts
(`hivenod run gemini` says so). It can come back with a paid API key or Antigravity CLI.

## Advanced: plain MCP with a token (without `hivenod run`)

1. **Get a token.** In Hivenod: Agents (top-level), New agent. Copy the token (`hive_agt_...`); it is shown once.
2. **Build the client** (once, from the repo root):
   ```sh
   pnpm install && pnpm --filter @hive/agent build
   export HIVENOD_TOKEN=hive_agt_...
   node packages/agent/dist/cli.js whoami
   ```
3. **Give it to Claude Code.** Add this to `.mcp.json` in your project (use the real path and token):
   ```json
   {
     "mcpServers": {
       "hivenod": {
         "command": "node",
         "args": ["/path/to/hivenod/packages/agent/dist/cli.js", "mcp"],
         "env": { "HIVENOD_TOKEN": "hive_agt_..." }
       }
     }
   }
   ```
   Claude Code then lists the tools `list_work`, `claim`, `read_item`, `log`, `attach`, `ask`,
   `progress`, `raise_finding`, `end_run`, `complete`, `report_usage` and `wait_for_work`. (`claude mcp list` shows the server.)

## The loop

```sh
hivenod work list                         # items waiting for an agent
hivenod work wait [--timeout 300]         # blocks until work is waiting (live, seconds after a gate approval)
hivenod work claim <itemId>               # starts a run, prints runId
hivenod item read <itemId>                # brief, instructions, messages, why it was sent back
hivenod run log <runId> "what I am doing"
hivenod item attach <itemId> report.html  # html/md/txt/png/jpg/pdf up to 900 KB, else give a URL
hivenod item ask <itemId> "Which audience?"          # shows under "Needs you"
hivenod finding raise <itemId> "title" "details"     # suggest something outside your task (not work)
hivenod run usage <runId> --tokens-in 52000 --tokens-cached 40000 --tokens-out 900 --model claude-opus-5-5
hivenod run end <runId> --status done --cost 0.42 --tokens-in 1200 --tokens-out 300
hivenod item complete <itemId> --run <runId>         # moves on along its path; stops at the next human gate
hivenod item path <itemId>                           # every library step: done, current, ahead, skipped
hivenod item skip <itemId> <stepId> --reason "why"   # skip an agent step ahead (--undo puts it back)
hivenod item ask-path <itemId> <stepId> "reason"     # ask a people step's deciders to skip it
hivenod step propose <itemId> --name N --kind agent|human --after <stepId> --reason "why"
```

Add `--json` to any command for machine-readable output (errors become `{"error": "..."}` on
stderr, exit code 1). Use `--project <id>` if an item id exists in more than one project.

- **Waiting for work.** `hivenod work wait` (MCP: `wait_for_work`) listens live and returns the rows as soon
  as an item reaches an agent step, for example right after a person approves a gate (within about
  a second). It returns at once if work is already waiting, and after the timeout (default 10 min
  CLI, 5 min MCP) with nothing, so call it in a loop. Agents that are not connected still need a
  scheduled or webhook wake (a separate decision).
- **Heartbeats.** While a run is open, the process that claimed it beats every 60 s (the MCP
  server does this for you). For one-shot CLI use, loop `hivenod run heartbeat <runId>` yourself:
  a claim goes stale after 10 minutes without one.
- **Per-item paths.** Each item goes only through the library steps it needs. A new item is first
  _shaped_: `work list` shows it as `(to shape)` (MCP: `job: "shape"`), any agent on the project may
  claim it (step limits do not apply), read the library (`hivenod item read` / `read_item`, field
  `path`) and end the shaping run with `hivenod item shape <itemId> --run R --skip a,b --note "…"`
  (MCP: `shape_item`). Agent steps it skips apply at once; a people step can only be skipped by one
  of its deciders, so listing one asks them (it stays on the path until one approves). While working
  an item, `item skip` / `skip_step` changes agent steps ahead, `item ask-path` / `ask_path_change`
  asks about people steps, and `step propose` / `propose_step` suggests a new library step to an
  approver. `hivenod run` does all of this for you, and stops with an update message when Hivenod
  needs a newer CLI (`cliProtocol` in /version.json).
- **Findings are suggestions.** `hivenod finding raise` (MCP: `raise_finding`) works on any item of a
  project this agent may use, holding it or not. The finding waits in the suggestions lane at the
  top of the project's first step until a person adds it there or dismisses it (with a reason). It
  is not work: it never shows in `work list` / `wait_for_work` and cannot be claimed. Once added,
  it is a normal item that agents pick up like any other.
- **Settings and guardrails** (set by an admin on the agent's page in Hivenod; `hivenod whoami` shows them):
  - _Projects and steps._ The agent works only in its projects. A project's process can limit an
    agent step to some agents: other agents never see it in `work list` / `wait_for_work`, and the
    rules refuse their claim.
  - _Failed runs._ Each `run end --status failed` adds one to
    the agent's failure streak; a done run resets it. At the limit (default 3 in a row) the agent
    pauses itself: `work list`, `work wait` and `work claim` then say "This agent is paused" until
    an admin presses Resume. Revoking stays the stop switch.
  - _Tokens._ Report `tokensIn` (all input, cache reads included), `tokensCached` and `tokensOut`
    with `hivenod run usage` / `report_usage` while working: usage is tracked and shown (new tokens =
    input without cache reads, plus output) and never limits a run.
  - _When unsure, ask._ An item whose latest run asked a question and was given back (released or
    failed) is not offered again until people answer.
  - _Permissions._ Not set in Hivenod: what Claude may do on a machine is that machine's Claude Code
    settings. (Codex and Copilot, which do not read them, get fixed defaults.)
- **Gates.** `complete` moves an item exactly one step forward. At a human step only people can
  decide: the client says "This item is at a human gate. Only people can move it."
- **Sessions.** The token signs in with the Firebase JS SDK; the session refreshes by itself. A
  revoked or rotated agent gets a clear message and must be given a new token.
- **Emulators** (development): set `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` and
  `HIVENOD_PROJECT_ID`.

Tests: `pnpm --filter @hive/agent test` (unit) and, with the emulators running,
`pnpm test:rules` (includes the end-to-end agent run). Real Claude Code sessions with the channel
plugin: `pnpm smoke:claude`, manual only, see [docs/AGENT-SMOKE.md](../../docs/AGENT-SMOKE.md).
