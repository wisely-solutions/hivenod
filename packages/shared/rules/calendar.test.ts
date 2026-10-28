/**
 * The per-member Calendar (Inbox item w9SAf): events with details stay inside their organization,
 * busy blocks carry no titles, agents reach only their own organization's events plus the busy
 * blocks of its members.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
} from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { beginOrgDelete, leaveOrganization, SERVER_TIME } from '../src/actions';
import {
  busyBlockId,
  calendarDelete,
  calendarEventId,
  calendarPaths,
  calendarUpsert,
  freeSlots,
  type CalendarEventInput,
} from '../src/calendar';
import { paths } from '../src/schema';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, now } from './harness';

useEmulator();

/** Two more organizations of Alice: her personal one and a client's, each with an agent. */
const PERSONAL = 'wPersonal';
const CLIENT = 'wClient';
const AP = 'agentPersonal';
const AC = 'agentClient';

async function seedOrgs() {
  const ws = (owner: string, roles: Record<string, string>) => ({
    name: 'Org',
    ownerUid: owner,
    adminUids: [owner],
    memberRoles: roles,
    createdAt: now(),
    lastEventId: 'seed',
  });
  const agent = {
    name: 'Agent',
    color: '#2F5FD0',
    projectIds: '*',
    createdBy: 'alice',
    createdAt: now(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  };
  await put({
    [paths.workspace(PERSONAL)]: ws('alice', { alice: 'admin' }),
    [paths.workspace(CLIENT)]: ws('zoe', { zoe: 'admin', alice: 'member' }),
    [paths.agent(PERSONAL, AP)]: agent,
    [paths.agent(CLIENT, AC)]: agent,
  });
}

const T = (h: number) => new Date(Date.UTC(2030, 0, 7, h));
const ev = (id: string, h: number, over: Partial<CalendarEventInput> = {}): CalendarEventInput => ({
  source: 'google',
  sourceEventId: id,
  title: `Meeting ${id}`,
  start: T(h),
  end: T(h + 1),
  attendees: ['zoe@client.example'],
  ...over,
});

const agentIn = (uid: string, wid: string) => as(uid, { workspaceId: wid });

describe('calendar events', () => {
  it('an agent upserts events for a member of its organization, mirrored as busy blocks without titles', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('g1', 9), ev('g2', 11)] });
    await ok(a.run(p));
    const e = await snap(calendarPaths.event(W, p.ids[0]!));
    expect(e).toMatchObject({ memberUid: 'alice', title: 'Meeting g1', deleted: false });
    const b = await snap(calendarPaths.busyBlock('alice', busyBlockId(W, p.ids[0]!)));
    expect(Object.keys(b).sort()).toEqual(
      ['deleted', 'end', 'lastEventId', 'start', 'updatedAt', 'workspaceId'].sort(),
    );
    // the same source event again is an update of the same document
    await ok(a.run(calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('g1', 10)] })));
    expect(p.ids[0]).toBe(calendarEventId('alice', 'google', 'g1'));
  });

  it('upserts 100 events in one batch', async () => {
    const a = as(AGENTS.star);
    const events = Array.from({ length: 100 }, (_, i) => ev(`n${i}`, 1 + (i % 20)));
    await ok(a.run(calendarUpsert(a.ctx, { memberUid: 'alice', events })));
  });

  it('refuses events for someone outside the organization, from revoked agents and from other organizations', async () => {
    const a = as(AGENTS.star);
    await denied(a.run(calendarUpsert(a.ctx, { memberUid: 'eve', events: [ev('x', 9)] })));
    const r = as(AGENTS.revoked);
    await denied(r.run(calendarUpsert(r.ctx, { memberUid: 'alice', events: [ev('x', 9)] })));
    await seedOrgs();
    // the client's agent cannot write into W
    const c = agentIn(AC, W);
    await denied(c.run(calendarUpsert(c.ctx, { memberUid: 'alice', events: [ev('x', 9)] })));
  });

  it('a member books only in their own calendar', async () => {
    const alice = as('alice');
    await ok(alice.run(calendarUpsert(alice.ctx, { memberUid: 'alice', events: [ev('h1', 9)] })));
    const bob = as('bob');
    const forAlice = calendarUpsert(
      { ...bob.ctx, actor: { ...bob.ctx.actor, id: 'alice' } },
      {
        memberUid: 'alice',
        events: [ev('h2', 9)],
      },
    );
    // Bob replaying a plan built for Alice: the actor and the busy writer do not match
    await denied(bob.run(forAlice));
    const eve = as('eve');
    await denied(eve.run(calendarUpsert(eve.ctx, { memberUid: 'eve', events: [ev('h3', 9)] })));
  });

  it('keeps details off busy-only and deleted events', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('b1', 9)] });
    await ok(a.run(p));
    const id = p.ids[0]!;
    // a hand-made busy-only event with a title
    const bad = calendarUpsert(a.ctx, {
      memberUid: 'alice',
      events: [ev('b2', 9, { busyOnly: true })],
    });
    (bad.ops[0]!.data as Record<string, unknown>).title = 'Secret';
    await denied(a.run(bad));
    // delete clears the details
    await ok(a.run(calendarDelete(a.ctx, { events: [{ id, memberUid: 'alice' }] })));
    expect(await snap(calendarPaths.event(W, id))).toMatchObject({ title: '', deleted: true });
    expect(await snap(calendarPaths.busyBlock('alice', busyBlockId(W, id)))).toMatchObject({
      deleted: true,
    });
    // a deleted event cannot get its title back without un-deleting it
    await denied(
      a.run({
        ops: [
          {
            kind: 'update',
            path: calendarPaths.event(W, id),
            data: {
              title: 'Back',
              updatedAt: SERVER_TIME,
              updatedBy: { type: 'agent', id: AGENTS.star },
            },
          },
        ],
      }),
    );
  });

  it('is never hard-deleted and needs its event', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('d1', 9)] });
    await ok(a.run(p));
    await denied(deleteDoc(doc(a.db, calendarPaths.event(W, p.ids[0]!))));
    // without the calendar.changed event
    await denied(a.run({ ops: p.ops.slice(0, 2) }));
  });

  it('cannot take another member’s id', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('i1', 9)] });
    const op = p.ops[0]!;
    op.path = calendarPaths.event(W, `bob_${p.ids[0]!.slice('alice_'.length)}`);
    await denied(a.run({ ops: [op, p.ops[2]!] }));
  });

  it('members and agents of the organization read its events; nobody else', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('r1', 9)] });
    await ok(a.run(p));
    const path = calendarPaths.event(W, p.ids[0]!);
    await ok(getDoc(doc(as('alice').db, path)));
    await ok(getDoc(doc(as('bob').db, path)));
    await ok(getDoc(doc(as(AGENTS.a).db, path)));
    await denied(getDoc(doc(as('eve').db, path)));
    await denied(getDoc(doc(as(AGENTS.revoked).db, path)));
    await seedOrgs();
    await denied(getDoc(doc(agentIn(AC, CLIENT).db, path)));
    await denied(getDocs(collection(agentIn(AC, CLIENT).db, calendarPaths.events(W))));
  });

  it('the event carries no titles', async () => {
    const a = as(AGENTS.star);
    const p = calendarUpsert(a.ctx, { memberUid: 'alice', events: [ev('t1', 9)] });
    const e = p.ops.at(-1)!;
    (e.data!.data as Record<string, unknown>).title = 'Meeting t1';
    await denied(a.run(p));
  });
});

describe('busy store', () => {
  async function threeOrgs() {
    await seedOrgs();
    const w = as(AGENTS.star);
    const pa = agentIn(AP, PERSONAL);
    const ca = agentIn(AC, CLIENT);
    await ok(w.run(calendarUpsert(w.ctx, { memberUid: 'alice', events: [ev('w', 9)] })));
    await ok(
      pa.run(
        calendarUpsert(pa.ctx, { memberUid: 'alice', events: [ev('p', 10, { source: 'gcal' })] }),
      ),
    );
    await ok(
      ca.run(
        calendarUpsert(ca.ctx, { memberUid: 'alice', events: [ev('c', 13, { busyOnly: true })] }),
      ),
    );
    return { w, pa, ca };
  }

  it('the member reads all their busy blocks; others do not', async () => {
    await threeOrgs();
    const mine = await getDocs(collection(as('alice').db, calendarPaths.busy('alice')));
    expect(mine.docs.map((d) => d.data().workspaceId).sort()).toEqual([CLIENT, PERSONAL, W].sort());
    for (const d of mine.docs) expect(d.data()).not.toHaveProperty('title');
    await denied(getDocs(collection(as('bob').db, calendarPaths.busy('alice'))));
  });

  it('an agent reads the busy blocks of its members across organizations, after saying where it lives', async () => {
    const { ca } = await threeOrgs();
    const col = collection(ca.db, calendarPaths.busy('alice'));
    await denied(getDocs(col));
    await ok(setDoc(doc(ca.db, calendarPaths.agentHome(AC)), { workspaceId: CLIENT }));
    const all = await ok(getDocs(query(col, where('end', '>', Timestamp.fromDate(T(0))))));
    const busy = all.docs.map((d) => ({
      start: d.data().start.toDate(),
      end: d.data().end.toDate(),
    }));
    expect(freeSlots({ from: T(8), to: T(15), busy, minMinutes: 30 })).toEqual([
      { start: T(8), end: T(9) },
      { start: T(11), end: T(13) },
      { start: T(14), end: T(15) },
    ]);
    // not a member of the agent's organization: refused
    await denied(getDocs(collection(ca.db, calendarPaths.busy('bob'))));
  });

  it('agentHomes: only for itself, only where it is active, once', async () => {
    await seedOrgs();
    const ca = agentIn(AC, CLIENT);
    await denied(setDoc(doc(ca.db, calendarPaths.agentHome(AC)), { workspaceId: W }));
    await denied(setDoc(doc(ca.db, calendarPaths.agentHome(AP)), { workspaceId: PERSONAL }));
    await denied(setDoc(doc(as('alice').db, calendarPaths.agentHome('alice')), { workspaceId: W }));
    await ok(setDoc(doc(ca.db, calendarPaths.agentHome(AC)), { workspaceId: CLIENT }));
    await denied(updateDoc(doc(ca.db, calendarPaths.agentHome(AC)), { workspaceId: PERSONAL }));
    const r = as(AGENTS.revoked);
    await denied(setDoc(doc(r.db, calendarPaths.agentHome(AGENTS.revoked)), { workspaceId: W }));
  });

  it('an agent writes busy blocks only for its own organization', async () => {
    await seedOrgs();
    const ca = agentIn(AC, CLIENT);
    const p = calendarUpsert(ca.ctx, { memberUid: 'alice', events: [ev('x', 9)] });
    // rewrite the busy block as if it came from W
    const busy = p.ops[1]!;
    busy.path = calendarPaths.busyBlock('alice', busyBlockId(W, p.ids[0]!));
    (busy.data as Record<string, unknown>).workspaceId = W;
    await denied(ca.run(p));
    // a title on a busy block
    const p2 = calendarUpsert(ca.ctx, { memberUid: 'alice', events: [ev('y', 9)] });
    (p2.ops[1]!.data as Record<string, unknown>).title = 'Secret';
    await denied(ca.run(p2));
  });

  it('a block of one organization cannot be overwritten from another', async () => {
    await threeOrgs();
    const pa = agentIn(AP, PERSONAL);
    const wid = calendarEventId('alice', 'google', 'w');
    await denied(
      pa.run([
        {
          kind: 'set',
          path: calendarPaths.busyBlock('alice', busyBlockId(W, wid)),
          data: {
            workspaceId: PERSONAL,
            start: T(1),
            end: T(2),
            deleted: false,
            updatedAt: SERVER_TIME,
            lastEventId: 'nope',
          },
        },
      ]),
    );
  });
});

describe('busy blocks after leaving or deleting an organization', () => {
  const block = (u: string, wid: string, e: string) =>
    calendarPaths.busyBlock(u, busyBlockId(wid, e));
  async function setup() {
    await seedOrgs();
    const w = as(AGENTS.star);
    const ca = agentIn(AC, CLIENT);
    await ok(w.run(calendarUpsert(w.ctx, { memberUid: 'alice', events: [ev('w', 9)] })));
    await ok(w.run(calendarUpsert(w.ctx, { memberUid: 'bob', events: [ev('w', 9)] })));
    await ok(ca.run(calendarUpsert(ca.ctx, { memberUid: 'alice', events: [ev('c', 13)] })));
    return {
      aliceW: block('alice', W, calendarEventId('alice', 'google', 'w')),
      bobW: block('bob', W, calendarEventId('bob', 'google', 'w')),
      aliceC: block('alice', CLIENT, calendarEventId('alice', 'google', 'c')),
    };
  }
  const exists = async (path: string) => {
    return Object.keys(await snap(path)).length > 0;
  };

  it('a member cannot delete their blocks of an organization they are in', async () => {
    const p = await setup();
    await denied(deleteDoc(doc(as('alice').db, p.aliceW)));
    await denied(deleteDoc(doc(as('alice').db, p.aliceC)));
  });

  it('after leaving, the member deletes their own blocks of it, and only those', async () => {
    const p = await setup();
    const a = as('alice');
    await ok(a.run(leaveOrganization(a.ctx, { adminUids: ['owner'] })));
    await denied(deleteDoc(doc(as('bob').db, p.aliceW))); // not bob's
    await denied(deleteDoc(doc(a.db, p.aliceC))); // still in the client's organization
    await ok(deleteDoc(doc(a.db, p.aliceW)));
    expect(await exists(p.aliceW)).toBe(false);
    expect(await exists(p.bobW)).toBe(true);
  });

  it('while an organization is being deleted its admin clears its blocks in the members stores', async () => {
    const p = await setup();
    const o = as('owner');
    await denied(deleteDoc(doc(o.db, p.aliceW))); // not flagged yet
    await ok(o.run(beginOrgDelete(o.ctx)));
    await denied(deleteDoc(doc(as('bob').db, p.aliceW))); // a plain member
    await denied(deleteDoc(doc(o.db, p.aliceC))); // another organization's block
    await ok(deleteDoc(doc(o.db, p.aliceW)));
    await ok(deleteDoc(doc(o.db, p.bobW)));
    await ok(deleteDoc(doc(o.db, block('alice', W, 'gone')))); // already deleted: harmless
    expect(await exists(p.aliceW)).toBe(false);
    expect(await exists(p.aliceC)).toBe(true);
    // what an agent of the client's organization now sees as alice's busy time
    const seen = await getDocs(collection(agentIn(AC, CLIENT).db, calendarPaths.busy('alice')));
    expect(seen.docs.map((d) => d.data().workspaceId)).toEqual([CLIENT]);
  });
});
