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
  buildStepIndex,
  paths,
  postMessage,
  stopWork,
  type ItemState,
  type Step,
} from '@hive/shared';
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
async function session(token: string, maxItems?: number) {
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
      { channel: { retryMs: 500, presenceMs: 1000, ...(maxItems ? { maxItems } : {}) } },
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
