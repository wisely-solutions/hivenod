/**
 * Item QjTTL: `stepAt`, when the item reached its step (agents get work oldest first by it). Moves
 * set it to the server time; nobody may set it to any other time (jumping the queue), and writes
 * from clients that leave it out still pass.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  approve,
  claimItem,
  completeStep,
  createItem,
  releaseClaim,
  type ItemState,
} from '../src/actions';
import type { WriteOp } from '../src/actions';
import {
  AGENTS,
  as,
  atGate,
  denied,
  I,
  itemDoc,
  now,
  ok,
  put,
  snap,
  steps,
  useEmulator,
} from './harness';

useEmulator();

const project = { steps: steps() };

async function claimed() {
  const a = as(AGENTS.a);
  const base = itemDoc() as unknown as ItemState;
  const p = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: base, runId: 'run-a' });
  await a.run(p);
  const item = {
    ...base,
    status: 'working',
    claim: { runId: p.runId, agentUid: AGENTS.a, heartbeatAt: now() },
  } as ItemState;
  return { a, item };
}

/** The plan with the item update's data changed by `f`. */
function withItem<P extends { ops: WriteOp[] }>(p: P, f: (d: Record<string, unknown>) => void): P {
  const ops = p.ops.map((o) => {
    if (o.kind !== 'update' || !o.path.includes('/items/')) return o;
    const data = { ...(o.data as Record<string, unknown>) };
    f(data);
    return { ...o, data };
  });
  return { ...p, ops } as P;
}

const ms = (v: unknown) => (v as Timestamp).toMillis();

describe('stepAt (item QjTTL)', () => {
  it('complete stamps stepAt with the server time', async () => {
    const { a, item } = await claimed();
    const t0 = Date.now();
    await ok(a.run(completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item })));
    const after = await snap(I('i1'));
    expect(after.stepId).toBe('review');
    expect(Math.abs(ms(after.stepAt) - t0)).toBeLessThan(60_000);
  });
  it('ATTACK: an agent may not backdate stepAt to jump the queue', async () => {
    const { a, item } = await claimed();
    const p = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    await denied(a.run(withItem(p, (d) => (d.stepAt = Timestamp.fromMillis(1)))));
  });
  it('ATTACK: stepAt does not change on a write that is not a move (release)', async () => {
    const { a, item } = await claimed();
    const p = releaseClaim(a.ctx, { projectId: 'p1', itemId: 'i1', item });
    await denied(
      a.run(withItem(p, (d) => (d.stepAt = { __hive: 'serverTime' } as unknown as Timestamp))),
    );
    await ok(a.run(p));
  });
  it('a move from a client without stepAt still passes (it keeps the old value)', async () => {
    const { a, item } = await claimed();
    const p = completeStep(a.ctx, { project, projectId: 'p1', itemId: 'i1', item });
    await ok(a.run(withItem(p, (d) => delete d.stepAt)));
    expect((await snap(I('i1'))).stepAt ?? null).toBeNull();
  });
  it('approving at a gate stamps stepAt; a new item gets one; ATTACK: not a backdated one', async () => {
    await put({ [I('gated')]: atGate() });
    const o = as('alice');
    const item = (await snap(I('gated'))) as unknown as ItemState;
    await ok(o.run(approve(o.ctx, { project, projectId: 'p1', itemId: 'gated', item })));
    expect((await snap(I('gated'))).stepAt).toBeTruthy();
    const alice = as('alice');
    const c = createItem(alice.ctx, { project, projectId: 'p1', title: 'New', type: 'idea' });
    const backdated = {
      ...c,
      ops: c.ops.map((op) =>
        op.kind === 'set' && op.path.includes('/items/')
          ? { ...op, data: { ...(op.data as object), stepAt: Timestamp.fromMillis(1) } }
          : op,
      ),
    };
    await denied(alice.run(backdated));
    await ok(alice.run(c));
  });
});
