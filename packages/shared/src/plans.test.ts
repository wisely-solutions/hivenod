/** Inbox plans (item qwFAWxZM5xkcE7PPjAzi): the registry additions and the pure plan views. */
import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import { proposeOutcome, type ThreadStateOf } from './inbox';
import {
  OUTCOMES,
  PLAN_TYPES,
  SINGLE_TYPES,
  cleanOutcomeFields,
  outcomeGuide,
  isRetiredOutcome,
  outcomeKind,
  outcomeRulesBlock,
  type OutcomeType,
} from './outcomes';
import {
  inboxPlanSchema,
  planThreadState,
  planView,
  singlePlanView,
  type PlanOutcomeOf,
  type PlanStateOf,
} from './plans';

const o = (
  type: string,
  state: PlanOutcomeOf['state'],
  fields: PlanOutcomeOf['fields'] = {},
): PlanOutcomeOf => ({ type, state, fields });

// The design's example: reply → book → you approve → Build it → reply "done".
const IDS = ['s1', 's2', 's3', 's4', 's5'];
const example = (states: PlanOutcomeOf['state'][]): Record<string, PlanOutcomeOf> => {
  const types = ['reply', 'book', 'approval', 'make_it_work', 'reply'];
  const fields: PlanOutcomeOf['fields'][] = [
    { text: 'Thursday works' },
    { start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z', with: 'Sam' },
    { what: 'The price-list change' },
    { title: 'Update the price list' },
    { text: 'Done' },
  ];
  return Object.fromEntries(IDS.map((id, i) => [id, o(types[i]!, states[i]!, fields[i])]));
};
const plan = (cursor: number, state: PlanStateOf['state'] = 'active'): PlanStateOf => ({
  steps: IDS,
  cursor,
  state,
});

describe('the registry', () => {
  const all = OUTCOMES as Record<string, OutcomeType>;
  it('has a person-approval type, decided by the member, never carried out', () => {
    expect(outcomeKind('approval')).toBe('human');
    expect(all.approval!.executor).toBe('none');
    expect(Object.keys(all.approval!.fields)).toEqual(['what', 'detail', 'link']);
    expect(cleanOutcomeFields('approval', { what: ' New prices ' })).toEqual({
      what: 'New prices',
    });
    expect(() => cleanOutcomeFields('approval', {})).toThrow(/needs what/);
  });
  it('every other type is an agent action', () => {
    for (const k of Object.keys(all)) if (k !== 'approval') expect(outcomeKind(k)).toBe('agent');
    expect(outcomeKind('nope')).toBe('agent');
  });
  it('keeps book and reply_book as retired types for old records (Calendar removed, slice 5)', () => {
    expect(Object.keys(all.book!.fields)).toEqual(['start', 'end', 'with', 'title']);
    for (const k of ['book', 'reply_book']) {
      expect(isRetiredOutcome(k), k).toBe(true);
      expect(all[k]!.plan, k).toBeUndefined();
      expect(all[k]!.planOnly, k).toBe(true);
    }
    expect(isRetiredOutcome('reply')).toBe(false);
  });
  it('allows the design types in a plan, never no_reply or ignore', () => {
    expect(PLAN_TYPES).toEqual([
      'reply',
      'make_it_work',
      'handover',
      'snooze',
      'nudge',
      'shape',
      'build',
      'release',
      'approval',
    ]);
  });
  it('keeps approval and book out of single proposals', () => {
    expect(SINGLE_TYPES).toEqual([
      'reply',
      'no_reply',
      'make_it_work',
      'handover',
      'snooze',
      'nudge',
      'ignore',
    ]);
    for (const [k, t] of Object.entries(all))
      if (t.planOnly && !t.retired) expect(t.plan, k).toBe(true);
  });
  it('the guides list the single or the plan types', () => {
    expect(outcomeGuide()).not.toMatch(/^approval:/m);
    expect(outcomeGuide()).toMatch(/^ignore:/m);
    expect(outcomeGuide('plan')).toMatch(/^approval:/m);
    expect(outcomeGuide('plan')).not.toMatch(/^ignore:/m);
  });
  it('the rules block carries the single, plan and human lists', () => {
    const b = outcomeRulesBlock();
    expect(b).toContain(
      "function outcomeSingle() { return ['reply', 'no_reply', 'make_it_work', 'handover', 'snooze', 'nudge', 'ignore']; }",
    );
    // Retired types have no field lists: the rules refuse proposing, revising or approving them.
    expect(b).not.toMatch(/function outcomeFieldKeys\(\) \{[^\n]*'reply_book'/);
    expect(b).toMatch(/function outcomeAfter\(\) \{[^\n]*'reply_book'/);
    expect(b).toContain("function outcomeHuman() { return ['approval']; }");
    expect(b).toMatch(/function outcomePlanTypes\(\) \{ return \['reply', .*'approval'\]; \}/);
  });
});

describe('proposeOutcome', () => {
  const agent: ActionContext = {
    workspaceId: 'w1',
    actor: { type: 'agent', id: 'agentA', name: 'Agent' },
    newId: () => 'e1',
  };
  const TH: ThreadStateOf = {
    memberUid: 'joao',
    subjectId: 's1',
    state: 'investigating',
    fetchedBy: 'agentA',
    refs: [],
  };
  it('refuses a plan-only type alone', () => {
    expect(() =>
      proposeOutcome(agent, {
        threadId: 't1',
        thread: TH,
        type: 'approval',
        fields: { what: 'x' },
      }),
    ).toThrow(/only a step of a plan/);
    expect(() =>
      proposeOutcome(agent, {
        threadId: 't1',
        thread: TH,
        type: 'book',
        fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', with: 'Sam' },
      }),
    ).toThrow(/retired with Calendar/);
  });
});

describe('inboxPlanSchema', () => {
  const at = { toMillis: () => 0, seconds: 0, nanoseconds: 0 };
  const base = {
    memberUid: 'joao',
    threadId: 't1',
    proposedBy: 'agentA',
    steps: IDS,
    cursor: 0,
    state: 'proposed',
    note: 'Why',
    createdAt: at,
    updatedAt: at,
    lastEventId: 'e1',
  };
  it('takes 1-8 steps', () => {
    expect(inboxPlanSchema.safeParse(base).success).toBe(true);
    expect(inboxPlanSchema.safeParse({ ...base, steps: [] }).success).toBe(false);
    expect(
      inboxPlanSchema.safeParse({ ...base, steps: Array.from({ length: 9 }, (_, i) => `o${i}`) })
        .success,
    ).toBe(false);
    expect(inboxPlanSchema.safeParse({ ...base, state: 'running' }).success).toBe(false);
  });
});

describe('planView', () => {
  it('a proposed plan: step 1 waits for you, the rest are proposed', () => {
    const v = planView(plan(0, 'proposed'), example(Array(5).fill('proposed')));
    expect(v.steps.map((s) => s.ui)).toEqual([
      'waitingForYou',
      'proposed',
      'proposed',
      'proposed',
      'proposed',
    ]);
    expect(v.steps.map((s) => s.kind)).toEqual(['agent', 'agent', 'human', 'agent', 'agent']);
    expect(v.steps.map((s) => s.number)).toEqual([1, 2, 3, 4, 5]);
    expect(v.steps[2]!.label).toBe('Your approval');
    expect(v.progress).toBe('Step 1 of 5');
    expect(v.waitingForYou?.outcomeId).toBe('s1');
  });
  it('after Approve plan: the gate waits, the steps after it stay approved', () => {
    const v = planView(plan(2), example(['done', 'done', 'proposed', 'approved', 'approved']));
    expect(v.steps.map((s) => s.ui)).toEqual([
      'done',
      'done',
      'waitingForYou',
      'approved',
      'approved',
    ]);
    expect(v.through).toBe(2);
    expect(v.waitingForYou?.kind).toBe('human');
    expect(v.progress).toBe('Step 3 of 5');
  });
  it('the approved step at its turn is running; revising stays revising', () => {
    const v = planView(
      plan(0),
      example(['approved', 'revising', 'proposed', 'proposed', 'proposed']),
    );
    expect(v.steps.slice(0, 2).map((s) => s.ui)).toEqual(['running', 'revising']);
    expect(v.waitingForYou).toBeNull();
  });
  it('Build it waiting for its item, a failed step, skipped steps', () => {
    expect(
      planView(plan(3), example(['done', 'done', 'done', 'running', 'approved'])).steps[3]!.ui,
    ).toBe('running');
    const blocked = planView(
      plan(1, 'blocked'),
      example(['done', 'failed', 'proposed', 'approved', 'proposed']),
    );
    expect(blocked.steps[1]!.ui).toBe('blocked');
    const skipped = planView(
      plan(2),
      example(['done', 'rejected', 'proposed', 'proposed', 'proposed']),
    );
    expect(skipped.steps[1]!.ui).toBe('skipped');
    expect(skipped.through).toBe(2);
  });
  it('a stopped plan has no current step; its rest is stopped', () => {
    const v = planView(
      plan(2, 'stopped'),
      example(['done', 'done', 'rejected', 'rejected', 'rejected']),
    );
    expect(v.current).toBeNull();
    expect(v.steps.slice(2).map((s) => s.ui)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(v.progress).toBe('Stopped');
  });
  it('a finished plan', () => {
    const v = planView(plan(5, 'done'), example(Array(5).fill('done')));
    expect(v.current).toBeNull();
    expect(v.through).toBe(5);
    expect(v.progress).toBe('Done');
  });
  it('a step not loaded yet', () => {
    const v = planView(plan(0, 'proposed'), {});
    expect(v.steps[0]).toMatchObject({ type: null, label: '…', ui: 'proposed', kind: 'agent' });
  });
});

describe('singlePlanView', () => {
  it('draws a single outcome as a one-step plan', () => {
    expect(singlePlanView('x', o('reply', 'proposed')).steps[0]!.ui).toBe('waitingForYou');
    expect(singlePlanView('x', o('reply', 'approved')).steps[0]!.ui).toBe('running');
    expect(singlePlanView('x', o('reply', 'revising')).steps[0]!.ui).toBe('revising');
    expect(singlePlanView('x', o('reply', 'failed')).steps[0]!.ui).toBe('blocked');
    const done = singlePlanView('x', o('reply', 'done'));
    expect([done.steps[0]!.ui, done.progress, done.total]).toEqual(['done', 'Done', 1]);
    expect(singlePlanView('x', o('reply', 'rejected')).steps[0]!.ui).toBe('stopped');
  });
});

describe('planThreadState', () => {
  const yourCall = { state: 'yourCall', waiting: null };
  const them = { state: 'waiting', waiting: { on: 'them', until: null } };
  it('waits for the member while a step at the cursor needs them', () => {
    expect(planThreadState(plan(0, 'proposed'), example(Array(5).fill('proposed')))).toEqual(
      yourCall,
    );
    expect(
      planThreadState(plan(2), example(['done', 'done', 'proposed', 'approved', 'approved'])),
    ).toEqual(yourCall);
    expect(
      planThreadState(
        plan(1, 'blocked'),
        example(['done', 'failed', 'proposed', 'proposed', 'proposed']),
      ),
    ).toEqual(yourCall);
    expect(
      planThreadState(plan(1), example(['done', 'revising', 'proposed', 'proposed', 'proposed'])),
    ).toEqual(yourCall);
  });
  it('an approved first step keeps Your call, like an approved single outcome', () => {
    expect(planThreadState(plan(0), example(Array(5).fill('approved')))).toEqual(yourCall);
  });
  it('an approved later step: the previous agent step’s after-state', () => {
    expect(
      planThreadState(plan(1), example(['done', 'approved', 'proposed', 'proposed', 'proposed'])),
    ).toEqual(them);
    // past the gate: the person step has no after-state of its own
    expect(
      planThreadState(plan(3), example(['done', 'done', 'done', 'approved', 'approved'])),
    ).toEqual(them);
  });
  it('Build it running: waiting on the item', () => {
    expect(
      planThreadState(plan(3), example(['done', 'done', 'done', 'running', 'approved'])),
    ).toEqual({ state: 'waiting', waiting: { on: 'item', until: null } });
  });
  it('an approved wait-until step at the cursor: waiting until its date', () => {
    const p: PlanStateOf = { steps: ['a', 'b'], cursor: 1, state: 'active' };
    expect(
      planThreadState(p, {
        a: o('reply', 'done', { text: 'Hi' }),
        b: o('snooze', 'approved', { until: '2026-11-03T09:00:00.000Z' }),
      }),
    ).toEqual({
      state: 'waiting',
      waiting: { on: 'date', until: new Date('2026-11-03T09:00:00.000Z') },
    });
  });
  it('every step through: the last agent step’s after-state', () => {
    expect(planThreadState(plan(5, 'done'), example(Array(5).fill('done')))).toEqual(them);
    const skipLast = example(['done', 'done', 'done', 'done', 'rejected']);
    expect(planThreadState(plan(5, 'done'), skipLast)).toEqual({
      state: 'waiting',
      waiting: { on: 'item', until: null },
    });
    expect(
      planThreadState({ steps: ['g'], cursor: 1, state: 'done' }, { g: o('approval', 'done') }),
    ).toEqual({ state: 'done', waiting: null });
  });
  it('a stopped plan hands the thread back to the agent', () => {
    expect(
      planThreadState(
        plan(2, 'stopped'),
        example(['done', 'done', 'rejected', 'rejected', 'rejected']),
      ),
    ).toEqual({ state: 'investigating', waiting: null });
  });
  it('a step not loaded yet: Your call', () => {
    expect(planThreadState(plan(0, 'proposed'), {})).toEqual(yourCall);
  });
});
