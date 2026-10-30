import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  arrayUnion,
  createWorkspace,
  leaveOrganization,
  removeMember,
  setMemberRole,
  type ActionContext,
} from './actions';
import { toFirestoreValue } from './firestore';
import { userSchema, workspaceSchema } from './schema';

let n = 0;
const ctx: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'ana', name: 'Ana' },
  newId: () => `id${++n}`,
};
const data = (
  plan: { ops: Array<{ path: string; data?: Record<string, unknown> }> },
  path: string,
) => plan.ops.find((o) => o.path === path)!.data!;

describe('organizations', () => {
  it('creates an organization with the creator as its only admin', () => {
    const d = data(createWorkspace(ctx, { name: 'Acme' }), 'workspaces/w1');
    expect(d.memberRoles).toEqual({ ana: 'admin' });
    expect(d.adminUids).toEqual(['ana']);
  });

  it('keeps adminUids in step with a role change, and refuses to empty it', () => {
    const promote = setMemberRole(ctx, { uid: 'bob', role: 'admin', adminUids: ['ana'] });
    expect(data(promote, 'workspaces/w1').adminUids).toEqual(['ana', 'bob']);
    const demote = setMemberRole(ctx, { uid: 'ana', role: 'member', adminUids: ['ana', 'bob'] });
    expect(data(demote, 'workspaces/w1').adminUids).toEqual(['bob']);
    expect(() => setMemberRole(ctx, { uid: 'ana', role: 'member', adminUids: ['ana'] })).toThrow(
      /at least one admin/,
    );
    expect(() => removeMember(ctx, { uid: 'ana', adminUids: ['ana'] })).toThrow();
  });

  it('leaving removes the caller and their card, and never the last admin', () => {
    const bob = { ...ctx, actor: { ...ctx.actor, id: 'bob' } };
    const plan = leaveOrganization(bob, { adminUids: ['ana'] });
    expect(
      plan.ops.some((o) => o.kind === 'delete' && o.path === 'workspaces/w1/members/bob'),
    ).toBe(true);
    expect(() => leaveOrganization(ctx, { adminUids: ['ana'] })).toThrow();
  });

  it('removing a member also clears their card', () => {
    const plan = removeMember(ctx, { uid: 'bob', adminUids: ['ana'] });
    expect(
      plan.ops.some((o) => o.kind === 'delete' && o.path === 'workspaces/w1/members/bob'),
    ).toBe(true);
  });

  it('adds an invited admin to adminUids through arrayUnion, a member does not', () => {
    const asAdmin = acceptInvite(
      { ...ctx, actor: { ...ctx.actor, id: 'cy' } },
      { code: 'c', role: 'admin' },
    );
    expect(data(asAdmin, 'workspaces/w1').adminUids).toEqual(arrayUnion('cy'));
    const asMember = acceptInvite(
      { ...ctx, actor: { ...ctx.actor, id: 'cy' } },
      { code: 'c', role: 'member' },
    );
    expect(data(asMember, 'workspaces/w1')).not.toHaveProperty('adminUids');
  });

  it('turns the arrayUnion placeholder into a Firestore sentinel', () => {
    const v = toFirestoreValue({ adminUids: arrayUnion('cy') }) as { adminUids: object };
    expect(v.adminUids).not.toEqual(arrayUnion('cy'));
    expect(JSON.stringify(v.adminUids)).toContain('cy');
  });
});

describe('older documents still parse', () => {
  const ts = { seconds: 1, nanoseconds: 0, toMillis: () => 1000 };
  it('reads the old owner role as admin and fills the new lists', () => {
    const ws = workspaceSchema.parse({
      name: 'Hivenod',
      ownerUid: 'jo',
      memberRoles: { jo: 'owner', ana: 'member' },
      createdAt: ts,
      lastEventId: 'e',
    });
    expect(ws.memberRoles).toEqual({ jo: 'admin', ana: 'member' });
    expect(ws.adminUids).toEqual([]);
    const user = userSchema.parse({
      name: 'J',
      email: 'j@x.com',
      photoURL: null,
      color: 'c1',
      workspaceId: 'w1',
      theme: null,
    });
    expect(user.workspaceIds).toEqual([]);
  });
});
