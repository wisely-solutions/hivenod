/**
 * Item fJnu6: the Personal organization is created exactly as the app creates one, so the rules
 * accept the same batch from the person; it lands in their switcher without switching them.
 */
import { describe, expect, it } from 'vitest';
import { personalOrgPlan } from '../src/personalOrg';
import { paths } from '../src/schema';
import { as, ok, snap, useEmulator, W } from './harness';

useEmulator();

const card = { name: 'Alice', email: 'alice@example.com', photoURL: null, color: '#000' };

describe('the Personal organization', () => {
  it('is a valid app write: workspace, member card, workspace.created event, switcher entry', async () => {
    const alice = as('alice', { workspaceId: 'wPersonalA' });
    const p = personalOrgPlan(alice.ctx, { profile: card });
    await ok(alice.run(p));
    expect(await snap(paths.workspace('wPersonalA'))).toMatchObject({
      name: 'Personal',
      ownerUid: 'alice',
      memberRoles: { alice: 'admin' },
      adminUids: ['alice'],
    });
    expect(await snap(paths.member('wPersonalA', 'alice'))).toMatchObject({ name: 'Alice' });
    expect(await snap(paths.event('wPersonalA', p.eventId))).toMatchObject({
      type: 'workspace.created',
      actor: { type: 'human', id: 'alice' },
      projectId: null,
    });
    const user = await snap(paths.user('alice'));
    expect(user.workspaceIds).toEqual([W, 'wPersonalA']);
    // Not switched: the organization on screen stays the same.
    expect(user.workspaceId).toBe(W);
  });
});
