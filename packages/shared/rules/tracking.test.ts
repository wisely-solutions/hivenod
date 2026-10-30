/**
 * SPEC §5.3: tracking is enforced. Every domain write needs its event in the same batch
 * (existsAfter, actor == auth uid, at == request.time); events are create-only. Project, item and
 * run events went with Projects (OE8Fm slice 11): workspace events carry no project, item or run.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { describe, it } from 'vitest';
import { saveGroup, SERVER_TIME, type ActionPlan } from '../src/actions';
import { paths } from '../src/schema';
import { AGENTS, as, denied, eventOp, LEGACY, ok, useEmulator, W } from './harness';

useEmulator();

const edit = (uid = 'owner') => {
  const a = as(uid);
  return {
    a,
    plan: saveGroup(a.ctx, { groupId: 'g1', name: 'Renamed', memberUids: ['alice'], isNew: false }),
  };
};
const mapEvent = (plan: ActionPlan, data: Record<string, unknown>): ActionPlan => ({
  ...plan,
  ops: plan.ops.map((op) =>
    op.path.includes('/events/') ? { ...op, data: { ...op.data, ...data } } : op,
  ),
});

describe('every domain write carries an event', () => {
  it('allows a group edit with its event', async () => {
    const { a, plan } = edit();
    await ok(a.run(plan));
  });
  it('ATTACK: denies writing without an event', async () => {
    const { a, plan } = edit();
    await denied(a.run(plan.ops.filter((op) => !op.path.includes('/events/'))));
  });
  it('ATTACK: denies pointing lastEventId at an old event', async () => {
    const { a, plan } = edit();
    const reuse = plan.ops
      .filter((op) => !op.path.includes('/events/'))
      .map((op) => ({ ...op, data: { ...op.data, lastEventId: 'seed' } }));
    await denied(a.run(reuse));
  });
  it('ATTACK: denies an event attributed to someone else', async () => {
    const { a, plan } = edit();
    await denied(a.run(mapEvent(plan, { actor: { type: 'human', id: 'bob', name: 'Bob' } })));
  });
  it('ATTACK: denies an event with a client-chosen time', async () => {
    const { a, plan } = edit();
    await denied(a.run(mapEvent(plan, { at: Timestamp.fromMillis(Date.now() - 3_600_000) })));
  });
  it('ATTACK: denies an event of the wrong type, or naming a project, item or run', async () => {
    const { a, plan } = edit();
    await denied(a.run(mapEvent(plan, { type: 'group.deleted' })));
    await denied(a.run(mapEvent(plan, { projectId: 'p1' })));
    await denied(a.run(mapEvent(plan, { itemId: 'i1' })));
    await denied(a.run(mapEvent(plan, { runId: 'r1' })));
  });
  it('ATTACK: denies an agent writing any workspace event', async () => {
    const ag = as(AGENTS.star);
    for (const type of ['workspace.updated', 'run.started', 'item.claimed', 'agent.updated'])
      await denied(ag.run([eventOp(ag, `e-${type}`, { type })]));
    // control: a workspace event by a member is allowed
    const a = as('alice');
    await ok(a.run([eventOp(a, 'e2', { type: 'workspace.updated' })]));
  });
  it('denies an event with extra or missing fields', async () => {
    const a = as('alice');
    await denied(a.run([eventOp(a, 'e1', { extra: 1 })]));
    const op = eventOp(a, 'e2');
    const { at: _at, ...noAt } = op.data!;
    void _at;
    await denied(a.run([{ ...op, data: noAt }]));
  });
});

describe('events are append-only', () => {
  it('ATTACK: denies editing or deleting an event, for everyone', async () => {
    for (const uid of ['owner', 'alice', AGENTS.a]) {
      const x = as(uid);
      await denied(updateDoc(doc(x.db, paths.event(W, 'seed')), { type: 'group.updated' }));
      await denied(deleteDoc(doc(x.db, paths.event(W, 'seed'))));
    }
  });
  it('ATTACK: denies overwriting an existing event id with set()', async () => {
    const a = as('owner');
    await denied(
      setDoc(doc(a.db, paths.event(W, 'seed')), {
        actor: { type: 'human', id: 'owner', name: 'Owner' },
        projectId: null,
        itemId: null,
        runId: null,
        type: 'workspace.updated',
        data: {},
        at: SERVER_TIME as never,
      }),
    );
  });
  it('members read workspace events; old project events only admins; agents and outsiders nothing', async () => {
    await ok(getDoc(doc(as('dave').db, paths.event(W, 'seed'))));
    await denied(getDoc(doc(as('dave').db, LEGACY.projectEvent)));
    await ok(getDoc(doc(as('owner').db, LEGACY.projectEvent)));
    await denied(getDoc(doc(as(AGENTS.a).db, paths.event(W, 'seed'))));
    await denied(getDoc(doc(as('eve').db, paths.event(W, 'seed'))));
    const col = (uid: string) => collection(as(uid).db, `workspaces/${W}/events`);
    await ok(getDocs(query(col('dave'), where('projectId', '==', null))));
    await denied(getDocs(col('dave')));
    await ok(getDocs(col('owner')));
    await denied(getDocs(query(col(AGENTS.a), where('projectId', '==', 'p1'))));
  });
});
