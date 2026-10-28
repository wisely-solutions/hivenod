import { describe, expect, it } from 'vitest';
import type { ActionContext, ItemState } from './actions';
import {
  agentSendBack,
  agentSendBackTargets,
  checkSendBackTarget,
  stuckQuestion,
  STUCK_QUESTION_PREFIX,
} from './sendback';
import type { Step } from './schema';

const g = {
  deciderUids: ['alice'],
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 24,
};
const LIB: Step[] = [
  { id: 'plan', name: 'Plan', kind: 'agent', description: '' },
  { id: 'ok', name: 'OK', kind: 'human', description: '', gate: g },
  { id: 'build', name: 'Build', kind: 'agent', description: '' },
  { id: 'lint', name: 'Lint', kind: 'agent', description: '' },
  { id: 'test', name: 'Test', kind: 'agent', description: '' },
];
const project = { steps: LIB };
const ctx: ActionContext = {
  workspaceId: 'w',
  actor: { type: 'agent', id: 'a1', name: 'A' },
  newId: () => 'e1',
};
const item = (over: Partial<ItemState> = {}): ItemState => ({
  title: 'T',
  type: 'task',
  stepId: 'test',
  status: 'working',
  claim: { runId: 'r1', agentUid: 'a1', heartbeatAt: null as never },
  gate: null,
  sendBackCount: 0,
  costEur: 0.5,
  triage: null,
  ...over,
});

describe('agentSendBackTargets', () => {
  it('lists earlier agent steps on the path, nearest first, up to the people step', () => {
    expect(agentSendBackTargets(project, item()).map((s) => s.id)).toEqual(['lint', 'build']);
  });
  it('leaves out skipped steps, and passes a skipped people step', () => {
    const it = item({ pathSkips: { lint: 'x' }, gateSkips: { ok: 'y' } });
    expect(agentSendBackTargets(project, it).map((s) => s.id)).toEqual(['build', 'plan']);
  });
});

describe('checkSendBackTarget', () => {
  it('explains each refusal', () => {
    expect(() => checkSendBackTarget(project, item(), 'test')).toThrow(/at now/);
    expect(() => checkSendBackTarget(project, item({ stepId: 'build' }), 'test')).toThrow(
      /earlier step/,
    );
    expect(() => checkSendBackTarget(project, item(), 'ok')).toThrow(/people step/);
    expect(() => checkSendBackTarget(project, item(), 'plan')).toThrow(/across people/);
    expect(() => checkSendBackTarget(project, item({ pathSkips: { lint: '' } }), 'lint')).toThrow(
      /skipped/,
    );
    expect(() => checkSendBackTarget(project, item(), 'nope')).toThrow(/Unknown step/);
  });
});

describe('agentSendBack', () => {
  it('moves the item, counts the round, ends the run and leaves the reason as a note', () => {
    const p = agentSendBack(ctx, {
      project,
      projectId: 'p',
      itemId: 'i',
      item: item({ agentSendBacks: 1 }),
      toStepId: 'build',
      reason: '  tests fail  ',
      result: { costEur: 0.25 },
    });
    expect(p.round).toBe(2);
    const byPath = Object.fromEntries(p.ops.map((o) => [o.path, o.data]));
    expect(byPath['workspaces/w/projects/p/items/i']).toMatchObject({
      stepId: 'build',
      status: 'queued',
      claim: null,
      gate: null,
      progress: null,
      agentSendBacks: 2,
      costEur: 0.75,
    });
    expect(byPath['workspaces/w/runs/r1']).toMatchObject({ status: 'done' });
    expect(byPath['workspaces/w/projects/p/items/i/messages/e1-note']).toMatchObject({
      kind: 'note',
      text: 'tests fail',
    });
    expect(byPath['workspaces/w/events/e1']).toMatchObject({
      type: 'item.sentBack',
      data: { fromStepId: 'test', toStepId: 'build', reason: 'tests fail', round: 2 },
    });
  });
  it('refuses a 4th round, an empty reason, a person and an item it does not hold', () => {
    const base = { project, projectId: 'p', itemId: 'i', toStepId: 'build', reason: 'why' };
    expect(() => agentSendBack(ctx, { ...base, item: item({ agentSendBacks: 3 }) })).toThrow(
      /needs people/,
    );
    expect(() => agentSendBack(ctx, { ...base, item: item(), reason: ' ' })).toThrow(/reason/);
    expect(() => agentSendBack(ctx, { ...base, item: item(), reason: 'x'.repeat(2001) })).toThrow(
      /2000/,
    );
    expect(() =>
      agentSendBack({ ...ctx, actor: { ...ctx.actor, type: 'human' } }, { ...base, item: item() }),
    ).toThrow(/Only agents/);
    expect(() => agentSendBack(ctx, { ...base, item: item({ claim: null }) })).toThrow(
      /do not hold/,
    );
  });
});

describe('stuckQuestion', () => {
  it('lists the reasons and fits a message', () => {
    const q = stuckQuestion(['a', 'b', 'c'], 'd');
    expect(q.startsWith(STUCK_QUESTION_PREFIX)).toBe(true);
    expect(q).toContain('1. a\n2. b\n3. c');
    expect(q).toContain('This time: d');
    expect(stuckQuestion(['x'.repeat(5000), 'y'.repeat(5000)], 'z').length).toBeLessThanOrEqual(
      8000,
    );
  });
});
