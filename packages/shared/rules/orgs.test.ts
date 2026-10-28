/**
 * Organizations (card aZYPm9bf): roles, the last-admin guard, many orgs per person, and project
 * privacy. A plain member sees no project until an admin adds them; admins see everything.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  acceptInvite,
  createInvite,
  createProject,
  createItem,
  createWorkspace,
  leaveOrganization,
  memberProfileOp,
  removeMember,
  saveProcess,
  renameWorkspace,
  setMemberRole,
  setProjectMembers,
  updateItem,
} from '../src/actions';
import { paths } from '../src/schema';
import { stepsFor, templateById } from '../src/templates';
import {
  AGENTS,
  as,
  denied,
  eventOp,
  I,
  itemDoc,
  now,
  ok,
  P,
  projectDoc,
  put,
  snap,
  useEmulator,
  W,
} from './harness';

useEmulator();

const inFuture = () => new Date(Date.now() + 86_400_000);
const roles = async () => (await snap(paths.workspace(W))).memberRoles as Record<string, string>;
const admins = async () => (await snap(paths.workspace(W))).adminUids as string[];

/** A private project only alice is on, with an item, a run, a message and a decision. */
async function seedPrivate() {
  await put({
    [P('priv')]: projectDoc({}, { memberUids: ['alice'] }),
    [I('x1', 'priv')]: itemDoc(),
    [paths.run(W, 'r1')]: {
      agentUid: AGENTS.star,
      projectId: 'priv',
      itemId: 'x1',
      stepId: 'draft',
      startedAt: now(),
      heartbeatAt: now(),
      heartbeatEventAt: now(),
      endedAt: null,
      status: 'running',
      costEur: 0,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'seed',
    },
    [paths.message(W, 'priv', 'x1', 'm1')]: {
      workspaceId: W,
      projectId: 'priv',
      itemId: 'x1',
      by: { type: 'human', id: 'alice' },
      kind: 'note',
      text: 'secret',
      at: now(),
      answered: false,
      replyTo: null,
      lastEventId: 'seed',
    },
    [paths.event(W, 'ev-priv')]: {
      actor: { type: 'human', id: 'alice', name: 'Alice' },
      projectId: 'priv',
      itemId: null,
      runId: null,
      type: 'project.created',
      data: {},
      at: now(),
    },
    [paths.event(W, 'ev-org')]: {
      actor: { type: 'human', id: 'owner', name: 'Owner' },
      projectId: null,
      itemId: null,
      runId: null,
      type: 'workspace.updated',
      data: {},
      at: now(),
    },
  });
}

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
    await ok(getDoc(doc(o.db, P('p1'))));
    await ok(getDocs(collection(o.db, `workspaces/${W}/projects`)));
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

describe('project privacy', () => {
  it('shows a member only the projects that list them (query by memberUids)', async () => {
    await seedPrivate();
    const dave = as('dave');
    const mine = await ok(
      getDocs(
        query(
          collection(dave.db, `workspaces/${W}/projects`),
          where('memberUids', 'array-contains', 'dave'),
        ),
      ),
    );
    expect(mine.docs.map((d) => d.id).sort()).toEqual(['p1', 'p2']);
    // the unfiltered list is refused for a member and fine for an admin
    await denied(getDocs(collection(dave.db, `workspaces/${W}/projects`)));
    const all = await ok(getDocs(collection(as('owner').db, `workspaces/${W}/projects`)));
    expect(all.docs.map((d) => d.id).sort()).toEqual(['p1', 'p2', 'priv']);
  });

  it('hides a private project and everything under it from a member who is not on it', async () => {
    await seedPrivate();
    const d = as('dave');
    for (const path of [
      P('priv'),
      I('x1', 'priv'),
      paths.run(W, 'r1'),
      paths.message(W, 'priv', 'x1', 'm1'),
      paths.event(W, 'ev-priv'),
    ]) {
      await denied(getDoc(doc(d.db, path)));
      await ok(getDoc(doc(as('alice').db, path)));
      await ok(getDoc(doc(as('owner').db, path)));
    }
    // organization-level events stay visible to every member
    await ok(getDoc(doc(d.db, paths.event(W, 'ev-org'))));
  });

  it('lets a member query runs and events of a project they are on, one project at a time', async () => {
    await seedPrivate();
    const d = as('dave');
    const runsOf = (pid: string) =>
      getDocs(query(collection(d.db, `workspaces/${W}/runs`), where('projectId', '==', pid)));
    await denied(runsOf('priv'));
    await ok(runsOf('p1'));
    await denied(getDocs(collection(d.db, `workspaces/${W}/runs`)));
    const eventsOf = (pid: string) =>
      getDocs(
        query(
          collection(d.db, `workspaces/${W}/events`),
          where('projectId', '==', pid),
          orderBy('at', 'desc'),
          limit(20),
        ),
      );
    await denied(eventsOf('priv'));
    await ok(eventsOf('p1'));
    await ok(
      getDocs(
        query(
          collection(as('owner').db, `workspaces/${W}/events`),
          orderBy('at', 'desc'),
          limit(20),
        ),
      ),
    );
  });

  it('denies a member working in a project they are not on, allows it once added', async () => {
    await seedPrivate();
    const d = as('dave');
    const project = { steps: projectDoc().steps };
    const make = () =>
      createItem(d.ctx, { project, projectId: 'priv', title: 'Sneaky', type: 'idea' });
    await denied(d.run(make()));
    await denied(
      d.run(updateItem(d.ctx, { projectId: 'priv', itemId: 'x1', changes: { title: 'Mine' } })),
    );

    const o = as('owner');
    await ok(
      o.run(
        setProjectMembers(o.ctx, {
          projectId: 'priv',
          name: 'Blog',
          memberUids: ['alice', 'dave'],
        }),
      ),
    );
    await ok(d.run(make()));
    await ok(getDoc(doc(d.db, P('priv'))));
    // and removing them hides it again
    await ok(
      o.run(setProjectMembers(o.ctx, { projectId: 'priv', name: 'Blog', memberUids: ['alice'] })),
    );
    await denied(getDoc(doc(d.db, P('priv'))));
  });

  it('lets only admins change who is on a project', async () => {
    const a = as('alice');
    await denied(
      a.run(
        setProjectMembers(a.ctx, { projectId: 'p1', name: 'Blog', memberUids: ['alice', 'eve'] }),
      ),
    );
    await denied(updateDoc(doc(a.db, P('p1')), { memberUids: ['alice', 'eve'] }));
    // a project member can still change the process, without touching its people
    const b = as('bob');
    await ok(b.run(saveProcess(b.ctx, { projectId: 'p1', steps: projectDoc().steps })));
  });

  it('lets an admin create a project for a team; a member only for themselves', async () => {
    const steps = stepsFor(templateById('content-pipeline')!, 'owner');
    const base = {
      name: 'New',
      emoji: '🐝',
      color: 'agent-1',
      templateId: 'content-pipeline',
      steps,
    };
    const o = as('owner');
    await ok(
      o.run(createProject(o.ctx, { ...base, projectId: 'n1', memberUids: ['owner', 'alice'] })),
    );
    const d = as('dave');
    await ok(d.run(createProject(d.ctx, { ...base, projectId: 'n2' })));
    await denied(
      d.run(createProject(d.ctx, { ...base, projectId: 'n3', memberUids: ['dave', 'alice'] })),
    );
    await denied(d.run(createProject(d.ctx, { ...base, projectId: 'n4', memberUids: [] })));
    expect((await snap(P('n2'))).memberUids).toEqual(['dave']);
    // a project made by a member is invisible to other members, visible to admins
    await denied(getDoc(doc(as('bob').db, P('n2'))));
    await ok(getDoc(doc(o.db, P('n2'))));
  });

  it('keeps agents working per project, private or not', async () => {
    await seedPrivate();
    const star = as(AGENTS.star);
    await ok(getDoc(doc(star.db, P('priv'))));
    await ok(getDoc(doc(star.db, I('x1', 'priv'))));
    const one = as(AGENTS.a);
    await denied(getDoc(doc(one.db, P('priv'))));
    await ok(getDoc(doc(one.db, P('p1'))));
  });

  it('ATTACK: denies a member planting events into a project they cannot see', async () => {
    await seedPrivate();
    const d = as('dave');
    await denied(d.run([eventOp(d, 'forged', { projectId: 'priv', type: 'item.updated' })]));
    await ok(d.run([eventOp(d, 'fine', { projectId: 'p1', type: 'item.updated' })]));
  });

  it('lets nobody delete a project outside an organization delete', async () => {
    await seedPrivate();
    await denied(deleteDoc(doc(as('alice').db, P('priv'))));
    await denied(deleteDoc(doc(as('owner').db, P('priv'))));
  });
});
