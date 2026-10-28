import { describe, expect, it } from 'vitest';
import { raiseFinding, triageFinding, type ActionContext } from './actions';
import type { Step } from './schema';
import { canTriage, isSuggestion } from './suggestions';

const agentStep = (id: string): Step => ({ id, name: id, kind: 'agent', description: '' });
const gateStep = (id: string, deciderUids: string[]): Step => ({
  id,
  name: id,
  kind: 'human',
  description: '',
  gate: {
    deciderUids,
    groupIds: [],
    rule: 'any',
    n: 1,
    mustInclude: [],
    rejectPolicy: 'one',
    remindAfterHours: 24,
  },
});
const project = { steps: [agentStep('ideas'), gateStep('pick', ['bo'])] };

const ctx: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'ana', name: 'Ana' },
  newId: () => 'id1',
};
const summaryOf = (parentSummary: string, summary: string) => {
  const p = triageFinding(ctx, {
    project,
    projectId: 'p',
    itemId: 'f',
    finding: { title: 'Fix X', summary, parentItemId: 'i' },
    outcome: 'addedToItem',
    parentSummary,
  });
  return p.ops.find((o) => o.path.endsWith('/items/i'))!.data!.summary;
};

describe('add finding to item', () => {
  it('has no leading blank lines when the item had no summary', () => {
    expect(summaryOf('', 'Details')).toBe('Added from finding: Fix X\nDetails');
  });
  it('appends after an existing summary, without a trailing blank when the finding has none', () => {
    expect(summaryOf('Existing', '')).toBe('Existing\n\nAdded from finding: Fix X');
  });
});

const itemOp = (p: { ops: { path: string; data?: Record<string, unknown> }[] }) =>
  p.ops.find((o) => o.path.includes('/items/'))!.data!;
const eventOf = (p: { ops: { path: string; data?: Record<string, unknown> }[] }) =>
  p.ops.find((o) => o.path.includes('/events/'))!.data!;

describe('suggestions', () => {
  const agent: ActionContext = { ...ctx, actor: { type: 'agent', id: 'ag', name: 'Writer' } };
  it('raises a suggestion at the first step without holding the item', () => {
    const p = raiseFinding(agent, {
      project,
      projectId: 'p',
      parentItemId: 'i',
      parent: { title: 'Post 3', claim: null },
      title: '  Alt text missing ',
      details: '4 images',
    });
    expect(itemOp(p)).toMatchObject({
      title: 'Alt text missing',
      status: 'suggested',
      stepId: 'ideas',
      claim: null,
      gate: null,
      sourceRunId: null,
      source: { kind: 'finding', label: 'Writer on Post 3' },
    });
  });
  it('records the run when the agent holds the item', () => {
    const p = raiseFinding(agent, {
      project,
      projectId: 'p',
      parentItemId: 'i',
      parent: { title: 'Post 3', claim: { runId: 'r1', agentUid: 'ag' } as never },
      title: 'X',
      details: '',
    });
    expect(itemOp(p).sourceRunId).toBe('r1');
    expect(eventOf(p).runId).toBe('r1');
  });
  it('adding arrives at the current first step like a new item; the event names it', () => {
    const gated = { steps: [gateStep('pick', ['bo']), agentStep('ideas')] };
    const p = triageFinding(ctx, {
      project: gated,
      projectId: 'p',
      itemId: 'f',
      finding: { title: 'X', summary: '', parentItemId: 'i' },
      outcome: 'intake',
    });
    expect(itemOp(p)).toMatchObject({
      type: 'task',
      stepId: 'pick',
      status: 'waiting',
      gate: { stepId: 'pick', approvals: {}, rejections: {} },
    });
    expect(eventOf(p).data).toMatchObject({ outcome: 'intake', stepName: 'pick', title: 'X' });
  });
  it('dismissing needs a 10+ character reason and keeps it in the event', () => {
    const go = (reason: string) =>
      triageFinding(ctx, {
        project,
        projectId: 'p',
        itemId: 'f',
        finding: { title: 'X', summary: '', parentItemId: 'i' },
        outcome: 'dismissed',
        reason,
      });
    expect(() => go('too short')).toThrow(/10 characters/);
    const p = go(' Out of scope now ');
    expect(itemOp(p)).toMatchObject({ status: 'stopped' });
    expect(eventOf(p).data).toMatchObject({ outcome: 'dismissed', reason: 'Out of scope now' });
  });
  it('canTriage: admins, the creator, and deciders of a first-step gate', () => {
    const p = { ...project, createdBy: 'cy' };
    expect(canTriage(p, 'ad', true)).toBe(true);
    expect(canTriage(p, 'cy', false)).toBe(true);
    expect(canTriage(p, 'bo', false)).toBe(false); // decides at the 2nd step only
    const gated = { steps: [gateStep('pick', ['bo'])], createdBy: 'cy' };
    expect(canTriage(gated, 'bo', false)).toBe(true);
    expect(canTriage(gated, 'da', false)).toBe(false);
  });
  it('isSuggestion: only untriaged findings in the suggested state', () => {
    expect(isSuggestion({ type: 'finding', status: 'suggested', triage: null })).toBe(true);
    expect(isSuggestion({ type: 'finding', status: 'queued', triage: null })).toBe(false);
    expect(isSuggestion({ type: 'task', status: 'suggested', triage: null })).toBe(false);
  });
});
