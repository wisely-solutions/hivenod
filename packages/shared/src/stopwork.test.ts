import { describe, expect, it } from 'vitest';
import { resumeWork, stopWork, type ActionContext, type ItemState } from './actions';
import type { Step } from './schema';
import { canStopWork, isOnHold, isWorkStoppable, stopGateFor } from './stopwork';

const gate = (deciderUids: string[]) => ({
  deciderUids,
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 24,
});
const steps: Step[] = [
  { id: 'spec', name: 'Spec', kind: 'human', description: '', gate: gate(['carol']) },
  { id: 'draft', name: 'Draft', kind: 'agent', description: '' },
  { id: 'review', name: 'Review', kind: 'human', description: '', gate: gate(['alice']) },
];
const project = { steps };
const ctx: ActionContext = {
  workspaceId: 'w',
  actor: { type: 'human', id: 'alice', name: 'Alice' },
  newId: () => 'e1',
};
const working = {
  title: 'Post',
  type: 'idea',
  stepId: 'draft',
  status: 'working',
  claim: { runId: 'r1', agentUid: 'a1', heartbeatAt: {} },
  gate: null,
  sendBackCount: 0,
  costEur: 0.5,
  triage: null,
} as unknown as ItemState;

describe('who may stop work (João, Q23: admins and the deciders of any gate)', () => {
  it('admins without a gate, deciders through their gate, nobody else', () => {
    expect(stopGateFor(project, 'owner', true)).toBe('');
    expect(stopGateFor(project, 'alice', false)).toBe('review');
    expect(stopGateFor(project, 'carol', false)).toBe('spec');
    expect(stopGateFor(project, 'dave', false)).toBeNull();
    expect(canStopWork(project, 'dave', false)).toBe(false);
    expect(canStopWork(project, 'carol', false)).toBe(true);
  });
});

describe('stoppable and on hold', () => {
  it('only a claimed item at an agent step can be stopped', () => {
    expect(isWorkStoppable(project, working as never)).toBe(true);
    expect(isWorkStoppable(project, { ...working, claim: null } as never)).toBe(false);
    expect(isWorkStoppable(project, { ...working, stepId: 'review' } as never)).toBe(false);
  });
  it('go back holds; cancel is stopped, not held', () => {
    const w = { byUid: 'a', at: {}, reason: '', runId: 'r1' };
    expect(isOnHold({ status: 'queued', workStopped: { ...w, mode: 'back' } } as never)).toBe(true);
    expect(isOnHold({ status: 'stopped', workStopped: { ...w, mode: 'cancel' } } as never)).toBe(
      false,
    );
    expect(isOnHold({ status: 'queued' } as never)).toBe(false);
  });
});

describe('stopWork / resumeWork plans', () => {
  it('go back: claim cleared, item queued and held, run stopped by the person, note for the next agent', () => {
    const p = stopWork(ctx, {
      project,
      projectId: 'p',
      itemId: 'i',
      item: working,
      mode: 'back',
      reason: '  wrong brief  ',
      gateStepId: 'review',
      run: { costEur: 0.25, endedAt: null },
    });
    const item = p.ops.find((o) => o.path.endsWith('/items/i'))!.data!;
    expect(item).toMatchObject({
      claim: null,
      status: 'queued',
      workStopped: { mode: 'back', byUid: 'alice', reason: 'wrong brief', runId: 'r1' },
      costEur: 0.75,
    });
    const run = p.ops.find((o) => o.path.endsWith('/runs/r1'))!.data!;
    expect(run).toMatchObject({ status: 'stopped', stoppedBy: { uid: 'alice', name: 'Alice' } });
    expect(String(run.summary)).toContain('Stopped by Alice');
    expect(p.ops.find((o) => o.path.endsWith('/messages/e1-note'))!.data).toMatchObject({
      kind: 'note',
      text: 'Work stopped: wrong brief',
    });
    const ev = p.ops.find((o) => o.path.endsWith('/events/e1'))!.data!;
    expect(ev).toMatchObject({
      type: 'item.workStopped',
      runId: 'r1',
      data: { mode: 'back', reason: 'wrong brief', gateStepId: 'review', agentUid: 'a1' },
    });
    // Nothing touches the agent: a stop is not a failure.
    expect(p.ops.some((o) => o.path.includes('/agents/'))).toBe(false);
  });

  it('cancel: item stopped, no note; an ended run is left alone', () => {
    const p = stopWork(ctx, {
      project,
      projectId: 'p',
      itemId: 'i',
      item: working,
      mode: 'cancel',
      run: { costEur: 1, endedAt: { seconds: 1 } },
    });
    expect(p.ops.find((o) => o.path.endsWith('/items/i'))!.data).toMatchObject({
      status: 'stopped',
      costEur: 0.5,
    });
    expect(p.ops.some((o) => o.path.includes('/runs/'))).toBe(false);
    expect(p.ops.some((o) => o.path.includes('/messages/'))).toBe(false);
  });

  it('refuses agents, unclaimed items and long reasons', () => {
    const agent = { ...ctx, actor: { type: 'agent' as const, id: 'a1', name: 'A' } };
    const base = { project, projectId: 'p', itemId: 'i', item: working, mode: 'back' as const };
    expect(() => stopWork(agent, base)).toThrow(/Only people/);
    expect(() => stopWork(ctx, { ...base, item: { ...working, claim: null } })).toThrow(/No agent/);
    expect(() => stopWork(ctx, { ...base, reason: 'x'.repeat(501) })).toThrow(/500/);
  });

  it('resume clears the hold; only a held item', () => {
    const held = {
      status: 'queued',
      workStopped: { mode: 'back', byUid: 'a', at: {}, reason: '', runId: 'r1' },
    } as never;
    const p = resumeWork(ctx, { projectId: 'p', itemId: 'i', item: held, gateStepId: 'review' });
    expect(p.ops[0]!.data).toMatchObject({ workStopped: null });
    expect(p.ops[1]!.data).toMatchObject({ type: 'item.resumed', data: { gateStepId: 'review' } });
    expect(() =>
      resumeWork(ctx, { projectId: 'p', itemId: 'i', item: { status: 'queued' } as never }),
    ).toThrow(/not on hold/);
  });
});
