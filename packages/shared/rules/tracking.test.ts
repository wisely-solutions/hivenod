/**
 * SPEC §5.3: tracking is enforced. Every domain write needs its event in the same batch
 * (existsAfter, actor == auth uid, at == request.time, matching scope); events are create-only.
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
import { describe, expect, it } from 'vitest';
import {
  claimItem,
  archiveProject,
  restoreProject,
  createProject,
  saveProcess,
  SERVER_TIME,
  updateItem,
  type ActionPlan,
  type ItemState,
} from '../src/actions';
import { stepsFor, templateById } from '../src/templates';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  eventOp,
  I,
  itemDoc,
  ok,
  put,
  snap,
  steps,
  useEmulator,
  W,
} from './harness';

useEmulator();

const edit = (uid = 'alice') => {
  const a = as(uid);
  return {
    a,
    plan: updateItem(a.ctx, { projectId: 'p1', itemId: 'i1', changes: { title: 'Renamed' } }),
  };
};
const mapEvent = (plan: ActionPlan, data: Record<string, unknown>): ActionPlan => ({
  ...plan,
  ops: plan.ops.map((op) =>
    op.path.includes('/events/') ? { ...op, data: { ...op.data, ...data } } : op,
  ),
});

describe('every domain write carries an event', () => {
  it('allows an item edit with its event', async () => {
    const { a, plan } = edit();
    await ok(a.run(plan));
  });
  it('ATTACK: denies writing an item without an event', async () => {
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
  it('ATTACK: denies an event about a different item or of the wrong type', async () => {
    const { a, plan } = edit();
    await denied(a.run(mapEvent(plan, { itemId: 'gated' })));
    await denied(a.run(mapEvent(plan, { type: 'item.created' })));
  });
  it('ATTACK: denies an agent emitting a human-only event type', async () => {
    const ag = as(AGENTS.a);
    await denied(ag.run([eventOp(ag, 'e1', { type: 'decision.approved', itemId: 'gated' })]));
    await ok(ag.run([eventOp(ag, 'e2', { type: 'run.started' })]));
  });
  it('ATTACK: denies an agent event outside its projects or without a project', async () => {
    const ag = as(AGENTS.a);
    await denied(ag.run([eventOp(ag, 'e1', { type: 'run.started', projectId: 'p2' })]));
    await denied(ag.run([eventOp(ag, 'e2', { type: 'run.started', projectId: null })]));
  });
  it('denies an event with extra or missing fields', async () => {
    const a = as('alice');
    await denied(a.run([eventOp(a, 'e1', { extra: 1 })]));
    const op = eventOp(a, 'e2');
    const { at: _at, ...noAt } = op.data!;
    void _at;
    await denied(a.run([{ ...op, data: noAt }]));
  });
  it('ATTACK: denies an agent claim batch without an event', async () => {
    const ag = as(AGENTS.a);
    const p = claimItem(ag.ctx, {
      projectId: 'p1',
      itemId: 'i1',
      item: itemDoc() as unknown as ItemState,
    });
    await denied(ag.run(p.ops.filter((op) => !op.path.includes('/events/'))));
  });
  it('allows project create / process change with events; denies them without', async () => {
    const a = as('alice');
    const c = createProject(a.ctx, {
      projectId: 'p9',
      name: 'New',
      emoji: '',
      color: '',
      templateId: 'blank',
      steps: steps(),
    });
    await denied(a.run(c.ops.filter((op) => !op.path.includes('/events/'))));
    await ok(a.run(c));
    const s = saveProcess(a.ctx, { projectId: 'p9', steps: steps({ rule: 'all' }) });
    await denied(a.run(s.ops.filter((op) => !op.path.includes('/events/'))));
    await ok(a.run(s));
  });
  it('projects have no budget: new ones cannot store one, older stored ones are kept as they are', async () => {
    const a = as('alice');
    const withBudget = (plan: ActionPlan): ActionPlan => ({
      ...plan,
      ops: plan.ops.map((op) =>
        op.path.includes('/events/') ? op : { ...op, data: { ...op.data, budgetEur: 20 } },
      ),
    });
    const c = createProject(a.ctx, {
      projectId: 'p11',
      name: 'No budget',
      emoji: '',
      color: '',
      templateId: 'blank',
      steps: steps(),
    });
    await denied(a.run(withBudget(c)));
    await ok(a.run(c));
    // p1 is seeded like an older project, with a stored budget: it still saves, the budget stays put.
    const s = saveProcess(a.ctx, { projectId: 'p1', steps: steps({ rule: 'all' }) });
    await denied(a.run(withBudget(s)));
    await ok(a.run(s));
    expect((await snap(paths.project(W, 'p1'))).budgetEur).toBe(10);
  });
  it('creates a project from every template; archive and undo are tracked', async () => {
    const a = as('alice');
    const t = templateById('build-a-system')!;
    const c = createProject(a.ctx, {
      projectId: 'p10',
      name: 'From template',
      emoji: t.emoji,
      color: 'agent-2',
      templateId: t.id,
      steps: stepsFor(t, 'alice'),
    });
    await ok(a.run(c));
    // Only an admin archives or restores; the member who created it cannot.
    const adm = as('owner');
    const arch = archiveProject(adm.ctx, { projectId: 'p10', name: 'From template' });
    await denied(adm.run(arch.ops.filter((op) => !op.path.includes('/events/'))));
    await ok(adm.run(arch));
    const back = restoreProject(adm.ctx, { projectId: 'p10', name: 'From template' });
    await denied(adm.run(back.ops.filter((op) => !op.path.includes('/events/'))));
    await ok(adm.run(back));
  });
  it('ATTACK: denies a plain member archiving or restoring a project', async () => {
    const a = as('alice');
    await denied(a.run(archiveProject(a.ctx, { projectId: 'p1', name: 'Blog' })));
    const adm = as('owner');
    await ok(adm.run(archiveProject(adm.ctx, { projectId: 'p1', name: 'Blog' })));
    await denied(a.run(restoreProject(a.ctx, { projectId: 'p1', name: 'Blog' })));
    await ok(adm.run(restoreProject(adm.ctx, { projectId: 'p1', name: 'Blog' })));
  });
  it('ATTACK: denies an agent changing the process (e.g. removing a gate)', async () => {
    const ag = as(AGENTS.a);
    const s = saveProcess(
      { ...ag.ctx, actor: { ...ag.ctx.actor, type: 'human' } },
      { projectId: 'p1', steps: steps() },
    );
    await denied(ag.run(s));
  });
});

describe('events are append-only', () => {
  it('ATTACK: denies editing or deleting an event, for everyone', async () => {
    for (const uid of ['owner', 'alice', AGENTS.a]) {
      const x = as(uid);
      await denied(updateDoc(doc(x.db, paths.event(W, 'seed')), { type: 'item.updated' }));
      await denied(deleteDoc(doc(x.db, paths.event(W, 'seed'))));
    }
  });
  it('ATTACK: denies overwriting an existing event id with set()', async () => {
    const a = as('owner');
    await denied(
      setDoc(doc(a.db, paths.event(W, 'seed')), {
        actor: { type: 'human', id: 'owner', name: 'Owner' },
        projectId: 'p1',
        itemId: null,
        runId: null,
        type: 'project.created',
        data: {},
        at: SERVER_TIME as never,
      }),
    );
  });
  it('allows members to read events; agents only their projects; outsiders nothing', async () => {
    await put({
      [paths.event(W, 'e-p2')]: {
        actor: { type: 'human', id: 'owner', name: 'Owner' },
        projectId: 'p2',
        itemId: null,
        runId: null,
        type: 'project.created',
        data: {},
        at: Timestamp.now(),
      },
    });
    await ok(getDoc(doc(as('dave').db, paths.event(W, 'e-p2'))));
    await ok(getDoc(doc(as(AGENTS.a).db, paths.event(W, 'seed'))));
    await denied(getDoc(doc(as(AGENTS.a).db, paths.event(W, 'e-p2'))));
    await denied(getDoc(doc(as('eve').db, paths.event(W, 'seed'))));
    const q = query(
      collection(as(AGENTS.a).db, `workspaces/${W}/events`),
      where('projectId', '==', 'p1'),
    );
    await ok(getDocs(q));
    await denied(getDocs(collection(as(AGENTS.a).db, `workspaces/${W}/events`)));
  });
});

describe('items cannot be deleted', () => {
  it('ATTACK: denies deleting an item (owner, member, agent)', async () => {
    for (const uid of ['owner', 'alice', AGENTS.star]) {
      await denied(deleteDoc(doc(as(uid).db, I('i1'))));
    }
  });
});
