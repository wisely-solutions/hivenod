/** SPEC §9 Activity: an admin releases a stalled claim (no heartbeat for 10 minutes). */
import { describe, it, expect } from 'vitest';
import { releaseStale } from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, I, itemDoc, minutesAgo, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

async function stalled(minutes: number) {
  const at = minutesAgo(minutes);
  await put({
    [I('work')]: itemDoc({
      status: 'working',
      claim: { runId: 'r1', agentUid: 'agentA', heartbeatAt: at },
    }),
    [paths.run(W, 'r1')]: {
      agentUid: 'agentA',
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
}
const plan = (uid: string) =>
  releaseStale(as(uid).ctx, {
    projectId: 'p1',
    itemId: 'work',
    runId: 'r1',
    agentUid: 'agentA',
  });

describe('release a stalled claim', () => {
  it('lets an admin release a claim silent for 11 minutes', async () => {
    await stalled(11);
    await ok(as('owner').run(plan('owner')));
    const item = await snap(I('work'));
    expect(item.claim).toBeNull();
    expect(item.status).toBe('queued');
    expect((await snap(paths.run(W, 'r1'))).status).toBe('released');
  });
  it('ATTACK: refuses a claim that is still fresh', async () => {
    await stalled(3);
    await denied(as('owner').run(plan('owner')));
  });
  it('ATTACK: refuses a plain member, even on their own project', async () => {
    await stalled(30);
    await denied(as('alice').run(plan('alice')));
  });
  it('ATTACK: refuses the item without the run (or the event)', async () => {
    await stalled(30);
    const p = plan('owner');
    await denied(as('owner').run(p.ops.filter((o) => !o.path.includes('/runs/'))));
    await denied(as('owner').run(p.ops.filter((o) => !o.path.includes('/events/'))));
  });
  it('ATTACK: refuses ending the run without the item being released', async () => {
    await stalled(30);
    const p = plan('owner');
    await denied(as('owner').run(p.ops.filter((o) => !o.path.includes('/items/'))));
  });
});
