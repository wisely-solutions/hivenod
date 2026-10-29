/**
 * Build 07 acceptance, through the Go CLI (`hivenod mcp`, black box; Go-only since item
 * MlWOc3O5NyfZcLgetrVo), against the real Auth and Firestore emulators and the real rules:
 * claim -> log -> attach HTML -> ask -> raise a finding -> end the run with cost -> complete ->
 * the item stops at the next human gate; every step left an event with the agent as actor.
 * Also: gates cannot be passed, send-back reasons reach the next agent, revoked agents are told.
 * (A hand-built approval written with an agent's session is refused by the rules:
 * packages/shared/rules/decisions.test.ts.)
 */
import {
  answer,
  pairingPath,
  paths,
  sendBack,
  stop,
  stopWork,
  type ItemState,
  type ProjectState,
} from '@hive/shared';
import { Timestamp } from 'firebase/firestore';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
  snap,
  useEmulator,
  W,
} from '../../../packages/shared/rules/harness';
import { docs, GoAgent, newAgent as makeAgent } from './agentcli';
import { GO, goBinary, goEnv } from './gobin';

useEmulator();

const d = GO ? describe : describe.skip;
beforeAll(() => {
  if (GO) goBinary();
}, 300_000);

const clients: GoAgent[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

const newAgent = (over: { revoked?: boolean; extra?: Record<string, unknown> } = {}) =>
  makeAgent(over);

async function connect(
  a: { uid: string; token: string },
  env: Record<string, string> = {},
  args?: string[],
) {
  const c = await GoAgent.start(a.uid, a.token, env, args);
  clients.push(c);
  return c;
}

const events = async () => Object.values(await docs(`workspaces/${W}/events`));

d('the Go CLI as an agent, against the emulators', () => {
  it('claim, log, attach, ask, finding, end run with cost, complete: stops at the gate, all tracked', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
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
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const r = await c.raiseFinding('i1', 'Footer link is broken', 'The /pricing link 404s');
    expect(r).toMatchObject({ status: 'suggested' });
    const finding = (await docs(`workspaces/${W}/projects/p1/items`))[r.findingItemId]!;
    expect(finding).toMatchObject({ status: 'suggested', sourceRunId: null, stepId: 'intake' });
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain(r.findingItemId);
    const waited = await c.waitForWork({ timeoutMs: 3000 });
    expect(waited.work.map((w) => w.itemId)).not.toContain(r.findingItemId);
    await expect(c.claim(r.findingItemId)).rejects.toThrow(/suggestion waiting for people/);
  });

  it('creates an item where the project allows it: work at the first step, by the agent (item DhsO9)', async () => {
    await put({ [P('p1')]: projectDoc({}, { agentsMayCreateItems: true }) });
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const dir = await mkdtemp(join(tmpdir(), 'hive-'));
    const file = join(dir, 'notes.md');
    await writeFile(file, '# Steps to reproduce');
    const r = await c.createItem('Blog', 'Checkout times out', 'Asked on Telegram.', [
      file,
      join(dir, 'missing.md'),
    ]);
    expect(r).toMatchObject({ projectId: 'p1', step: 'Intake', status: 'queued' });
    expect(r.attachments).toMatchObject([{ name: 'notes.md', kind: 'markdown' }]);
    expect(r.attachErrors?.[0]).toMatch(/missing\.md/);
    const it0 = (await docs(`workspaces/${W}/projects/p1/items`))[r.itemId]!;
    expect(it0).toMatchObject({
      title: 'Checkout times out',
      summary: 'Asked on Telegram.',
      stepId: 'intake',
      status: 'queued',
      createdBy: { type: 'agent', id: uid },
      source: { kind: 'agent', label: 'Research agent' },
      attachmentCount: 1,
    });
    const created = (await events()).find(
      (e) => e.type === 'item.created' && e.itemId === r.itemId,
    );
    expect(created).toMatchObject({ actor: { type: 'agent', id: uid } });
    // Ordinary work: listed and claimable at once.
    expect((await c.listWork()).map((w) => w.itemId)).toContain(r.itemId);
    await c.claim(r.itemId);
  });

  it('refuses a create where the setting is off or the project is not its own (item DhsO9)', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    await expect(c.createItem('p1', 'x')).rejects.toThrow(/does not let agents create items/);
    await put({ [P('p2')]: projectDoc({}, { agentsMayCreateItems: true }) });
    await expect(c.createItem('p2', 'x')).rejects.toThrow(/cannot use the project "p2"/);
  });

  it('list_work checks the project up front: foreign project, project name (item p6FzU)', async () => {
    await put({ [P('p2')]: projectDoc({}, {}) });
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const err = await c.call('list_work', { project: 'p2' }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(err).toMatch(/This agent cannot use the project "p2"\. Its projects: /);
    expect(err).not.toMatch(/change|permission denied|hivenod item/);
    // by id and by name (any case)
    expect(Array.isArray(await c.call('list_work', { project: 'p1' }))).toBe(true);
  });

  it('stops at the rate limit with a clear message (item DhsO9)', async () => {
    await put({ [P('p1')]: projectDoc({}, { agentsMayCreateItems: true }) });
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    // 28 creations in the last hour already (the limit file next to the token, shared by every
    // hivenod process on the machine): two more fit, the 31st is refused.
    const t = Date.now() - 60_000;
    writeFileSync(
      join(c.home, 'created-items.json'),
      JSON.stringify({ [uid]: Array.from({ length: 28 }, (_, i) => t + i) }),
    );
    await c.createItem('p1', 'One');
    await c.createItem('p1', 'Two');
    await expect(c.createItem('p1', 'Three')).rejects.toThrow(/Rate limit.*at most 30 per hour/);
  });

  it('completes an open run directly, ending it as done with the cost', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const { runId } = await c.claim('i1');
    await c.complete('i1', runId, { costEur: 0.1 });
    expect((await docs(`workspaces/${W}/runs`))[runId]).toMatchObject({
      status: 'done',
      costEur: 0.1,
    });
  });

  it('asking on an item it has not claimed says so, with the next step', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    await expect(c.ask('i1', 'Tone?')).rejects.toThrow(
      /not claimed this item.*Call claim with itemId i1/,
    );
  });

  it('cannot claim, complete or approve past a human gate, with a clear message', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const gateMsg = 'This item is at a human gate. Only people can move it.';
    await expect(c.claim('gated')).rejects.toThrow(gateMsg);
    await expect(c.complete('gated', 'whatever')).rejects.toThrow(gateMsg);

    // A hand-built approval with the agent's session: refused by the rules (decisions.test.ts).
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).gated!;
    expect(item).toMatchObject({ stepId: 'review', status: 'waiting' });
  });

  it('keeps the run alive with automatic heartbeats', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token }, { HIVENOD_HEARTBEAT_MS: '100' });
    const { runId } = await c.claim('i1');
    const before = (await docs(`workspaces/${W}/runs`))[runId]!.heartbeatAt as {
      toMillis(): number;
    };
    await new Promise((r) => setTimeout(r, 1200));
    const after = (await docs(`workspaces/${W}/runs`))[runId]!.heartbeatAt as {
      toMillis(): number;
    };
    expect(after.toMillis()).toBeGreaterThan(before.toMillis());
  });

  it('read_item returns send-back reasons, decisions, messages and attachments', async () => {
    const { uid, token } = await newAgent();
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
    const c = await connect({ uid, token });
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

  it('a human send back reaches the next agent through read_item, and a stop closes the item', async () => {
    const { uid, token } = await newAgent();
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

    const c = await connect({ uid, token });
    const json = await c.readItem('gated2');
    expect(json.sendBackCount).toBe(1);
    expect(json.step.id).toBe('draft');
    expect(json.sendBackReasons[0]).toMatchObject({
      reason: 'Wrong audience: write for developers',
      toStepId: 'draft',
      tags: ['Wrong audience'],
    });
    expect(
      json.messages.some(
        (m: { kind: string; text: string }) => m.kind === 'note' && m.text.includes('developers'),
      ),
    ).toBe(true);

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
    expect((await c.listWork()).map((w) => w.itemId)).not.toContain('gated3');
    await expect(c.claim('gated3')).rejects.toThrow();
  });

  it('wait_for_work returns at once when work exists, and is released within seconds of a gate decision', async () => {
    const a = await connect(await newAgent());
    const b = await connect(await newAgent());
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
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const dir = await mkdtemp(join(tmpdir(), 'hive-'));
    const big = join(dir, 'big.html');
    await writeFile(big, 'x'.repeat(900 * 1024 + 1));
    await expect(c.attach('i1', big)).rejects.toThrow(/over the 900 KB limit.*attach its URL/s);
  });

  it('tells a revoked agent plainly', async () => {
    const c = await connect(await newAgent({ revoked: true }));
    await expect(c.listWork()).rejects.toThrow(/revoked/);
    expect(() => c.whoami()).toThrow(/revoked/);
  });
});

d('agent settings and guardrails (card zSzW3LXy)', () => {
  it('a step limited to another agent is neither listed nor claimable; the listed agent gets it', async () => {
    const x = await newAgent();
    const y = await newAgent();
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: [x.uid] } }) });
    const cy = await connect(y);
    expect((await cy.listWork()).map((w) => w.itemId)).not.toContain('i1');
    await expect(cy.claim('i1')).rejects.toThrow(/limited to other agents/);
    const cx = await connect(x);
    expect((await cx.listWork()).map((w) => w.itemId)).toContain('i1');
    await cx.claim('i1');
  });

  it('pauses itself after 3 failed runs in a row; paused, it takes no work until resumed', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
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
    const c = await connect({ uid, token });
    const { runId } = await c.claim('i1');
    await c.complete('i1', runId);
    expect((await docs(`workspaces/${W}/agents`))[uid]).toMatchObject({ failStreak: 0 });
  });

  it('usage is tracked, never limited; a question holds the item; answered, it is work again', async () => {
    // An old agent doc that still stores a token limit: ignored (card rifzGl8M).
    const { uid, token } = await newAgent({
      extra: { guardrails: { maxFailedRuns: 3, maxTokensPerItem: 10_000 } },
    });
    const c = await connect({ uid, token });
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

    // A question from the agent holds the item until people answer (unchanged). In the Go CLI
    // the channel session holds it: the same agent, now as a channel session, gets i1 handed
    // over and asks.
    await c.release('i1');
    await c.close();
    const ch = await connect({ uid, token }, {}, ['mcp', '--channel']);
    await expect
      .poll(async () => (await docs(`workspaces/${W}/projects/p1/items`)).i1?.claim, {
        timeout: 15_000,
      })
      .toMatchObject({ agentUid: uid });
    await ch.ask('i1', 'Go on, or stop here?');
    await ch.close();
    const again = await connect({ uid, token });
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
    expect((await again.listWork()).map((w) => w.itemId)).not.toContain('i1');
    await expect(again.claim('i1')).rejects.toThrow(/answer/);
    const other = await connect(await newAgent());
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
    expect((await again.listWork()).map((w) => w.itemId)).toContain('i1');
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
    const ca = await connect(a);
    const cb = await connect(b);
    expect((await ca.listWork()).map((w) => w.itemId)).not.toContain('i1');
    expect((await cb.listWork()).map((w) => w.itemId)).not.toContain('i1');
    // Not even the agent whose (stale) claim it is gets it back as "resumed".
    await expect(ca.claim('i1')).rejects.toThrow(/answer/);
    await expect(cb.claim('i1')).rejects.toThrow(/answer/);
  });

  it('a failed run releases the item; run end done keeps the claim and a new claim starts a new run', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
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
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const { runId } = await c.claim('i1');
    await c.ask('i1', 'Which audience?');
    await c.endRun(runId, 'failed');
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
    expect((await c.waitForWork({ timeoutMs: 3000 })).work.map((w) => w.itemId)).toContain('i1');
  });

  it('an old question from a run that finished does not hold the item back', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    const { runId } = await c.claim('i1');
    await c.ask('i1', 'Which audience?');
    await c.endRun(runId, 'done');
    await put({ [I('i1')]: itemDoc() });
    expect((await c.listWork()).map((w) => w.itemId)).toContain('i1');
  });

  it('whoami shows the settings with defaults for an agent that never had them', async () => {
    const { uid, token } = await newAgent();
    const c = await connect({ uid, token });
    expect(c.whoami()).toMatchObject({
      paused: false,
      guardrails: { maxFailedRuns: 3 },
    });
    expect(c.whoami()).not.toHaveProperty('permissions');
  });
});

void P;

// From the old `hivenod run` suite (TypeScript only; the Go CLI has no `run`): the parts that are
// about claims, stopping and pairing, which the Go CLI does too.
d('claims, Stop work and pairing (Go CLI)', () => {
  it('Stop work while the agent is away ends the claim on the server; its next call says so (BrK0r2FE)', async () => {
    const a = await newAgent();
    const c = await connect(a);
    const { runId } = await c.claim('i1');
    const owner = as('owner');
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).i1 as unknown as ItemState;
    await owner.run(
      stopWork(owner.ctx, {
        project: { steps: projectDoc().steps } as ProjectState,
        projectId: 'p1',
        itemId: 'i1',
        item,
        mode: 'cancel',
        run: { costEur: 0, endedAt: null },
      }),
    );
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      status: 'stopped',
      claim: null,
    });
    await expect(c.complete('i1', runId)).rejects.toThrow(/People stopped this work/);
  });

  it('taking over a stale claim ends the old agent run (it does not stay running)', async () => {
    const a = await newAgent();
    const b = await newAgent();
    const ca = await connect(a);
    const { runId: oldRun } = await ca.claim('i1');
    // A's process died: no heartbeat for 11 minutes.
    await ca.close();
    const stale = Timestamp.fromMillis(Date.now() - 11 * 60_000);
    const item = (await docs(`workspaces/${W}/projects/p1/items`)).i1!;
    const run = (await docs(`workspaces/${W}/runs`))[oldRun]!;
    await put({
      [I('i1')]: { ...item, claim: { runId: oldRun, agentUid: a.uid, heartbeatAt: stale } },
      [paths.run(W, oldRun)]: { ...run, heartbeatAt: stale, heartbeatEventAt: stale },
    });
    const cb = await connect(b);
    const { runId } = await cb.claim('i1');
    expect((await docs(`workspaces/${W}/runs`))[oldRun]).toMatchObject({ status: 'released' });
    await cb.complete('i1', runId);
    expect((await docs(`workspaces/${W}/projects/p1/items`)).i1).toMatchObject({
      stepId: 'review',
    });
  });

  it('cancelling hivenod pair (Ctrl+C) deletes its pending pairing doc (card PXOzcYeG)', async () => {
    const child = spawn(goBinary(), ['pair'], { env: goEnv() });
    let said = '';
    child.stdout.on('data', (b: Buffer) => (said += b.toString()));
    child.stderr.on('data', (b: Buffer) => (said += b.toString()));
    const gone = new Promise((r) => child.once('exit', r));
    try {
      await expect.poll(() => said, { timeout: 15_000 }).toMatch(/confirm the code/);
      const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
      expect(Object.keys(await snap(pairingPath(code))).length).toBeGreaterThan(0);
      child.kill('SIGINT');
      await gone;
      expect(await snap(pairingPath(code))).toEqual({});
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
