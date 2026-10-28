/**
 * Card KLCTVnX8: `hivenod mcp --channel` against the emulators and the real rules, through a real
 * MCP client that receives the `notifications/claude/channel` events (what Claude Code gets).
 * - an item reaching the agent's step is handed over within seconds, already claimed;
 * - one at a time: a second item waits until the first ends;
 * - send_back: the item comes back as new work with the reason (why="sent_back");
 * - a person's note on the current item, Stop work, and an answer (after ask held the item);
 * - offline, then reconnect: waiting work arrives; a second live session gets no handovers.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import {
  answer,
  answerQuestion,
  approveOutcome,
  askForStatus,
  buildStepIndex,
  inboxPaths,
  type OutcomeStateOf,
  type ThreadStateOf,
  paths,
  postMessage,
  stopWork,
  type ItemState,
  type Step,
} from '@hive/shared';
import { Timestamp } from 'firebase/firestore';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
import { HiveClient } from '../src/client';
import { createMcpServer } from '../src/mcp';
import { GO, goBinary, goEnv } from './gobin';

/** Each suite runs on the TypeScript server and on the Go binary (when Go is installed). */
const IMPLS: ('ts' | 'go')[] = GO ? ['ts', 'go'] : ['ts'];
let IMPL: 'ts' | 'go' = 'ts';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

/** build → test → review (people) */
const LIB: Step[] = [
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'test', name: 'Test', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate() },
];
const PROJECT = { steps: LIB };

interface Pushed {
  content: string;
  meta: Record<string, string>;
}

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f()));
});

async function newAgent() {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Builder',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
    },
    [P('p1')]: projectDoc({}, { steps: LIB, stepIndex: buildStepIndex(LIB) }),
    // The seeded item of the harness is not part of these tests.
    [I('i1')]: itemDoc({ stepId: 'review', status: 'stopped' }),
  });
  return { uid, token };
}

/** A Claude Code stand-in: an MCP client on the channel server, collecting what is pushed. */
async function session(
  token: string,
  maxItems?: number,
  maxInbox?: number,
  statusMinuteMs?: number,
) {
  const events: Pushed[] = [];
  const client = new Client({ name: 'claude-code', version: '0' });
  client.fallbackNotificationHandler = async (n) => {
    if (n.method === 'notifications/claude/channel') events.push(n.params as unknown as Pushed);
  };
  let srv: ReturnType<typeof createMcpServer> | null = null;
  let transport: StdioClientTransport | null = null;
  if (IMPL === 'ts') {
    srv = createMcpServer(
      () => HiveClient.connect({ token, projectId: 'hive-rules-test', authEmulator: AUTH_HOST }),
      undefined,
      {
        channel: {
          retryMs: 500,
          presenceMs: 1000,
          parkCheckMs: 500,
          inbox: { tickMs: 500, ...(maxInbox !== undefined ? { maxInbox } : {}) },
          ...(maxItems ? { maxItems } : {}),
          ...(statusMinuteMs ? { statusMinuteMs, statusCheckMs: 200 } : {}),
        },
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([srv.server.connect(a), client.connect(b)]);
    await srv.started();
  } else {
    // The Go binary (item zLwtX2WEEg3mER4CR74g), the same assertions.
    const t0 = Date.now();
    transport = new StdioClientTransport({
      command: goBinary(),
      args: ['mcp', '--channel', ...(maxItems ? ['--max-items', String(maxItems)] : [])],
      env: goEnv({
        HIVENOD_TOKEN: token,
        HIVENOD_PRESENCE_MS: '1000',
        HIVENOD_CHANNEL_RETRY_MS: '500',
        HIVENOD_PARK_CHECK_MS: '500',
        HIVENOD_INBOX_TICK_MS: '500',
        ...(maxInbox !== undefined ? { HIVENOD_MAX_INBOX: String(maxInbox) } : {}),
        ...(statusMinuteMs
          ? { HIVENOD_STATUS_MINUTE_MS: String(statusMinuteMs), HIVENOD_STATUS_CHECK_MS: '200' }
          : {}),
      }),
      stderr: 'inherit',
    });
    await client.connect(transport);
    // Started: presence written, or an info event (busy, setup).
    const uid = (await HiveClient.connect({
      token,
      projectId: 'hive-rules-test',
      authEmulator: AUTH_HOST,
    }).then(async (c) => {
      const id = c.uid;
      await c.close();
      return id;
    })) as string;
    for (;;) {
      const seen = (await read(paths.agent(W, uid))).lastSeenAt as
        { toMillis(): number } | undefined;
      if ((seen && seen.toMillis() >= t0 - 1000) || events.some((e) => e.meta.kind === 'info'))
        break;
      if (Date.now() - t0 > 10_000) throw new Error('the Go channel session did not start in 10 s');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const close = async () => {
    const pid = transport?.pid ?? null;
    await client.close().catch(() => undefined);
    await srv?.close();
    if (pid) await exited(pid);
  };
  open.push(close);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { text: string }[])[0]!.text;
    if (r.isError) throw new Error(text);
    return JSON.parse(text) as Record<string, unknown>;
  };
  /** The n-th event of `kind` (1-based), waiting up to `ms` for it. */
  const next = async (kind: string, n = 1, ms = 5000) => {
    const t0 = Date.now();
    for (;;) {
      const got = events.filter((e) => e.meta.kind === kind);
      if (got.length >= n) return { ...got[n - 1]!, ms: Date.now() - t0 };
      if (Date.now() - t0 > ms)
        throw new Error(`no ${kind} #${n} within ${ms} ms; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return {
    events,
    call,
    next,
    close,
    srv,
    disconnect: async () => {
      await client.close();
    },
    listTools: () => client.listTools(),
  };
}

async function read(path: string) {
  let d: Record<string, unknown> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    d = (await c.firestore().doc(path).get()).data() ?? {};
  });
  return d;
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits (up to 8 s) until a process has exited. */
async function exited(pid: number) {
  for (const t0 = Date.now(); Date.now() - t0 < 8000;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The items this agent holds (claimed), from Firestore. */
async function heldBy(uid: string): Promise<string[]> {
  const out: string[] = [];
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const snap = await c.firestore().collection(`workspaces/${W}/projects/p1/items`).get();
    for (const d of snap.docs) if (d.data().claim?.agentUid === uid) out.push(d.id);
  });
  return out;
}

for (const impl of IMPLS)
  describe(`hivenod mcp --channel [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });

    it('declares the channel and offers no claim-yourself tools', async () => {
      const { token } = await newAgent();
      const s = await session(token);
      const names = (await s.listTools()).tools.map((t) => t.name);
      expect(names).toContain('send_back');
      expect(names).not.toContain('wait_for_work');
      await expect(s.call('claim', { itemId: 'x' })).rejects.toThrow(/already claimed/);
    });

    it('hands over one item at a time, claimed, within seconds; complete brings the next', async () => {
      const { uid, token } = await newAgent();
      const s = await session(token);
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'First', order: 1 }) });
      const w1 = await s.next('work');
      expect(w1.ms).toBeLessThan(5000);
      expect(w1.meta).toMatchObject({
        kind: 'work',
        step: 'Build',
        project: 'Blog',
        why: 'arrived',
      });
      const first = w1.meta.item_id!;
      expect(await read(I(first))).toMatchObject({
        status: 'working',
        claim: { agentUid: uid, runId: w1.meta.run_id },
      });
      // Presence: the agent shows online.
      expect((await read(paths.agent(W, uid))).lastSeenAt).toBeTruthy();
      await put({ [I('b')]: itemDoc({ stepId: 'build', title: 'Second', order: 2 }) });
      await pause(1500);
      expect(s.events.filter((e) => e.meta.kind === 'work')).toHaveLength(1);
      expect((await read(I('b'))).claim).toBeNull();
      // Finishing the first moves it to Test, which this agent also works: one at a time still.
      await s.call('complete', { itemId: first, runId: w1.meta.run_id });
      const w2 = await s.next('work', 2);
      // Either the first at Test or the second at Build: the other one is not claimed meanwhile.
      const other = w2.meta.item_id === first ? 'b' : first;
      expect((await read(I(other))).claim).toBeNull();
      expect(s.events.filter((e) => e.meta.kind === 'work')).toHaveLength(2);
    });

    it('send_back returns the item as new work with the reason', async () => {
      const { token } = await newAgent();
      const s = await session(token);
      await put({ [I('a')]: itemDoc({ stepId: 'test', title: 'Login' }) });
      const w = await s.next('work');
      await s.call('send_back', {
        itemId: 'a',
        runId: w.meta.run_id,
        toStep: 'build',
        reason: 'The login test fails on Safari',
      });
      const back = await s.next('work', 2);
      expect(back.meta).toMatchObject({ item_id: 'a', step: 'Build', why: 'sent_back' });
      expect(back.content).toContain('The login test fails on Safari');
    });

    it("pushes a person's note on the current item, then Stop work", async () => {
      const { token } = await newAgent();
      const s = await session(token);
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'Docs' }) });
      const w = await s.next('work');
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, {
          projectId: 'p1',
          itemId: 'a',
          kind: 'note',
          text: 'Use British spelling',
        }),
      );
      const note = await s.next('note');
      expect(note.content).toContain('Use British spelling');
      expect(note.meta).toMatchObject({ item_id: 'a', run_id: w.meta.run_id });
      // Stop work (an admin).
      const o = as('owner');
      const item = (await read(I('a'))) as unknown as ItemState;
      await o.run(
        stopWork(o.ctx, {
          project: PROJECT,
          projectId: 'p1',
          itemId: 'a',
          item,
          mode: 'back',
          reason: 'Wrong item',
          run: { costEur: 0, endedAt: null },
        }),
      );
      const stop = await s.next('stop');
      expect(stop.meta).toMatchObject({ item_id: 'a', run_id: w.meta.run_id });
      expect(stop.content).toMatch(/stopped your work on "Docs"/);
      await pause(800);
      expect(s.events.filter((e) => e.meta.kind === 'note')).toHaveLength(1);
    });

    it('ask holds the item; the answer brings it back as new work with the answer', async () => {
      const { token } = await newAgent();
      const s = await session(token);
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'Pricing' }) });
      const w = await s.next('work');
      const asked = await s.call('ask', { itemId: 'a', question: 'Which currency?' });
      expect(asked.note).toMatch(/comes back to you/);
      const held = await read(I('a'));
      expect(held).toMatchObject({ claim: null, awaitingAnswer: { questionId: asked.messageId } });
      expect((await read(paths.run(W, w.meta.run_id!))).endedAt).toBeTruthy();
      const alice = as('alice');
      await alice.run(
        answer(alice.ctx, {
          projectId: 'p1',
          itemId: 'a',
          item: held as unknown as ItemState,
          questionId: asked.messageId as string,
          text: 'Euro',
        }),
      );
      const again = await s.next('work', 2);
      expect(again.meta).toMatchObject({ item_id: 'a', why: 'answered' });
      expect(again.content).toContain('Which currency?');
      expect(again.content).toContain('Euro');
    });

    it('goes offline at once when the session ends cleanly (client closes the connection)', async () => {
      const { uid, token } = await newAgent();
      const s = await session(token);
      await pause(1500); // presence written
      const before = await read(paths.agent(W, uid));
      expect(before.lastSeenAt).toBeTruthy();
      expect(before.signedOutAt ?? null).toBeNull();
      // Claude Code ends the session: only the connection closes, nobody calls srv.close().
      await s.disconnect();
      const t0 = Date.now();
      for (;;) {
        if ((await read(paths.agent(W, uid))).signedOutAt) break;
        if (Date.now() - t0 > 3000) throw new Error('not offline within 3 s of the session ending');
        await pause(100);
      }
    });

    it('offline, then reconnect: waiting work arrives; a second session gets no handovers', async () => {
      const { uid, token } = await newAgent();
      let s = await session(token);
      await s.close();
      expect((await read(paths.agent(W, uid))).signedOutAt).toBeTruthy();
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'Waited' }) });
      await pause(500);
      expect((await read(I('a'))).claim).toBeNull();
      s = await session(token);
      const w = await s.next('work');
      expect(w.meta.item_id).toBe('a');
      const other = await session(token);
      const busy = await other.next('info');
      expect(busy.meta.code).toBe('busy');
      await put({ [I('b')]: itemDoc({ stepId: 'build', title: 'Not for the second' }) });
      await pause(1500);
      expect(other.events.filter((e) => e.meta.kind === 'work')).toHaveLength(0);
    });
  });

for (const impl of IMPLS)
  describe(`hivenod mcp --channel with max_items 3 (card cGSENsRF) [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });

    const works = (s: Awaited<ReturnType<typeof session>>) =>
      s.events.filter((e) => e.meta.kind === 'work');

    it('holds at most 3: a 4th waits and is pushed when one ends; each event asks for a sub-agent', async () => {
      const { uid, token } = await newAgent();
      const s = await session(token, 3);
      await put({
        [I('a')]: itemDoc({ stepId: 'review', title: 'A', order: 1 }),
        [I('b')]: itemDoc({ stepId: 'review', title: 'B', order: 2 }),
        [I('c')]: itemDoc({ stepId: 'review', title: 'C', order: 3 }),
        [I('d')]: itemDoc({ stepId: 'review', title: 'D', order: 4 }),
      });
      // All four reach the agent step at once.
      await put({
        [I('a')]: itemDoc({ stepId: 'build', title: 'A', order: 1 }),
        [I('b')]: itemDoc({ stepId: 'build', title: 'B', order: 2 }),
        [I('c')]: itemDoc({ stepId: 'build', title: 'C', order: 3 }),
        [I('d')]: itemDoc({ stepId: 'build', title: 'D', order: 4 }),
      });
      await s.next('work', 3);
      await pause(1500);
      const w = works(s);
      expect(w).toHaveLength(3);
      const ids = w.map((e) => e.meta.item_id!);
      expect(new Set(ids).size).toBe(3);
      for (const e of w) {
        expect(e.meta).toMatchObject({ max_items: '3' });
        expect(e.content).toContain(`item_id ${e.meta.item_id}`);
        expect(e.content).toMatch(/background sub-agent/);
        expect(await read(I(e.meta.item_id!))).toMatchObject({
          claim: { agentUid: uid, runId: e.meta.run_id },
        });
      }
      const waiting = ['a', 'b', 'c', 'd'].find((x) => !ids.includes(x))!;
      expect((await read(I(waiting))).claim).toBeNull();
      expect(await heldBy(uid)).toHaveLength(3);
      // Without itemId, a tool is refused with the held items listed.
      await expect(s.call('add_note', { text: 'x' })).rejects.toThrow(/holds 3 items: pass itemId/);
      await expect(s.call('add_note', { itemId: waiting, text: 'x' })).rejects.toThrow(
        new RegExp(`does not hold item ${waiting}`),
      );
      // Logging and finishing by item id alone (the run id is filled in).
      const first = w[0]!;
      expect(await s.call('log', { itemId: first.meta.item_id, text: 'working' })).toMatchObject({
        runId: first.meta.run_id,
      });
      await s.call('complete', { itemId: first.meta.item_id });
      // The finished item moves on to Test (also this agent's) or the 4th comes: one more, not two.
      const w4 = await s.next('work', 4);
      await pause(1500);
      expect(works(s)).toHaveLength(4);
      expect(await heldBy(uid)).toHaveLength(3);
      expect([waiting, first.meta.item_id]).toContain(w4.meta.item_id);
    });

    it('notes and stops are per item; after a stop only that item is refused', async () => {
      const { token } = await newAgent();
      const s = await session(token, 3);
      await put({
        [I('a')]: itemDoc({ stepId: 'build', title: 'A', order: 1 }),
        [I('b')]: itemDoc({ stepId: 'build', title: 'B', order: 2 }),
        [I('c')]: itemDoc({ stepId: 'build', title: 'C', order: 3 }),
      });
      await s.next('work', 3);
      const runOf = (id: string) => works(s).find((e) => e.meta.item_id === id)!.meta.run_id!;
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, { projectId: 'p1', itemId: 'b', kind: 'note', text: 'Only for B' }),
      );
      const note = await s.next('note');
      expect(note.meta).toMatchObject({ item_id: 'b', run_id: runOf('b') });
      expect(note.content).toContain('(item_id b)');
      const o = as('owner');
      await o.run(
        stopWork(o.ctx, {
          project: PROJECT,
          projectId: 'p1',
          itemId: 'b',
          item: (await read(I('b'))) as unknown as ItemState,
          mode: 'back',
          reason: 'Not B',
          run: { costEur: 0, endedAt: null },
        }),
      );
      const stop = await s.next('stop');
      expect(stop.meta).toMatchObject({ item_id: 'b', run_id: runOf('b') });
      expect(stop.content).toMatch(/the others go on/);
      await pause(800);
      expect(s.events.filter((e) => e.meta.kind === 'stop')).toHaveLength(1);
      // B's tools refuse; A and C go on.
      await expect(s.call('add_note', { itemId: 'b', text: 'late' })).rejects.toThrow(
        /A person stopped the work on item b/,
      );
      await expect(s.call('log', { runId: runOf('b'), text: 'late' })).rejects.toThrow(
        /stopped the work of run/,
      );
      await s.call('add_note', { itemId: 'a', text: 'A goes on' });
      await s.call('complete', { itemId: 'c' });
      expect(await read(I('c'))).toMatchObject({ stepId: 'test' });
      expect((await read(I('a'))).claim).toMatchObject({ runId: runOf('a') });
    });
  });

for (const impl of IMPLS)
  describe(`hivenod mcp --channel hand-out order (item QjTTL) [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });

    const ago = (min: number) => Timestamp.fromMillis(Date.now() - min * 60_000);

    it('hands out oldest first by stepAt; a given-back item skips this agent', async () => {
      const { token } = await newAgent();
      // Document ids in the opposite order of age, so Firestore order would be wrong.
      await put({
        [I('a1')]: itemDoc({ stepId: 'build', title: 'Newest', stepAt: ago(5) }),
        [I('b1')]: itemDoc({ stepId: 'build', title: 'Middle', stepAt: ago(60) }),
        [I('c1')]: itemDoc({ stepId: 'build', title: 'Oldest', stepAt: ago(180) }),
      });
      const s = await session(token);
      const w1 = await s.next('work');
      expect(w1.meta.item_id).toBe('c1');
      // Given back: the next oldest comes, not the same item again.
      await s.call('release', { itemId: 'c1' });
      const w2 = await s.next('work', 2);
      expect(w2.meta.item_id).toBe('b1');
      expect((await read(I('c1'))).claim).toBeNull();
      await s.call('complete', { itemId: 'b1' });
      // b1 moves on to Test with a fresh stepAt (newer than a1); c1 is still skipped.
      const w3 = await s.next('work', 3);
      expect(w3.meta.item_id).toBe('a1');
      expect((await read(I('b1'))).stepAt).toBeTruthy();
      await s.call('complete', { itemId: 'a1' });
      const w4 = await s.next('work', 4);
      expect(w4.meta.item_id).toBe('b1');
      await pause(1000);
      expect(
        s.events.filter((e) => e.meta.kind === 'work' && e.meta.item_id === 'c1'),
      ).toHaveLength(1);
    });

    it('items without stepAt count as older than any that moved (max_items 3)', async () => {
      const { token } = await newAgent();
      await put({
        [I('a2')]: itemDoc({ stepId: 'build', title: 'New', stepAt: ago(1) }),
        [I('b2')]: itemDoc({ stepId: 'build', title: 'Legacy' }),
        [I('c2')]: itemDoc({ stepId: 'test', title: 'Old', stepAt: ago(30) }),
      });
      const s = await session(token, 3);
      await s.next('work', 3);
      const order = s.events.filter((e) => e.meta.kind === 'work').map((e) => e.meta.item_id);
      expect(order).toEqual(['b2', 'c2', 'a2']);
    });
  });

for (const impl of IMPLS)
  describe(`hivenod mcp --channel parking (item QjTTL) [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });

    const works = (s: Awaited<ReturnType<typeof session>>) =>
      s.events.filter((e) => e.meta.kind === 'work');
    const ago = (min: number) => Timestamp.fromMillis(Date.now() - min * 60_000);

    it('max_items 2: a parked item frees its slot; any tool call wakes it', async () => {
      const { uid, token } = await newAgent();
      await put({
        [I('a')]: itemDoc({ stepId: 'build', title: 'A', stepAt: ago(30) }),
        [I('b')]: itemDoc({ stepId: 'build', title: 'B', stepAt: ago(20) }),
        [I('c')]: itemDoc({ stepId: 'build', title: 'C', stepAt: ago(10) }),
      });
      const s = await session(token, 2);
      await s.next('work', 2);
      await pause(1000);
      expect(works(s).map((e) => e.meta.item_id)).toEqual(['a', 'b']);
      const parked = await s.call('park', { itemId: 'a', reason: 'release batch' });
      expect(parked).toMatchObject({ itemId: 'a', parked: { reason: 'release batch' } });
      expect(parked.note).toMatch(/no longer counts toward max_items/);
      const runA = works(s)[0]!.meta.run_id;
      expect(await read(I('a'))).toMatchObject({
        claim: { agentUid: uid, runId: runA },
        parked: { runId: runA, reason: 'release batch' },
      });
      // The slot is free: the third item arrives; a stays claimed by this agent.
      const w3 = await s.next('work', 3);
      expect(w3.meta).toMatchObject({ item_id: 'c', holding: '2', parked: '1' });
      expect((await heldBy(uid)).sort()).toEqual(['a', 'b', 'c']);
      // Any tool call on it wakes it: 2 active + it, nothing more is handed over.
      await s.call('log', { itemId: 'a', text: 'back on it' });
      expect((await read(I('a'))).parked).toBeNull();
      await put({ [I('d')]: itemDoc({ stepId: 'build', title: 'D' }) });
      await pause(1500);
      expect(works(s)).toHaveLength(3);
      // Only the holder may park; an item this session does not hold is refused.
      await expect(s.call('park', { itemId: 'd', reason: 'x' })).rejects.toThrow(
        /does not hold item d/,
      );
    });

    it('a note wakes a parked item and still reaches the session; Stop reaches it too', async () => {
      const { token } = await newAgent();
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'Docs' }) });
      const s = await session(token, 2);
      const w = await s.next('work');
      await s.call('park', { itemId: 'a', reason: 'review' });
      const alice = as('alice');
      await alice.run(
        postMessage(alice.ctx, { projectId: 'p1', itemId: 'a', kind: 'note', text: 'Go ahead' }),
      );
      const note = await s.next('note');
      expect(note.content).toContain('Go ahead');
      expect((await read(I('a'))).parked).toBeNull();
      await s.call('park', { itemId: 'a', reason: 'review again' });
      const o = as('owner');
      await o.run(
        stopWork(o.ctx, {
          project: PROJECT,
          projectId: 'p1',
          itemId: 'a',
          item: (await read(I('a'))) as unknown as ItemState,
          mode: 'back',
          reason: 'Not now',
          run: { costEur: 0, endedAt: null },
        }),
      );
      const stop = await s.next('stop');
      expect(stop.meta).toMatchObject({ item_id: 'a', run_id: w.meta.run_id });
    });

    it('a parked item resumed after a restart returns to the queue 24 h after parking', async () => {
      const { uid, token } = await newAgent();
      // The agent's earlier session parked it 25 hours ago (server time) and went away.
      const runId = 'run-parked';
      await put({
        [paths.run(W, runId)]: {
          agentUid: uid,
          projectId: 'p1',
          itemId: 'a',
          stepId: 'build',
          startedAt: ago(26 * 60),
          heartbeatAt: ago(1),
          heartbeatEventAt: ago(1),
          endedAt: null,
          status: 'running',
          costEur: 0,
          tokensIn: 0,
          tokensOut: 0,
          model: null,
          summary: null,
          lastEventId: 'seed',
        },
        [I('a')]: itemDoc({
          stepId: 'build',
          title: 'Waiting on release',
          status: 'working',
          claim: { runId, agentUid: uid, heartbeatAt: ago(1) },
          parked: { runId, reason: 'release batch', at: ago(25 * 60) },
        }),
      });
      const s = await session(token, 2);
      const w = await s.next('work');
      expect(w.meta).toMatchObject({ item_id: 'a', resumed: 'true' });
      const back = await s.next('info', 1, 8000);
      expect(back.meta).toMatchObject({ code: 'returned', item_id: 'a' });
      const item = await read(I('a'));
      expect(item).toMatchObject({ claim: null, status: 'queued' });
      let notes: string[] = [];
      await getEnv().withSecurityRulesDisabled(async (c) => {
        const snap = await c
          .firestore()
          .collection(`workspaces/${W}/projects/p1/items/a/messages`)
          .get();
        notes = snap.docs.map((d) => d.data().text as string);
      });
      expect(notes.join('\n')).toMatch(
        /Parked for 24 hours without activity \(waiting: release batch\)/,
      );
      // Given back: not handed straight back to this session.
      await pause(1500);
      expect(works(s)).toHaveLength(1);
    });
  });

// ---------- Inbox events (item 4PEHrOW5IfXBQWgOK9wo, part 2) ----------

for (const impl of IMPLS)
  describe(`hivenod mcp --channel inbox events (item 4PEHr) [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });
    const msg = (over: Record<string, unknown> = {}) => ({
      source: 'teams',
      sender: { name: 'Sam Example', handle: 'sam@example.com' },
      text: 'Can we move the review to Thursday?',
      threadRef: 'thread-1',
      receivedAt: '2026-10-28T09:00:00Z',
      ...over,
    });
    const inbox = (s: Awaited<ReturnType<typeof session>>) =>
      s.events.filter((e) => e.meta.kind === 'inbox');
    const thread = async (tid: string) =>
      (await read(inboxPaths.thread(W, tid))) as unknown as ThreadStateOf;
    const owner = () => as('owner');

    it('arrive while max_items is full, are never claimed, and items still flow', async () => {
      const { token } = await newAgent();
      const s = await session(token);
      await put({ [I('a')]: itemDoc({ stepId: 'build', title: 'First', order: 1 }) });
      const w1 = await s.next('work');
      // The one item slot is taken; a message comes in all the same.
      const added = await s.call('inbox_add', msg());
      const tid = added.threadId as string;
      const e1 = await s.next('inbox');
      expect(e1.meta).toMatchObject({
        kind: 'inbox',
        thread_id: tid,
        reason: 'new',
        member: 'owner',
        inbox_cap: '3',
        inbox_active: '1',
      });
      expect(e1.content).toMatch(/background sub-agent/);
      expect(e1.content).toContain(`thread_read (threadId ${tid})`);
      // Items are handed out as before.
      await put({ [I('b')]: itemDoc({ stepId: 'build', title: 'Second', order: 2 }) });
      await s.call('complete', { itemId: w1.meta.item_id, runId: w1.meta.run_id });
      await s.next('work', 2);
      // A second message on the thread, while it is in flight: passed on, not a new sub-agent.
      await s.call('inbox_add', msg({ messageId: 'm-2', text: 'Or Friday?' }));
      const e2 = await s.next('inbox', 2);
      expect(e2.meta).toMatchObject({ thread_id: tid, reason: 'message', update: 'true' });
      // Notes and filing are nothing new.
      await s.call('inbox_note', { threadId: tid, text: 'Checked the calendar.' });
      await s.call('subject_assign', { threadId: tid, name: 'Review date' });
      // The question waits for the person; the answer comes back as an event.
      await s.call('inbox_ask', { threadId: tid, question: 'Thursday or Friday?' });
      const o = owner();
      await o.run(
        answerQuestion(o.ctx, { threadId: tid, thread: await thread(tid), answer: 'Thursday' }),
      );
      const e3 = await s.next('inbox', 3);
      expect(e3.meta).toMatchObject({ thread_id: tid, reason: 'answered' });
      expect(e3.content).toContain('Their answer: Thursday');
      await pause(1200);
      expect(inbox(s)).toHaveLength(3);
    });

    it('an approved outcome is sent to the agent that brought the thread in, once', async () => {
      const { token } = await newAgent();
      const s = await session(token, 2);
      const tid = (await s.call('inbox_add', msg())).threadId as string;
      await s.next('inbox');
      const oid = (
        await s.call('outcome_propose', {
          threadId: tid,
          type: 'reply',
          fields: { text: 'Thursday works.' },
        })
      ).outcomeId as string;
      await pause(800);
      expect(inbox(s)).toHaveLength(1); // proposing is not agent work
      const o = owner();
      await o.run(
        approveOutcome(o.ctx, {
          outcomeId: oid,
          outcome: (await read(inboxPaths.outcome(W, oid))) as unknown as OutcomeStateOf,
          thread: await thread(tid),
        }),
      );
      const e = await s.next('inbox', 2);
      expect(e.meta).toMatchObject({
        thread_id: tid,
        reason: 'carry_out',
        outcome_id: oid,
        outcome_type: 'reply',
      });
      expect(e.content).toMatch(/outcome_done/);
      await s.call('outcome_done', {
        outcomeId: oid,
        status: 'done',
        result: { permalink: 'https://teams.example.com/m/9' },
      });
      await pause(1200);
      expect(inbox(s)).toHaveLength(2);
    });

    it('at most maxInbox threads at a time; a reconnect or restart sends no duplicates', async () => {
      const { token } = await newAgent();
      const s = await session(token, 1, 2);
      for (const ref of ['r1', 'r2', 'r3'])
        await s.call('inbox_add', msg({ threadRef: ref, text: `Ask ${ref}` }));
      await s.next('inbox', 2);
      await pause(1200);
      expect(inbox(s)).toHaveLength(2);
      expect(inbox(s)[1]!.meta).toMatchObject({ inbox_cap: '2', inbox_active: '2' });
      // One moves on (proposed): the third goes out.
      const first = inbox(s)[0]!.meta.thread_id!;
      await s.call('outcome_propose', { threadId: first, type: 'no_reply', fields: {} });
      await s.next('inbox', 3);
      const sent = inbox(s).map((e) => e.meta.thread_id);
      expect(new Set(sent).size).toBe(3);
      // The listeners reconnect (TypeScript: a test hook; the Go listeners restart the same way).
      s.srv?.channel()?.inbox?.subscribe();
      await pause(1500);
      expect(inbox(s)).toHaveLength(3);
      // A new session resends the two still being investigated, once each.
      await s.close();
      const s2 = await session(token, 1, 2);
      await s2.next('inbox', 2);
      await pause(1500);
      const again = inbox(s2);
      expect(again).toHaveLength(2);
      expect(again.map((e) => e.meta.reason)).toEqual(['new', 'new']);
      expect(new Set(again.map((e) => e.meta.thread_id))).toEqual(
        new Set(sent.filter((t) => t !== first)),
      );
    });

    it('max_inbox 0 turns inbox events off', async () => {
      const { token } = await newAgent();
      const s = await session(token, 1, 0);
      await s.call('inbox_add', msg());
      await pause(1500);
      expect(inbox(s)).toHaveLength(0);
    });
  });

for (const impl of IMPLS)
  describe(`hivenod mcp --channel status checks (item AzveC) [${impl}]`, () => {
    beforeAll(() => {
      IMPL = impl;
    });
    const statuses = (s: Awaited<ReturnType<typeof session>>) =>
      s.events.filter((e) => e.meta.kind === 'status');

    it('asks at the interval (a short minute), stores the answer, and not while parked', async () => {
      const { uid, token } = await newAgent();
      // statusEvery 15 "minutes" of 100 ms: a status event about 1.5 s after the handover.
      await put({
        [P('p1')]: projectDoc({}, { steps: LIB, stepIndex: buildStepIndex(LIB), statusEvery: 15 }),
        [I('a')]: itemDoc({ stepId: 'build', title: 'Release checks' }),
      });
      const s = await session(token, 2, undefined, 100);
      const w = await s.next('work');
      const first = await s.next('status', 1, 6000);
      expect(first.meta).toMatchObject({ item_id: 'a', run_id: w.meta.run_id, why: 'interval' });
      expect(first.content).toContain('Status check on "Release checks" (item_id a)');
      const out = await s.call('status', {
        itemId: 'a',
        text: 'Running e2e batch 2 of 3',
        pct: 70,
      });
      expect(out).toEqual({ itemId: 'a', status: { text: 'Running e2e batch 2 of 3', pct: 70 } });
      expect((await read(I('a'))).statusUpdate).toMatchObject({
        runId: w.meta.run_id,
        text: 'Running e2e batch 2 of 3',
        pct: 70,
        by: uid,
      });
      // Too soon after the last one: refused, the stored status stays.
      await expect(s.call('status', { itemId: 'a', text: 'again' })).rejects.toThrow(
        /less than 30 seconds ago/,
      );
      // Parked: no status events.
      await s.call('park', { itemId: 'a', reason: 'release batch' });
      const n = statuses(s).length;
      await pause(2500);
      expect(statuses(s).length).toBe(n);
    });

    it('off by default (no statusEvery): none; a person asking sends one at once', async () => {
      const { token } = await newAgent();
      await put({
        [P('p1')]: projectDoc({}, { steps: LIB, stepIndex: buildStepIndex(LIB) }),
        [I('a')]: itemDoc({ stepId: 'build', title: 'Docs' }),
      });
      const s = await session(token, 1, undefined, 100);
      await s.next('work');
      await pause(2000);
      expect(statuses(s)).toHaveLength(0);
      const alice = as('alice');
      await alice.run(
        askForStatus(alice.ctx, {
          projectId: 'p1',
          itemId: 'a',
          item: (await read(I('a'))) as unknown as ItemState,
          nowMs: Date.now(),
        }),
      );
      const asked = await s.next('status');
      expect(asked.meta).toMatchObject({ item_id: 'a', why: 'asked' });
      expect(asked.content).toMatch(
        /^Alice asked for a status on "Docs" \(item_id a\)\. Please answer/,
      );
      await s.call('status', { text: 'Writing the docs' });
      expect((await read(I('a'))).statusUpdate).toMatchObject({
        text: 'Writing the docs',
        pct: null,
      });
      await pause(1000);
      expect(statuses(s)).toHaveLength(1);
    });
  });
