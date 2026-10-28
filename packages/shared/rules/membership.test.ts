/**
 * SPEC §5.1 membership: only members and active agents read; only the owner manages members,
 * groups, agents and project deletion; invites; user profiles; cross-project queries.
 */
import {
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  createAgent,
  createInvite,
  createWorkspace,
  deleteGroup,
  removeMember,
  revokeAgent,
  revokeInvite,
  saveGroup,
  setMemberRole,
} from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, anon, as, denied, I, ok, P, put, snap, useEmulator, W } from './harness';

useEmulator();

const inFuture = () => new Date(Date.now() + 86_400_000);

describe('reading', () => {
  it('allows members to read the workspace, projects and items', async () => {
    const d = as('dave');
    await ok(getDoc(doc(d.db, paths.workspace(W))));
    await ok(getDoc(doc(d.db, P('p2'))));
    await ok(getDoc(doc(d.db, I('i1'))));
  });
  it('denies outsiders and anonymous users everything', async () => {
    for (const db of [as('eve').db, anon()]) {
      await denied(getDoc(doc(db, paths.workspace(W))));
      await denied(getDoc(doc(db, P('p1'))));
      await denied(getDoc(doc(db, I('i1'))));
      await denied(getDoc(doc(db, paths.group(W, 'g1'))));
    }
  });
  it('allows members to read groups and agents; denies agents reading groups', async () => {
    await ok(getDoc(doc(as('dave').db, paths.group(W, 'g1'))));
    await ok(getDoc(doc(as('dave').db, paths.agent(W, AGENTS.a))));
    await denied(getDoc(doc(as(AGENTS.star).db, paths.group(W, 'g1'))));
  });
  it('allows organization-wide question/decision queries for admins only', async () => {
    const q = (uid: string, group: string) =>
      getDocs(query(collectionGroup(as(uid).db, group), where('workspaceId', '==', W)));
    await ok(q('owner', 'messages'));
    await ok(q('owner', 'decisions'));
    await denied(q('dave', 'messages'));
    await denied(q('eve', 'messages'));
    await denied(q(AGENTS.star, 'decisions'));
  });
  it('lets a member query one of their projects, not an unrelated one', async () => {
    const q = (uid: string, pid: string) =>
      getDocs(
        query(
          collectionGroup(as(uid).db, 'decisions'),
          where('workspaceId', '==', W),
          where('projectId', '==', pid),
        ),
      );
    await ok(q('dave', 'p1'));
    await put({ [P('p9')]: { ...(await snap(P('p1'))), memberUids: ['alice'] } });
    await denied(q('dave', 'p9'));
    await ok(q('alice', 'p9'));
  });
  it('lets members and admins run the Needs-you questions query for a project they can see', async () => {
    const q = (uid: string, pid: string) =>
      getDocs(
        query(
          collectionGroup(as(uid).db, 'messages'),
          where('workspaceId', '==', W),
          where('projectId', '==', pid),
          where('kind', '==', 'question'),
          where('answered', '==', false),
          orderBy('at', 'asc'),
        ),
      );
    await ok(q('dave', 'p1'));
    await ok(q('owner', 'p1'));
    await denied(q('eve', 'p1'));
    await put({ [P('p9')]: { ...(await snap(P('p1'))), memberUids: ['alice'] } });
    await denied(q('dave', 'p9'));
  });
});

describe('workspace and members', () => {
  it('allows anyone signed in to create their own workspace', async () => {
    const e = as('frank', { workspaceId: 'w3' });
    await ok(e.run(createWorkspace(e.ctx, { name: 'Frank & co' })));
  });
  it('denies creating a workspace for someone else or as an agent identity', async () => {
    const e = as('frank', { workspaceId: 'w3' });
    const p = createWorkspace(e.ctx, { name: 'x' });
    const forged = p.ops.map((op) =>
      op.path === paths.workspace('w3')
        ? { ...op, data: { ...op.data, ownerUid: 'alice', memberRoles: { alice: 'owner' } } }
        : op,
    );
    await denied(e.run(forged));
    const bot = as('agentX', { workspaceId: 'w4', email: 'agent-abc123@agents.hive-board.app' });
    await denied(
      bot.run(
        createWorkspace({ ...bot.ctx, actor: { ...bot.ctx.actor, type: 'human' } }, { name: 'x' }),
      ),
    );
  });
  it('allows the owner to change roles and remove members; denies members', async () => {
    const o = as('owner');
    const admins = ['owner'];
    await ok(o.run(setMemberRole(o.ctx, { uid: 'alice', role: 'admin', adminUids: admins })));
    await ok(o.run(removeMember(o.ctx, { uid: 'dave', adminUids: ['owner', 'alice'] })));
    const b = as('bob');
    await denied(b.run(setMemberRole(b.ctx, { uid: 'bob', role: 'admin', adminUids: admins })));
    await denied(b.run(removeMember(b.ctx, { uid: 'carol', adminUids: admins })));
  });
  it('denies the admin adding members directly or making a stranger an admin', async () => {
    const o = as('owner');
    await denied(
      o.run(setMemberRole(o.ctx, { uid: 'frank', role: 'member', adminUids: ['owner'] })),
    );
    await denied(
      o.run(setMemberRole(o.ctx, { uid: AGENTS.a, role: 'admin', adminUids: ['owner'] })),
    );
  });
});

describe('invites', () => {
  it('allows the owner to invite; denies members', async () => {
    const o = as('owner');
    await ok(
      o.run(
        createInvite(o.ctx, {
          email: 'Frank@Example.com',
          role: 'member',
          expiresAt: inFuture(),
          code: 'c1',
        }),
      ),
    );
    const a = as('alice');
    await denied(
      a.run(createInvite(a.ctx, { email: 'x@example.com', role: 'admin', expiresAt: inFuture() })),
    );
  });
  it('allows the invited email to join with the invite role, once', async () => {
    const o = as('owner');
    await o.run(
      createInvite(o.ctx, {
        email: 'frank@example.com',
        role: 'member',
        expiresAt: inFuture(),
        code: 'c1',
      }),
    );
    const f = as('frank', { email: 'frank@example.com' });
    await ok(getDoc(doc(f.db, paths.invite(W, 'c1'))));
    await denied(f.run(acceptInvite(f.ctx, { code: 'c1', role: 'admin' })));
    await ok(f.run(acceptInvite(f.ctx, { code: 'c1', role: 'member' })));
    expect(((await snap(paths.workspace(W))).memberRoles as Record<string, string>).frank).toBe(
      'member',
    );
    const g = as('gina', { email: 'frank@example.com' });
    await denied(g.run(acceptInvite(g.ctx, { code: 'c1', role: 'member' })));
  });
  it('denies another email, an expired invite, or an agent joining', async () => {
    await put({
      [paths.invite(W, 'old')]: {
        email: 'frank@example.com',
        role: 'member',
        createdBy: 'owner',
        expiresAt: Timestamp.fromMillis(Date.now() - 1000),
        usedBy: null,
        lastEventId: 'seed',
      },
      [paths.invite(W, 'c2')]: {
        email: 'frank@example.com',
        role: 'member',
        createdBy: 'owner',
        expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
        usedBy: null,
        lastEventId: 'seed',
      },
    });
    const wrong = as('mallory', { email: 'mallory@example.com' });
    await denied(getDoc(doc(wrong.db, paths.invite(W, 'c2'))));
    await denied(wrong.run(acceptInvite(wrong.ctx, { code: 'c2', role: 'member' })));
    const f = as('frank', { email: 'frank@example.com' });
    await denied(f.run(acceptInvite(f.ctx, { code: 'old', role: 'member' })));
    await put({
      [paths.invite(W, 'c3')]: {
        email: 'agent-x@agents.hive-board.app',
        role: 'member',
        createdBy: 'owner',
        expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
        usedBy: null,
        lastEventId: 'seed',
      },
    });
    const bot = as(AGENTS.a, { email: 'agent-x@agents.hive-board.app' });
    await denied(
      bot.run(
        acceptInvite(
          { ...bot.ctx, actor: { ...bot.ctx.actor, type: 'human' } },
          { code: 'c3', role: 'member' },
        ),
      ),
    );
  });
  it('allows the owner to revoke an invite (tombstone event); denies a plain delete', async () => {
    await put({
      [paths.invite(W, 'c2')]: {
        email: 'f@example.com',
        role: 'member',
        createdBy: 'owner',
        expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000),
        usedBy: null,
        lastEventId: 'seed',
      },
    });
    const o = as('owner');
    await denied(deleteDoc(doc(o.db, paths.invite(W, 'c2'))));
    await ok(o.run(revokeInvite(o.ctx, { code: 'c2' })));
  });
});

describe('groups', () => {
  it('allows the owner to create, update and delete groups; denies members', async () => {
    const o = as('owner');
    await ok(
      o.run(
        saveGroup(o.ctx, { groupId: 'g2', name: 'Leadership', memberUids: ['bob'], isNew: true }),
      ),
    );
    await ok(
      o.run(
        saveGroup(o.ctx, {
          groupId: 'g2',
          name: 'Leads',
          memberUids: ['bob', 'carol'],
          isNew: false,
        }),
      ),
    );
    await denied(deleteDoc(doc(o.db, paths.group(W, 'g2'))));
    await ok(o.run(deleteGroup(o.ctx, { groupId: 'g2' })));
    const a = as('alice');
    await denied(
      a.run(saveGroup(a.ctx, { groupId: 'g1', name: 'Mine', memberUids: ['alice'], isNew: false })),
    );
    await denied(a.run(deleteGroup(a.ctx, { groupId: 'g1' })));
  });
});

describe('agents', () => {
  it('allows the owner to create and revoke agents; denies members', async () => {
    const o = as('owner');
    await ok(
      o.run(
        createAgent(o.ctx, {
          agentUid: 'agentNew',
          name: 'Research agent',
          color: '#2F5FD0',
          projectIds: ['p1'],
          tokenHint: '…a7f3',
        }),
      ),
    );
    await ok(o.run(revokeAgent(o.ctx, { agentUid: 'agentNew' })));
    const a = as('alice');
    await denied(
      a.run(
        createAgent(a.ctx, {
          agentUid: 'agentZ',
          name: 'Mine',
          color: '',
          projectIds: '*',
          tokenHint: '',
        }),
      ),
    );
    await denied(a.run(revokeAgent(a.ctx, { agentUid: AGENTS.a })));
  });
  it('denies turning a member into an agent, or the owner into one', async () => {
    const o = as('owner');
    await denied(
      o.run(
        createAgent(o.ctx, {
          agentUid: 'alice',
          name: 'x',
          color: '',
          projectIds: '*',
          tokenHint: '',
        }),
      ),
    );
    await denied(
      o.run(
        createAgent(o.ctx, {
          agentUid: 'owner',
          name: 'x',
          color: '',
          projectIds: '*',
          tokenHint: '',
        }),
      ),
    );
  });
  it('revocation is final: denies un-revoking and editing a revoked agent', async () => {
    const o = as('owner');
    await denied(updateDoc(doc(o.db, paths.agent(W, AGENTS.revoked)), { revokedAt: null }));
    await denied(o.run(revokeAgent(o.ctx, { agentUid: AGENTS.revoked })));
  });
  it('denies deleting agent docs (history stays)', async () => {
    await denied(deleteDoc(doc(as('owner').db, paths.agent(W, AGENTS.a))));
  });
});

describe('projects', () => {
  it('does not let anyone delete a project (archive only; see orgdelete.test.ts)', async () => {
    await denied(deleteDoc(doc(as('alice').db, P('p2'))));
    await denied(deleteDoc(doc(as('owner').db, P('p2'))));
  });
  it('denies an outsider creating a project in the workspace', async () => {
    await denied(setDoc(doc(as('eve').db, P('p8')), { name: 'x' }));
  });
});

describe('user profiles', () => {
  it('allows reading and writing your own profile; nobody else reads it', async () => {
    const a = as('alice');
    await ok(updateDoc(doc(a.db, paths.user('alice')), { theme: 'dark' }));
    await ok(getDoc(doc(a.db, paths.user('alice'))));
    await denied(getDoc(doc(as('bob').db, paths.user('alice'))));
  });
  it('denies writing someone else’s profile or claiming a workspace you are not in', async () => {
    await denied(updateDoc(doc(as('bob').db, paths.user('alice')), { theme: 'dark' }));
    await denied(getDoc(doc(as('eve').db, paths.user('alice'))));
    await denied(
      setDoc(doc(as('eve').db, paths.user('eve')), {
        name: 'Eve',
        email: 'e@x.com',
        photoURL: null,
        color: '',
        workspaceId: W,
        theme: null,
      }),
    );
    await ok(
      setDoc(doc(as('eve').db, paths.user('eve')), {
        name: 'Eve',
        email: 'e@x.com',
        photoURL: null,
        color: '',
        workspaceId: 'w2',
        workspaceIds: ['w2'],
        theme: null,
      }),
    );
  });
});
