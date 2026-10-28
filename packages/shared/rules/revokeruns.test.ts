/**
 * Card MkUwvyWs, tester findings 1 and 3: a run cut off by a revoke must not stay "running"
 * forever. Revoking (or rotating) ends the agent's open runs and gives their items back in the
 * same batch; an agent taking over a stale claim ends the old run. And an agent may say its
 * session stopped (presence).
 */
import { describe, expect, it } from 'vitest';
import {
  claimItem,
  revokeAgent,
  REVOKED_RUN_SUMMARY,
  rotateAgent,
  SERVER_TIME,
  type ItemState,
} from '../src/actions';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  eventOp,
  I,
  itemDoc,
  minutesAgo,
  ok,
  put,
  snap,
  useEmulator,
  W,
} from './harness';

useEmulator();

/** agentA holds item `work` with the open run r1, last heartbeat `minutes` ago. */
async function running(minutes: number, agentUid: string = AGENTS.a) {
  const at = minutesAgo(minutes);
  const item = itemDoc({
    status: 'working',
    claim: { runId: 'r1', agentUid, heartbeatAt: at },
  });
  await put({
    [I('work')]: item,
    [paths.run(W, 'r1')]: {
      agentUid,
      projectId: 'p1',
      itemId: 'work',
      stepId: 'draft',
      startedAt: minutesAgo(minutes + 5),
      heartbeatAt: at,
      heartbeatEventAt: at,
      endedAt: null,
      status: 'running',
      costEur: 0,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'seed',
    },
  });
  return item as unknown as ItemState;
}
const open = [{ runId: 'r1', projectId: 'p1', itemId: 'work', holdsItem: true }];

describe('revoke ends the open runs of the agent', () => {
  it('ends the run as failed and gives the item back, in the revoke batch', async () => {
    await running(0);
    const o = as('owner');
    await ok(o.run(revokeAgent(o.ctx, { agentUid: AGENTS.a, openRuns: open })));
    const run = await snap(paths.run(W, 'r1'));
    expect(run).toMatchObject({ status: 'failed', summary: REVOKED_RUN_SUMMARY });
    expect(run.endedAt).toBeTruthy();
    expect(await snap(I('work'))).toMatchObject({ claim: null, status: 'queued' });
  });

  it('rotating does the same for the old identity', async () => {
    await running(0);
    const o = as('owner');
    await ok(
      o.run(
        rotateAgent(o.ctx, {
          previousAgentUid: AGENTS.a,
          agentUid: 'agentNew',
          name: 'Agent',
          color: '#2F5FD0',
          projectIds: ['p1'],
          tokenHint: 'b1c2',
          openRuns: open,
        }),
      ),
    );
    expect(await snap(paths.run(W, 'r1'))).toMatchObject({ status: 'failed' });
  });

  it('an item already taken by someone else keeps its claim (only the run ends)', async () => {
    await running(0);
    const o = as('owner');
    await ok(
      o.run(
        revokeAgent(o.ctx, { agentUid: AGENTS.a, openRuns: [{ ...open[0]!, holdsItem: false }] }),
      ),
    );
    expect(await snap(paths.run(W, 'r1'))).toMatchObject({ status: 'failed' });
    expect((await snap(I('work'))).claim).toBeTruthy();
  });

  it('ATTACK: an admin cannot end the run of an agent that is not revoked', async () => {
    await running(0);
    const o = as('owner');
    const p = revokeAgent(o.ctx, { agentUid: AGENTS.a, openRuns: open });
    await denied(o.run(p.ops.filter((op) => op.path !== paths.agent(W, AGENTS.a))));
  });

  it('ATTACK: a plain member cannot do it, and an agent cannot end another agent’s run', async () => {
    await running(0);
    const alice = as('alice');
    await denied(alice.run(revokeAgent(alice.ctx, { agentUid: AGENTS.a, openRuns: open })));
    const star = as(AGENTS.star);
    await denied(
      star.run([
        eventOp(star, 'ev1', { type: 'item.claimed', itemId: 'work', runId: 'r1' }),
        {
          kind: 'update',
          path: paths.run(W, 'r1'),
          data: { status: 'failed', endedAt: SERVER_TIME, summary: 'x', lastEventId: 'ev1' },
        },
      ]),
    );
  });
});

describe('taking over a stale claim ends the old run', () => {
  it('the new claim releases the old open run in the same batch', async () => {
    const item = await running(11);
    const star = as(AGENTS.star);
    const p = claimItem(star.ctx, {
      projectId: 'p1',
      itemId: 'work',
      item,
      takeover: { runId: 'r1' },
    });
    await ok(star.run(p));
    const old = await snap(paths.run(W, 'r1'));
    expect(old.status).toBe('released');
    expect(old.endedAt).toBeTruthy();
    expect(String(old.summary)).toMatch(/Taken over/);
    expect(await snap(I('work'))).toMatchObject({
      claim: expect.objectContaining({ runId: p.runId, agentUid: AGENTS.star }),
    });
  });

  it('ATTACK: a fresh run cannot be ended by another agent, claim or not', async () => {
    const item = await running(3);
    const star = as(AGENTS.star);
    await denied(
      star.run(
        claimItem(star.ctx, { projectId: 'p1', itemId: 'work', item, takeover: { runId: 'r1' } }),
      ),
    );
  });

  it('ATTACK: a stale run cannot be ended without taking the claim', async () => {
    await running(30);
    const star = as(AGENTS.star);
    await denied(
      star.run([
        eventOp(star, 'ev2', { type: 'item.claimed', itemId: 'work', runId: 'r1' }),
        {
          kind: 'update',
          path: paths.run(W, 'r1'),
          data: { status: 'released', endedAt: SERVER_TIME, summary: 'x', lastEventId: 'ev2' },
        },
      ]),
    );
  });
});

describe('presence', () => {
  it('an agent may stamp that its session stopped, and nothing else with it', async () => {
    const a = as(AGENTS.a);
    await ok(
      a.run([
        { kind: 'update', path: paths.agent(W, AGENTS.a), data: { signedOutAt: SERVER_TIME } },
      ]),
    );
    expect((await snap(paths.agent(W, AGENTS.a))).signedOutAt).toBeTruthy();
    await ok(
      a.run([
        { kind: 'update', path: paths.agent(W, AGENTS.a), data: { lastSeenAt: SERVER_TIME } },
      ]),
    );
    await denied(
      a.run([
        {
          kind: 'update',
          path: paths.agent(W, AGENTS.a),
          data: { signedOutAt: SERVER_TIME, projectIds: '*' },
        },
      ]),
    );
    await denied(
      a.run([
        { kind: 'update', path: paths.agent(W, AGENTS.star), data: { signedOutAt: SERVER_TIME } },
      ]),
    );
    const r = as(AGENTS.revoked);
    await denied(
      r.run([
        {
          kind: 'update',
          path: paths.agent(W, AGENTS.revoked),
          data: { signedOutAt: SERVER_TIME },
        },
      ]),
    );
  });
});
