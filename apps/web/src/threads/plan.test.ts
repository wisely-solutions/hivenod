import type { InboxOutcome, InboxPlan } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { firstFree, planInputOf, planMain, planSummary, planWaits, stepTitle } from './plan';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const oc = (id: string, type: string, state: InboxOutcome['state'], fields = {}) => ({
  id,
  data: {
    memberUid: 'u',
    threadId: 't',
    type,
    fields,
    state,
    note: '',
    proposedBy: 'a',
    executor: type === 'approval' ? null : 'a',
    decision: null,
    result: null,
    planId: 'p',
    createdAt: ts(0),
    updatedAt: ts(0),
    lastEventId: 'e',
  } as unknown as InboxOutcome,
});
const plan = (steps: string[], cursor: number, state: InboxPlan['state']) => ({
  id: 'p',
  data: {
    memberUid: 'u',
    threadId: 't',
    proposedBy: 'a',
    steps,
    cursor,
    state,
    note: '',
    createdAt: ts(0),
    updatedAt: ts(0),
    lastEventId: 'e',
  } as unknown as InboxPlan,
});

describe('plans on the thread page (item qwFAW, slice 4)', () => {
  it('builds the action input from the plan and only its own steps', () => {
    const pl = planInputOf(plan(['o1', 'o2'], 0, 'proposed'), [
      oc('o1', 'reply', 'proposed', { text: 'x' }),
      oc('o2', 'approval', 'proposed', { what: 'y' }),
      oc('other', 'reply', 'proposed'),
    ]);
    expect(Object.keys(pl.outcomes)).toEqual(['o1', 'o2']);
    expect(pl.plan).toMatchObject({ steps: ['o1', 'o2'], cursor: 0, state: 'proposed' });
  });

  it('the main action: Approve plan, then the step at its turn, then Retry', () => {
    const rows = [
      oc('o1', 'reply', 'proposed', { text: 'x' }),
      oc('o2', 'approval', 'proposed', { what: 'y' }),
      oc('o3', 'nudge', 'proposed', { text: 'z' }),
    ];
    const p0 = planInputOf(plan(['o1', 'o2', 'o3'], 0, 'proposed'), rows);
    expect(planMain(p0)).toEqual({ kind: 'approvePlan' });
    expect(planSummary(p0)).toBe('1 needs you on the way');
    // Step 1 done, the gate at its turn.
    const p1 = planInputOf(plan(['o1', 'o2', 'o3'], 1, 'active'), [
      oc('o1', 'reply', 'done'),
      rows[1]!,
      oc('o3', 'nudge', 'approved', { text: 'z' }),
    ]);
    expect(planMain(p1)).toEqual({ kind: 'step', index: 1, outcomeId: 'o2', gate: true });
    expect(planSummary(p1)).toBe('1 done · 1 approved · 1 needs you on the way');
    // An agent step not approved at its turn.
    const p2 = planInputOf(plan(['o1', 'o3'], 1, 'active'), [oc('o1', 'reply', 'done'), rows[2]!]);
    expect(planMain(p2)).toEqual({ kind: 'step', index: 1, outcomeId: 'o3', gate: false });
    // Blocked.
    const p3 = planInputOf(plan(['o1'], 0, 'blocked'), [oc('o1', 'reply', 'failed')]);
    expect(planMain(p3)).toEqual({ kind: 'retry', index: 0 });
    // Running, nothing to decide.
    const p4 = planInputOf(plan(['o1', 'o3'], 0, 'active'), [
      oc('o1', 'reply', 'approved'),
      oc('o3', 'nudge', 'approved'),
    ]);
    expect(planMain(p4)).toBeNull();
    expect(planWaits(p4)).toBe(false);
    // Approved ahead, but a later agent step still proposed: Approve plan.
    const p5 = planInputOf(plan(['o1', 'o3'], 0, 'active'), [
      oc('o1', 'reply', 'approved'),
      oc('o3', 'nudge', 'proposed'),
    ]);
    expect(planMain(p5)).toEqual({ kind: 'approvePlan' });
    // Done or stopped: nothing.
    expect(planMain(planInputOf(plan(['o1'], 1, 'done'), [oc('o1', 'reply', 'done')]))).toBeNull();
  });

  it('only steps that have not started move', () => {
    const rows = [oc('o1', 'reply', 'approved'), oc('o2', 'nudge', 'proposed')];
    expect(firstFree(planInputOf(plan(['o1', 'o2'], 0, 'active'), rows))).toBe(1);
    expect(
      firstFree(
        planInputOf(plan(['o1', 'o2'], 0, 'proposed'), [oc('o1', 'reply', 'proposed'), rows[1]!]),
      ),
    ).toBe(0);
  });

  it('titles say what each step does', () => {
    expect(stepTitle('reply', { text: 'Thursday works, see you then.' })).toBe(
      'Reply: “Thursday works, see you then.”',
    );
    expect(stepTitle('approval', { what: 'New price list' })).toBe('You approve: New price list');
    expect(stepTitle('make_it_work', { title: 'Update the prices' })).toBe(
      'Build it: Update the prices',
    );
    expect(stepTitle('handover', { to: 'Maria' })).toBe('Hand over to Maria');
    expect(stepTitle('book', { start: '2026-10-30T10:00:00Z' })).toMatch(
      /^Book Fri 30 Oct, \d\d:00$/,
    );
    expect(stepTitle(null, {})).toBe('…');
    expect(stepTitle('reply', { text: 'x'.repeat(80) }).length).toBeLessThan(60);
  });
});
