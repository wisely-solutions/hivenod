/**
 * Organizations (card aZYPm9bf): roles, the last-admin guard, many orgs per person.
 */
import { collection, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  createInvite,
  createWorkspace,
  leaveOrganization,
  memberProfileOp,
  removeMember,
  renameWorkspace,
  setMemberRole,
} from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, eventOp, now, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

const inFuture = () => new Date(Date.now() + 86_400_000);
const roles = async () => (await snap(paths.workspace(W))).memberRoles as Record<string, string>;
const admins = async () => (await snap(paths.workspace(W))).adminUids as string[];

describe('roles and the last admin', () => {
  it('lets an admin promote a member, then lets the new admin demote the first', async () => {
    const o = as('owner');
    await ok(o.run(setMemberRole(o.ctx, { uid: 'alice', role: 'admin', adminUids: ['owner'] })));
    expect(await admins()).toEqual(['owner', 'alice']);
    const a = as('alice');
    await ok(
      a.run(setMemberRole(a.ctx, { uid: 'owner', role: 'member', adminUids: ['owner', 'alice'] })),
    );
    expect(await admins()).toEqual(['alice']);
    expect((await roles()).owner).toBe('member');
  });

  it('denies demoting or removing the last admin, even by hand', async () => {
    const o = as('owner');
    await denied(
      o.run(setMemberRole(o.ctx, { uid: 'owner', role: 'member', adminUids: ['owner', 'x'] })),
    );
    await denied(o.run(removeMember(o.ctx, { uid: 'owner', adminUids: ['owner', 'x'] })));
    // the client helpers refuse too
    expect(() =>
      setMemberRole(o.ctx, { uid: 'owner', role: 'member', adminUids: ['owner'] }),
    ).toThrow();
    expect(() => removeMember(o.ctx, { uid: 'owner', adminUids: ['owner'] })).toThrow();
  });

  it('lets an admin remove another admin when one is left', async () => {
    const o = as('owner');
    await ok(o.run(setMemberRole(o.ctx, { uid: 'alice', role: 'admin', adminUids: ['owner'] })));
    await ok(o.run(removeMember(o.ctx, { uid: 'alice', adminUids: ['owner', 'alice'] })));
    expect(await admins()).toEqual(['owner']);
    expect(Object.keys(await roles())).not.toContain('alice');
  });

  it('lets a member leave on their own', async () => {
    const b = as('bob');
    await ok(b.run(leaveOrganization(b.ctx, { adminUids: ['owner'] })));
    expect(Object.keys(await roles())).not.toContain('bob');
  });

  it('ATTACK: a leave event cannot remove someone else', async () => {
    const a = as('alice');
    // alice cannot use her leave event to remove bob
    const plan = leaveOrganization(a.ctx, { adminUids: ['owner'] });
    await denied(
      a.run(
        plan.ops.map((op) =>
          op.path === paths.workspace(W)
            ? {
                ...op,
                data: {
                  adminUids: op.data!.adminUids,
                  lastEventId: op.data!.lastEventId,
                  'memberRoles.bob': op.data!['memberRoles.alice'],
                },
              }
            : op,
        ),
      ),
    );
  });

  it('the last admin cannot leave', async () => {
    const o = as('owner');
    expect(() => leaveOrganization(o.ctx, { adminUids: ['owner'] })).toThrow();
    await denied(o.run(leaveOrganization(o.ctx, { adminUids: ['owner', 'x'] })));
  });

  it('ATTACK: denies a member promoting themselves or editing adminUids', async () => {
    const b = as('bob');
    await denied(b.run(setMemberRole(b.ctx, { uid: 'bob', role: 'admin', adminUids: ['owner'] })));
    await denied(updateDoc(doc(b.db, paths.workspace(W)), { adminUids: ['owner', 'bob'] }));
    await denied(updateDoc(doc(b.db, paths.workspace(W)), { 'memberRoles.bob': 'admin' }));
  });

  it('ATTACK: denies an admin making adminUids disagree with memberRoles', async () => {
    const o = as('owner');
    const plan = setMemberRole(o.ctx, { uid: 'alice', role: 'admin', adminUids: ['owner'] });
    // role says admin, list forgot her
    await denied(
      o.run(
        plan.ops.map((op) =>
          op.path === paths.workspace(W)
            ? { ...op, data: { ...op.data, adminUids: ['owner'] } }
            : op,
        ),
      ),
    );
    // list says admin for bob while only alice is promoted
    await denied(
      o.run(
        plan.ops.map((op) =>
          op.path === paths.workspace(W)
            ? { ...op, data: { ...op.data, adminUids: ['owner', 'alice', 'bob'] } }
            : op,
        ),
      ),
    );
    // two roles in one write
    await denied(
      o.run([
        {
          kind: 'update',
          path: paths.workspace(W),
          data: {
            'memberRoles.alice': 'admin',
            'memberRoles.bob': 'admin',
            adminUids: ['owner', 'alice', 'bob'],
            lastEventId: 'e',
          },
        },
        eventOp(o, 'e', { projectId: null, type: 'member.roleChanged', data: { uid: 'alice' } }),
      ]),
    );
  });

  it('lets only an admin rename the organization', async () => {
    const o = as('owner');
    await ok(o.run(renameWorkspace(o.ctx, { name: 'Renamed' })));
    const b = as('bob');
    await denied(b.run(renameWorkspace(b.ctx, { name: 'Mine now' })));
  });

  it('still treats the legacy "owner" role as admin until the migration runs', async () => {
    await put({
      [paths.workspace(W)]: {
        name: 'Hive',
        ownerUid: 'owner',
        memberRoles: {
          owner: 'owner',
          alice: 'member',
          bob: 'member',
          carol: 'member',
          dave: 'member',
        },
        createdAt: now(),
        lastEventId: 'seed',
      },
    });
    const o = as('owner');
    await ok(getDocs(collection(o.db, `workspaces/${W}/events`)));
    await ok(getDocs(collection(o.db, `workspaces/${W}/agents`)));
  });
});

describe('invites carry the role', () => {
  it('adds an invited admin to adminUids and refuses a forged join', async () => {
    const o = as('owner');
    await o.run(
      createInvite(o.ctx, {
        email: 'f@example.com',
        role: 'admin',
        expiresAt: inFuture(),
        code: 'a1',
      }),
    );
    await o.run(
      createInvite(o.ctx, {
        email: 'g@example.com',
        role: 'member',
        expiresAt: inFuture(),
        code: 'm1',
      }),
    );

    const g = as('gina', { email: 'g@example.com' });
    // a member invite cannot be turned into an admin join
    const forged = acceptInvite(g.ctx, { code: 'm1', role: 'admin' });
    await denied(g.run(forged));
    await ok(
      g.run(
        acceptInvite(g.ctx, {
          code: 'm1',
          role: 'member',
          profile: { name: 'Gina', email: 'g@example.com', photoURL: null, color: 'c1' },
        }),
      ),
    );
    expect(await admins()).toEqual(['owner']);

    const f = as('frank', { email: 'f@example.com' });
    // an admin join that skips adminUids is refused
    const plain = acceptInvite(f.ctx, { code: 'a1', role: 'admin' });
    await denied(
      f.run(
        plain.ops.map((op) =>
          op.path === paths.workspace(W)
            ? { ...op, data: { 'memberRoles.frank': 'admin', lastEventId: plain.eventId } }
            : op,
        ),
      ),
    );
    await ok(f.run(acceptInvite(f.ctx, { code: 'a1', role: 'admin' })));
    expect(await admins()).toEqual(['owner', 'frank']);
  });
});

describe('many organizations per person', () => {
  it('lets someone create a second organization and list it on their profile', async () => {
    const f = as('frank', { workspaceId: 'w3' });
    await ok(
      setDoc(doc(f.db, paths.user('frank')), {
        name: 'F',
        email: 'f@x.com',
        photoURL: null,
        color: 'c1',
        workspaceId: null,
        workspaceIds: [],
        theme: null,
      }),
    );
    await ok(
      f.run([
        ...createWorkspace(f.ctx, {
          name: 'One',
          profile: { name: 'F', email: 'f@x.com', photoURL: null, color: 'c1' },
        }).ops,
        {
          kind: 'update',
          path: paths.user('frank'),
          data: { workspaceId: 'w3', workspaceIds: ['w3'] },
        },
      ]),
    );
    const second = as('frank', { workspaceId: 'w4' });
    await ok(
      second.run([
        ...createWorkspace(second.ctx, { name: 'Two' }).ops,
        {
          kind: 'update',
          path: paths.user('frank'),
          data: { workspaceId: 'w4', workspaceIds: ['w3', 'w4'] },
        },
      ]),
    );
    expect((await snap(paths.user('frank'))).workspaceIds as string[]).toEqual(['w3', 'w4']);
    // both are readable at once
    await ok(getDoc(doc(f.db, paths.workspace('w3'))));
    await ok(getDoc(doc(f.db, paths.workspace('w4'))));
  });

  it('ATTACK: denies listing an organization you are not in, or rewriting the list', async () => {
    const a = as('alice');
    await denied(updateDoc(doc(a.db, paths.user('alice')), { workspaceIds: [W, 'w2'] }));
    await denied(updateDoc(doc(a.db, paths.user('alice')), { workspaceId: 'w2' }));
    await denied(updateDoc(doc(a.db, paths.user('alice')), { workspaceIds: [] }));
  });

  it('keeps each organization’s members and cards apart', async () => {
    await ok(
      as('alice').run([
        memberProfileOp(W, 'alice', {
          name: 'Alice',
          email: 'a@x.com',
          photoURL: null,
          color: 'c1',
        }),
      ]),
    );
    await ok(getDoc(doc(as('bob').db, paths.member(W, 'alice'))));
    await denied(getDoc(doc(as('eve').db, paths.member(W, 'alice'))));
    // nobody writes someone else’s card, and outsiders cannot write their own
    await denied(
      as('bob').run([
        memberProfileOp(W, 'alice', {
          name: 'Hacked',
          email: 'a@x.com',
          photoURL: null,
          color: 'c1',
        }),
      ]),
    );
    await denied(
      as('eve').run([
        memberProfileOp(W, 'eve', { name: 'Eve', email: 'e@x.com', photoURL: null, color: 'c1' }),
      ]),
    );
  });
});
