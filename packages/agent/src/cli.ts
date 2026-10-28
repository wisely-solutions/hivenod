#!/usr/bin/env node
/** The `hivenod` command (SPEC section 10). `--json` prints machine-readable output. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { setLogLevel } from 'firebase/firestore';
import { outcomeType } from '@hive/shared';
import { deleteEvents, freeTime, upsertEvents, type CalendarEventArg } from './calendar';
import { HiveClient } from './client';
import { HiveError, isRateLimited, messageOf } from './errors';
import { bridgeClient, bridgedTools } from './bridge';
import { runBridgedMcp, runMcp } from './mcp';
import { parseMaxItems } from './channel';
import {
  clearCredentials,
  credentialsPath,
  damagedMessage,
  readCredentials,
  resolveToken,
  saveCredentials,
} from './credentials';
import { pairTerminal } from './pair';
import { describeRequest, hookDecision } from './interactive';
import { EXIT, headerLines, Runner } from './runner';
import { runTools } from './runtools';
import { retryOnRateLimit } from './startup-retry';
import type { CliAdapter } from './adapter';
import { ADAPTERS } from './clis';
import { updateNeeded, versionLine } from './version';
import { HIVENOD_WEB_URL } from './pair';
import { activeSite, resolveServer, serverFields } from './server';
import { isRunCli } from '@hive/shared';
import { claudeArgsProblem, describeExtraArgs, isBypass } from './claude';

export const PERMISSIONS_DOCS = 'https://docs.claude.com/en/docs/claude-code/iam';

/** `hivenod run <cli>` is paused (card Ul32d6Ee): the Claude Code channel plugin is the way in. */
export const RUN_PAUSED = `hivenod run is paused for now; use the Claude Code channel plugin (see ${HIVENOD_WEB_URL}/agents)`;
/** Set HIVENOD_ALLOW_RUN=1 to run the paused engine anyway. */
const runAllowed = () => process.env.HIVENOD_ALLOW_RUN === '1';

const HELP = `hivenod: work in Hivenod as an agent, through the Claude Code channel plugin.

  hivenod pair                                         pairs this machine with Hivenod (shows a code
                                                    an admin confirms) and saves the token; then
                                                    install the hivenod plugin in Claude Code
  hivenod pair --server https://your.host              the same with a self-hosted Hivenod (saved
                                                    with the token; HIVENOD_WEB_URL does the same)

  hivenod --version                                    the installed version (matches the Hivenod release)
  hivenod logout                                       forgets the token saved by pairing

  The commands below use HIVENOD_TOKEN, or the token saved by pairing (~/.hivenod/agent.json).

  hivenod whoami
  hivenod work list [--project P] [--step S]
  hivenod work wait [--project P] [--step S] [--timeout SECONDS]
                                                    blocks until work is waiting (live, within seconds)
  hivenod work claim <itemId>                          starts a run, prints runId
  hivenod run log <runId> "text" [--level info|warn|error]
  hivenod run heartbeat <runId>
  hivenod run usage <runId> --tokens-in N --tokens-out N [--tokens-cached N] [--model M]
                       running totals so far (tracked and shown in Hivenod, never limited)
  hivenod work release <itemId>       gives an item you hold back to the queue (failed or unfinished work)
  hivenod run end <runId> --status done|failed [--cost 0.42] [--tokens-in N --tokens-out N]
                       [--tokens-cached N] [--summary "..."] [--model M]
  hivenod item read <itemId>                           brief, attachments, messages, send-back reasons
  hivenod item attach <itemId> <file|url> [--name N]   html/md/txt/png/jpg/pdf up to 900 KB, else a URL
  hivenod item ask <itemId> "question"                 appears in "Needs you"
  hivenod item progress <itemId> <done> <total>
  hivenod item complete <itemId> --run <runId> [--cost ...]   moves on; stops at the next human gate
  hivenod finding raise <itemId> "title" "details"   suggests it to people (not work; no claim needed)
  hivenod calendar upsert <events.json|-> [--member M]   adds or updates a member's events here
                       (a JSON array like calendar_upsert's events; same source id = same event)
  hivenod calendar delete <id>... | --source S [--member M] <sourceEventId>...
  hivenod calendar free --from T --to T [--member M] [--min N]
                       free time across all the member's organizations (busy time only)
  hivenod create-item --project P --title "title" [--description "brief"] [--attach file|url]...
                       creates an item (work at the first step) where the project lets agents
                       create items; at most 30 an hour
  hivenod inbox add --source S --sender NAME --thread-ref REF --received-at ISO (--text T | --text-file F)
                    [--handle H] [--message-id M] [--permalink URL] [--reply-ref R] [--member UID]
                    [--thread ID] [--from-member] [--title T]
  hivenod inbox list | note <threadId> --text T | ask <threadId> --text Q
  hivenod thread read <id> | wake <id>
  hivenod subject list [--member UID] | assign <threadId> (--subject-id S | --name "Topic")
  hivenod outcome propose <threadId> --type T [--field name=value]... [--note N]
  hivenod outcome done <outcomeId> --status done|failed [--text T] [--permalink URL] [--item-id I] [--error E]
                       a person's Inbox (item 4PEHr): nothing is carried out before they approve
  hivenod item path <itemId>                           the item's path: every library step, skipped or not
  hivenod item shape <itemId> --run R [--skip a,b] [--reason "why"] --note "one line"
                       ends a shaping run (work list shows job shape): the steps it skips; people
                       steps listed are asked of their deciders and stay until one approves
  hivenod item skip <itemId> <stepId> [--undo] [--reason "why"]
                       skips an agent step ahead on the item you hold (--undo puts it back)
  hivenod item ask-path <itemId> <stepId> "reason"   asks a people step's deciders to skip it / put it back
  hivenod step propose <itemId> --name N --kind agent|human --after <stepId|''> --reason "why"
                       [--description D] [--instructions I]   a new library step, for an approver
  hivenod mcp                                          MCP stdio server for Claude Code
  hivenod mcp --channel [--project P] [--step S]       the same, as a Claude Code channel: a live
                                                    session gets its work pushed in, claimed,
                                                    one item at a time (the hivenod plugin)
      [--max-items N]                                  holds up to N items at once (1-10, default 1;
                                                    or HIVENOD_MAX_ITEMS), each for a sub-agent

Add --json for JSON output. Use --project P if an item id is ambiguous.`;

/** `hivenod run <cli> --help`. */
export const RUN_HELP: Record<'claude' | 'codex' | 'copilot', string> = {
  claude: `hivenod run claude [--project P] [--model M] [--once] [--max-minutes N] [--headless] [--clean] [-- <claude arguments>]

Turns this terminal into a Hivenod agent with Claude Code (verified with Claude Code 2.1.310).
Pairs the terminal the first time, then waits for AI work and opens Claude Code for each item:
interactive in a terminal (Remote Control, your own setup; --clean: only the Hivenod tools), or
headless (claude -p) with --headless or without a terminal. HIVENOD_CLAUDE_BIN picks the executable.

Permissions: your own Claude Code settings (~/.claude/settings.json or the project's
.claude/settings.json: permissions.allow/deny, default mode) decide what Claude may do. A headless
run denies whatever they do not allow. See ${PERMISSIONS_DOCS}

Claude arguments: everything after -- is passed to Claude Code, interactive and headless, for
example --model, --effort, --add-dir, or YOLO (bypass permissions):
  hivenod run claude -- --dangerously-skip-permissions
A headless run otherwise forces --permission-mode dontAsk; with --dangerously-skip-permissions,
--allow-dangerously-skip-permissions or --permission-mode after -- your choice applies instead.
Hivenod's own guards stay on whatever you pass: Claude's file tools are denied on ~/.hivenod and the run
folder, the token never reaches Claude, and the time cap, revoke and pause still apply.
Refused (Hivenod sets them): -p/--print, --session-id, -n/--name, --remote-control, --mcp-config,
--strict-mcp-config (use --clean), --settings, --append-system-prompt, --output-format,
--input-format, --permission-prompts, --resume/--continue/--fork-session/--from-pr, --bg, --cloud,
--teleport, --desktop, --tmux, --no-session-persistence, -h, -v.`,
  codex: `hivenod run codex [--project P] [--model M] [--once] [--max-minutes N]

EXPERIMENTAL, UNTESTED: built for OpenAI Codex CLI 0.164.0 and tested only with recorded-style
fixtures, never with a real OpenAI account. Watch the first items closely.

Same loop as hivenod run claude, always headless: one "codex exec --json" per item with only the
Hivenod MCP server (your config.toml is not loaded; your Codex login is), approval_policy "never".
Sign in to Codex yourself first (codex login); Hivenod never touches that login.

Permissions: Codex does not read your Claude Code settings and has no per-command rules, so Hivenod
uses fixed defaults as its sandbox: nothing but reading -> --sandbox read-only; anything that writes -> workspace-write
(edits in this folder); web access, git push or packages -> network on. Commands always run,
inside the sandbox, and can read files outside this folder, including a saved token, so hivenod run
codex requires HIVENOD_TOKEN and refuses a saved token (Codex's deny_read is not verified to block it).

Verified without an account: the flags (codex exec --help; --full-auto is gone and never used),
the -c config keys for the MCP server and approvals, the JSON event and token field names.
Not verified: a real run end to end, the exact event shapes, the model and running token totals
read from Codex's session file (~/.codex/sessions), MCP calls without prompts, git commit inside
the sandbox. Tokens: input (cached counted apart) and output; no cost is recorded.
HIVENOD_CODEX_BIN picks the executable.`,
  copilot: `hivenod run copilot [--project P] [--model M] [--once] [--max-minutes N]

EXPERIMENTAL, UNTESTED: built for GitHub Copilot CLI 1.0.103 and tested only with
recorded-style fixtures, never with a real GitHub account. Every item spends AI Credits from
your Copilot plan. Watch the first items closely.

Same loop as hivenod run claude, always headless: one "copilot -p --output-format json
--no-ask-user" per item, built-in GitHub MCP servers off, the Hivenod MCP server added (your own
~/.copilot MCP servers still load). Sign in to Copilot yourself first; Hivenod never touches that
login. COPILOT_ALLOW_ALL is removed from its environment.

Permissions: Copilot does not read your Claude Code settings, so Hivenod passes fixed defaults as
--allow-tool rules (write, shell(git commit), shell(npm test:*), …); a kind with no rule (shell, write, url) is denied outright.
File tools stay inside this folder.

Verified without an account: the flags, the MCP config shape, the usage file's top level.
Not verified: a real run end to end, the JSON event shapes, running token totals from the
OpenTelemetry file, that -p runs with explicit rules instead of --allow-all-tools, multi-word
shell patterns. Tokens and model come from --usage-output-file when the run ends; no cost is
recorded. HIVENOD_COPILOT_BIN picks the executable.`,
};

const OPTIONS = {
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'V' },
  project: { type: 'string' },
  step: { type: 'string' },
  name: { type: 'string' },
  status: { type: 'string' },
  cost: { type: 'string' },
  'tokens-in': { type: 'string' },
  'tokens-out': { type: 'string' },
  'tokens-cached': { type: 'string' },
  summary: { type: 'string' },
  model: { type: 'string' },
  run: { type: 'string' },
  level: { type: 'string' },
  timeout: { type: 'string' },
  bridge: { type: 'string' },
  job: { type: 'string' },
  skip: { type: 'string' },
  reason: { type: 'string' },
  note: { type: 'string' },
  undo: { type: 'boolean' },
  kind: { type: 'string' },
  after: { type: 'string' },
  description: { type: 'string' },
  title: { type: 'string' },
  attach: { type: 'string', multiple: true },
  instructions: { type: 'string' },
  once: { type: 'boolean' },
  headless: { type: 'boolean' },
  clean: { type: 'boolean' },
  channel: { type: 'boolean' },
  'max-minutes': { type: 'string' },
  'max-items': { type: 'string' },
  server: { type: 'string' },
  // Inbox (item 4PEHrOW5IfXBQWgOK9wo)
  source: { type: 'string' },
  sender: { type: 'string' },
  handle: { type: 'string' },
  'thread-ref': { type: 'string' },
  'received-at': { type: 'string' },
  text: { type: 'string' },
  'text-file': { type: 'string' },
  'message-id': { type: 'string' },
  permalink: { type: 'string' },
  'reply-ref': { type: 'string' },
  member: { type: 'string' },
  thread: { type: 'string' },
  'from-member': { type: 'boolean' },
  'subject-id': { type: 'string' },
  type: { type: 'string' },
  field: { type: 'string', multiple: true },
  'item-id': { type: 'string' },
  error: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  min: { type: 'string' },
} as const;

type Opts = ReturnType<typeof parse>['values'];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
}

function num(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HiveError(`${flag} must be a number >= 0`);
  return n;
}
function need(args: string[], i: number, what: string): string {
  const v = args[i];
  if (v === undefined || v === '') throw new HiveError(`Missing ${what}. Run hivenod --help.`);
  return v;
}
const outcome = (o: Opts) => ({
  costEur: num(o.cost, '--cost'),
  tokensIn: num(o['tokens-in'], '--tokens-in'),
  tokensOut: num(o['tokens-out'], '--tokens-out'),
  tokensCached: num(o['tokens-cached'], '--tokens-cached'),
  model: o.model,
  summary: o.summary,
});

export interface Command {
  result: unknown;
  text: (r: never) => string;
}

const INBOX_USAGE =
  'Usage: hivenod inbox add|list|note|ask …, hivenod thread read|wake <id>, hivenod subject list|assign …, hivenod outcome propose|done … (see hivenod --help)';

/** --field k=v (repeatable) as outcome fields; "true"/"false" for the type's boolean fields. */
function outcomeFields(type: string, pairs: readonly string[]): Record<string, unknown> {
  const t = outcomeType(type);
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new HiveError(`--field wants name=value, got ${p}`);
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    out[k] = t?.fields[k]?.kind === 'boolean' && (v === 'true' || v === 'false') ? v === 'true' : v;
  }
  return out;
}

/** `hivenod inbox|thread|subject|outcome …` (item 4PEHrOW5IfXBQWgOK9wo): the inbox tools. */
async function inboxCommand(c: HiveClient, pos: string[], o: Opts): Promise<Command> {
  const [a, b, id] = pos;
  const inbox = c.inbox();
  const usage = () => new HiveError(INBOX_USAGE);
  const json = (r: unknown) => ({ result: r, text: () => JSON.stringify(r, null, 2) });
  switch (`${a} ${b ?? ''}`) {
    case 'inbox add': {
      const text = o['text-file'] ? readFileSync(o['text-file'], 'utf8') : o.text;
      if (!o.source || !o.sender || !o['thread-ref'] || !o['received-at'] || !text) throw usage();
      return json(
        await inbox.add({
          source: o.source,
          sender: { name: o.sender, ...(o.handle !== undefined ? { handle: o.handle } : {}) },
          text,
          threadRef: o['thread-ref'],
          receivedAt: o['received-at'],
          messageId: o['message-id'],
          permalink: o.permalink,
          replyRef: o['reply-ref'],
          member: o.member,
          thread: o.thread,
          fromMember: o['from-member'],
          title: o.title,
        }),
      );
    }
    case 'inbox list':
      return json(await inbox.listWork());
    case 'inbox note':
      if (!id || !o.text) throw usage();
      return json(await inbox.note(id, o.text));
    case 'inbox ask':
      if (!id || !o.text) throw usage();
      return json(await inbox.ask(id, o.text));
    case 'thread read':
      if (!id) throw usage();
      return json(await inbox.readThread(id));
    case 'thread wake':
      if (!id) throw usage();
      return json(await inbox.wake(id));
    case 'subject list':
      return json(await inbox.subjects(o.member));
    case 'subject assign':
      if (!id || (o['subject-id'] === undefined) === (o.name === undefined)) throw usage();
      return json(await inbox.assign(id, o['subject-id'], o.name));
    case 'outcome propose':
      if (!id || !o.type) throw usage();
      return json(await inbox.propose(id, o.type, outcomeFields(o.type, o.field ?? []), o.note));
    case 'outcome done':
      if (!id || (o.status !== 'done' && o.status !== 'failed')) throw usage();
      return json(
        await inbox.done(id, o.status, {
          ...(o.text !== undefined ? { text: o.text } : {}),
          ...(o.permalink !== undefined ? { permalink: o.permalink } : {}),
          ...(o['item-id'] !== undefined ? { itemId: o['item-id'] } : {}),
          ...(o.error !== undefined ? { error: o.error } : {}),
        }),
      );
  }
  throw usage();
}

async function dispatch(c: HiveClient, pos: string[], o: Opts): Promise<Command> {
  const [a, b] = pos;
  if (a === 'create-item') {
    const title = o.title ?? b;
    if (!o.project || !title)
      throw new HiveError(
        'Usage: hivenod create-item --project P --title "title" [--description "brief"] [--attach file|url]...',
      );
    const r = await c.createItem(o.project, title, o.description ?? '', o.attach ?? []);
    return {
      result: r,
      text: () =>
        [
          `Created item ${r.itemId}. ${r.note}`,
          ...r.attachments.map((f) => `  attached ${f.name}`),
          ...(r.attachErrors ?? []).map((e) => `  not attached: ${e}`),
        ].join('\n'),
    };
  }
  if (['inbox', 'thread', 'subject', 'outcome'].includes(a ?? '')) return inboxCommand(c, pos, o);
  const key = `${a} ${b ?? ''}`.trim();
  switch (key) {
    case 'whoami':
      await c.refreshAgent();
      return {
        result: c.whoami(),
        text: (r: ReturnType<HiveClient['whoami']>) =>
          [
            `${r.name} (${r.agentUid}) in organization ${r.workspaceId}`,
            r.scope === 'inbox'
              ? 'scope: Inbox and Calendar only (no development projects)'
              : `projects: ${r.projectIds === '*' ? 'all' : r.projectIds.join(', ') || 'none'}`,
            `guardrails: pause after ${r.guardrails.maxFailedRuns} failed runs in a row`,
            `Permissions: your Claude Code settings (~/.claude/settings.json), see ${PERMISSIONS_DOCS}`,
            ...(r.paused
              ? [
                  `PAUSED${r.pausedReason ? `: ${r.pausedReason}` : ''}. An admin resumes it in Hivenod.`,
                ]
              : []),
          ].join('\n'),
      };
    case 'work list': {
      const rows = await c.listWork({ projectId: o.project, stepId: o.step });
      return {
        result: rows,
        text: () =>
          rows.length === 0
            ? 'No work waiting for an agent.'
            : rows
                .map(
                  (r) =>
                    `${r.itemId}  [${r.project} / ${r.step}]  ${r.title}${r.job === 'shape' ? '  (to shape)' : ''}${r.claim ? (r.claim.mine ? '  (yours)' : '  (stale claim)') : ''}${r.sendBackCount ? `  sent back ${r.sendBackCount}x` : ''}`,
                )
                .join('\n'),
      };
    }
    case 'work wait': {
      const secs = num(o.timeout, '--timeout');
      const r = await c.waitForWork({
        projectId: o.project,
        stepId: o.step,
        timeoutMs: secs === undefined ? undefined : secs * 1000,
      });
      return {
        result: r,
        text: () => waitText(r),
      };
    }
    case 'work claim': {
      const r = await c.claim(need(pos, 2, 'item id'), o.project);
      return {
        result: r,
        text: () =>
          `${r.resumed ? 'Already yours' : 'Claimed'}: ${r.title}\nrunId: ${r.runId}\n${r.hint}`,
      };
    }
    case 'run log': {
      const r = await c.log(
        need(pos, 2, 'run id'),
        need(pos, 3, 'log text'),
        (o.level as 'info' | 'warn' | 'error' | undefined) ?? 'info',
      );
      return { result: r, text: () => `Logged line ${r.line}.` };
    }
    case 'run heartbeat': {
      const r = await c.heartbeat(need(pos, 2, 'run id'));
      return { result: r, text: () => 'Heartbeat sent.' };
    }
    case 'run usage': {
      const tokensIn = num(o['tokens-in'], '--tokens-in');
      const tokensOut = num(o['tokens-out'], '--tokens-out');
      if (tokensIn === undefined || tokensOut === undefined)
        throw new HiveError('Usage: hivenod run usage <runId> --tokens-in N --tokens-out N');
      const r = await c.reportUsage(need(pos, 2, 'run id'), {
        tokensIn,
        tokensOut,
        tokensCached: num(o['tokens-cached'], '--tokens-cached'),
        model: o.model,
      });
      return {
        result: r,
        text: () => `${r.newTokens.toLocaleString('en')} new tokens used so far.`,
      };
    }
    case 'work release': {
      const r = await c.release(need(pos, 2, 'item id'), o.project);
      return { result: r, text: () => 'Released: the item is back in the queue.' };
    }
    case 'run end': {
      if (o.status !== 'done' && o.status !== 'failed')
        throw new HiveError('--status must be done or failed');
      const r = await c.endRun(need(pos, 2, 'run id'), o.status, outcome(o));
      return {
        result: r,
        text: () => `Run ended as ${r.status}.${'note' in r && r.note ? `\n${r.note}` : ''}`,
      };
    }
    case 'item read': {
      const r = await c.readItem(need(pos, 2, 'item id'), o.project);
      return { result: r, text: () => renderItem(r) };
    }
    case 'item attach': {
      const r = await c.attach(need(pos, 2, 'item id'), need(pos, 3, 'file or URL'), {
        name: o.name,
        projectId: o.project,
      });
      return { result: r, text: () => `Attached ${r.name} (${r.kind}).` };
    }
    case 'item ask': {
      const r = await c.ask(need(pos, 2, 'item id'), need(pos, 3, 'question'), o.project);
      return { result: r, text: () => r.note };
    }
    case 'item progress': {
      const done = num(pos[3], 'done');
      const total = num(pos[4], 'total');
      if (done === undefined || total === undefined)
        throw new HiveError('Usage: hivenod item progress <itemId> <done> <total>');
      const r = await c.progress(need(pos, 2, 'item id'), done, total, o.project);
      return { result: r, text: () => `Progress ${done}/${total}.` };
    }
    case 'item complete': {
      const r = await c.complete(
        need(pos, 2, 'item id'),
        o.run ?? need([], 0, '--run <runId>'),
        outcome(o),
        o.project,
      );
      return {
        result: r,
        text: () =>
          r.movedTo
            ? `Moved to ${r.movedTo.name}${r.waitingForPeople ? ': waiting at a human gate for people to decide.' : '.'}`
            : 'Finished the last step.',
      };
    }
    case 'item path': {
      const r = await c.readItem(need(pos, 2, 'item id'), o.project);
      return { result: { job: r.job, shape: r.shape, path: r.path }, text: () => renderPath(r) };
    }
    case 'item shape': {
      if (!o.note) throw new HiveError('Give a one-line --note on the path.');
      const ids = (o.skip ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const r = await c.shape(
        need(pos, 2, 'item id'),
        o.run ?? need([], 0, '--run <runId>'),
        { skips: Object.fromEntries(ids.map((id) => [id, o.reason ?? ''])), note: o.note },
        outcome(o),
        o.project,
      );
      return {
        result: r,
        text: () =>
          `${r.note} ${r.skipped.length ? `Skips: ${r.skipped.join(', ')}.` : 'Full process.'}${r.askedToSkip.length ? ` Asked to skip: ${r.askedToSkip.join(', ')}.` : ''}`,
      };
    }
    case 'item skip': {
      const r = await c.skipStep(
        need(pos, 2, 'item id'),
        need(pos, 3, 'step id'),
        !o.undo,
        o.reason ?? '',
        o.project,
      );
      return {
        result: r,
        text: () => (r.skipped ? `Skipped ${r.stepId}.` : `${r.stepId} is back on the path.`),
      };
    }
    case 'item ask-path': {
      const r = await c.askPathChange(
        need(pos, 2, 'item id'),
        need(pos, 3, 'step id'),
        need(pos, 4, 'reason'),
        o.project,
      );
      return { result: r, text: () => r.note };
    }
    case 'step propose': {
      if (o.kind !== 'agent' && o.kind !== 'human')
        throw new HiveError('--kind must be agent or human');
      if (!o.name || o.after === undefined || !o.reason)
        throw new HiveError(
          'Usage: hivenod step propose <itemId> --name N --kind agent|human --after <stepId> --reason "why"',
        );
      const r = await c.proposeStep(
        need(pos, 2, 'item id'),
        {
          name: o.name,
          kind: o.kind,
          description: o.description ?? '',
          instructions: o.instructions,
          afterStepId: o.after,
          reason: o.reason,
        },
        o.project,
      );
      return { result: r, text: () => `Proposed ${r.proposalId}. ${r.note}` };
    }
    case 'calendar upsert': {
      const file = need(pos, 2, 'events file (a JSON array, or - for stdin)');
      let events: CalendarEventArg[];
      try {
        events = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8')) as CalendarEventArg[];
      } catch {
        throw new HiveError(`${file}: not a JSON array of events.`);
      }
      if (!Array.isArray(events)) throw new HiveError(`${file}: not a JSON array of events.`);
      const r = await upsertEvents(c.calendarDeps(), o.member, events);
      return { result: r, text: () => r.note };
    }
    case 'calendar delete': {
      const ids = pos.slice(2);
      const r = await deleteEvents(
        c.calendarDeps(),
        o.source
          ? { member: o.member, source: o.source, sourceEventIds: ids }
          : { ids, member: o.member },
      );
      return {
        result: r,
        text: () => [r.note, ...r.notFound.map((id) => `  not found: ${id}`)].join('\n'),
      };
    }
    case 'calendar free': {
      if (!o.from || !o.to)
        throw new HiveError('Usage: hivenod calendar free --from T --to T [--member M] [--min N]');
      const r = await freeTime(c.calendarDeps(), {
        member: o.member,
        from: o.from,
        to: o.to,
        minMinutes: num(o.min, '--min'),
      });
      return {
        result: r,
        text: () =>
          r.free.length === 0
            ? 'No free time in that range.'
            : r.free.map((f) => `${f.start}  to  ${f.end}`).join('\n'),
      };
    }
    case 'finding raise': {
      const r = await c.raiseFinding(
        need(pos, 2, 'item id'),
        need(pos, 3, 'title'),
        pos[4] ?? '',
        o.project,
      );
      return { result: r, text: () => `Raised suggestion ${r.findingItemId}. ${r.note}` };
    }
    default:
      throw new HiveError(`Unknown command "${pos.join(' ')}". Run hivenod --help.`);
  }
}

/** The path of an item, one library step per line (card st5INNZj). */
export function renderPath(r: Awaited<ReturnType<HiveClient['readItem']>>): string {
  const mark: Record<string, string> = {
    done: '✓',
    current: '▶',
    ahead: '·',
    skipped: '–',
    proposed: '+',
  };
  return [
    r.job === 'shape'
      ? 'Not shaped yet: a shaping run picks its steps.'
      : r.shape
        ? `Shaped${r.shape.note ? `: ${r.shape.note}` : ''}`
        : 'Full process.',
    ...r.path.map(
      (p) =>
        `  ${mark[p.state] ?? '·'} ${p.name} [${p.id}]${p.kind === 'human' ? ' (people)' : ''}${p.state === 'skipped' ? ` skipped${p.skipReason ? `: ${p.skipReason}` : ''}` : ''}${p.pending ? ` (asked to ${p.pending.op === 'drop' ? 'skip' : 'add'}: ${p.pending.reason})` : ''}${p.refused ? ' (a decider kept it)' : ''}`,
    ),
  ].join('\n');
}

export function renderItem(r: Awaited<ReturnType<HiveClient['readItem']>>): string {
  const out = [`${r.title}  [${r.project} / ${r.step?.name ?? r.status}]`];
  // The description people write on the item (Markdown) is the brief: work from it.
  if (r.summary) out.push(`\nBrief (Markdown):\n${r.summary}`);
  if (r.step?.instructions) out.push(`\nInstructions:\n${r.step.instructions}`);
  if (r.step?.outputs.length) out.push(`Expected outputs: ${r.step.outputs.join('; ')}`);
  if (r.sendBackReasons.length)
    out.push(
      '\nSent back (address these first):',
      ...r.sendBackReasons.map(
        (s) => `  - ${s.reason}${s.tags.length ? ` [${s.tags.join(', ')}]` : ''}`,
      ),
    );
  if (r.messages.length)
    out.push('\nMessages:', ...r.messages.map((m) => `  ${m.kind}: ${m.text}`));
  if (r.attachments.length)
    out.push(
      '\nAttachments:',
      ...r.attachments.map((a) => `  ${a.name} (${a.kind}, ${a.bytes} bytes)`),
    );
  return out.filter((l) => l !== '').join('\n');
}

const RUN_SUBCOMMANDS = new Set(['log', 'heartbeat', 'usage', 'end']);

const say = (line: string) => process.stdout.write(`${line}\n`);

/** The adapter for `hivenod run <cli>`, or a clear error. */
export function adapterFor(cli: string): CliAdapter {
  if (isRunCli(cli)) return ADAPTERS[cli];
  if (cli === 'gemini')
    throw new HiveError(
      'hivenod run gemini is not available: Gemini CLI no longer works with personal Google accounts (June 2026). Use claude, codex or copilot.',
    );
  throw new HiveError(
    `hivenod run ${cli} is not supported. Use hivenod run claude, codex or copilot.`,
  );
}

/**
 * Checks the installed CLI: it starts, its version (a warning when Hivenod was not checked against
 * it) and, for Codex and Copilot, that the flags Hivenod needs are still there.
 */
export function checkCli(
  adapter: CliAdapter,
  cliCommand: string,
  run: typeof spawnSync = spawnSync,
): { version: string; warnings: string[] } {
  const env = { ...process.env, ...adapter.checkEnv };
  const v = run(cliCommand, ['--version'], { encoding: 'utf8', env });
  if (v.error || v.status !== 0)
    throw new HiveError(
      `${adapter.name} (${cliCommand}) was not found or did not start. Install it and sign in (run ${adapter.bin} once), then try again.`,
    );
  const version = adapter.parseVersion(String(v.stdout ?? ''));
  let help = '';
  if (adapter.helpArgs) {
    const h = run(cliCommand, adapter.helpArgs, { encoding: 'utf8', env });
    help = `${String(h.stdout ?? '')}\n${String(h.stderr ?? '')}`;
  }
  const p = adapter.preflight(version, help);
  if (p.errors.length) throw new HiveError(p.errors.join(' '));
  return { version: version ?? '', warnings: p.warnings };
}

/** Refuses a saved token (or pairing, which saves one) for a CLI that could read it (card l7waTKBB). */
export function tokenGuard(adapter: CliAdapter): void {
  if (!adapter.envTokenOnly) return;
  const saved = readCredentials();
  if (process.env.HIVENOD_TOKEN && !saved) return;
  throw new HiveError(
    `hivenod run ${adapter.id} needs HIVENOD_TOKEN and will not use a saved token: ${adapter.envTokenOnly}. ` +
      `Create an agent in Hivenod (the Agents page), export HIVENOD_TOKEN=hive_agt_... and run again.` +
      (saved
        ? ` A saved token exists at ${credentialsPath()} and ${adapter.id} could read it: run hivenod logout to remove it, then run again.`
        : ''),
  );
}

/** `hivenod run <cli>`: pair if needed, then the work loop (cards MkUwvyWs, 3RiuFK00). */
async function hiveRun(cli: string, o: Opts, extraArgs: string[] = []): Promise<number> {
  const adapter = adapterFor(cli);
  tokenGuard(adapter);
  const cliCommand = process.env[adapter.binEnv] || adapter.bin;
  const checked = checkCli(adapter, cliCommand);
  if (adapter.experimental)
    say(
      `${adapter.name} support is EXPERIMENTAL and untested with a real account. Watch the first items closely.`,
    );
  for (const w of checked.warnings) say(`! ${w}`);
  const maxMinutes = num(o['max-minutes'], '--max-minutes');
  if (!adapter.interactive && o.clean)
    throw new HiveError(`--clean works only with hivenod run claude (interactive).`);
  const interactive =
    adapter.interactive && !o.headless && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (adapter.interactive && !o.headless && !interactive)
    say('No terminal attached: running Claude Code headless (as with --headless).');
  if (o.clean && !interactive) throw new HiveError('--clean works only with the interactive mode.');
  const abort = new AbortController();
  let interrupts = 0;
  let runner: Runner | undefined;
  const onInt = () => {
    // Inside an interactive Claude session, Ctrl+C belongs to Claude (it cancels, or closes it).
    if (runner?.inSession) return;
    interrupts++;
    if (interrupts > 1) process.exit(EXIT.interrupted);
    say('\nStopping… (Ctrl+C again to quit at once)');
    abort.abort();
  };
  const onTerm = () => {
    if (runner?.inSession) {
      abort.abort();
      return;
    }
    onInt();
  };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  let client: HiveClient | undefined;
  try {
    const server = await resolveServer(o.server);
    let resolved = resolveToken();
    let saved: string | undefined;
    let pairedCode: string | undefined;
    if (!resolved) {
      const p = await pairTerminal({ cli, say, signal: abort.signal });
      saved = saveCredentials({
        token: p.token,
        workspaceId: p.workspaceId,
        agentUid: p.agentUid,
        agentName: p.agentName,
        ...serverFields(server),
      });
      pairedCode = p.code;
      resolved = { token: p.token, source: 'file' };
      say(`✓ Paired: this terminal is now the agent ${p.agentName}.`);
    }
    const token = resolved.token;
    let names: Awaited<ReturnType<HiveClient['projectNames']>>;
    // A Firebase rate limit at startup waits and retries like the work loop (card ASU73ciy).
    try {
      await retryOnRateLimit(
        async () => {
          await client?.close().catch(() => undefined);
          client = await HiveClient.connect({ token });
          if (pairedCode) await client.deletePairing(pairedCode);
          await client.refreshAgent();
          await client.syncServerClock();
          client.checkNoOtherTerminal();
          names = await client.projectNames();
        },
        { say, signal: abort.signal },
      );
    } catch (e) {
      // Ctrl+C while waiting to retry: leave quietly (130), not with the rate-limit error.
      if (abort.signal.aborted && isRateLimited(e)) return EXIT.interrupted;
      throw e;
    }
    if (!client) return EXIT.interrupted;
    // A CLI too old for what Hivenod now sends (e.g. shaping jobs) stops before taking work.
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      const update = await updateNeeded(activeSite());
      if (update) {
        say(`✗ ${update}`);
        return EXIT.error;
      }
    }
    const me = client.whoami();
    for (const l of headerLines(me, names!, {
      cli: adapter.name,
      cliVersion: checked.version,
      mode: interactive ? (o.clean ? 'interactive-clean' : 'interactive') : 'headless',
      headlessLine: adapter.headlessLine,
      bypass: isBypass(extraArgs),
      permissionsLine: isBypass(extraArgs)
        ? "Permissions: bypass (your flags). Hivenod's own guards stay on."
        : adapter.permissionsLine,
      notes: [
        ...adapter.notes,
        ...(extraArgs.length ? [`  Extra Claude arguments: ${describeExtraArgs(extraArgs)}`] : []),
      ],
      saved: saved ?? (resolved.source === 'file' ? credentialsPath() : undefined),
    }))
      say(l);
    if (me.paused) {
      say(
        `■ This agent is paused${me.pausedReason ? ` (${me.pausedReason})` : ''}. An admin resumes it in Hivenod (Agents).`,
      );
      return EXIT.paused;
    }
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
    runner = new Runner({
      client,
      interactive,
      clean: o.clean,
      hiveCommand: [process.execPath, entry],
      adapter,
      cliCommand,
      model: o.model,
      extraArgs,
      projectId: o.project,
      once: o.once,
      ...(maxMinutes ? { maxRunMinutes: maxMinutes } : {}),
      terminal: { line: say },
      signal: abort.signal,
    });
    return await runner.run();
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    await client?.close();
  }
}

/**
 * `hivenod pair` (card KLCTVnX8): pairs this machine like `hivenod run` does the first time, and
 * saves the token for `hivenod mcp` (the Claude Code plugin). The token is never printed.
 */
async function pairOnly(server?: string): Promise<number> {
  const say = (line: string) => process.stdout.write(`${line}\n`);
  let have: ReturnType<typeof resolveToken> = null;
  try {
    have = resolveToken();
  } catch {
    say(`${damagedMessage()} Pairing again replaces it.`);
  }
  if (have) {
    say(
      have.source === 'env'
        ? 'HIVENOD_TOKEN is set: this machine already acts as that agent. Unset it to pair another one.'
        : `Already paired (${credentialsPath()}). Run hivenod logout first to pair as another agent.`,
    );
    return 0;
  }
  const resolved = await resolveServer(server);
  const abort = new AbortController();
  const onInt = () => abort.abort();
  process.once('SIGINT', onInt);
  try {
    const p = await pairTerminal({ cli: 'claude', say, signal: abort.signal });
    saveCredentials({
      token: p.token,
      workspaceId: p.workspaceId,
      agentUid: p.agentUid,
      agentName: p.agentName,
      ...serverFields(resolved),
    });
    const c = await HiveClient.connect({ token: p.token }).catch(() => null);
    await c?.deletePairing(p.code);
    await c?.close();
    say(
      `✓ Paired: this machine is now the agent ${p.agentName}. Token saved in ${credentialsPath()}.`,
    );
    return 0;
  } finally {
    process.off('SIGINT', onInt);
  }
}

/**
 * `hivenod hook permission --bridge S`: Claude Code's PermissionRequest hook in an interactive run
 * (card OPpbi0MS). It runs while the permission prompt is shown and asks hivenod run, which denies
 * after 10 minutes without an answer; when the person answers first, Claude ends this hook.
 * Fails soft: on any error it prints nothing and the prompt simply stays.
 */
async function permissionHook(bridge: string | undefined): Promise<number> {
  if (!bridge) return 0;
  let input = '';
  for await (const chunk of process.stdin) input += String(chunk);
  const c = bridgeClient(bridge);
  try {
    let req: unknown = null;
    try {
      req = JSON.parse(input);
    } catch {
      /* describe it as "a tool" */
    }
    const answer = await c.call('permission_wait', { request: describeRequest(req) });
    const out = hookDecision(answer);
    if (out) process.stdout.write(`${out}\n`);
  } catch {
    /* hivenod run is gone: leave the prompt to the person */
  } finally {
    c.close();
  }
  return 0;
}

/** Plain-text answer of `work wait`; a timeout says `timedOut: true` like --json does. */
export function waitText(r: {
  timedOut: boolean;
  work: { itemId: string; project: string; step: string; title: string }[];
}): string {
  return r.timedOut
    ? 'timedOut: true. No work arrived before the timeout. Run hivenod work wait again to keep waiting.'
    : r.work.map((w) => `${w.itemId}  [${w.project} / ${w.step}]  ${w.title}`).join('\n');
}

/**
 * `hivenod run <cli> [options] -- <cli arguments>`: the part after the first `--` is the person's own
 * arguments for the coding CLI and is never parsed by hive. Only for `hivenod run <cli>`; anywhere
 * else `--` keeps its usual meaning.
 */
export function splitExtraArgs(argv: string[]): { argv: string[]; extra: string[] } {
  const at = argv.indexOf('--');
  if (at < 0) return { argv, extra: [] };
  try {
    const { positionals } = parse(argv.slice(0, at));
    if (positionals[0] === 'run' && positionals[1] && isRunCli(positionals[1]))
      return { argv: argv.slice(0, at), extra: argv.slice(at + 1) };
  } catch {
    /* parse reports it below */
  }
  return { argv, extra: [] };
}

export async function main(rawArgv: string[]): Promise<number> {
  const { argv, extra } = splitExtraArgs(rawArgv);
  let parsed;
  try {
    parsed = parse(argv);
    // The pause checks the parsed command, so options before `run` or `--help` cannot skip it.
    const [c0, c1] = parsed.positionals;
    if (c0 === 'run' && c1 && !RUN_SUBCOMMANDS.has(c1) && !runAllowed()) {
      process.stderr.write(`hivenod: ${RUN_PAUSED}\n`);
      return 1;
    }
    if (extra.length) {
      const cli = parsed.positionals[1]!;
      if (cli !== 'claude')
        throw new HiveError(
          `hivenod run ${cli} does not take arguments after -- (only hivenod run claude passes them on).`,
        );
      const bad = claudeArgsProblem(extra, parsed.values.model);
      if (bad) throw new HiveError(bad);
    }
  } catch (e) {
    process.stderr.write(`hivenod: ${messageOf(e)}\n`);
    return 2;
  }
  const { values: o, positionals: pos } = parsed;
  if (o.version || pos[0] === 'version') {
    process.stdout.write(`${versionLine()}\n`);
    return 0;
  }
  if (o.help && pos[0] === 'run' && pos[1] && isRunCli(pos[1])) {
    process.stdout.write(`${RUN_HELP[pos[1]]}\n`);
    return 0;
  }
  if (o.help && pos[0] === 'run' && pos[1] === 'gemini') {
    try {
      adapterFor('gemini');
    } catch (e) {
      process.stderr.write(`hivenod: ${messageOf(e)}\n`);
    }
    return 1;
  }
  if (o.help || pos.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return o.help || pos.length === 0 ? 0 : 2;
  }
  const fail = (e: unknown) => {
    const msg = messageOf(e);
    if (o.json) process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
    else process.stderr.write(`hivenod: ${msg}\n`);
    return 1;
  };
  if (pos[0] === 'hook' && pos[1] === 'permission') return permissionHook(o.bridge);
  if (o.server && pos[0] !== 'pair' && pos[0] !== 'run')
    return fail(
      new HiveError(
        '--server goes with pair; the other commands use the server saved with the token.',
      ),
    );
  if (pos[0] === 'mcp') {
    try {
      if (o.run || o.bridge) {
        if (!o.run || !o.bridge) throw new HiveError('hivenod mcp --run needs --run and --bridge.');
        // Only the tool names, descriptions and schemas are used here; every call is forwarded
        // to hivenod run, which holds the token and the item's scope.
        const defs = runTools({
          runId: o.run,
          itemId: '',
          projectId: '',
          cwd: process.cwd(),
          onFinish: () => undefined,
          job: o.job === 'shape' ? 'shape' : null,
        });
        await runBridgedMcp(bridgedTools(o.bridge, defs));
        return -1;
      }
      // Plain mcp has nobody to tell, so it exits non-zero without a usable token. The channel
      // server stays up: it sends the same text to the session as a setup message.
      if (!o.channel) {
        if (!resolveToken())
          throw new HiveError(
            'HIVENOD_TOKEN is not set and this terminal is not paired. Run `hivenod pair` to pair it with Hivenod, or set HIVENOD_TOKEN.',
          );
      }
      // Card cGSENsRF: how many items the session holds at once (the plugin sets it by env).
      const flag = parseMaxItems(o['max-items'], '--max-items');
      if (flag !== undefined && !o.channel)
        throw new HiveError('--max-items needs hivenod mcp --channel.');
      const maxItems = o.channel
        ? (flag ?? parseMaxItems(process.env.HIVENOD_MAX_ITEMS, 'HIVENOD_MAX_ITEMS'))
        : undefined;
      await resolveServer();
      await runMcp(
        o.channel ? { channel: { projectId: o.project, stepId: o.step, maxItems } } : {},
      );
      return -1; // keep running
    } catch (e) {
      return fail(e);
    }
  }
  // The CLI prints its own one-line errors; the SDK's raw stream log lines would only repeat them.
  setLogLevel('silent');
  if (pos[0] === 'pair') {
    try {
      return await pairOnly(o.server);
    } catch (e) {
      return fail(e);
    }
  }
  if (pos[0] === 'logout') {
    const had = clearCredentials();
    process.stdout.write(
      had
        ? `Removed the saved token (${credentialsPath()}). The agent still exists in Hivenod; revoke it there if it should stop for good.\n`
        : 'No saved token on this machine.\n',
    );
    return 0;
  }
  if (pos[0] === 'run' && pos[1] && !RUN_SUBCOMMANDS.has(pos[1])) {
    try {
      return await hiveRun(pos[1], o, extra);
    } catch (e) {
      return fail(e);
    }
  }
  let client: HiveClient | undefined;
  try {
    await resolveServer();
    client = await HiveClient.connect();
    const cmd = await dispatch(client, pos, o);
    process.stdout.write(
      o.json ? `${JSON.stringify(cmd.result, null, 2)}\n` : `${cmd.text(cmd.result as never)}\n`,
    );
    return 0;
  } catch (e) {
    return fail(e);
  } finally {
    await client?.close();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  main(process.argv.slice(2)).then((code) => {
    if (code >= 0) process.exit(code);
  });
}
