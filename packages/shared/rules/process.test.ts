/** Card 09: the process editor. Who may save a process, and moving items off removed steps. */
import { describe, expect, it } from 'vitest';
import { MAX_MOVES_PER_SAVE, saveProcess } from '../src/actions';
import { defaultGate } from '../src/process';
import { buildStepIndex, type Step } from '../src/schema';
import {
  as,
  denied,
  eventOp,
  I,
  itemDoc,
  ok,
  P,
  projectDoc,
  put,
  snap,
  steps,
  useEmulator,
} from './harness';

useEmulator();

const without = (id: string) => steps().filter((s) => s.id !== id);

describe('saving a process', () => {
  it('lets an admin and a project member save, with a diff in the event', async () => {
    const before = steps();
    const after = [
      ...before,
      { id: 'extra', name: 'Extra', kind: 'agent', description: '' } as Step,
    ];
    const o = as('owner');
    await ok(o.run(saveProcess(o.ctx, { projectId: 'p1', steps: after, before })));
    expect(((await snap(P('p1'))).steps as Step[]).map((s) => s.id)).toContain('extra');
    const a = as('alice');
    await ok(a.run(saveProcess(a.ctx, { projectId: 'p1', steps: before, before: after })));
  });
  it('denies a member who is not on the project, and an organization outsider', async () => {
    await put({ [P('p1')]: projectDoc({}, { memberUids: ['alice'] }) });
    const b = as('bob');
    await denied(b.run(saveProcess(b.ctx, { projectId: 'p1', steps: without('publish') })));
    const e = as('eve');
    await denied(e.run(saveProcess(e.ctx, { projectId: 'p1', steps: without('publish') })));
  });
  it('denies an agent', async () => {
    const g = as('agentStar');
    await denied(g.run([{ kind: 'update', path: P('p1'), data: { steps: without('publish') } }]));
  });
});

describe('removing a step that holds items', () => {
  const open = (stepId: string) =>
    itemDoc({ stepId, status: stepId === 'review' ? 'waiting' : 'queued' });

  it('moves the item to an earlier step in the same batch', async () => {
    const o = as('owner');
    await ok(
      o.run(
        saveProcess(o.ctx, {
          projectId: 'p1',
          steps: without('draft'),
          before: steps(),
          moves: [{ itemId: 'i1', toStepId: 'intake' }],
        }),
      ),
    );
    expect((await snap(I('i1'))).stepId).toBe('intake');
  });
  it('lets a project member do it, and an agent step passes items to the next step', async () => {
    const a = as('alice');
    await ok(
      a.run(
        saveProcess(a.ctx, {
          projectId: 'p1',
          steps: without('draft'),
          moves: [{ itemId: 'i1', toStepId: 'review' }],
        }),
      ),
    );
    const it = await snap(I('i1'));
    expect(it.stepId).toBe('review');
    expect(it.status).toBe('waiting');
    expect(it.gate).toMatchObject({ stepId: 'review', approvals: {}, rejections: {} });
  });
  it('denies skipping ahead past a gate (a human step cannot hand items forward)', async () => {
    await put({ [I('g1')]: open('review') });
    const o = as('owner');
    await denied(
      o.run(
        saveProcess(o.ctx, {
          projectId: 'p1',
          steps: without('review'),
          moves: [{ itemId: 'g1', toStepId: 'publish' }],
        }),
      ),
    );
    await ok(
      o.run(
        saveProcess(o.ctx, {
          projectId: 'p1',
          steps: without('review'),
          moves: [{ itemId: 'g1', toStepId: 'draft' }],
        }),
      ),
    );
  });
  it('denies moving an item when its step is not removed', async () => {
    const o = as('owner');
    await denied(
      o.run([
        {
          kind: 'update',
          path: I('i1'),
          data: {
            stepId: 'review',
            status: 'waiting',
            claim: null,
            updatedAt: { __hive: 'serverTime' },
            lastEventId: 'm1',
            gate: { stepId: 'review', approvals: {}, rejections: {} },
          },
        },
        eventOp(o, 'm1', { type: 'item.moved', itemId: 'i1' }),
      ]),
    );
  });
  it('moves the most items one save allows', async () => {
    const docs: Record<string, Record<string, unknown>> = {};
    const moves = Array.from({ length: MAX_MOVES_PER_SAVE }, (_, i) => {
      docs[I(`bulk${i}`)] = open('draft');
      return { itemId: `bulk${i}`, toStepId: 'intake' };
    });
    await put(docs);
    const o = as('owner');
    await ok(o.run(saveProcess(o.ctx, { projectId: 'p1', steps: without('draft'), moves })));
    expect((await snap(I('bulk9'))).stepId).toBe('intake');
    expect(() =>
      saveProcess(o.ctx, {
        projectId: 'p1',
        steps: without('draft'),
        moves: [...moves, moves[0]!],
      }),
    ).toThrow();
  });
});

describe('who decides', () => {
  it('saves a changed gate and keeps stepIndex in step', async () => {
    const next = steps().map((s) =>
      s.id === 'review'
        ? { ...s, gate: { ...defaultGate(['alice', 'owner']), rule: 'all' as const } }
        : s,
    );
    const o = as('owner');
    await ok(o.run(saveProcess(o.ctx, { projectId: 'p1', steps: next, before: steps() })));
    const p = await snap(P('p1'));
    expect(p.stepIndex).toEqual(buildStepIndex(next));
    expect((p.steps as Step[]).find((s) => s.id === 'review')?.gate?.rule).toBe('all');
  });
});

describe('who decides: only admins, the creator and current deciders change a gate', () => {
  const withDeciders = (uids: string[]) =>
    steps().map((st) => (st.id === 'review' ? { ...st, gate: defaultGate(uids) } : st));
  const save = (who: string, next: Step[]) => {
    const a = as(who);
    return a.run(saveProcess(a.ctx, { projectId: 'p1', steps: next, before: steps() }));
  };

  it('denies a plain member making themselves a decider', async () => {
    await denied(save('dave', withDeciders(['alice', 'bob', 'carol', 'dave'])));
    await denied(save('dave', withDeciders(['dave'])));
  });
  it('denies a plain member changing the rule or reject policy of a gate', async () => {
    const next = steps().map((st) =>
      st.id === 'review' && st.gate ? { ...st, gate: { ...st.gate, rule: 'all' as const } } : st,
    );
    await denied(save('dave', next));
  });
  it('denies a plain member adding a new gate that already names deciders', async () => {
    const next = [
      ...steps(),
      {
        id: 'sign',
        name: 'Sign',
        kind: 'human',
        description: '',
        gate: defaultGate(['dave']),
      } as Step,
    ];
    await denied(save('dave', next));
  });
  it('lets a plain member edit steps and add a gate with nobody deciding yet', async () => {
    const next = [
      ...steps().map((st) => (st.id === 'draft' ? { ...st, name: 'Write' } : st)),
      { id: 'sign', name: 'Sign', kind: 'human', description: '', gate: defaultGate([]) } as Step,
    ];
    await ok(save('dave', next));
  });
  it('denies a plain member turning a gate with deciders into an agent step', async () => {
    await denied(
      save(
        'dave',
        steps().map((st) =>
          st.id === 'review'
            ? { id: st.id, name: st.name, kind: 'agent' as const, description: '' }
            : st,
        ),
      ),
    );
  });
  it('still evaluates within the rules budget on a long process', async () => {
    const long: Step[] = [
      ...steps(),
      ...Array.from({ length: 26 }, (_, i) => ({
        id: `x${i}`,
        name: `X${i}`,
        kind: 'agent' as const,
        description: '',
      })),
    ];
    await put({
      [P('p1')]: projectDoc({}, { steps: long, stepIndex: buildStepIndex(long) }),
    });
    const next = long.map((st) => (st.id === 'x24' ? { ...st, name: 'Renamed' } : st));
    const a = as('dave');
    await ok(a.run(saveProcess(a.ctx, { projectId: 'p1', steps: next, before: long })));
  });
  it('still evaluates when every step shifts in a 10-step process', async () => {
    const long: Step[] = [
      ...steps(),
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `y${i}`,
        name: `Y${i}`,
        kind: 'agent' as const,
        description: '',
      })),
    ];
    await put({
      [P('p1')]: projectDoc({}, { steps: long, stepIndex: buildStepIndex(long) }),
    });
    const a = as('dave');
    await ok(a.run(saveProcess(a.ctx, { projectId: 'p1', steps: long.slice(1), before: long })));
  });
  it('lets a current decider change that gate', async () => {
    await ok(save('bob', withDeciders(['alice', 'bob', 'dave'])));
  });
  it('lets an admin and the project creator change a gate', async () => {
    await ok(save('owner', withDeciders(['alice'])));
    await put({ [P('p1')]: projectDoc({}, { createdBy: 'dave' }) });
    await ok(save('dave', withDeciders(['dave'])));
  });
});

describe('a new decider is added to the project (card 1QYP6KpI)', () => {
  const onlyThree = () =>
    put({ [P('p1')]: projectDoc({}, { memberUids: ['alice', 'bob', 'carol'] }) });
  const withDeciders = (uids: string[]) =>
    steps().map((st) => (st.id === 'review' ? { ...st, gate: defaultGate(uids) } : st));
  const members = async () => (await snap(P('p1'))).memberUids as string[];

  it('adds the decider to the project people with a membersChanged event (by an admin)', async () => {
    await onlyThree();
    const o = as('owner');
    const plan = saveProcess(o.ctx, {
      projectId: 'p1',
      steps: withDeciders(['alice', 'dave']),
      before: steps(),
      memberUids: ['alice', 'bob', 'carol'],
    });
    await ok(o.run(plan));
    expect(await members()).toEqual(['alice', 'bob', 'carol', 'dave']);
    const ev = plan.ops.find(
      (op) => op.kind === 'set' && (op.data as { type?: string }).type === 'project.membersChanged',
    );
    expect(ev).toBeTruthy();
    expect((await snap((ev as { path: string }).path)).type).toBe('project.membersChanged');
  });
  it('lets a current decider (a plain member) do it too', async () => {
    await onlyThree();
    const b = as('bob');
    await ok(
      b.run(
        saveProcess(b.ctx, {
          projectId: 'p1',
          steps: withDeciders(['alice', 'bob', 'dave']),
          before: steps(),
          memberUids: ['alice', 'bob', 'carol'],
        }),
      ),
    );
    expect(await members()).toContain('dave');
  });
  it('denies a plain member adding someone who is not a decider, or removing anyone', async () => {
    await onlyThree();
    const a = as('alice');
    await denied(
      a.run([
        { kind: 'update', path: P('p1'), data: { memberUids: ['alice', 'bob', 'carol', 'dave'] } },
      ]),
    );
    const bad = saveProcess(a.ctx, { projectId: 'p1', steps: steps(), before: steps() });
    const upd = bad.ops.find((op) => op.kind === 'update')!;
    (upd.data as Record<string, unknown>).memberUids = ['alice', 'carol'];
    await denied(a.run(bad));
  });
  it('denies a project outsider', async () => {
    await onlyThree();
    const d = as('dave');
    await denied(
      d.run(
        saveProcess(d.ctx, {
          projectId: 'p1',
          steps: withDeciders(['dave']),
          before: steps(),
          memberUids: ['alice', 'bob', 'carol'],
        }),
      ),
    );
  });
});
