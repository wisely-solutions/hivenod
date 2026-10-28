/**
 * Item QjTTL: parking. Only the agent holding an item parks or unparks it, under its current claim
 * (the park names that claim's run), at the server time, with a short reason. Nothing else changes.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, it } from 'vitest';
import {
  claimItem,
  parkItem,
  SERVER_TIME,
  unparkItem,
  type ActionPlan,
  type ItemState,
} from '../src/actions';
import { AGENTS, as, denied, itemDoc, now, ok, useEmulator } from './harness';

useEmulator();

async function claimed(uid: string = AGENTS.a) {
  const a = as(uid);
  const base = itemDoc() as unknown as ItemState;
  const p = claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: base, runId: `run-${uid}` });
  await a.run(p);
  const item = {
    ...base,
    status: 'working',
    claim: { runId: p.runId, agentUid: uid, heartbeatAt: now() },
  } as ItemState;
  return { a, item, runId: p.runId };
}

/** The plan with the item update's data changed by `f`. */
function withItem(p: ActionPlan, f: (d: Record<string, unknown>) => void): ActionPlan {
  return {
    ...p,
    ops: p.ops.map((o) => {
      if (o.kind !== 'update' || !o.path.includes('/items/')) return o;
      const data = { ...o.data };
      f(data);
      return { ...o, data };
    }),
  };
}

describe('parking (item QjTTL)', () => {
  it('the holder parks and unparks its item', async () => {
    const { a, item, runId } = await claimed();
    await ok(a.run(parkItem(a.ctx, { projectId: 'p1', itemId: 'i1', item, reason: 'release' })));
    const parked = { ...item, parked: { runId, reason: 'release', at: now() } };
    await ok(a.run(unparkItem(a.ctx, { projectId: 'p1', itemId: 'i1', item: parked })));
  });
  it('ATTACK: another agent may not park or unpark an item it does not hold', async () => {
    const { item } = await claimed(AGENTS.a);
    const s = as(AGENTS.star);
    const forged = { ...item, claim: { ...item.claim!, agentUid: AGENTS.star } };
    await denied(
      s.run(parkItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: forged, reason: 'mine now' })),
    );
    await denied(s.run(unparkItem(s.ctx, { projectId: 'p1', itemId: 'i1', item: forged })));
  });
  it('ATTACK: a park under another run, backdated, too long, or with more fields is refused', async () => {
    const { a, item } = await claimed();
    const p = parkItem(a.ctx, { projectId: 'p1', itemId: 'i1', item, reason: 'review' });
    const park = (f: (pk: Record<string, unknown>) => void) =>
      withItem(p, (d) => {
        const pk = { ...(d.parked as Record<string, unknown>) };
        f(pk);
        d.parked = pk;
      });
    await denied(a.run(park((pk) => (pk.runId = 'other-run'))));
    await denied(a.run(park((pk) => (pk.at = Timestamp.fromMillis(1)))));
    await denied(a.run(park((pk) => (pk.reason = 'x'.repeat(201)))));
    await denied(a.run(park((pk) => (pk.reason = ''))));
    await denied(a.run(park((pk) => (pk.by = 'someone'))));
    // Not in the same write as anything else (e.g. a claim change or progress).
    await denied(a.run(withItem(p, (d) => (d.progress = { done: 1, total: 2 }))));
    await denied(a.run(withItem(p, (d) => (d.claim = null))));
    await ok(a.run(p));
  });
  it('ATTACK: a person may not park an item', async () => {
    const { a, item, runId } = await claimed();
    const p = parkItem(a.ctx, { projectId: 'p1', itemId: 'i1', item, reason: 'review' });
    const alice = as('alice');
    await denied(
      alice.run({
        ...p,
        ops: p.ops.map((o) =>
          o.path.includes('/events/')
            ? { ...o, data: { ...o.data, actor: { type: 'human', id: 'alice', name: 'Alice' } } }
            : { ...o, data: { ...o.data, parked: { runId, reason: 'review', at: SERVER_TIME } } },
        ),
      }),
    );
  });
});
