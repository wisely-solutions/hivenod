/**
 * Build 07 acceptance, against the real Auth and Firestore emulators and the real rules:
 * claim -> log -> attach HTML -> ask -> raise a finding -> end the run with cost -> complete ->
 * the item stops at the next human gate; every step left an event with the agent as actor.
 * Also: gates cannot be passed, send-back reasons reach the next agent, revoked agents are told.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { answer, approve, paths, sendBack, stop, type ItemState } from '@hive/shared';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  as,
  getEnv,
  I,
  itemDoc,
  minutesAgo,
  now,
  P,
  projectDoc,
  put,
  useEmulator,
  W,
} from '../../shared/rules/harness';
import { HiveClient } from '../src/client';
import { main } from '../src/cli';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

const clients: HiveClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function newAgent(over: { revoked?: boolean; extra?: Record<string, unknown> } = {}) {
  const { uid, token } = await createAgentIdentity(options, W, {
    authEmulatorUrl: `http://${AUTH_HOST}`,
  });
  await put({
    [paths.agent(W, uid)]: {
      name: 'Research agent',
      color: '#2F5FD0',
      projectIds: ['p1'],
      createdBy: 'owner',
      createdAt: now(),
      revokedAt: over.revoked ? now() : null,
      lastSeenAt: null,
      tokenHint: token.slice(-4),
      previousAgentUid: null,
      lastEventId: 'seed',
      ...over.extra,
    },
  });
  return { uid, token };
}

async function connect(token: string, heartbeatIntervalMs?: number) {
  const c = await HiveClient.connect({
    token,
    projectId: 'hive-rules-test',
    heartbeatIntervalMs,
    authEmulator: AUTH_HOST,
  });
  clients.push(c);
  return c;
}

async function docs(path: string) {
  const out: Record<string, Record<string, unknown>> = {};
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const snap = await c.firestore().collection(path).get();
    snap.forEach((d) => (out[d.id] = d.data()));
  });
  return out;
}
const events = async () => Object.values(await docs(`workspaces/${W}/events`));

describe('agent client against the emulators', () => {
  it('claim, log, attach, ask, finding, end run with cost, complete: stops at the gate, all tracked', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    expect(c.whoami()).toMatchObject({ agentUid: uid, name: 'Research agent', workspaceId: W });

    const work = await c.listWork();
    expect(work.map((w) => w.itemId)).toContain('i1');
    expect(work.map((w) => w.itemId)).not.toContain('gated');

    // 1. claim
    const { runId } = await c.claim('i1');
    expect(runId).toBeTruthy();
    // 2. log
    expect(await c.log(runId, 'Reading the brief')).toEqual({ runId, line: 0 });
    expect(await c.log(runId, 'Drafting', 'warn')).toEqual({ runId, line: 1 });
    // 3. attach HTML (a file) and a link
    const dir = await mkdtemp(join(tmpdir(), 'hive-'));
    const file = join(dir, 'report.html');
    await writeFile(file, '<h1>Bees</h1>');
    expect(await c.attach('i1', file)).toMatchObject({ name: 'report.html', kind: 'html' });
    expect(await c.attach('i1', 'https://example.com/big.pdf', { name: 'Big' })).toMatchObject({
      kind: 'link',
    });
    // 4. ask
    await c.ask('i1', 'Which audience?');
    // progress, 5. finding
    await c.progress('i1', 1, 3);
    const { findingItemId } = await c.raiseFinding(
      'i1',
      'Typo on the landing page',
      'Seen in the hero',
    );
    // 6. end the run with cost, 7. complete
    await c.endRun(runId, 'done', {
      costEur: 0.42,
      tokensIn: 1000,
      tokensOut: 200,
      summary: 'Drafted',
    });
    const done = await c.complete('i1', runId);
    expect(done).toMatchObject({
      movedTo: { stepId: 'review' },
      status: 'waiting',
      waitingForPeople: true,
    });

    const item = (await docs(`workspaces/${W}/projects/p1/items`)).i1!;
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting', claim: null, costEur: 0.42 });
    const run = (await docs(`workspaces/${W}/runs`))[runId]!;
    expect(run).toMatchObject({ status: 'done', costEur: 0.42, tokensIn: 1000, tokensOut: 200 });
    expect(Object.keys(await docs(`workspaces/${W}/runs/${runId}/log`))).toHaveLength(2);
    const finding = (await docs(`workspaces/${W}/projects/p1/items`))[findingItemId]!;
    expect(finding).toMatchObject({
      type: 'finding',
      parentItemId: 'i1',
      stepId: 'intake',
      status: 'suggested',
      sourceRunId: runId,
      claim: null,
    });

    // 8. an event per step, agent as actor
    const all = (await events()).filter((e) => e.actor && (e.actor as { id: string }).id === uid);
    const types = all.map((e) => e.type);
    for (const t of [
      'item.claimed',
      'attachment.added',
      'message.posted',
      'item.updated',
      'finding.raised',
      'run.ended',
      'item.completed',
    ])
      expect(types, t).toContain(t);
    expect(types.filter((t) => t === 'attachment.added')).toHaveLength(2);
    for (const e of all)
      expect(e.actor).toMatchObject({ type: 'agent', id: uid, name: 'Research agent' });
  });

  it('raises a suggestion without holding the item; it is never listed as work or claimable', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const r = await c.raiseFinding('i1', 'Footer link is broken', 'The /pricing link 404s');
    expect(r).toMatchObject({ status: 'suggested' });
    const finding = (await docs(`workspaces/${W}/projects/p1/items`))[r.findingItemId]!;
    expect(finding).toMatchObject({ status: 'suggested', sourceRunId: null, stepId: 'intake' });
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain(r.findingItemId);
    const waited = await c.waitForWork({ timeoutMs: 3000 });
    expect(waited.work.map((w) => w.itemId)).not.toContain(r.findingItemId);
    await expect(c.claim(r.findingItemId)).rejects.toThrow(/suggestion waiting for people/);
  });

  it('completes an open run directly, ending it as done with the cost', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    await c.complete('i1', runId, { costEur: 0.1 });
    expect((await docs(`workspaces/${W}/runs`))[runId]).toMatchObject({
      status: 'done',
      costEur: 0.1,
    });
  });

  it('asking on an item it has not claimed says so, with the next step', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    await expect(c.ask('i1', 'Tone?')).rejects.toThrow(
      /not claimed this item.*hivenod work claim i1/,
    );
  });

  it('cannot claim, complete or approve past a human gate, with a clear message', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    const gateMsg = 'This item is at a human gate. Only people can move it.';
    await expect(c.claim('gated')).rejects.toThrow(gateMsg);
    await expect(c.complete('gated', 'whatever')).rejects.toThrow(gateMsg);

    // Even a hand-built approval, written with the agent's own session, is refused by the rules.
    const l = { projectId: 'p1', itemId: 'gated' };
    const project = { steps: projectDoc().steps };
    const forged = approve(
      { workspaceId: W, actor: { type: 'human', id: uid, name: 'Research agent' } },
      {
        project,
        ...l,
        item: itemDoc({
          stepId: 'review',
          status: 'waiting',
          gate: { stepId: 'review', approvals: {}, rejections: {} },
        }) as never,
      },
    );
    await expect(c.write(forged, l)).rejects.toThrow(gateMsg);
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).gated!;
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting' });
  });

  it('keeps the run alive with automatic heartbeats', async () => {
    const { token } = await newAgent();
    const c = await connect(token, 100);
    const { runId } = await c.claim('i1');
    const before = (await docs(`workspaces/${W}/runs`))[runId]!.heartbeatAt as {
      toMillis(): number;
    };
    await new Promise((r) => setTimeout(r, 1200));
    const after = (await docs(`workspaces/${W}/runs`))[runId]!.heartbeatAt as {
      toMillis(): number;
    };
    expect(after.toMillis()).toBeGreaterThan(before.toMillis());
    expect(c.autoHeartbeatError).toBeNull();
    expect(await c.heartbeat(runId)).toMatchObject({ runId });
  });

  it('read_item returns send-back reasons, decisions, messages and attachments', async () => {
    const { token } = await newAgent();
    await put({
      [I('i1')]: itemDoc({ sendBackCount: 1, summary: 'Write about bees' }),
      [paths.decision(W, 'p1', 'd1')]: {
        workspaceId: W,
        projectId: 'p1',
        itemId: 'i1',
        itemTitle: 'Post about bees',
        stepId: 'review',
        outcome: 'sentBack',
        toStepId: 'draft',
        byUid: 'alice',
        rationale: 'Too long, cut it to 300 words',
        tags: ['length'],
        at: now(),
        lastEventId: 'd1',
      },
    });
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    await c.ask('i1', 'Tone?');
    const r = await c.readItem('i1');
    expect(r.sendBackReasons).toHaveLength(1);
    expect(r.sendBackReasons[0]).toMatchObject({
      reason: 'Too long, cut it to 300 words',
      toStepId: 'draft',
    });
    expect(r.decisions[0]).toMatchObject({ outcome: 'sentBack', byUid: 'alice' });
    expect(r.messages[0]).toMatchObject({ kind: 'question', text: 'Tone?' });
    expect(r.step).toMatchObject({ id: 'draft', kind: 'agent', instructions: 'Write' });
    expect(r.claim).toEqual({ runId, mine: true });
  });

  it('a human send back reaches the next agent through hivenod item read, and a stop closes the item', async () => {
    const { token } = await newAgent();
    await put({
      [I('gated2')]: itemDoc({
        stepId: 'review',
        status: 'waiting',
        gate: { stepId: 'review', approvals: {}, rejections: {} },
      }),
      [I('gated3')]: itemDoc({
        stepId: 'review',
        status: 'waiting',
        gate: { stepId: 'review', approvals: {}, rejections: {} },
      }),
    });
    const project = { steps: projectDoc().steps };
    const alice = as('alice');
    const read = async (id: string) => {
      const item = (await docs(`workspaces/${W}/projects/p1/items`))[id] as unknown as ItemState;
      return item;
    };
    const plan = sendBack(alice.ctx, {
      project,
      projectId: 'p1',
      itemId: 'gated2',
      item: await read('gated2'),
      toStepId: 'draft',
      rationale: 'Wrong audience: write for developers',
      tags: ['Wrong audience'],
    });
    await alice.run(plan);

    process.env.HIVENOD_TOKEN = token;
    process.env.HIVENOD_PROJECT_ID = 'hive-rules-test';
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= AUTH_HOST;
    process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    try {
      expect(await main(['item', 'read', 'gated2'])).toBe(0);
      const text = out.join('');
      expect(text).toContain('Wrong audience: write for developers');
      expect(text).toContain('[Wrong audience]');
      out.length = 0;
      expect(await main(['item', 'read', 'gated2', '--json'])).toBe(0);
      const json = JSON.parse(out.join('')) as {
        sendBackCount: number;
        step: { id: string };
        sendBackReasons: Array<{ reason: string; toStepId: string; tags: string[] }>;
        messages: Array<{ kind: string; text: string }>;
      };
      expect(json.sendBackCount).toBe(1);
      expect(json.step.id).toBe('draft');
      expect(json.sendBackReasons[0]).toMatchObject({
        reason: 'Wrong audience: write for developers',
        toStepId: 'draft',
        tags: ['Wrong audience'],
      });
      expect(json.messages.some((m) => m.kind === 'note' && m.text.includes('developers'))).toBe(
        true,
      );
    } finally {
      write.mockRestore();
      delete process.env.HIVENOD_TOKEN;
      delete process.env.HIVENOD_PROJECT_ID;
    }

    // A stopped item is closed: no agent can pick it up.
    await alice.run(
      stop(alice.ctx, {
        project,
        projectId: 'p1',
        itemId: 'gated3',
        item: await read('gated3'),
        rationale: 'Not worth doing any more',
      }),
    );
    const c = await connect(token);
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain('gated3');
    await expect(c.claim('gated3')).rejects.toThrow();
  });

  it('wait_for_work returns at once when work exists, and is released within seconds of a gate decision', async () => {
    const a = await connect((await newAgent()).token);
    const b = await connect((await newAgent()).token);
    const quick = await a.waitForWork({ timeoutMs: 5000 });
    expect(quick.timedOut).toBe(false);
    expect(quick.work.map((w) => w.itemId)).toContain('i1');

    // Another agent holds i1, so nothing is left for `a`; the only way out is a human decision.
    await b.claim('i1');
    await put({
      [I('gatedw')]: itemDoc({
        stepId: 'review',
        status: 'waiting',
        gate: { stepId: 'review', approvals: {}, rejections: {} },
      }),
    });
    const none = await a.waitForWork({ timeoutMs: 700 });
    expect(none).toEqual({ timedOut: true, work: [] });

    const alice = as('alice');
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).gatedw as unknown as ItemState;
    const waiting = a.waitForWork({ timeoutMs: 20000 });
    await new Promise((r) => setTimeout(r, 800));
    const t0 = Date.now();
    await alice.run(
      sendBack(alice.ctx, {
        project: { steps: projectDoc().steps },
        projectId: 'p1',
        itemId: 'gatedw',
        item,
        toStepId: 'draft',
        rationale: 'Redo it for developers',
        tags: [],
      }),
    );
    const got = await waiting;
    expect(got.timedOut).toBe(false);
    expect(got.work.map((w) => w.itemId)).toEqual(['gatedw']);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('rejects oversized files with a hint to attach a URL', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const dir = await mkdtemp(join(tmpdir(), 'hive-'));
    const big = join(dir, 'big.html');
    await writeFile(big, 'x'.repeat(900 * 1024 + 1));
    await expect(c.attach('i1', big)).rejects.toThrow(/over the 900 KB limit.*attach its URL/s);
  });

  it('tells a revoked agent plainly', async () => {
    const { token } = await newAgent({ revoked: true });
    await expect(connect(token)).rejects.toThrow(/revoked/);
  });

  it('the hive command works end to end with --json', async () => {
    const { token } = await newAgent();
    process.env.HIVENOD_TOKEN = token;
    process.env.HIVENOD_PROJECT_ID = 'hive-rules-test';
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= AUTH_HOST;
    process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    try {
      expect(await main(['whoami', '--json'])).toBe(0);
      expect(JSON.parse(out.join(''))).toMatchObject({ name: 'Research agent' });
      out.length = 0;
      expect(await main(['work', 'claim', 'i1', '--json'])).toBe(0);
      const { runId } = JSON.parse(out.join('')) as { runId: string };
      out.length = 0;
      expect(await main(['run', 'log', runId, 'hello', '--json'])).toBe(0);
      expect(await main(['item', 'complete', 'i1', '--run', runId, '--cost', '0.3'])).toBe(0);
    } finally {
      write.mockRestore();
      delete process.env.HIVENOD_TOKEN;
      delete process.env.HIVENOD_PROJECT_ID;
    }
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      stepId: 'review',
    });
  });
});

describe('agent settings and guardrails (card zSzW3LXy)', () => {
  it('a step limited to another agent is neither listed nor claimable; the listed agent gets it', async () => {
    const x = await newAgent();
    const y = await newAgent();
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: [x.uid] } }) });
    const cy = await connect(y.token);
    expect((await cy.listWork()).map((w) => w.itemId)).not.toContain('i1');
    await expect(cy.claim('i1')).rejects.toThrow(/limited to other agents/);
    const cx = await connect(x.token);
    expect((await cx.listWork()).map((w) => w.itemId)).toContain('i1');
    await cx.claim('i1');
  });

  it('pauses itself after 3 failed runs in a row; paused, it takes no work until resumed', async () => {
    const { uid, token } = await newAgent();
    const c = await connect(token);
    let last: Record<string, unknown> = {};
    for (let n = 1; n <= 3; n++) {
      await put({ [I('i1')]: itemDoc() });
      const { runId } = await c.claim('i1');
      last = await c.endRun(runId, 'failed', { summary: `attempt ${n}` });
    }
    expect(last).toMatchObject({ status: 'failed', agentPaused: true });
    const me = (await docs(`workspaces/${W}/agents`))[uid]!;
    expect(me).toMatchObject({ failStreak: 3, pausedReason: '3 failed runs in a row' });
    await expect(c.listWork()).rejects.toThrow(/paused/);
    await expect(c.waitForWork({ timeoutMs: 1000 })).rejects.toThrow(/paused/);
    // A failed run gives the item back; a paused agent claims nothing.
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      claim: null,
      status: 'queued',
    });
    await expect(c.claim('i1')).rejects.toThrow(/paused/);
    await put({ [I('i1')]: itemDoc() });
    await expect(c.claim('i1')).rejects.toThrow(/paused/);
    // An admin resumes it (rules tests cover who may); then it works again.
    await getEnv().withSecurityRulesDisabled((ctx) =>
      ctx
        .firestore()
        .doc(paths.agent(W, uid))
        .update({ pausedAt: null, pausedReason: null, failStreak: 0 }),
    );
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
  });

  it('a done run resets the streak', async () => {
    const { uid, token } = await newAgent({ extra: { failStreak: 2 } });
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    await c.complete('i1', runId);
    expect((await docs(`workspaces/${W}/agents`))[uid]).toMatchObject({ failStreak: 0 });
  });

  it('usage is tracked, never limited; a question holds the item; answered, it is work again', async () => {
    // An old agent doc that still stores a token limit: ignored (card rifzGl8M).
    const { uid, token } = await newAgent({
      extra: { guardrails: { maxFailedRuns: 3, maxTokensPerItem: 10_000 } },
    });
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    const first = await c.reportUsage(runId, {
      tokensIn: 50_000,
      tokensCached: 45_000,
      tokensOut: 1_000,
      model: 'claude-opus-5-5',
    });
    expect(first).toEqual({ runId, newTokens: 6_000 });
    expect((await docs(`workspaces/${W}/runs`))[runId]).toMatchObject({
      status: 'running',
      tokensIn: 50_000,
      tokensCached: 45_000,
      model: 'claude-opus-5-5',
    });
    await expect(c.reportUsage(runId, { tokensIn: 10, tokensOut: 1 })).rejects.toThrow(/only grow/);

    // Far over the old limit (and over 500k): the run goes on, nothing is stopped or asked.
    const over = await c.reportUsage(runId, {
      tokensIn: 900_000,
      tokensCached: 50_000,
      tokensOut: 2_000,
    });
    expect(over).toEqual({ runId, newTokens: 852_000 });
    expect((await docs(`workspaces/${W}/runs`))[runId]).toMatchObject({
      status: 'running',
      tokensIn: 900_000,
      tokensOut: 2_000,
    });
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      claim: { runId },
      status: 'working',
    });
    expect((await docs(`workspaces/${W}/agents`))[uid]).not.toHaveProperty(
      'pausedAt',
      expect.anything(),
    );

    // A question from the agent holds the item until people answer (unchanged).
    await c.ask('i1', 'Go on, or stop here?');
    const q0 = Object.entries(await docs(`workspaces/${W}/projects/p1/items/i1/messages`)).find(
      ([, m]) => m.kind === 'question',
    )!;
    await c.releaseRun(runId, { status: 'released', holdFor: q0[0] });
    const msgs = await docs(`workspaces/${W}/projects/p1/items/i1/messages`);
    const [qid, q] = Object.entries(msgs).find(([, m]) => m.kind === 'question')!;
    expect(q.text).toBe('Go on, or stop here?');
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).i1!;
    // The hold is on the item itself, naming the question (tester R72, finding A).
    expect(item).toMatchObject({
      claim: null,
      status: 'queued',
      awaitingAnswer: { questionId: qid, agentUid: uid },
    });
    // A question is not a failure.
    expect((await docs(`workspaces/${W}/agents`))[uid]).not.toMatchObject({ failStreak: 1 });

    // Waiting for the answer: not offered to agents, not even to others, and nobody can claim
    // it by id (client check here; the rules tests cover a client that skips it).
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain('i1');
    await expect(c.claim('i1')).rejects.toThrow(/answer/);
    const other = await connect((await newAgent()).token);
    expect((await other.listWork()).map((w) => w.itemId)).not.toContain('i1');
    await expect(other.claim('i1')).rejects.toThrow(/answer/);
    expect(await other.waitForWork({ timeoutMs: 1500 })).toMatchObject({ timedOut: true });

    // A waiting agent hears about it once people answer.
    const waiting = other.waitForWork({ timeoutMs: 20_000 });
    const alice = as('alice');
    await alice.run(
      answer(alice.ctx, {
        projectId: 'p1',
        itemId: 'i1',
        item: item as unknown as ItemState,
        questionId: qid,
        text: 'Go on, keep it short',
      }),
    );
    expect((await waiting).work.map((w) => w.itemId)).toContain('i1');
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      awaitingAnswer: null,
    });
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
    await other.claim('i1');
  });

  it('the hold outlives a stale claim: still nobody may claim until answered', async () => {
    const a = await newAgent();
    const b = await newAgent();
    await put({
      [I('i1')]: itemDoc({
        status: 'working',
        claim: { runId: 'old', agentUid: a.uid, heartbeatAt: minutesAgo(30) },
        awaitingAnswer: { questionId: 'q-old', agentUid: a.uid, at: minutesAgo(31) },
      }),
    });
    const ca = await connect(a.token);
    const cb = await connect(b.token);
    expect((await ca.listWork()).map((w) => w.itemId)).not.toContain('i1');
    expect((await cb.listWork()).map((w) => w.itemId)).not.toContain('i1');
    // Not even the agent whose (stale) claim it is gets it back as "resumed".
    await expect(ca.claim('i1')).rejects.toThrow(/answer/);
    await expect(cb.claim('i1')).rejects.toThrow(/answer/);
  });

  it('plain hivenod run end says when that run paused the agent', async () => {
    const { token } = await newAgent({ extra: { failStreak: 2 } });
    process.env.HIVENOD_TOKEN = token;
    process.env.HIVENOD_PROJECT_ID = 'hive-rules-test';
    process.env.FIREBASE_AUTH_EMULATOR_HOST ??= AUTH_HOST;
    process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8080';
    const out: string[] = [];
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((s) => (out.push(String(s)), true));
    try {
      expect(await main(['work', 'claim', 'i1', '--json'])).toBe(0);
      const { runId } = JSON.parse(out.join('')) as { runId: string };
      out.length = 0;
      expect(await main(['run', 'end', runId, '--status', 'failed'])).toBe(0);
    } finally {
      write.mockRestore();
      delete process.env.HIVENOD_TOKEN;
      delete process.env.HIVENOD_PROJECT_ID;
    }
    expect(out.join('')).toMatch(/Run ended as failed\.\n.*now paused after 3 failed runs/);
  });

  it('a failed run releases the item; run end done keeps the claim and a new claim starts a new run', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const items = async () => (await docs(`workspaces/${W}/projects/p1/items`)).i1;
    const first = await c.claim('i1');
    expect(await c.endRun(first.runId, 'failed')).toMatchObject({ released: true });
    expect(await items()).toMatchObject({ claim: null, status: 'queued' });
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');

    const second = await c.claim('i1');
    expect(second.runId).not.toBe(first.runId);
    await c.endRun(second.runId, 'done');
    expect(await items()).toMatchObject({ claim: { runId: second.runId } });
    const third = await c.claim('i1');
    expect(third).toMatchObject({ resumed: false });
    expect(third.runId).not.toBe(second.runId);
    expect(await items()).toMatchObject({ claim: { runId: third.runId }, status: 'working' });

    // release gives it back, also after the run already ended.
    await c.endRun(third.runId, 'done');
    expect(await c.release('i1')).toMatchObject({ released: true });
    expect(await items()).toMatchObject({ claim: null, status: 'queued' });
    await expect(c.release('i1')).rejects.toThrow(/do not hold/);
    const fourth = await c.claim('i1');
    expect(await c.release('i1')).toMatchObject({ runId: fourth.runId });
    expect((await docs(`workspaces/${W}/runs`))[fourth.runId]).toMatchObject({
      status: 'released',
    });
  });

  it('an item released after a hold shows in list and wait even if its last run failed', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    await c.ask('i1', 'Which audience?');
    await c.endRun(runId, 'failed');
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
    expect((await c.waitForWork({ timeoutMs: 3000 })).work.map((w) => w.itemId)).toContain('i1');
  });

  it('an old question from a run that finished does not hold the item back', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    const { runId } = await c.claim('i1');
    await c.ask('i1', 'Which audience?');
    await c.endRun(runId, 'done');
    await put({ [I('i1')]: itemDoc() });
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
  });

  it('whoami shows the settings with defaults for an agent that never had them', async () => {
    const { token } = await newAgent();
    const c = await connect(token);
    expect(c.whoami()).toMatchObject({
      paused: false,
      guardrails: { maxFailedRuns: 3 },
    });
    expect(c.whoami()).not.toHaveProperty('permissions');
  });
});

void P;
