/**
 * Card ZY6KC56r (after KLCTVnX8): real interactive Claude Code sessions with the hivenod plugin,
 * installed from this repo's marketplace, paired to an emulator agent. MANUAL ONLY: run it with
 * `pnpm smoke:claude` (scripts/smoke-claude.mjs), never directly, never in CI or the e2e. The
 * wrapper makes the isolated Claude config, guards the live Telegram / agent-mail processes and
 * cleans up; this file only runs when the wrapper set its environment. See docs/AGENT-SMOKE.md.
 * Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 11): work arrives as Inbox threads.
 * Checks, in order (each one a test step with its own message in the output):
 * - connect (item EJ2Cxq4k): `hivenod connect` confirmed by a plain member installs the plugin
 *   itself, and `hivenod claude` investigates a thread and proposes an outcome;
 * - basic: a thread is investigated by a sub-agent; a second session as the same agent is told it
 *   is busy; quit, then restart: a thread still being investigated is sent again;
 * - inbox (item 4PEHr): a sub-agent proposes an outcome; the person approves it: the carry-out
 *   event reaches the session and a sub-agent reports it with outcome_done.
 * `pnpm smoke:claude --only connect|basic|inbox` runs one of the parts.
 */
import { GoAgent } from './agentcli';
import { goBinary } from './gobin';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  createAgent,
  pairingCompletion,
  pairingPath,
  paths,
  sealToken,
  approveOutcome,
} from '@hive/shared';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { as, getEnv, now, put, useEmulator, W } from '../../../packages/shared/rules/harness';

const CONFIG = process.env.HIVE_SMOKE_CLAUDE_CONFIG_DIR ?? '';
const DIR = process.env.HIVE_SMOKE_DIR ?? '';
const SOCKET = process.env.HIVE_SMOKE_TMUX ?? '';
const run = process.env.HIVE_SMOKE_CLAUDE_CHANNEL === '1' && CONFIG && DIR && SOCKET;
const ONLY = process.env.HIVE_SMOKE_ONLY ?? '';
const MODEL = process.env.HIVE_SMOKE_MODEL || 'haiku';
if (run) useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

/** The clean environment every claude / tmux process of the smoke gets (no secrets, no live config). */
const cleanEnv = (extra: Record<string, string> = {}) => ({
  HOME: join(DIR, 'home'),
  PATH: `${join(DIR, 'bin')}:${process.env.PATH ?? ''}`,
  TERM: 'xterm-256color',
  CLAUDE_CONFIG_DIR: CONFIG,
  ...extra,
});
const tmux = (...a: string[]) =>
  execFileSync('tmux', ['-L', SOCKET, ...a], { encoding: 'utf8', env: cleanEnv() });
const pane = (s: string) => {
  try {
    return tmux('capture-pane', '-p', '-S', '-300', '-t', s);
  } catch {
    return '';
  }
};
const alive = (s: string) => {
  try {
    tmux('has-session', '-t', s);
    return true;
  } catch {
    return false;
  }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function read(path: string) {
  let d: Record<string, unknown> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    d = (await c.firestore().doc(path).get()).data() ?? {};
  });
  return d;
}
/** Polls `f` until it returns truthy, at most `ms` (a bounded wait, never forever). */
async function until<T>(
  what: string,
  ms: number,
  f: () => Promise<T | false> | T | false,
  s?: string,
) {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as T;
    if (Date.now() - t0 > ms)
      throw new Error(`timed out after ${ms} ms: ${what}${s ? `\n--- pane ---\n${pane(s)}` : ''}`);
    await pause(500);
  }
}

const STANDING =
  'You are a Hivenod worker session. Handle every hivenod channel event (also ones that arrived before this message), as the hivenod skill says. This is a test organization: to carry out a reply outcome, just report it with outcome_done (status done, result text "smoke"). Meanwhile just say ready.';

const out = (s: string) => void process.stdout.write(`[smoke] ${s}\n`);

const BIN = () => join(DIR, 'bin');
const PROJECT_DIR = () => join(DIR, 'project');
let prepared: Promise<void> | null = null;

/** Builds the CLI and installs the plugin into the private Claude config, once per run. */
function prepare() {
  prepared ??= (async () => {
    goBinary();
    for (const d of [BIN(), PROJECT_DIR(), join(DIR, 'home'), join(DIR, 'hivenod-home')])
      mkdirSync(d, { recursive: true });
    const claude = (args: string[]) =>
      execFileSync('claude', args, {
        cwd: PROJECT_DIR(),
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 120_000,
        env: cleanEnv(),
      });
    // The connect part (first) installs the plugin itself, from this repo, with hivenod connect.
    if (!/hivenod@hivenod/.test(claude(['plugin', 'list']))) {
      claude(['plugin', 'marketplace', 'add', REPO, '--scope', 'local']);
      claude(['plugin', 'install', 'hivenod@hivenod', '--scope', 'local']);
    }
  })();
  return prepared;
}

/** The token of the last smoke agent (the inbox part brings a message in as it). */
let lastToken = '';
async function smokeAgent(name: string) {
  await prepare();
  const { uid, token } = await createAgentIdentity(
    { apiKey: 'fake-api-key', projectId: 'hive-rules-test' },
    W,
    { authEmulatorUrl: `http://${AUTH_HOST}` },
  );
  await put({
    [paths.agent(W, uid)]: {
      name,
      color: '#2F5FD0',
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: 'a7f3',
      previousAgentUid: null,
      lastEventId: 'seed',
    },
  });
  // `hivenod` as the plugin runs it, pointed at the emulators (the token is a test token).
  // The Go binary (item zLwtX2WEEg3mER4CR74g).
  const cli = `${goBinary()} `;
  console.log(`[smoke] hivenod is the Go binary: ${cli.trim()}`);
  writeFileSync(
    join(BIN(), 'hivenod'),
    `#!/bin/sh\nexec env FIRESTORE_EMULATOR_HOST=${FS_HOST} FIREBASE_AUTH_EMULATOR_HOST=${AUTH_HOST} HIVENOD_PROJECT_ID=hive-rules-test HIVENOD_FIREBASE_API_KEY=fake-api-key HIVENOD_HOME=${join(DIR, 'hivenod-home')} HIVENOD_TOKEN=${token} ${cli}"$@"\n`,
  );
  chmodSync(join(BIN(), 'hivenod'), 0o755);
  lastToken = token;
  return uid;
}

/** Starts claude in a new tmux session, passes the start-up dialogs and the standing prompt. */
async function start(
  name: string,
  prompt: string | null,
  opts: { env?: string; tools?: string; launcher?: string } = {},
) {
  tmux(
    'new-session',
    '-d',
    '-s',
    name,
    '-x',
    '200',
    '-y',
    '50',
    '-c',
    PROJECT_DIR(),
    `env -i HOME=${join(DIR, 'home')} PATH=${BIN()}:${process.env.PATH} TERM=xterm-256color CLAUDE_CONFIG_DIR=${CONFIG} ${opts.env ?? ''} ${opts.launcher ?? 'claude --dangerously-load-development-channels plugin:hivenod@hivenod'} --model ${MODEL} --allowedTools ${opts.tools ?? 'mcp__plugin_hivenod_hivenod'}`,
  );
  // Answer the start-up dialogs (folder trust, development channels) as they come.
  await until(
    'claude is up',
    60_000,
    () => {
      const p = pane(name);
      // The trust dialog selects "No, exit" first.
      if (/trust this folder/i.test(p)) tmux('send-keys', '-t', name, 'Down', 'Enter');
      else if (/local development/i.test(p)) tmux('send-keys', '-t', name, 'Enter');
      return (
        /Channels \(experimental\)|inject directly|❯/.test(p) &&
        !/local development|trust this folder/i.test(p)
      );
    },
    name,
  );
  await pause(4000);
  if (prompt) {
    tmux('send-keys', '-t', name, '-l', prompt);
    await pause(300);
    tmux('send-keys', '-t', name, 'Enter');
    await until(
      'claude says ready',
      60_000,
      () => /ready/i.test(pane(name).split(prompt.slice(-30)).pop() ?? ''),
      name,
    );
  }
}

/** One tool call found in the session transcripts of the private Claude config. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Made by a sub-agent (a sidechain entry, or a sub-agent transcript file). */
  sub: boolean;
  /** Which agent made it: the sub-agent id, or the transcript file. */
  by: string;
}

/** Every tool call in the transcripts under the private config's projects folder. */
function toolCalls(): ToolCall[] {
  const out: ToolCall[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl'))
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          let j: {
            isSidechain?: boolean;
            agentId?: string;
            message?: { content?: unknown };
          };
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          const content = Array.isArray(j.message?.content) ? j.message.content : [];
          for (const c of content as { type?: string; name?: string; input?: unknown }[]) {
            if (c.type !== 'tool_use' || !c.name) continue;
            const sub = j.isSidechain === true || p.includes('/subagents/');
            out.push({
              name: c.name,
              input: (c.input ?? {}) as Record<string, unknown>,
              sub,
              by: j.agentId ?? p,
            });
          }
        }
    }
  };
  walk(join(CONFIG, 'projects'));
  return out;
}

const quit = async (name: string) => {
  tmux('send-keys', '-t', name, '-l', '/exit');
  await pause(300);
  tmux('send-keys', '-t', name, 'Enter');
};

/** Brings a message in as the agent (its home agent then gets the thread). */
async function bringIn(uid: string, token: string, ref: string, text: string) {
  const c = await GoAgent.start(uid, token);
  const added = await c.call('inbox_add', {
    source: 'teams',
    sender: { name: 'Sam Example', handle: 'sam@example.com' },
    text,
    threadRef: ref,
    receivedAt: new Date().toISOString(),
  });
  await c.close();
  return added.threadId as string;
}
const threadOf = (tid: string) => read(`workspaces/${W}/inboxThreads/${tid}`);
/** The thread was investigated: an outcome is proposed (or it was answered). */
const investigated = async (tid: string) =>
  ['yourCall', 'done', 'waiting'].includes(String((await threadOf(tid)).state));
const TOOLS = 'mcp__plugin_hivenod_hivenod,Agent,Task,SendMessage,TaskStop';

describe.skipIf(!run)('hivenod plugin: real Claude Code sessions', () => {
  // Item EJ2Cxq4k: the connect flow with the Go binary. `hivenod connect` (no browser) shows a
  // code; a plain member confirms it; connect saves the token and installs the plugin into the
  // private Claude config itself; `hivenod claude` starts the session and work arrives.
  it.skipIf(!!ONLY && ONLY !== 'connect')(
    'connect: hivenod connect, a member confirms, hivenod claude gets the work',
    async () => {
      for (const d of [BIN(), PROJECT_DIR(), join(DIR, 'home'), join(DIR, 'connect-home')])
        mkdirSync(d, { recursive: true });
      // `hivenod` without a token: connect gets one. HIVENOD_PLUGIN_MARKETPLACE: this repo.
      writeFileSync(
        join(BIN(), 'hivenod'),
        `#!/bin/sh\nexec env FIRESTORE_EMULATOR_HOST=${FS_HOST} FIREBASE_AUTH_EMULATOR_HOST=${AUTH_HOST} HIVENOD_PROJECT_ID=hive-rules-test HIVENOD_FIREBASE_API_KEY=fake-api-key HIVENOD_HOME=${join(DIR, 'connect-home')} HIVENOD_NO_BROWSER=1 HIVENOD_PLUGIN_MARKETPLACE=${REPO} ${goBinary()} "$@"\n`,
      );
      chmodSync(join(BIN(), 'hivenod'), 0o755);
      const child = spawn(join(BIN(), 'hivenod'), ['connect', '--no-start'], {
        cwd: PROJECT_DIR(),
        env: cleanEnv(),
      });
      let said = '';
      child.stdout.on('data', (d: Buffer) => (said += d.toString()));
      child.stderr.on('data', (d: Buffer) => (said += d.toString()));
      const exited = new Promise<number | null>((r) => child.once('exit', r));
      await until('connect shows a code', 30_000, () => /enter the code/.test(said));
      const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
      out(`hivenod connect is waiting (code ${code.slice(0, 4)}-…)`);

      // Alice, a plain member, confirms (what the /connect page does).
      const { uid, token } = await createAgentIdentity(
        { apiKey: 'fake-api-key', projectId: 'hive-rules-test' },
        W,
        { authEmulatorUrl: `http://${AUTH_HOST}` },
      );
      const alice = as('alice');
      await alice.run(
        createAgent(alice.ctx, {
          agentUid: uid,
          name: 'Connect smoke',
          color: '#2F5FD0',
          projectIds: [],
          tokenHint: 'a7f3',
        }),
      );
      const req = await read(pairingPath(code));
      const sealed = await sealToken(token, req.publicKey as string, code);
      await alice.run({
        ops: [
          {
            kind: 'update',
            path: pairingPath(code),
            data: pairingCompletion({
              workspaceId: W,
              agentUid: uid,
              agentName: 'Connect smoke',
              pairedBy: 'alice',
              sealed,
            }),
          },
        ],
      });
      const status = await Promise.race([exited, pause(240_000).then(() => 'timeout')]);
      expect(status, said).toBe(0);
      expect(said).toContain('Connected: this machine is now the agent Connect smoke');
      expect(said).toContain('Claude Code has the hivenod plugin');
      expect(said).not.toContain(token);
      out('CHECK connect: confirmed by a plain member, token saved, plugin installed: PASS');

      await start('c1', STANDING, { launcher: 'hivenod claude', tools: TOOLS });
      out('hivenod claude session up');
      const tid = await bringIn(
        uid,
        token,
        'connect-thread',
        'Can we move our review to Thursday?',
      );
      await until('connect thread investigated', 300_000, () => investigated(tid), 'c1');
      out('CHECK hivenod claude: the connected agent investigated the thread: PASS');
      await quit('c1');
    },
    600_000,
  );

  it.skipIf(!!ONLY && ONLY !== 'basic')(
    'a thread, busy, quit and restart',
    async () => {
      const uid = await smokeAgent('Channel smoke');
      await start('s1', STANDING, { tools: TOOLS });
      out('session 1 up');
      const t1 = await bringIn(uid, lastToken, 'basic-1', 'Can we move our review to Thursday?');
      await until('thread one investigated', 300_000, () => investigated(t1), 's1');
      const calls = toolCalls().filter((c) => c.name.endsWith('__thread_read'));
      expect(calls.some((c) => c.sub)).toBe(true);
      out('CHECK thread: a sub-agent read the thread and proposed an outcome: PASS');

      // A second session as the same agent, on another machine, is told it is busy (on the
      // same machine it would take over: item N0biX).
      await start('s2', null, { env: 'HIVENOD_HOST_ID=smoke-second-machine' });
      await until(
        'busy notice',
        60_000,
        () => /already running in another terminal/i.test(pane('s2')),
        's2',
      );
      out('CHECK busy: a second session as the same agent was told it is busy: PASS');
      tmux('kill-session', '-t', 's2');

      // Quit, then restart: a thread brought in meanwhile is sent on reconnect.
      await quit('s1');
      await until('session 1 quit', 30_000, () => !alive('s1'));
      out('session 1 quit');
      const t2 = await bringIn(uid, lastToken, 'basic-2', 'Is the invoice for October ready?');
      await pause(2000);
      expect((await threadOf(t2)).state).toBe('investigating'); // nobody online: it waits
      await start('s3', STANDING, { tools: TOOLS });
      await until('thread two investigated after restart', 300_000, () => investigated(t2), 's3');
      out(
        'CHECK restart: after quit and restart the waiting thread was sent and investigated: PASS',
      );
      await quit('s3');
    },
    900_000,
  );

  it.skipIf(!!ONLY && ONLY !== 'inbox')(
    'inbox: a sub-agent proposes an outcome; an approved outcome is carried out',
    async () => {
      const uid = await smokeAgent('Channel smoke (inbox)');
      await start('x', STANDING, { tools: TOOLS });
      out('inbox session up');
      const tid = await bringIn(
        uid,
        lastToken,
        'smoke-thread',
        'Hi! Can we move our review from Wednesday to Thursday at 10:00?',
      );
      await until(
        'the thread investigated and an outcome proposed',
        300_000,
        async () => (await threadOf(tid)).state === 'yourCall',
        'x',
      );
      out('CHECK inbox: a sub-agent investigated the thread and proposed an outcome: PASS');
      let oid = '';
      let o: Record<string, unknown> = {};
      await getEnv().withSecurityRulesDisabled(async (db) => {
        const snap = await db
          .firestore()
          .collection(`workspaces/${W}/inboxOutcomes`)
          .where('threadId', '==', tid)
          .get();
        const d = snap.docs.find((x) => x.data().state === 'proposed')!;
        oid = d.id;
        o = d.data();
      });
      const owner = as('owner');
      await owner.run(
        approveOutcome(owner.ctx, {
          outcomeId: oid,
          outcome: o as never,
          thread: (await threadOf(tid)) as never,
        }),
      );
      const immediate = ['no_reply', 'snooze', 'ignore'].includes(String(o.type));
      if (!immediate) {
        await until(
          'the approved outcome carried out',
          300_000,
          async () => {
            const got = await read(`workspaces/${W}/inboxOutcomes/${oid}`);
            return got.state === 'done' || got.state === 'failed';
          },
          'x',
        );
        out(
          `CHECK carry out: the approved ${String(o.type)} outcome reached the session and was reported with outcome_done: PASS`,
        );
      } else
        out(
          `NOTE carry out: the model proposed ${String(o.type)}, which takes effect on approval (nothing to carry out)`,
        );
      await quit('x');
    },
    900_000,
  );
});
