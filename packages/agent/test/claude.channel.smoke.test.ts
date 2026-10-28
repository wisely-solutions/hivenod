/**
 * Card ZY6KC56r (after KLCTVnX8): real interactive Claude Code sessions with the hivenod plugin,
 * installed from this repo's marketplace, paired to an emulator agent. MANUAL ONLY: run it with
 * `pnpm smoke:claude` (scripts/smoke-claude.mjs), never directly, never in CI or the e2e. The
 * wrapper makes the isolated Claude config, guards the live Telegram / agent-mail processes and
 * cleans up; this file only runs when the wrapper set its environment. See docs/AGENT-SMOKE.md.
 * Checks, in order (each one a test step with its own message in the output):
 *  1. work is handed over already claimed (no claim call by the model);
 *  2. the model finishes an item with a note and complete;
 *  3. a person's note and Stop work arrive in the session;
 *  4. a second session as the same agent is told it is busy;
 *  5. quit, then restart: a waiting item is handed over on reconnect.
 * Then, card cGSENsRF, one session with max_items 3 (HIVENOD_MAX_ITEMS=3):
 *  6. three items are handed over at once, a 4th waits until one ends;
 *  7. each item is worked by its own background sub-agent (complete called from a sub-agent
 *     transcript, a different sub-agent per item);
 *  8. Stop work on one held item stops only that one (the other held item keeps its run), and a
 *     note on the other one reaches its sub-agent, which then completes it.
 * Then, item QjTTL, one session with max_items 1:
 *  9. the model parks its item with a reason: it stays claimed and parked, and the next item is
 *     handed over and finished; a person's note on the parked item reaches the session and wakes it.
 * `pnpm smoke:claude --only basic|max-items|park` runs one of the parts.
 */
import { goBinary } from './gobin';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  buildStepIndex,
  paths,
  postMessage,
  stopWork,
  type ItemState,
  type Step,
} from '@hive/shared';
import { execFileSync } from 'node:child_process';
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
import {
  as,
  gate,
  getEnv,
  I,
  itemDoc,
  now,
  P,
  projectDoc,
  put,
  useEmulator,
  W,
} from '../../shared/rules/harness';

const CONFIG = process.env.HIVE_SMOKE_CLAUDE_CONFIG_DIR ?? '';
const DIR = process.env.HIVE_SMOKE_DIR ?? '';
const SOCKET = process.env.HIVE_SMOKE_TMUX ?? '';
const run = process.env.HIVE_SMOKE_CLAUDE_CHANNEL === '1' && CONFIG && DIR && SOCKET;
const ONLY = process.env.HIVE_SMOKE_ONLY ?? '';
const MODEL = process.env.HIVE_SMOKE_MODEL || 'haiku';
if (run) useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PKG = fileURLToPath(new URL('..', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));

const LIB: Step[] = [
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate() },
];

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
  'You are a Hivenod worker. When a hivenod channel event of kind work arrives (or already arrived before this message), call read_item and do what the item says; if it says nothing special, add one short line with add_note and then finish with complete and a short summary. When a channel event of kind note arrives, reply with the single word made by joining ACK and NOTE. When a channel event of kind stop arrives, reply with the single word made by joining ACK and STOP and nothing else. Meanwhile just say ready.';

const out = (s: string) => void process.stdout.write(`[smoke] ${s}\n`);

const BIN = () => join(DIR, 'bin');
const PROJECT_DIR = () => join(DIR, 'project');
let prepared: Promise<void> | null = null;

/** Builds the CLI and installs the plugin into the private Claude config, once per run. */
function prepare() {
  prepared ??= (async () => {
    execFileSync('pnpm', ['build'], { cwd: PKG, stdio: 'ignore' });
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
    claude(['plugin', 'marketplace', 'add', REPO, '--scope', 'local']);
    claude(['plugin', 'install', 'hivenod@hivenod', '--scope', 'local']);
  })();
  return prepared;
}

/** A fresh emulator agent on project p1, and the `hivenod` stub on PATH signed in as it. */
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
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: 'a7f3',
      previousAgentUid: null,
      lastEventId: 'seed',
    },
    [P('p1')]: projectDoc({}, { steps: LIB, stepIndex: buildStepIndex(LIB) }),
    // The harness's seeded item is not part of this run.
    [I('i0')]: itemDoc({ stepId: 'review', status: 'stopped' }),
  });
  // `hivenod` as the plugin runs it, pointed at the emulators (the token is a test token).
  // HIVENOD_SMOKE_GO=1: the Go binary (item zLwtX2WEEg3mER4CR74g) instead of the TypeScript CLI.
  const cli =
    process.env.HIVENOD_SMOKE_GO === '1'
      ? `${goBinary()} `
      : `${process.execPath} ${join(PKG, 'dist/cli.js')} `;
  console.log(
    `[smoke] hivenod is ${process.env.HIVENOD_SMOKE_GO === '1' ? 'the Go binary' : 'the TypeScript CLI'}: ${cli.trim()}`,
  );
  writeFileSync(
    join(BIN(), 'hivenod'),
    `#!/bin/sh\nexec env FIRESTORE_EMULATOR_HOST=${FS_HOST} FIREBASE_AUTH_EMULATOR_HOST=${AUTH_HOST} HIVENOD_PROJECT_ID=hive-rules-test HIVENOD_FIREBASE_API_KEY=fake-api-key HIVENOD_HOME=${join(DIR, 'hivenod-home')} HIVENOD_TOKEN=${token} ${cli}"$@"\n`,
  );
  chmodSync(join(BIN(), 'hivenod'), 0o755);
  return uid;
}

/** Starts claude in a new tmux session, passes the start-up dialogs and the standing prompt. */
async function start(
  name: string,
  prompt: string | null,
  opts: { env?: string; tools?: string } = {},
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
    `env -i HOME=${join(DIR, 'home')} PATH=${BIN()}:${process.env.PATH} TERM=xterm-256color CLAUDE_CONFIG_DIR=${CONFIG} ${opts.env ?? ''} claude --model ${MODEL} --allowedTools ${opts.tools ?? 'mcp__plugin_hivenod_hivenod'} --dangerously-load-development-channels plugin:hivenod@hivenod`,
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

const STANDING_MULTI =
  'You are a Hivenod worker session that runs items through sub-agents, as the hivenod channel instructions say. For each hivenod channel event of kind work (also ones that arrived before this message), start one new background sub-agent (the Agent tool, subagent_type general-purpose, run_in_background true) with the brief in the event, and never do the item yourself. When a channel event of kind note arrives, pass the note text on to the sub-agent of that item_id (continue it with SendMessage; if that is not possible, start a new background sub-agent for that item with the note as its brief), then reply with ACKNOTE and the item_id. When a channel event of kind stop arrives, stop the sub-agent of that item if it still runs (TaskStop), then reply with ACKSTOP and the item_id, and nothing else. Meanwhile just say ready.';

/** The hivenod tool calls made for one item (by any agent of the session). */
const callsFor = (calls: ToolCall[], tool: string, itemId: string) =>
  calls.filter((c) => c.name.endsWith(`__${tool}`) && c.input.itemId === itemId);

async function messagesOf(itemId: string) {
  let texts: string[] = [];
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const snap = await c
      .firestore()
      .collection(`${I(itemId)}/messages`)
      .get();
    texts = snap.docs.map((d) => String(d.data().text ?? ''));
  });
  return texts;
}

describe.skipIf(!run)('hivenod plugin: real Claude Code sessions', () => {
  it.skipIf(!!ONLY && ONLY !== 'basic')(
    'handover, note, stop, busy, quit and restart',
    async () => {
      await smokeAgent('Channel smoke');
      // 1+2. Work handed over already claimed; the model finishes it with a note and complete.
      await start('s1', STANDING);
      out('session 1 up');
      await put({
        [I('i1')]: itemDoc({
          stepId: 'build',
          title: 'Smoke item one',
          summary: 'Write a one-line greeting with add_note, then finish the step with complete.',
          order: 1,
        }),
      });
      let sawClaim = false;
      await until(
        'item one done',
        180_000,
        async () => {
          const it = await read(I('i1'));
          if (it.claim && it.stepId === 'build') sawClaim = true;
          return it.stepId === 'review';
        },
        's1',
      );
      expect(sawClaim).toBe(true);
      out(
        'CHECK handover: item one arrived already claimed (claim seen before any complete): PASS',
      );
      expect(await read(I('i1'))).toMatchObject({
        stepId: 'review',
        status: 'waiting',
        claim: null,
      });
      out('CHECK complete: item one finished by the model (moved to Review, claim released): PASS');

      // 3. A person's note and Stop work arrive on an item the session holds.
      await put({
        [I('i2')]: itemDoc({
          stepId: 'build',
          title: 'Smoke item two',
          summary: 'Do not add a note and do not complete. Just say HOLDING and wait for a person.',
          order: 2,
        }),
      });
      const held = await until(
        'item two claimed',
        120_000,
        async () => {
          const it = await read(I('i2'));
          return it.claim ? it : false;
        },
        's1',
      );
      const runId = (held.claim as { runId: string }).runId;
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, {
          projectId: 'p1',
          itemId: 'i2',
          kind: 'note',
          text: 'Use British spelling',
        }),
      );
      await until('note acknowledged', 90_000, () => pane('s1').includes('ACKNOTE'), 's1');
      out("CHECK note: a person's note arrived in the session (model answered ACKNOTE): PASS");
      const owner = as('owner');
      await owner.run(
        stopWork(owner.ctx, {
          project: { steps: LIB } as never,
          projectId: 'p1',
          itemId: 'i2',
          item: (await read(I('i2'))) as unknown as ItemState,
          mode: 'back',
          reason: 'Smoke stop',
          run: { costEur: 0, endedAt: null },
        }),
      );
      await until('stop acknowledged', 90_000, () => pane('s1').includes('ACKSTOP'), 's1');
      expect(runId).toBeTruthy();
      out('CHECK stop: Stop work arrived in the session (model answered ACKSTOP): PASS');

      // 4. A second session as the same agent is told it is busy.
      await start('s2', null);
      await until(
        'busy notice',
        60_000,
        () => /already running in another terminal/i.test(pane('s2')),
        's2',
      );
      out('CHECK busy: a second session as the same agent was told it is busy: PASS');
      tmux('kill-session', '-t', 's2');

      // 5. Quit, then restart: a waiting item is handed over on reconnect.
      tmux('send-keys', '-t', 's1', '-l', '/exit');
      await pause(300);
      tmux('send-keys', '-t', 's1', 'Enter');
      await until('session 1 quit', 30_000, () => !alive('s1'));
      out('session 1 quit');
      await put({
        [I('i3')]: itemDoc({
          stepId: 'build',
          title: 'Smoke item three',
          summary: 'Write a one-line greeting with add_note, then finish the step with complete.',
          order: 3,
        }),
      });
      await pause(2000);
      expect((await read(I('i3'))).claim).toBeNull(); // nobody online: it waits
      await start('s3', STANDING);
      await until(
        'item three done after restart',
        180_000,
        async () => (await read(I('i3'))).stepId === 'review',
        's3',
      );
      out(
        'CHECK restart: after quit and restart the waiting item was handed over and finished: PASS',
      );
      tmux('send-keys', '-t', 's3', '-l', '/exit');
      await pause(300);
      tmux('send-keys', '-t', 's3', 'Enter');
    },
    900_000,
  );

  it.skipIf(!!ONLY && ONLY !== 'max-items')(
    'max_items 3: three items through three sub-agents, a 4th waits, Stop stops only that one',
    async () => {
      const uid = await smokeAgent('Channel smoke (max_items 3)');
      await start('m', STANDING_MULTI, {
        env: 'HIVENOD_MAX_ITEMS=3',
        tools: 'mcp__plugin_hivenod_hivenod,Agent,Task,SendMessage,TaskStop',
      });
      out('max_items session up (HIVENOD_MAX_ITEMS=3)');
      const finish = (n: string) =>
        `Add the note DONE-${n} with add_note, then finish the step with complete and a one-line summary.`;
      const hold = (n: string) =>
        `Add the note HOLDING-${n} with add_note, then report back WITHOUT calling complete, end_run or release (the item and its run must stay open). Only when a person's note later says to finish this item, call complete on it.`;
      const ids = ['m1', 'm2', 'm3', 'm4'];
      const brief: Record<string, string> = {
        m1: finish('1'),
        m2: finish('2'),
        m3: hold('3'),
        m4: hold('4'),
      };
      await put(
        Object.fromEntries(
          ids.map((id, n) => [
            I(id),
            itemDoc({
              stepId: 'build',
              title: `Parallel item ${n + 1}`,
              summary: brief[id],
              order: n + 1,
            }),
          ]),
        ),
      );
      // 6. Three claimed at once, the 4th waits.
      const firstThree = await until(
        'three items claimed',
        120_000,
        async () => {
          const claimed: string[] = [];
          for (const id of ids) {
            const it = await read(I(id));
            if ((it.claim as { agentUid?: string } | null)?.agentUid === uid) claimed.push(id);
          }
          if (claimed.length > 3)
            throw new Error(`more than 3 items claimed: ${claimed.join(',')}`);
          return claimed.length === 3 ? claimed : false;
        },
        'm',
      );
      const waiting = ids.find((id) => !firstThree.includes(id))!;
      await pause(3000);
      let heldNow = 0;
      for (const id of ids) if ((await read(I(id))).claim) heldNow++;
      const waitingDone = (await read(I(waiting))).stepId === 'review';
      expect(heldNow <= 3).toBe(true);
      out(
        `CHECK max_items: ${firstThree.join(', ')} claimed at once, ${waiting} waited (never more than 3 held): PASS`,
      );
      // The finishers complete; the holders hold with a note. The 4th arrives when one ends.
      await until(
        'm1, m2 completed and m3, m4 holding',
        360_000,
        async () => {
          let held = 0;
          for (const id of ids) if ((await read(I(id))).claim) held++;
          if (held > 3) throw new Error(`${held} items claimed at once (max_items 3)`);
          const done = [(await read(I('m1'))).stepId, (await read(I('m2'))).stepId];
          if (done.some((x) => x !== 'review')) return false;
          for (const id of ['m3', 'm4']) {
            const it = await read(I(id));
            if (!it.claim) return false;
            if (!(await messagesOf(id)).some((t) => t.includes(`HOLDING-${id.slice(1)}`)))
              return false;
          }
          return true;
        },
        'm',
      );
      expect(waitingDone).toBe(false);
      out(`CHECK 4th: ${waiting} was handed over after one of the first three ended: PASS`);
      // 7. Each item worked by its own sub-agent (transcripts are written as they go: let them land).
      await pause(3000);
      let calls = toolCalls();
      const short = (by: string) => by.split('/').slice(-2).join('/');
      for (const c of calls.filter((x) => x.name.includes('hivenod') || !x.name.startsWith('mcp')))
        out(
          `  call ${c.name.replace('mcp__plugin_hivenod_hivenod__', 'hivenod.')} item=${String(c.input.itemId ?? '-')} ${c.sub ? 'sub-agent' : 'main'} ${short(c.by)}`,
        );
      const workerOf: Record<string, string> = {};
      for (const id of ids) {
        const notes = callsFor(calls, 'add_note', id);
        expect(notes.length, `add_note for ${id}`).toBeGreaterThan(0);
        expect(
          notes.every((c) => c.sub),
          `${id} worked by a sub-agent, not the main session`,
        ).toBe(true);
        workerOf[id] = notes[0]!.by;
      }
      for (const id of ['m1', 'm2']) {
        const done = callsFor(calls, 'complete', id);
        expect(done.length && done.every((c) => c.sub && c.by === workerOf[id])).toBeTruthy();
      }
      expect(new Set(Object.values(workerOf)).size).toBe(4);
      out(
        'CHECK sub-agents: each of the 4 items was worked by its own background sub-agent (add_note and complete from 4 distinct sub-agent transcripts, none from the main session): PASS',
      );
      // 8. Stop work on m3 stops only m3; m4 keeps its run.
      const m4Run = ((await read(I('m4'))).claim as { runId: string }).runId;
      const m3Run = ((await read(I('m3'))).claim as { runId: string }).runId;
      const owner = as('owner');
      // The item may change between the read and the write (a heartbeat, a log line): read again.
      for (let attempt = 1; ; attempt++) {
        try {
          await owner.run(
            stopWork(owner.ctx, {
              project: { steps: LIB } as never,
              projectId: 'p1',
              itemId: 'm3',
              item: (await read(I('m3'))) as unknown as ItemState,
              mode: 'back',
              reason: 'Smoke stop of one item',
              run: (await read(paths.run(W, m3Run))) as never,
            }),
          );
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          const it = await read(I('m3'));
          const r = await read(paths.run(W, m3Run));
          out(
            `  stop write refused (attempt ${attempt}): item status ${String(it.status)}, run status ${String(r.status)}, run ended ${r.endedAt ? 'yes' : 'no'}`,
          );
          await pause(1000);
        }
      }
      await until('stop acknowledged', 120_000, () => /ACKSTOP\W*m3/.test(pane('m')), 'm');
      await pause(5000);
      expect((await read(paths.run(W, m3Run))).status).toBe('stopped');
      expect((await read(I('m3'))).claim).toBeNull();
      expect(((await read(I('m4'))).claim as { runId: string }).runId).toBe(m4Run);
      // Stop touches only m3: m4 keeps its claim and its run is not stopped.
      expect((await read(paths.run(W, m4Run))).status).not.toBe('stopped');
      expect((await read(paths.run(W, m4Run))).stoppedBy ?? null).toBeNull();
      out(
        'CHECK stop: Stop work on m3 reached the session (ACKSTOP m3); m3 stopped, m4 kept its claim and its run was not stopped: PASS',
      );
      // A note on m4 reaches its sub-agent, which finishes it.
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, {
          projectId: 'p1',
          itemId: 'm4',
          kind: 'note',
          text: 'A person says: finish it now. Call complete on this item with a one-line summary.',
        }),
      );
      await until(
        'm4 completed after the note',
        300_000,
        async () => (await read(I('m4'))).stepId === 'review',
        'm',
      );
      await pause(3000);
      calls = toolCalls();
      for (const c of callsFor(calls, 'complete', 'm4'))
        out(
          `  after the note: hivenod.complete item=m4 ${c.sub ? 'sub-agent' : 'main'} ${short(c.by)}`,
        );
      const m4Done = callsFor(calls, 'complete', 'm4');
      expect(m4Done.length && m4Done.every((c) => c.sub)).toBeTruthy();
      expect((await read(I('m3'))).stepId).toBe('build');
      expect(
        callsFor(calls, 'complete', 'm3').length === 0 || (await read(I('m3'))).stepId === 'build',
      ).toBe(true);
      out(
        `CHECK note: the note on m4 reached a sub-agent, which completed m4 (${m4Done[0]!.by === workerOf.m4 ? 'the same sub-agent, continued' : 'a new sub-agent for m4'}); m3 stayed stopped: PASS`,
      );
      await quit('m');
    },
    900_000,
  );

  it.skipIf(!!ONLY && ONLY !== 'park')(
    'park: a parked item frees the slot for the next one; a note wakes it',
    async () => {
      const uid = await smokeAgent('Channel smoke (park)');
      await start('k', STANDING);
      out('park session up (max_items 1)');
      await put({
        [I('k1')]: itemDoc({
          stepId: 'build',
          title: 'Smoke park one',
          summary:
            'This item waits for a release batch. Call the hivenod park tool on it with the reason "release batch". Do not add a note, do not complete it. Then just say PARKED.',
          order: 1,
        }),
      });
      const parked = await until(
        'k1 parked',
        180_000,
        async () => {
          const it = await read(I('k1'));
          return it.parked ? it : false;
        },
        'k',
      );
      expect(parked).toMatchObject({
        claim: { agentUid: uid },
        parked: { reason: 'release batch' },
      });
      out('CHECK park: the model parked k1 (claimed, parked with its reason): PASS');
      await put({
        [I('k2')]: itemDoc({
          stepId: 'build',
          title: 'Smoke park two',
          summary: 'Write a one-line greeting with add_note, then finish the step with complete.',
          order: 2,
        }),
      });
      await until(
        'k2 done while k1 is parked',
        180_000,
        async () => (await read(I('k2'))).stepId === 'review',
        'k',
      );
      expect(await read(I('k1'))).toMatchObject({
        stepId: 'build',
        claim: { agentUid: uid },
        parked: { reason: 'release batch' },
      });
      out(
        'CHECK next: with max_items 1, k2 was handed over and finished while k1 stayed parked: PASS',
      );
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, {
          projectId: 'p1',
          itemId: 'k1',
          kind: 'note',
          text: 'Batch is out',
        }),
      );
      await until('note on the parked item', 90_000, () => pane('k').includes('ACKNOTE'), 'k');
      await until('k1 awake', 30_000, async () => (await read(I('k1'))).parked === null, 'k');
      out("CHECK wake: a person's note on parked k1 reached the session and woke it: PASS");
      await quit('k');
    },
    600_000,
  );
});
