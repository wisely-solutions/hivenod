/**
 * Item lkkyB: many agents per step. Agents that ask for the same work at the same moment never both
 * get it (the rules judge each commit against the document as it is at that moment), several agents
 * listed for one step each take different items, and the usual limits hold per agent.
 */
import { describe, expect, it } from 'vitest';
import { claimItem, type ItemState } from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  I,
  itemDoc,
  minutesAgo,
  now,
  ok,
  P,
  projectDoc,
  put,
  snap,
  useEmulator,
  W,
} from './harness';

useEmulator();

const queued = itemDoc() as unknown as ItemState;
const claim = (uid: string, itemId = 'i1', item: ItemState = queued) => {
  const a = as(uid);
  return a.run(claimItem(a.ctx, { projectId: 'p1', itemId, item }));
};
const agentDoc = (over: Record<string, unknown> = {}) => ({
  name: 'Agent',
  color: '#2F5FD0',
  projectIds: ['p1'],
  createdBy: 'owner',
  createdAt: now(),
  revokedAt: null,
  lastSeenAt: null,
  tokenHint: 'a7f3',
  previousAgentUid: null,
  lastEventId: 'seed',
  ...over,
});
const extra = ['agentB', 'agentC', 'agentD'];
const seedAgents = () => put(Object.fromEntries(extra.map((u) => [paths.agent(W, u), agentDoc()])));

describe('claims by several agents (item lkkyB)', () => {
  it('two agents claiming the same item at the same moment: exactly one write is allowed', async () => {
    for (let round = 0; round < 5; round++) {
      await put({ [I('i1')]: itemDoc() });
      const results = await Promise.allSettled([claim(AGENTS.a), claim(AGENTS.star)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const held = (await snap(I('i1'))).claim as { agentUid: string };
      const winner = results[0]!.status === 'fulfilled' ? AGENTS.a : AGENTS.star;
      expect(held.agentUid).toBe(winner);
    }
  });
  it('four agents at once on one item: one winner; on three items each gets exactly one', async () => {
    await seedAgents();
    const all = [AGENTS.a, AGENTS.star, 'agentB', 'agentC'];
    const one = await Promise.allSettled(all.map((u) => claim(u)));
    expect(one.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const ids = ['m1', 'm2', 'm3'];
    await put(Object.fromEntries(ids.map((id) => [I(id), itemDoc()])));
    // each agent tries every item, in its own order
    const tries = all.flatMap((u, k) =>
      ids.map((_, j) => ids[(j + k) % ids.length]!).map((id) => claim(u, id)),
    );
    const res = await Promise.allSettled(tries);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(ids.length);
    for (const id of ids) expect((await snap(I(id))).claim).toBeTruthy();
  }, 60_000);
  it('several agents listed for one step may all claim different items', async () => {
    await seedAgents();
    await put({
      [P('p1')]: projectDoc({}, { stepAgents: { draft: [AGENTS.a, AGENTS.star, 'agentB'] } }),
      [I('x1')]: itemDoc(),
      [I('x2')]: itemDoc(),
      [I('x3')]: itemDoc(),
    });
    await ok(claim(AGENTS.a, 'x1'));
    await ok(claim(AGENTS.star, 'x2'));
    await ok(claim('agentB', 'x3'));
  });
  it('an agent not listed for the step is denied', async () => {
    await seedAgents();
    await put({ [P('p1')]: projectDoc({}, { stepAgents: { draft: [AGENTS.a, AGENTS.star] } }) });
    await denied(claim('agentB'));
  });
  it('a paused agent is denied while the others go on', async () => {
    await put({ [paths.agent(W, 'agentP')]: agentDoc({ pausedAt: now() }) });
    await denied(claim('agentP'));
    await ok(claim(AGENTS.a));
  });
  it('a freshly heartbeating claim is denied; a stale one (10 min) can be taken', async () => {
    const fresh = itemDoc({
      status: 'working',
      claim: { runId: 'r0', agentUid: AGENTS.a, heartbeatAt: minutesAgo(1) },
    });
    await put({ [I('i1')]: fresh });
    await denied(claim(AGENTS.star, 'i1', fresh as unknown as ItemState));
    const stale = itemDoc({
      status: 'working',
      claim: { runId: 'r0', agentUid: AGENTS.a, heartbeatAt: minutesAgo(11) },
    });
    await put({ [I('i1')]: stale });
    await ok(claim(AGENTS.star, 'i1', stale as unknown as ItemState));
  });
});
