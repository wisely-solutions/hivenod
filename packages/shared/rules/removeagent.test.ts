/**
 * Item 81P4s: an admin removes a revoked agent for good. A live agent, a member or an agent
 * (itself included) cannot delete an agent doc, and the delete needs its tombstone event.
 */
import { deleteDoc, doc, getDoc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { removeAgent } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, ok, useEmulator, W } from './harness';

useEmulator();

const A = (uid: string) => paths.agent(W, uid);

describe('removing a revoked agent', () => {
  it('allows an admin to remove a revoked agent, and the doc is gone', async () => {
    const o = as('owner');
    await ok(o.run(removeAgent(o.ctx, { agentUid: AGENTS.revoked, name: 'Old agent' })));
    const snap = await getDoc(doc(o.db, A(AGENTS.revoked)));
    if (snap.exists()) throw new Error('the agent doc is still there');
  });
  it('ATTACK: denies removing a live agent, even for an admin', async () => {
    const o = as('owner');
    await denied(o.run(removeAgent(o.ctx, { agentUid: AGENTS.a, name: 'A' })));
    await denied(deleteDoc(doc(o.db, A(AGENTS.a))));
  });
  it('ATTACK: denies a revoked agent removed without its event', async () => {
    const o = as('owner');
    await denied(deleteDoc(doc(o.db, A(AGENTS.revoked))));
  });
  it('ATTACK: denies a plain member', async () => {
    const m = as('alice');
    await denied(m.run(removeAgent(m.ctx, { agentUid: AGENTS.revoked, name: 'Old agent' })));
    await denied(deleteDoc(doc(m.db, A(AGENTS.revoked))));
  });
  it('ATTACK: denies an agent deleting a revoked agent doc or its own', async () => {
    const a = as(AGENTS.a);
    await denied(deleteDoc(doc(a.db, A(AGENTS.revoked))));
    await denied(deleteDoc(doc(a.db, A(AGENTS.a))));
    const s = as(AGENTS.star);
    await denied(deleteDoc(doc(s.db, A(AGENTS.a))));
  });
});
