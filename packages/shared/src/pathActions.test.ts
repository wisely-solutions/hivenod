import { describe, expect, it } from 'vitest';
import { DELETE_FIELD, type ActionContext, type ItemState } from './actions';
import {
  acceptProposal,
  askPathChange,
  decidePathChange,
  planPathChange,
  proposeStep,
  rejectProposal,
  shapeItem,
  skipStep,
  newStepId,
  fullProcessPlan,
} from './pathActions';
import type { Step } from './schema';

const gate = (deciderUids: string[]) => ({
  deciderUids,
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 24,
});
const LIB: Step[] = [
  { id: 'intake', name: 'Intake', kind: 'agent', description: '' },
  { id: 'research', name: 'Research', kind: 'agent', description: '' },
  { id: 'go', name: 'Go/no-go', kind: 'human', description: '', gate: gate(['alice']) },
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'release', name: 'Release', kind: 'human', description: '', gate: gate(['alice']) },
];
const project = { steps: LIB };
const human = (id: string): ActionContext => ({
  workspaceId: 'w',
  actor: { type: 'human', id, name: id },
  newId: () => 'e1',
});
const agent: ActionContext = {
  workspaceId: 'w',
  actor: { type: 'agent', id: 'ag', name: 'Scout' },
  newId: () => 'e1',
};
const base: ItemState = {
  title: 'Fix typo',
  type: 'bug',
  stepId: 'intake',
  status: 'queued',
  claim: null,
  gate: null,
  sendBackCount: 0,
  costEur: 0,
  triage: null,
};
const claim = { runId: 'r1', agentUid: 'ag', heartbeatAt: null as never };
const where = (item: ItemState) => ({ project, projectId: 'p', itemId: 'i', item });
const itemData = (p: { ops: { path: string; data?: Record<string, unknown> }[] }) =>
  p.ops.find((o) => o.path.endsWith('/items/i'))!.data!;

describe('shaping', () => {
  const unshaped = { ...base, shape: null };

  it('agent: agent steps skipped, gates become pending requests, run ends', () => {
    const p = shapeItem(agent, {
      ...where({ ...unshaped, status: 'working', claim }),
      skips: { intake: 'nothing to triage', release: 'static page' },
      note: 'copy change',
    });
    expect(p.pending).toEqual(['release']);
    const d = itemData(p);
    expect(d.pathSkips).toEqual({ intake: 'nothing to triage' });
    expect(d.pathRequests).toBeUndefined();
    expect(p.asks).toHaveLength(1);
    expect(itemData(p.asks[0]!)).toMatchObject({ pathRev: 1 });
    expect(d.pathRev).toBe(2);
    expect(d.stepId).toBe('research');
    expect(p.ops.some((o) => o.path.includes('/runs/r1'))).toBe(true);
  });

  it('refuses an item that is shaped or held by someone else', () => {
    expect(() => fullProcessPlan(human('dave'), where({ ...base, shape: undefined }))).toThrow(
      /already shaped/,
    );
    expect(() =>
      fullProcessPlan(human('dave'), where({ ...unshaped, claim: { ...claim, agentUid: 'x' } })),
    ).toThrow(/shaping this item/);
    expect(() => shapeItem(agent, { ...where(unshaped), skips: {}, note: '' })).toThrow(
      /do not hold/,
    );
  });

  it('a path needs at least one step', () => {
    const agentsOnly = { steps: LIB.filter((x) => x.kind === 'agent') };
    expect(() =>
      shapeItem(human('dave'), {
        project: agentsOnly,
        projectId: 'p',
        itemId: 'i',
        item: unshaped,
        skips: { intake: '', research: '', build: '' },
        note: '',
      }),
    ).toThrow(/at least one step/);
  });
});

describe('changing a path', () => {
  const shaped: ItemState = {
    ...base,
    shape: { by: { type: 'agent', id: 'ag' } } as never,
    pathSkips: {},
  };

  it('agent steps by anyone, gates only by a decider', () => {
    expect(
      itemData(skipStep(human('dave'), { ...where(shaped), stepId: 'build', skip: true })),
    ).toMatchObject({ 'pathSkips.build': '' });
    expect(() => skipStep(human('dave'), { ...where(shaped), stepId: 'go', skip: true })).toThrow(
      /people step/,
    );
    expect(
      itemData(
        skipStep(human('alice'), { ...where(shaped), stepId: 'go', skip: true, reason: 'x' }),
      ),
    ).toMatchObject({ 'gateSkips.go': 'x' });
    expect(() =>
      skipStep(agent, { ...where({ ...shaped, claim }), stepId: 'go', skip: true }),
    ).toThrow(/people step/);
    expect(() =>
      skipStep(human('dave'), { ...where(shaped), stepId: 'intake', skip: true }),
    ).toThrow(/not ahead/);
  });

  it('an item from before paths gets an empty agent-skips map with its first change', () => {
    const legacy = { ...base };
    expect(
      itemData(skipStep(human('alice'), { ...where(legacy), stepId: 'release', skip: true })),
    ).toMatchObject({ pathSkips: {}, 'gateSkips.release': '' });
  });

  it('splits a wanted path into direct changes and asks', () => {
    expect(
      planPathChange(project, shaped, { type: 'human', id: 'dave' }, ['intake', 'go']),
    ).toEqual({ skip: ['research', 'build'], unskip: [], ask: ['release'] });
    expect(
      planPathChange(project, shaped, { type: 'human', id: 'alice' }, ['intake', 'go']).skip,
    ).toEqual(['research', 'build', 'release']);
  });

  it('asks and decisions', () => {
    expect(() =>
      askPathChange(human('dave'), { ...where(shaped), stepId: 'release', reason: 'short' }),
    ).toThrow(/10 characters/);
    const ask = askPathChange(human('dave'), {
      ...where(shaped),
      stepId: 'release',
      reason: 'Nothing to release here',
    });
    expect(ask.op).toBe('drop');
    const pending = {
      ...shaped,
      pathRequests: {
        release: {
          op: 'drop' as const,
          by: { type: 'human' as const, id: 'dave' },
          reason: 'Nothing to release',
          at: null as never,
        },
      },
    };
    expect(() =>
      decidePathChange(human('dave'), { ...where(pending), stepId: 'release', approve: true }),
    ).toThrow(/Only a decider/);
    const yes = itemData(
      decidePathChange(human('alice'), { ...where(pending), stepId: 'release', approve: true }),
    );
    expect(yes['gateSkips.release']).toBe('Nothing to release');
    expect(yes['pathRequests.release']).toBe(DELETE_FIELD);
    const no = itemData(
      decidePathChange(human('alice'), { ...where(pending), stepId: 'release', approve: false }),
    );
    expect(no.pathRefused).toEqual(['release']);
    expect(() =>
      askPathChange(agent, {
        ...where({ ...shaped, claim, pathRefused: ['release'] }),
        stepId: 'release',
        reason: 'Please skip the release',
      }),
    ).toThrow(/already kept/);
  });

  it('approving the skip of the gate the item waits at moves it on', () => {
    const waiting: ItemState = {
      ...shaped,
      stepId: 'go',
      status: 'waiting',
      gate: { stepId: 'go', approvals: {}, rejections: {} },
      pathRequests: {
        go: {
          op: 'drop',
          by: { type: 'agent', id: 'ag' },
          reason: 'Tiny change here',
          at: null as never,
        },
      },
    };
    const d = itemData(
      decidePathChange(human('alice'), { ...where(waiting), stepId: 'go', approve: true }),
    );
    expect(d).toMatchObject({ stepId: 'build', status: 'queued', gate: null });
  });
});

describe('library proposals', () => {
  it('an agent holding the item proposes; approvers accept or reject with a reason', () => {
    const proposal = {
      name: 'Legal review',
      kind: 'human' as const,
      description: 'Terms',
      afterStepId: 'build',
      deciderUids: ['bob'],
      reason: 'The change touches the terms',
    };
    expect(() =>
      proposeStep(agent, { project, projectId: 'p', itemId: 'i', item: base, proposal }),
    ).toThrow(/do not hold/);
    const p = proposeStep(agent, {
      project,
      projectId: 'p',
      itemId: 'i',
      item: { ...base, claim },
      proposal,
    });
    expect(p.ops[0]!.data).toMatchObject({ status: 'open', deciderUids: ['bob'] });
    expect(newStepId()).toMatch(/^s-[A-Za-z0-9]{8}$/);
    const step: Step = {
      id: 'legal',
      name: 'Legal review',
      kind: 'human',
      description: '',
      gate: gate(['alice']),
    };
    const acc = acceptProposal(human('alice'), {
      project: { steps: LIB, memberUids: ['alice'] },
      projectId: 'p',
      proposalId: 'sp',
      proposal: { afterStepId: 'build', itemId: 'i', name: 'Legal review' },
      step,
    });
    const proj = acc.ops.find((o) => o.path === 'workspaces/w/projects/p')!.data!;
    expect((proj.steps as Step[]).map((s) => s.id)).toEqual([
      'intake',
      'research',
      'go',
      'build',
      'legal',
      'release',
    ]);
    expect(() =>
      rejectProposal(human('alice'), {
        projectId: 'p',
        proposalId: 'sp',
        itemId: 'i',
        reason: 'no',
      }),
    ).toThrow();
  });
});
