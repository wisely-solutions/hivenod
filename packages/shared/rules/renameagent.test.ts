/**
 * Item 8U5Rz: an admin renames an agent. Members and agents (itself included) cannot, and the
 * name changes only together with an agent.renamed event.
 */
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { renameAgent } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, ok, useEmulator, W } from './harness';

useEmulator();

const A = (uid: string) => paths.agent(W, uid);

describe('renaming an agent', () => {
  it('allows an admin, and the new name is stored', async () => {
    const o = as('owner');
    await ok(
      o.run(renameAgent(o.ctx, { agentUid: AGENTS.a, oldName: 'A', newName: 'IKEA agent' })),
    );
    const snap = await getDoc(doc(o.db, A(AGENTS.a)));
    expect(snap.data()?.name).toBe('IKEA agent');
  });
  it('ATTACK: denies a plain member', async () => {
    const m = as('alice');
    await denied(m.run(renameAgent(m.ctx, { agentUid: AGENTS.a, oldName: 'A', newName: 'X' })));
  });
  it('ATTACK: denies an agent renaming itself or another agent', async () => {
    const a = as(AGENTS.a);
    await denied(updateDoc(doc(a.db, A(AGENTS.a)), { name: 'Me now' }));
    await denied(updateDoc(doc(a.db, A(AGENTS.star)), { name: 'Hijacked' }));
  });
  it('ATTACK: denies a name change without the agent.renamed event', async () => {
    const o = as('owner');
    await denied(updateDoc(doc(o.db, A(AGENTS.a)), { name: 'Sneaky' }));
  });
  it('ATTACK: denies renaming a revoked agent', async () => {
    const o = as('owner');
    await denied(
      o.run(renameAgent(o.ctx, { agentUid: AGENTS.revoked, oldName: 'Old', newName: 'X' })),
    );
  });
});
