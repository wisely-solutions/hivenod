import { describe, expect, it } from 'vitest';
import { PROJECTS_PER_BATCH, recomputeGate, syncGroupDeciders } from './groups';
import type { ActionContext } from './actions';
import type { Step } from './schema';

const gateStep = (over: Partial<NonNullable<Step['gate']>> = {}): Step => ({
  id: 'review',
  name: 'Review',
  kind: 'human',
  description: '',
  gate: {
    deciderUids: ['x', 'a', 'b'],
    groupIds: ['g1'],
    rule: 'any',
    n: 1,
    mustInclude: [],
    rejectPolicy: 'one',
    remindAfterHours: 24,
    ...over,
  },
});
const agentStep: Step = { id: 'draft', name: 'Draft', kind: 'agent', description: '' };
const base = { groupId: 'g1', before: ['a', 'b'], after: ['a', 'c'], others: {} };

describe('recomputeGate', () => {
  it('ignores agent steps and gates that do not use the group', () => {
    expect(recomputeGate(agentStep, base)).toBeNull();
    expect(recomputeGate(gateStep({ groupIds: ['g2'] }), base)).toBeNull();
  });
  it('drops removed members, adds new ones, keeps directly chosen people', () => {
    expect(recomputeGate(gateStep(), base)?.gate?.deciderUids).toEqual(['x', 'a', 'c']);
  });
  it('keeps a removed member that another group on the gate still holds', () => {
    const s = gateStep({ groupIds: ['g1', 'g2'] });
    const r = recomputeGate(s, { ...base, others: { g2: ['b'] } });
    expect(r?.gate?.deciderUids).toEqual(['x', 'a', 'b', 'c']);
  });
  it('returns null when nothing changes', () => {
    expect(recomputeGate(gateStep(), { ...base, before: ['a'], after: ['a'] })).toBeNull();
  });
  it('removes the group from the gate when it is deleted', () => {
    const r = recomputeGate(gateStep(), { ...base, after: [], deleted: true });
    expect(r?.gate?.groupIds).toEqual([]);
    expect(r?.gate?.deciderUids).toEqual(['x']);
  });
  it('drops must-include people who left and clamps n', () => {
    const s = gateStep({ rule: 'atLeast', n: 3, mustInclude: ['b'] });
    const r = recomputeGate(s, { ...base, after: ['a'] });
    expect(r?.gate?.mustInclude).toEqual([]);
    expect(r?.gate?.deciderUids).toEqual(['x', 'a']);
    expect(r?.gate?.n).toBe(2);
  });
  it('leaves n alone when the gate ends up with no deciders', () => {
    const s = gateStep({ deciderUids: ['a'], n: 2 });
    const r = recomputeGate(s, { ...base, before: ['a'], after: [] });
    expect(r?.gate?.deciderUids).toEqual([]);
    expect(r?.gate?.n).toBe(2);
  });
});

describe('syncGroupDeciders', () => {
  let n = 0;
  const ctx: ActionContext = {
    workspaceId: 'w',
    actor: { type: 'human', id: 'owner', name: 'Owner' },
    newId: () => `e${++n}`,
  };
  it('writes one project update and one event per affected project, in batches', () => {
    const projects = Array.from({ length: PROJECTS_PER_BATCH + 2 }, (_, i) => ({
      id: `p${i}`,
      steps: [agentStep, gateStep()],
    }));
    projects.push({ id: 'untouched', steps: [agentStep] });
    const batches = syncGroupDeciders(ctx, base, projects);
    expect(batches.map((b) => b.ops.length)).toEqual([PROJECTS_PER_BATCH * 2, 4]);
    const first = batches[0]!.ops;
    expect(first[0]).toMatchObject({ kind: 'update', path: 'workspaces/w/projects/p0' });
    expect(first[1]).toMatchObject({ kind: 'set' });
    expect(first[1]!.data).toMatchObject({ type: 'project.processChanged', projectId: 'p0' });
  });
  it('adds new deciders to the project people, with a membersChanged event', () => {
    const [b] = syncGroupDeciders(ctx, base, [
      { id: 'p', steps: [agentStep, gateStep()], memberUids: ['a'] },
    ]);
    const upd = b!.ops.find((o) => o.kind === 'update')!;
    const added = (upd.data as { memberUids: string[] }).memberUids.filter((u) => u !== 'a');
    expect(added.length).toBeGreaterThan(0);
    expect(
      b!.ops.some((o) => (o.data as { type?: string }).type === 'project.membersChanged'),
    ).toBe(true);
  });
  it('returns no batches when no gate uses the group', () => {
    expect(syncGroupDeciders(ctx, base, [{ id: 'p', steps: [agentStep] }])).toEqual([]);
  });
  it('refuses agents', () => {
    expect(() =>
      syncGroupDeciders({ ...ctx, actor: { ...ctx.actor, type: 'agent' } }, base, []),
    ).toThrow();
  });
});
