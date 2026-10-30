/**
 * Calendar was removed (item OE8FmrTaIxFVGcaeGG3N, slice 5). Its old data stays until the export
 * (slice 7) and the deletion script (slice 11), so the rules keep only:
 *  - admins read the organization's old calendar events (for the export);
 *  - while an organization is being deleted, its admin clears its busy blocks in the members'
 *    own stores (and its events, like everything under it).
 * Every write is refused: events, busy blocks, agentHomes and calendar.changed events.
 */
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { beginOrgDelete, SERVER_TIME } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, now } from './harness';

useEmulator();

const EV = `${paths.workspace(W)}/calendar/alice_google_e1`;
const BUSY = (uid: string, w = W) => `users/${uid}/busy/${w}_${uid}_google_e1`;
const T = (h: number) => Timestamp.fromDate(new Date(Date.UTC(2030, 0, 7, h)));

const event = (over: Record<string, unknown> = {}) => ({
  memberUid: 'alice',
  title: 'Standup',
  start: T(9),
  end: T(10),
  allDay: false,
  attendees: [],
  source: 'google',
  sourceEventId: 'e1',
  busyOnly: false,
  deleted: false,
  updatedBy: { type: 'agent', id: AGENTS.a, name: 'Agent A' },
  updatedAt: SERVER_TIME,
  lastEventId: 'ev1',
  ...over,
});
const block = (over: Record<string, unknown> = {}) => ({
  workspaceId: W,
  start: T(9),
  end: T(10),
  deleted: false,
  updatedAt: SERVER_TIME,
  lastEventId: 'ev1',
  ...over,
});

async function oldData() {
  await put({
    [EV]: { ...event(), updatedAt: now() },
    [BUSY('alice')]: { ...block(), updatedAt: now() },
  });
}

describe('calendar, after its removal', () => {
  it('admins read the old events for the export; members and agents do not', async () => {
    await oldData();
    await ok(getDoc(doc(as('owner').db, EV)));
    await ok(getDocs(collection(as('owner').db, `${paths.workspace(W)}/calendar`)));
    await denied(getDoc(doc(as('alice').db, EV)));
    await denied(getDoc(doc(as(AGENTS.a).db, EV)));
    await denied(getDocs(collection(as(AGENTS.a).db, `${paths.workspace(W)}/calendar`)));
  });

  it('nobody writes an event any more, not an agent, not the member, not an admin', async () => {
    await denied(setDoc(doc(as(AGENTS.a).db, EV), event()));
    await denied(
      setDoc(doc(as('alice').db, EV), event({ updatedBy: { type: 'human', id: 'alice' } })),
    );
    await denied(
      setDoc(doc(as('owner').db, EV), event({ updatedBy: { type: 'human', id: 'owner' } })),
    );
    await oldData();
    await denied(deleteDoc(doc(as('owner').db, EV))); // not while the organization lives
  });

  it('busy blocks: no reads, no writes, the member does not even clear their own', async () => {
    await oldData();
    await denied(getDoc(doc(as('alice').db, BUSY('alice'))));
    await denied(getDocs(collection(as(AGENTS.a).db, 'users/alice/busy')));
    await denied(setDoc(doc(as(AGENTS.a).db, BUSY('bob')), block()));
    await denied(setDoc(doc(as('alice').db, BUSY('alice')), block()));
    await denied(deleteDoc(doc(as('alice').db, BUSY('alice'))));
  });

  it('agentHomes and calendar.changed events are refused', async () => {
    const a = as(AGENTS.a);
    await denied(setDoc(doc(a.db, `agentHomes/${AGENTS.a}`), { workspaceId: W }));
    await denied(getDoc(doc(a.db, `agentHomes/${AGENTS.a}`)));
    await denied(
      setDoc(doc(a.db, paths.event(W, 'ev1')), {
        actor: { type: 'agent', id: AGENTS.a, name: 'Agent A' },
        projectId: null,
        itemId: null,
        runId: null,
        type: 'calendar.changed',
        data: { memberUids: ['alice'], upserted: 1, deleted: 0 },
        at: SERVER_TIME,
      }),
    );
  });

  it('deleting the organization: its admin clears the events and the members busy blocks', async () => {
    await oldData();
    await put({
      [BUSY('alice', 'wOther')]: { ...block({ workspaceId: 'wOther' }), updatedAt: now() },
    });
    const o = as('owner');
    await denied(deleteDoc(doc(o.db, BUSY('alice')))); // not flagged yet
    await ok(o.run(beginOrgDelete(o.ctx)));
    await denied(deleteDoc(doc(as('alice').db, BUSY('alice')))); // a plain member
    await denied(deleteDoc(doc(o.db, BUSY('alice', 'wOther')))); // another organization's block
    await ok(deleteDoc(doc(o.db, BUSY('alice'))));
    await ok(deleteDoc(doc(o.db, EV)));
    expect(await snap(BUSY('alice'))).toEqual({});
    expect(await snap(EV)).toEqual({});
    expect(await snap(BUSY('alice', 'wOther'))).not.toEqual({});
  });
});
