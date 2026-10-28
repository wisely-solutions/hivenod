/**
 * Card st5INNZj: per-item paths. Every allow and deny of the path rules: shaping, moving along a
 * path, changing it, people-step requests and their decisions, library changes and proposals.
 * The promise under test: an agent never adds or drops a people step on a path by itself.
 */
import { describe, expect, it } from 'vitest';
import {
  approve,
  claimItem,
  completeStep,
  createItem,
  DELETE_FIELD,
  saveProcess,
  sendBack,
  SERVER_TIME,
  setShapeNewItems,
  stopWork,
  type ActionPlan,
  type ItemState,
  type WriteOp,
} from '../src/actions';
import {
  acceptProposal,
  askPathChange,
  decidePathChange,
  proposeStep,
  rejectProposal,
  shapeItem,
  skipStep,
  fullProcessPlan,
} from '../src/pathActions';
import { nextOnPath, pathOf } from '../src/itempath';
import { buildStepIndex, paths, type Step } from '../src/schema';
import {
  AGENTS,
  as,
  denied,
  gate,
  I,
  itemDoc,
  now,
  ok,
  P,
  put,
  snap,
  useEmulator,
  W,
  type As,
} from './harness';

useEmulator();

/** The library: agent steps and three gates (alice decides all; bob also decides Accept). */
const LIB: Step[] = [
  { id: 'intake', name: 'Intake', kind: 'agent', description: '' },
  { id: 'research', name: 'Research', kind: 'agent', description: '' },
  {
    id: 'go',
    name: 'Go/no-go',
    kind: 'human',
    description: '',
    gate: gate({ deciderUids: ['alice'] }),
  },
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'test', name: 'Test', kind: 'agent', description: '' },
  {
    id: 'accept',
    name: 'Accept',
    kind: 'human',
    description: '',
    gate: gate({ deciderUids: ['alice', 'bob'] }),
  },
  {
    id: 'release',
    name: 'Release',
    kind: 'human',
    description: '',
    gate: gate({ deciderUids: ['alice'] }),
  },
];
const project = { steps: LIB };
const PID = 'pp';
const IID = 'it';
const STAR = AGENTS.star;

function libDoc(steps: Step[] = LIB, extra: Record<string, unknown> = {}) {
  return {
    name: 'Paths',
    emoji: '🐝',
    color: '#2F5FD0',
    templateId: 'system',
    steps,
    stepIndex: buildStepIndex(steps),
    memberUids: ['alice', 'bob', 'carol', 'dave'],
    createdBy: 'carol',
    createdAt: now(),
    archivedAt: null,
    lastEventId: 'seed',
    ...extra,
  };
}
const runDoc = (stepId: string, job?: 'shape') => ({
  agentUid: STAR,
  projectId: PID,
  itemId: IID,
  stepId,
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
  ...(job ? { job } : {}),
  lastEventId: 'seed',
});
const claim = () => ({ runId: 'r1', agentUid: STAR, heartbeatAt: now() });
const by = { type: 'agent', id: STAR };

async function seed(item: Record<string, unknown>, opts: { run?: string; job?: 'shape' } = {}) {
  await put({
    [P(PID)]: libDoc(),
    [I(IID, PID)]: itemDoc(item),
    ...(opts.run ? { [paths.run(W, 'r1')]: runDoc(opts.run, opts.job) } : {}),
  });
  return (await snap(I(IID, PID))) as unknown as ItemState;
}
const unshapedDoc = (over: Record<string, unknown> = {}) => ({
  stepId: 'intake',
  status: 'queued',
  shape: null,
  ...over,
});
/** A shaped item at `stepId` that skips `skips`. */
const shapedDoc = (
  skips: Record<string, string>,
  stepId: string,
  over: Record<string, unknown> = {},
) => {
  const human = LIB.find((s) => s.id === stepId)!.kind === 'human';
  const isGate = (id: string) => LIB.find((s) => s.id === id)!.kind === 'human';
  const pick = (gate: boolean) =>
    Object.fromEntries(Object.entries(skips).filter(([id]) => isGate(id) === gate));
  return {
    stepId,
    status: human ? 'waiting' : 'queued',
    gate: human ? { stepId, approvals: {}, rejections: {} } : null,
    shape: { by, at: now(), note: 'short' },
    pathSkips: pick(false),
    ...(Object.keys(pick(true)).length ? { gateSkips: pick(true) } : {}),
    pathRequests: {},
    pathRev: 1,
    ...over,
  };
};
/** The item, held by the agent at its (agent) step. */
const heldDoc = (
  skips: Record<string, string>,
  stepId: string,
  over: Record<string, unknown> = {},
) => shapedDoc(skips, stepId, { status: 'working', claim: claim(), ...over });
const pending = (op: 'add' | 'drop') => ({
  op,
  by,
  reason: 'Nothing to do for this one',
  at: now(),
});

const where = (item: ItemState) => ({ project, projectId: PID, itemId: IID, item });
/** Rewrites the item op of a plan (what a cheating client sends). */
function forge(plan: Pick<ActionPlan, 'ops'>, data: Record<string, unknown>): { ops: WriteOp[] } {
  return {
    ops: plan.ops.map((op) =>
      op.path === I(IID, PID) ? { ...op, data: { ...op.data, ...data } } : op,
    ),
  };
}
/** Rewrites the event data of a plan. */
function forgeEvent(plan: Pick<ActionPlan, 'ops'>, data: Record<string, unknown>) {
  return {
    ops: plan.ops.map((op) =>
      op.path.includes('/events/')
        ? { ...op, data: { ...op.data, data: { ...(op.data!.data as object), ...data } } }
        : op,
    ),
  };
}
/** The same plan as written by someone else (actor swapped). */
function forgeAs(plan: Pick<ActionPlan, 'ops'>, who: As) {
  return {
    ops: plan.ops.map((op) =>
      op.path.includes('/events/')
        ? { ...op, data: { ...op.data, actor: { type: 'human', id: who.uid, name: who.uid } } }
        : op,
    ),
  };
}
/** Commits a shaping: its people-step asks first, then the shape. */
async function shapeAll(a: As, p: ReturnType<typeof shapeItem>) {
  for (const ask of p.asks) await ok(a.run(ask));
  await ok(a.run(p));
}
const item = async () => snap(I(IID, PID));
const fresh = async () => (await item()) as unknown as ItemState;
const agent = () => as(STAR);

// ---------------------------------------------------------------------------

describe('unshaped items', () => {
  it('a person creates an item that waits to be shaped, only at the first step', async () => {
    await put({ [P(PID)]: libDoc() });
    const d = as('dave');
    const p = createItem(d.ctx, {
      project,
      projectId: PID,
      itemId: IID,
      title: 'Fix typo',
      type: 'bug',
      unshaped: true,
    });
    await denied(d.run(forge(p, { stepId: 'build' })));
    await denied(d.run(forge(p, { status: 'waiting' })));
    await denied(
      d.run(forge(p, { shape: { by: { type: 'human', id: 'dave' }, at: SERVER_TIME, note: '' } })),
    );
    await ok(d.run(p));
    expect((await item()).shape).toBeNull();
    expect((await item()).status).toBe('queued');
  });

  it('an agent takes an unshaped item only as a shaping run, whatever the step limits', async () => {
    await put({ [P(PID)]: libDoc(LIB, { stepAgents: { intake: ['someoneElse'] } }) });
    const it0 = await seed(unshapedDoc());
    const a = agent();
    await denied(a.run(claimItem(a.ctx, { projectId: PID, itemId: IID, item: it0, runId: 'r1' })));
    await ok(
      a.run(
        claimItem(a.ctx, { projectId: PID, itemId: IID, item: it0, runId: 'r1', job: 'shape' }),
      ),
    );
    expect((await snap(paths.run(W, 'r1'))).job).toBe('shape');
  });

  it('a shaping run at a first step that is a people step can be stopped', async () => {
    const steps = [LIB[2]!, ...LIB.filter((x) => x.id !== 'go')];
    await put({
      [P(PID)]: libDoc(steps),
      [I(IID, PID)]: itemDoc(unshapedDoc({ stepId: 'go', status: 'working', claim: claim() })),
      [paths.run(W, 'r1')]: runDoc('go', 'shape'),
    });
    const it0 = await fresh();
    const o = as('owner');
    const p = stopWork(o.ctx, {
      project: { steps },
      projectId: PID,
      itemId: IID,
      item: it0,
      mode: 'back',
      reason: '',
      run: { costEur: 0, endedAt: null },
    });
    await ok(o.run(p));
    expect((await item()).claim).toBeNull();
  });

  it('nobody decides an unshaped item, even one left waiting at a gate', async () => {
    const it0 = await seed(
      unshapedDoc({
        stepId: 'go',
        status: 'waiting',
        gate: { stepId: 'go', approvals: {}, rejections: {} },
      }),
    );
    const al = as('alice');
    await denied(al.run(approve(al.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
  });

  it('an agent cannot complete step work on an unshaped item', async () => {
    const it0 = await seed(unshapedDoc({ status: 'working', claim: claim() }), { run: 'intake' });
    const a = agent();
    await denied(a.run(completeStep(a.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
  });
});

describe('shaping', () => {
  const held = () =>
    seed(unshapedDoc({ status: 'working', claim: claim() }), { run: 'intake', job: 'shape' });

  it('an agent shapes the item it holds: gates it would skip become pending requests', async () => {
    const it0 = await held();
    const a = agent();
    const p = shapeItem(a.ctx, {
      ...where(it0),
      skips: {
        research: 'Copy only',
        test: 'Nothing to test',
        go: 'Tiny change',
        release: 'Ships with the next deploy',
      },
      note: 'copy change',
    });
    expect(p.pending).toEqual(['go', 'release']);
    // The shape cannot carry requests itself (their content is checked one by one).
    await denied(
      a.run(
        forge(p, {
          pathRequests: {
            go: { op: 'drop', by: { type: 'human', id: 'alice' }, reason: 'x', at: SERVER_TIME },
          },
        }),
      ),
    );
    await shapeAll(a, p);
    const d = await item();
    expect(d.pathSkips).toEqual({ research: 'Copy only', test: 'Nothing to test' });
    expect(d.status).toBe('queued');
    expect(d.stepId).toBe('intake');
    expect(d.claim).toBeNull();
    expect(Object.keys(d.pathRequests as object).sort()).toEqual(['go', 'release']);
    expect((await snap(paths.run(W, 'r1'))).status).toBe('done');
  });

  it('an agent cannot skip a gate itself', async () => {
    const it0 = await held();
    const a = agent();
    const p = shapeItem(a.ctx, { ...where(it0), skips: { research: 'x' }, note: 'x' });
    await denied(a.run(forge(p, { gateSkips: { go: 'x' } })));
    // A people step listed with the agent steps is not skipped: the item still stops there.
    await ok(a.run(forge(p, { pathSkips: { research: 'x', go: 'x' } })));
    const it1 = await fresh();
    expect(nextOnPath(project, { ...it1, stepId: 'research' })?.id).toBe('go');
  });

  it('the item arrives at the first step on its path, never past a gate', async () => {
    const it0 = await held();
    const a = agent();
    const p = shapeItem(a.ctx, { ...where(it0), skips: { intake: 'x', research: 'y' }, note: 'x' });
    await denied(a.run(forge(p, { stepId: 'build', status: 'queued', gate: null })));
    await denied(a.run(forge(p, { stepId: 'intake', status: 'queued', gate: null })));
    await ok(a.run(p));
    expect((await item()).stepId).toBe('go');
    expect((await item()).status).toBe('waiting');
  });

  it('only the holding agent shapes, and its shaping run ends with it', async () => {
    const it0 = await held();
    const a = agent();
    const p = shapeItem(a.ctx, { ...where(it0), skips: {}, note: 'x' });
    await denied(a.run({ ops: p.ops.filter((o) => !o.path.includes('/runs/')) }));
    const other = as(AGENTS.a);
    const theirs = shapeItem(other.ctx, {
      ...where({ ...it0, claim: { ...it0.claim!, agentUid: AGENTS.a } }),
      skips: {},
      note: 'x',
    });
    await denied(other.run(theirs));
  });

  it('a person shapes: agent steps skipped at once, gates become requests', async () => {
    const it0 = await seed(unshapedDoc());
    const d = as('dave');
    const p = shapeItem(d.ctx, {
      ...where(it0),
      skips: { research: 'r', release: 'no' },
      note: 'small',
    });
    expect(p.pending).toEqual(['release']);
    for (const ask of p.asks) await ok(d.run(ask));
    await denied(d.run(forge(p, { gateSkips: { release: 'no' } })));
    await ok(d.run(p));
    expect((await item()).pathRequests).toMatchObject({ release: { op: 'drop' } });
    expect((await item()).pathSkips).toEqual({ research: 'r' });
  });

  it('a decider shaping approves their own gate skip right after (recorded as their decision)', async () => {
    const it0 = await seed(unshapedDoc());
    const al = as('alice');
    const p = shapeItem(al.ctx, {
      ...where(it0),
      skips: { release: 'Static page' },
      note: 'small',
    });
    await shapeAll(al, p);
    await ok(
      al.run(
        decidePathChange(al.ctx, { ...where(await fresh()), stepId: 'release', approve: true }),
      ),
    );
    expect((await item()).gateSkips).toEqual({ release: 'Static page' });
  });

  it('an archived unshaped item cannot be shaped back to life', async () => {
    const it0 = await seed(unshapedDoc({ status: 'stopped', archivedAt: now() }));
    const d = as('dave');
    await denied(d.run(fullProcessPlan(d.ctx, where({ ...it0, status: 'queued' }))));
  });

  it('"Use the full process" puts every step on the path', async () => {
    const it0 = await seed(unshapedDoc());
    const d = as('dave');
    await ok(d.run(fullProcessPlan(d.ctx, where(it0))));
    expect((await item()).pathSkips).toEqual({});
    expect((await item()).shape).toMatchObject({ by: { type: 'human', id: 'dave' } });
  });

  it('a person cannot shape an item an agent is shaping; an outsider never', async () => {
    const it0 = await held();
    const d = as('dave');
    await denied(d.run(fullProcessPlan(d.ctx, where({ ...it0, claim: null }))));
    const e = as('eve');
    await denied(e.run(fullProcessPlan(e.ctx, where({ ...it0, claim: null }))));
  });
});

describe('moving along a path', () => {
  const skips = { research: 'r', test: 't' };

  it('completing goes to the next step not skipped', async () => {
    const it0 = await seed(heldDoc(skips, 'intake'), { run: 'intake' });
    const a = agent();
    await ok(a.run(completeStep(a.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
    const d = await item();
    expect(d.stepId).toBe('go');
    expect(d.status).toBe('waiting');
  });

  it('an old client moving to a skipped step is refused', async () => {
    const it0 = await seed(heldDoc(skips, 'intake'), { run: 'intake' });
    const a = agent();
    const legacy = completeStep(a.ctx, {
      project,
      projectId: PID,
      itemId: IID,
      item: { ...it0, pathSkips: undefined },
    });
    await denied(a.run(legacy));
  });

  it('a people step written among the agent skips is not skipped', async () => {
    const it0 = await seed(heldDoc({}, 'research', { pathSkips: { go: 'forged' } }), {
      run: 'research',
    });
    const a = agent();
    const p = completeStep(a.ctx, { project, projectId: PID, itemId: IID, item: it0 });
    await denied(a.run(forge(p, { stepId: 'build', status: 'queued', gate: null })));
    await ok(a.run(p));
    expect((await item()).stepId).toBe('go');
  });

  it('cannot jump over a gate on the path', async () => {
    const it0 = await seed(heldDoc({ test: 't' }, 'build'), { run: 'build' });
    const a = agent();
    const p = completeStep(a.ctx, { project, projectId: PID, itemId: IID, item: it0 });
    await denied(
      a.run(
        forge(p, { stepId: 'release', gate: { stepId: 'release', approvals: {}, rejections: {} } }),
      ),
    );
    await denied(a.run(forge(p, { stepId: 'build', status: 'done', gate: null })));
    await ok(a.run(p));
    expect((await item()).stepId).toBe('accept');
  });

  it('approving a gate moves along the path; skipping the rest finishes it', async () => {
    let it0 = await seed(shapedDoc({ research: '', test: '', release: 'static' }, 'go'));
    const al = as('alice');
    await ok(al.run(approve(al.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
    expect((await item()).stepId).toBe('build');
    it0 = await seed(shapedDoc({ release: 'static' }, 'accept'));
    const b = as('bob');
    await ok(b.run(approve(b.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
    expect((await item()).status).toBe('done');
  });

  it('send back and move never land on a skipped step', async () => {
    const it0 = await seed(shapedDoc(skips, 'accept'));
    const b = as('bob');
    expect(() =>
      sendBack(b.ctx, { ...where(it0), toStepId: 'research', rationale: 'Needs research first' }),
    ).toThrow(/not on this item's path/);
    const p = sendBack(b.ctx, {
      ...where(it0),
      toStepId: 'build',
      rationale: 'The build is broken',
    });
    await denied(b.run(forge(p, { stepId: 'research', status: 'queued' })));
    await ok(b.run(p));
  });

  it('an item without skips still follows the whole library', async () => {
    const it0 = await seed(
      { stepId: 'intake', status: 'working', claim: claim() },
      { run: 'intake' },
    );
    const a = agent();
    await ok(a.run(completeStep(a.ctx, { project, projectId: PID, itemId: IID, item: it0 })));
    expect((await item()).stepId).toBe('research');
  });
});

describe('changing a path', () => {
  it('the agent holding the item skips and puts back agent steps ahead (logged)', async () => {
    const it0 = await seed(heldDoc({}, 'build'), { run: 'build' });
    const a = agent();
    const p = skipStep(a.ctx, { ...where(it0), stepId: 'test', skip: true, reason: 'No code' });
    await ok(a.run(p));
    expect((await item()).pathSkips).toEqual({ test: 'No code' });
    expect((await snap(paths.event(W, p.eventId))).data).toMatchObject({
      change: 'skip',
      stepId: 'test',
    });
    await ok(a.run(skipStep(a.ctx, { ...where(await fresh()), stepId: 'test', skip: false })));
    expect((await item()).pathSkips).toEqual({});
  });

  it('an agent cannot change steps already passed, its current step, or two at once', async () => {
    const it0 = await seed(heldDoc({}, 'build'), { run: 'build' });
    const a = agent();
    expect(() => skipStep(a.ctx, { ...where(it0), stepId: 'research', skip: true })).toThrow(
      /not ahead/,
    );
    const p = skipStep(a.ctx, { ...where(it0), stepId: 'test', skip: true, reason: 'x' });
    await denied(
      a.run(
        forgeEvent(forge(p, { 'pathSkips.test': DELETE_FIELD, 'pathSkips.research': 'x' }), {
          stepId: 'research',
        }),
      ),
    );
    await denied(a.run(forge(p, { 'pathSkips.intake': 'x' })));
    await denied(
      a.run(
        forgeEvent(forge(p, { 'pathSkips.test': DELETE_FIELD, 'pathSkips.build': 'x' }), {
          stepId: 'build',
        }),
      ),
    );
  });

  it('an agent cannot skip or put back a people step', async () => {
    const it0 = await seed(heldDoc({ release: 'static' }, 'build'), { run: 'build' });
    const a = agent();
    expect(() => skipStep(a.ctx, { ...where(it0), stepId: 'accept', skip: true })).toThrow(
      /people step/,
    );
    const p = skipStep(a.ctx, { ...where(it0), stepId: 'test', skip: true, reason: 'x' });
    await denied(
      a.run(
        forgeEvent(forge(p, { 'pathSkips.test': DELETE_FIELD, 'gateSkips.accept': 'x' }), {
          stepId: 'accept',
        }),
      ),
    );
    await denied(
      a.run(
        forgeEvent(
          forge(p, { 'pathSkips.test': DELETE_FIELD, 'gateSkips.release': DELETE_FIELD }),
          { stepId: 'release', change: 'unskip' },
        ),
      ),
    );
  });

  it('an agent that does not hold the item cannot change its path', async () => {
    const it0 = await seed(shapedDoc({}, 'build'));
    const a = agent();
    const p = skipStep(a.ctx, {
      ...where({ ...it0, claim: claim() as never }),
      stepId: 'test',
      skip: true,
    });
    await denied(a.run(p));
  });

  it('a person changes agent steps; only a decider skips their own gate at once', async () => {
    const it0 = await seed(shapedDoc({}, 'build'));
    const d = as('dave');
    await ok(d.run(skipStep(d.ctx, { ...where(it0), stepId: 'test', skip: true, reason: 'none' })));
    const it1 = await fresh();
    expect(() => skipStep(d.ctx, { ...where(it1), stepId: 'release', skip: true })).toThrow(
      /people step/,
    );
    const al = as('alice');
    const p = skipStep(al.ctx, {
      ...where(await fresh()),
      stepId: 'release',
      skip: true,
      reason: 'static',
    });
    await denied(d.run(forgeAs(p, d)));
    await ok(al.run(p));
    expect((await item()).pathSkips).toEqual({ test: 'none' });
    expect((await item()).gateSkips).toEqual({ release: 'static' });
  });
});

describe('people-step requests', () => {
  it('an agent asks to skip a gate; only a decider of that gate settles it', async () => {
    const it0 = await seed(heldDoc({}, 'build'), { run: 'build' });
    const a = agent();
    await ok(
      a.run(
        askPathChange(a.ctx, {
          ...where(it0),
          stepId: 'release',
          reason: 'Ships with the next deploy',
        }),
      ),
    );
    const it1 = await fresh();
    expect(it1.pathRequests?.release?.op).toBe('drop');
    expect(it1.pathSkips).toEqual({});
    const b = as('bob');
    expect(() =>
      decidePathChange(b.ctx, { ...where(it1), stepId: 'release', approve: true }),
    ).toThrow();
    const al = as('alice');
    const p = decidePathChange(al.ctx, { ...where(it1), stepId: 'release', approve: true });
    await denied(b.run(forgeAs(p, b)));
    await ok(al.run(p));
    expect((await item()).gateSkips).toEqual({ release: 'Ships with the next deploy' });
    expect((await item()).pathRequests).toEqual({});
  });

  it('after a refusal agents cannot ask again; people can', async () => {
    const it0 = await seed(shapedDoc({}, 'build'));
    const d = as('dave');
    await ok(
      d.run(
        askPathChange(d.ctx, { ...where(it0), stepId: 'release', reason: 'Nothing to release' }),
      ),
    );
    const al = as('alice');
    await ok(
      al.run(
        decidePathChange(al.ctx, { ...where(await fresh()), stepId: 'release', approve: false }),
      ),
    );
    expect((await item()).pathRefused).toEqual(['release']);
    expect((await item()).gateSkips ?? {}).toEqual({});
    await put({
      [I(IID, PID)]: { ...(await item()), status: 'working', claim: claim() },
      [paths.run(W, 'r1')]: runDoc('build'),
    });
    const it1 = await fresh();
    const a = agent();
    expect(() =>
      askPathChange(a.ctx, { ...where(it1), stepId: 'release', reason: 'Really no release' }),
    ).toThrow(/already kept/);
    await denied(
      a.run(
        askPathChange(a.ctx, {
          ...where({ ...it1, pathRefused: [] }),
          stepId: 'release',
          reason: 'Really no release',
        }),
      ),
    );
    await ok(
      d.run(askPathChange(d.ctx, { ...where(it1), stepId: 'release', reason: 'Asking once more' })),
    );
  });

  it('approving the skip of the gate the item waits at moves it on', async () => {
    const it0 = await seed(
      shapedDoc({ research: '', test: '' }, 'accept', {
        pathRequests: { accept: pending('drop') },
      }),
    );
    const b = as('bob');
    const p = decidePathChange(b.ctx, { ...where(it0), stepId: 'accept', approve: true });
    await denied(b.run(forge(p, { stepId: 'release', status: 'queued', gate: null })));
    await ok(b.run(p));
    const d = await item();
    expect(d.stepId).toBe('release');
    expect(d.status).toBe('waiting');
    expect(Object.keys(d.pathSkips as object).sort()).toEqual(['research', 'test']);
    expect(Object.keys(d.gateSkips as object)).toEqual(['accept']);
  });

  it('a decider approves putting a skipped gate back on the path', async () => {
    const it0 = await seed(heldDoc({ go: 'tiny' }, 'intake'), { run: 'intake' });
    const a = agent();
    await ok(
      a.run(askPathChange(a.ctx, { ...where(it0), stepId: 'go', reason: 'This one is risky' })),
    );
    const it1 = await fresh();
    expect(it1.pathRequests?.go?.op).toBe('add');
    const al = as('alice');
    await ok(al.run(decidePathChange(al.ctx, { ...where(it1), stepId: 'go', approve: true })));
    expect((await item()).gateSkips).toEqual({});
  });

  it('requests are only for people steps ahead, with a reason of 10 characters', async () => {
    const it0 = await seed(heldDoc({}, 'build'), { run: 'build' });
    const a = agent();
    expect(() =>
      askPathChange(a.ctx, { ...where(it0), stepId: 'test', reason: 'Add the tests' }),
    ).toThrow(/agent step/);
    expect(() =>
      askPathChange(a.ctx, { ...where(it0), stepId: 'go', reason: 'Skip the go/no-go' }),
    ).toThrow(/not ahead/);
    const p = askPathChange(a.ctx, {
      ...where(it0),
      stepId: 'accept',
      reason: 'Nothing to accept',
    });
    const q = (p.ops[0]!.data as Record<string, unknown>)['pathRequests.accept'];
    await denied(
      a.run(
        forgeEvent(forge(p, { 'pathRequests.accept': DELETE_FIELD, 'pathRequests.go': q }), {
          stepId: 'go',
        }),
      ),
    );
    await denied(a.run(forge(p, { 'pathRequests.accept': { ...(q as object), reason: 'short' } })));
    await denied(a.run(forge(p, { 'pathRequests.accept': { ...(q as object), op: 'add' } })));
    await ok(a.run(p));
  });
});

describe('library changes', () => {
  it('removing the current step of an item moves it on over the steps it skips', async () => {
    const it0 = await seed(shapedDoc({ test: 't' }, 'build'));
    const c = as('carol');
    const steps = LIB.filter((s) => s.id !== 'build');
    const p = saveProcess(c.ctx, {
      projectId: PID,
      steps,
      before: LIB,
      moves: [{ itemId: IID, toStepId: 'accept' }],
    });
    await ok(c.run(p));
    expect((await item()).stepId).toBe('accept');
    void it0;
  });
});

describe('step proposals', () => {
  const proposal = {
    name: 'Legal review',
    kind: 'human' as const,
    description: 'Check the terms',
    afterStepId: 'test',
    deciderUids: ['bob'],
    reason: 'The change touches the terms of service',
  };
  const propose = async () => {
    const it0 = await seed(heldDoc({ research: '' }, 'build'), { run: 'build' });
    const a = agent();
    const p = proposeStep(a.ctx, {
      project,
      projectId: PID,
      itemId: IID,
      item: it0,
      proposal,
      proposalId: 'sp1',
    });
    await ok(a.run(p));
    return snap(paths.stepProposal(W, PID, 'sp1'));
  };
  const legal: Step = {
    id: 'legal',
    name: 'Legal review',
    kind: 'human',
    description: 'Check the terms',
    gate: gate({ deciderUids: ['carol'] }),
  };

  it('an agent working an item proposes a step; others cannot', async () => {
    const it0 = await seed(shapedDoc({}, 'build'));
    const a = agent();
    await denied(
      a.run(
        proposeStep(a.ctx, {
          project,
          projectId: PID,
          itemId: IID,
          item: { ...it0, claim: claim() as never },
          proposal,
        }),
      ),
    );
    await propose();
    const rd = await import('firebase/firestore');
    await ok(rd.getDoc(rd.doc(agent().db, paths.stepProposal(W, PID, 'sp1'))));
  });

  it("the project's creator adds it to the library; it is on the proposing item's path", async () => {
    const sp = await propose();
    const d = as('dave');
    const input = {
      project: { steps: LIB, memberUids: ['alice', 'bob', 'carol', 'dave'] },
      projectId: PID,
      proposalId: 'sp1',
      proposal: sp as never,
      step: legal,
    };
    await denied(d.run(acceptProposal(d.ctx, input)));
    const c = as('carol');
    await ok(c.run(acceptProposal(c.ctx, input)));
    const pr = await snap(P(PID));
    expect((pr.steps as Step[]).map((s) => s.id)).toContain('legal');
    expect(pathOf({ steps: pr.steps as Step[] }, (await item()) as never)).toContain('legal');
    expect((await snap(paths.stepProposal(W, PID, 'sp1'))).status).toBe('accepted');
  });

  it('a rejection needs a reason of 10 characters', async () => {
    await propose();
    const o = as('owner');
    expect(() =>
      rejectProposal(o.ctx, { projectId: PID, proposalId: 'sp1', itemId: IID, reason: 'no' }),
    ).toThrow();
    const p = rejectProposal(o.ctx, {
      projectId: PID,
      proposalId: 'sp1',
      itemId: IID,
      reason: 'We use the checklist',
    });
    const d = as('dave');
    await denied(
      d.run(
        rejectProposal(d.ctx, {
          projectId: PID,
          proposalId: 'sp1',
          itemId: IID,
          reason: 'We use the checklist',
        }),
      ),
    );
    await ok(o.run(p));
    expect((await snap(paths.stepProposal(W, PID, 'sp1'))).decision).toMatchObject({
      reason: 'We use the checklist',
    });
  });
});

describe('the project switch "Shape new items"', () => {
  it("admins and the project's creator switch it; other members cannot", async () => {
    await put({ [P(PID)]: libDoc() });
    const d = as('dave');
    await denied(d.run(setShapeNewItems(d.ctx, { projectId: PID, on: true })));
    const c = as('carol');
    await ok(c.run(setShapeNewItems(c.ctx, { projectId: PID, on: true })));
    expect((await snap(P(PID))).shapeNewItems).toBe(true);
    const o = as('owner');
    await ok(o.run(setShapeNewItems(o.ctx, { projectId: PID, on: false })));
    expect((await snap(P(PID))).shapeNewItems).toBe(false);
  });
});
