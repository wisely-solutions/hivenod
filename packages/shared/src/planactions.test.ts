/** Inbox plans (item qwFAWxZM5xkcE7PPjAzi): the plan actions (slice 2). */
import { describe, expect, it } from 'vitest';
import type { ActionContext, WriteOp } from './actions';
import {
  approveOutcome,
  approvePlan,
  editPlan,
  finishOutcome,
  proposePlan,
  rejectOutcome,
  rejectPlan,
  retryPlanStep,
  skipPlanStep,
  stopPlan,
  wakeThread,
  type OutcomeStateOf,
  type PlanInput,
  type ThreadStateOf,
} from './inbox';

let n = 0;
const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => `id${++n}`,
};
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => `id${++n}`,
};
const maria: ActionContext = { ...joao, actor: { type: 'human', id: 'maria', name: 'Maria' } };
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'investigating',
  fetchedBy: 'agentA',
  refs: [],
};
const STEPS = [
  { type: 'reply', fields: { text: 'Thursday works' } },
  {
    type: 'book',
    fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', with: 'Sam' },
  },
  { type: 'approval', fields: { what: 'The price-list change' } },
  { type: 'make_it_work', fields: { title: 'Update the price list', project: 'Website' } },
  { type: 'reply', fields: { text: 'Done' } },
];
const IDS = ['s1', 's2', 's3', 's4', 's5'];
const at = (ops: WriteOp[], path: string) => ops.find((o) => o.path === path);
const P = 'workspaces/w1/inboxPlans/p1';
const O = (id: string) => `workspaces/w1/inboxOutcomes/${id}`;
const T = 'workspaces/w1/inboxThreads/t1';

/** The example plan with step states and a cursor. */
function plan(
  states: OutcomeStateOf['state'][],
  cursor: number,
  state: PlanInput['plan']['state'] = 'active',
): PlanInput {
  return {
    planId: 'p1',
    plan: { memberUid: 'joao', threadId: 't1', steps: IDS, cursor, state },
    outcomes: Object.fromEntries(
      IDS.map((id, i) => [
        id,
        {
          memberUid: 'joao',
          threadId: 't1',
          type: STEPS[i]!.type,
          fields: STEPS[i]!.fields as Record<string, string>,
          state: states[i]!,
          executor: STEPS[i]!.type === 'approval' ? null : 'agentA',
          planId: 'p1',
        },
      ]),
    ),
  };
}
const step = (pl: PlanInput, i: number) => ({
  outcomeId: IDS[i]!,
  outcome: pl.outcomes[IDS[i]!]!,
  thread: { ...TH, state: 'yourCall' as const },
  plan: pl,
});

describe('proposePlan', () => {
  it('writes the steps, the plan and the thread in one batch', () => {
    const p = proposePlan(agent, {
      threadId: 't1',
      thread: TH,
      note: ' Thursday, then the price list ',
      confidence: 'medium',
      steps: STEPS,
      planId: 'p1',
      stepIds: IDS,
    });
    expect(p.planId).toBe('p1');
    expect(p.ops.map((o) => o.path)).toEqual([
      ...IDS.map(O),
      P,
      T,
      `workspaces/w1/inboxEvents/${p.eventId}`,
    ]);
    expect(at(p.ops, P)!.data).toMatchObject({
      steps: IDS,
      cursor: 0,
      state: 'proposed',
      note: 'Thursday, then the price list',
      confidence: 'medium',
      proposedBy: 'agentA',
    });
    expect(at(p.ops, O('s2'))!.data).toMatchObject({
      type: 'book',
      planId: 'p1',
      executor: 'agentA',
      state: 'proposed',
      fields: { start: '2026-11-05T10:00:00.000Z' },
    });
    expect(at(p.ops, O('s3'))!.data).toMatchObject({ type: 'approval', executor: null });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'yourCall', waiting: null });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'plan.proposed',
      data: { planId: 'p1', steps: IDS },
    });
  });
  it('refuses what a plan cannot hold', () => {
    const base = { threadId: 't1', thread: TH };
    expect(() => proposePlan(agent, { ...base, steps: [] })).toThrow(/1 to 8 steps/);
    expect(() => proposePlan(agent, { ...base, steps: Array(9).fill(STEPS[0]) })).toThrow(
      /1 to 8 steps/,
    );
    expect(() => proposePlan(agent, { ...base, steps: [{ type: 'ignore', fields: {} }] })).toThrow(
      /Step 1: ignore is not a plan step/,
    );
    expect(() =>
      proposePlan(agent, { ...base, steps: [STEPS[0]!, { type: 'approval', fields: {} }] }),
    ).toThrow(/Step 2: approval needs what/);
    expect(() => proposePlan(joao, { ...base, steps: [STEPS[0]!] })).toThrow();
    expect(() =>
      proposePlan(agent, { ...base, thread: { ...TH, state: 'ignored' }, steps: [STEPS[0]!] }),
    ).toThrow(/ignored/);
  });
});

describe('approvePlan', () => {
  it('approves the proposed agent steps only, and books the booking step', () => {
    const pl = plan(['proposed', 'proposed', 'proposed', 'revising', 'proposed'], 0, 'proposed');
    const p = approvePlan(joao, { ...pl, thread: TH });
    const approved = p.ops.filter((o) => o.path.includes('inboxOutcomes')).map((o) => o.path);
    expect(approved).toEqual([O('s1'), O('s2'), O('s5')]);
    expect(at(p.ops, O('s1'))!.data).toMatchObject({
      state: 'approved',
      decision: { byUid: 'joao', edited: false, reason: null },
    });
    expect(at(p.ops, P)!.data).toMatchObject({ state: 'active' });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'yourCall' });
    expect(
      p.ops.some((o) => o.path.includes('/calendar/') || o.path.includes('calendarEvents')),
    ).toBe(true);
  });
  it('only the member, and not twice', () => {
    const pl = plan(Array(5).fill('proposed'), 0, 'proposed');
    expect(() => approvePlan(maria, { ...pl, thread: TH })).toThrow(/Only the person/);
    const all = plan(['approved', 'approved', 'proposed', 'approved', 'approved'], 0);
    expect(() => approvePlan(joao, { ...all, thread: TH })).toThrow(/No step waits/);
    const stopped = plan(Array(5).fill('proposed'), 0, 'stopped');
    expect(() => approvePlan(joao, { ...stopped, thread: TH })).toThrow(/stopped/);
  });
});

describe('approving and deciding steps', () => {
  it('an agent step may be pre-approved; it does not move the plan', () => {
    const pl = plan(Array(5).fill('proposed'), 0, 'proposed');
    const p = approveOutcome(joao, step(pl, 4));
    expect(at(p.ops, O('s5'))!.data).toMatchObject({ state: 'approved' });
    expect(at(p.ops, P)).toBeUndefined();
    expect(p.ops.at(-1)!.data).toMatchObject({ type: 'outcome.approved', data: { planId: 'p1' } });
  });
  it('a gate is decided only at its turn; passing it moves the cursor', () => {
    const early = plan(['done', 'approved', 'proposed', 'approved', 'approved'], 1);
    expect(() => approveOutcome(joao, step(early, 2))).toThrow(/Not its turn/);
    expect(() => rejectOutcome(joao, { ...step(early, 2), othersPending: false })).toThrow(
      /Not its turn/,
    );
    const now = plan(['done', 'done', 'proposed', 'approved', 'approved'], 2);
    const p = approveOutcome(joao, step(now, 2));
    expect(at(p.ops, O('s3'))!.data).toMatchObject({ state: 'done' });
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 3 });
    // the next step is approved: the thread shows the last agent step's after-state
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'them' } });
  });
  it('Not approved on a gate stops the plan and hands the thread back', () => {
    const now = plan(['done', 'done', 'proposed', 'approved', 'approved'], 2);
    const p = rejectOutcome(joao, { ...step(now, 2), othersPending: false, reason: 'Not now' });
    expect(at(p.ops, O('s3'))!.data).toMatchObject({ state: 'rejected' });
    expect(at(p.ops, P)!.data).toMatchObject({ state: 'stopped' });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'investigating', waiting: null });
  });
  it('an agent step is removed, not rejected', () => {
    const pl = plan(Array(5).fill('proposed'), 0, 'proposed');
    expect(() => rejectOutcome(joao, { ...step(pl, 1), othersPending: false })).toThrow(
      /Remove this step/,
    );
  });
  it('a plan step needs its plan', () => {
    const pl = plan(Array(5).fill('proposed'), 0, 'proposed');
    expect(() => approveOutcome(joao, { ...step(pl, 0), plan: undefined })).toThrow(
      /give its plan/,
    );
  });
});

describe('carrying out', () => {
  it('only the step at the cursor; done moves the plan on', () => {
    const pl = plan(['approved', 'approved', 'proposed', 'approved', 'approved'], 0, 'active');
    expect(() => finishOutcome(agent, { ...step(pl, 1), status: 'done' })).toThrow(/Not its turn/);
    const p = finishOutcome(agent, {
      ...step(pl, 0),
      status: 'done',
      result: { permalink: 'https://teams.example.com/m/2' },
    });
    expect(at(p.ops, O('s1'))!.data).toMatchObject({ state: 'done' });
    expect(at(p.ops, P)!.data).toEqual(expect.objectContaining({ cursor: 1 }));
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'them' } });
  });
  it('the last step done finishes the plan', () => {
    const pl = plan(['done', 'done', 'done', 'done', 'approved'], 4);
    const p = finishOutcome(agent, { ...step(pl, 4), status: 'done' });
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 5, state: 'done' });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'them' } });
  });
  it('Build it: started with the item, running until done', () => {
    const pl = plan(['done', 'done', 'done', 'approved', 'approved'], 3);
    expect(() => finishOutcome(agent, { ...step(pl, 3), status: 'started' })).toThrow(
      /Give the item/,
    );
    const p = finishOutcome(agent, {
      ...step(pl, 3),
      status: 'started',
      result: { itemId: 'it9' },
    });
    expect(at(p.ops, O('s4'))!.data).toMatchObject({ state: 'running', result: { itemId: 'it9' } });
    expect(at(p.ops, P)).toBeUndefined();
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
    expect(p.ops.at(-1)!.data).toMatchObject({ type: 'outcome.started' });
    const running = plan(['done', 'done', 'done', 'running', 'approved'], 3);
    const d = finishOutcome(agent, { ...step(running, 3), status: 'done' });
    expect(at(d.ops, P)!.data).toMatchObject({ cursor: 4 });
    expect(() =>
      finishOutcome(agent, {
        ...step(pl, 0),
        outcome: { ...pl.outcomes.s1!, state: 'approved' },
        status: 'started',
        result: { itemId: 'x' },
      }),
    ).toThrow();
  });
  it('a reply step is not started; a single outcome is never started', () => {
    const pl = plan(['approved', 'approved', 'proposed', 'approved', 'approved'], 0);
    expect(() =>
      finishOutcome(agent, { ...step(pl, 0), status: 'started', result: { itemId: 'x' } }),
    ).toThrow(/not started/);
    const single = { ...pl.outcomes.s4!, planId: undefined };
    expect(() =>
      finishOutcome(agent, {
        outcomeId: 'x',
        outcome: single,
        thread: TH,
        status: 'started',
        result: { itemId: 'x' },
      }),
    ).toThrow(/Only a plan step/);
  });
  it('failed blocks the plan; the member retries, skips or stops', () => {
    const pl = plan(['done', 'approved', 'proposed', 'approved', 'approved'], 1);
    const f = finishOutcome(agent, {
      ...step(pl, 1),
      status: 'failed',
      result: { error: 'Calendar refused' },
    });
    expect(at(f.ops, P)!.data).toMatchObject({ state: 'blocked' });
    expect(at(f.ops, T)!.data).toMatchObject({ state: 'yourCall' });
    const blocked = plan(['done', 'failed', 'proposed', 'approved', 'approved'], 1, 'blocked');
    const r = retryPlanStep(joao, { ...blocked, thread: TH });
    expect(at(r.ops, O('s2'))!.data).toMatchObject({ state: 'approved', result: null });
    expect(at(r.ops, P)!.data).toMatchObject({ state: 'active' });
    const s = skipPlanStep(joao, { ...blocked, thread: TH });
    expect(at(s.ops, O('s2'))!.data).toMatchObject({ state: 'rejected' });
    expect(at(s.ops, P)!.data).toMatchObject({ cursor: 2, state: 'active' });
    expect(at(s.ops, T)!.data).toMatchObject({ state: 'yourCall' });
    const st = stopPlan(joao, { ...blocked, thread: TH });
    expect(at(st.ops, P)!.data).toMatchObject({ state: 'stopped' });
    expect(at(st.ops, T)!.data).toMatchObject({ state: 'investigating' });
    expect(() => retryPlanStep(joao, { ...pl, thread: TH })).toThrow(/not blocked/);
    expect(() => finishOutcome(agent, { ...step(blocked, 3), status: 'done' })).toThrow(/blocked/);
  });
  it('a wait-until step is done when the thread wakes', () => {
    const pl: PlanInput = {
      planId: 'p1',
      plan: { memberUid: 'joao', threadId: 't1', steps: ['a', 'b'], cursor: 0, state: 'active' },
      outcomes: {
        a: {
          memberUid: 'joao',
          threadId: 't1',
          type: 'snooze',
          fields: { until: '2026-11-03T09:00:00.000Z' },
          state: 'approved',
          executor: null,
          planId: 'p1',
        },
        b: {
          memberUid: 'joao',
          threadId: 't1',
          type: 'nudge',
          fields: { text: 'Any news?' },
          state: 'approved',
          executor: 'agentA',
          planId: 'p1',
        },
      },
    };
    const thread = {
      ...TH,
      state: 'waiting' as const,
      waiting: { on: 'date', until: { toMillis: () => Date.parse('2026-11-03T09:00:00Z') } },
    };
    const p = wakeThread(agent, {
      threadId: 't1',
      thread,
      nowMs: Date.parse('2026-11-03T10:00:00Z'),
      plan: pl,
    });
    expect(at(p.ops, O('a'))!.data).toMatchObject({ state: 'done' });
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 1 });
    // the nudge runs next: no agent step before it, so Your call
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'yourCall' });
  });
});

describe('rejectPlan and editPlan', () => {
  it('Reject plan rejects what has not started and stops the plan', () => {
    const pl = plan(['done', 'approved', 'proposed', 'revising', 'approved'], 1);
    // s2 is at the cursor and approved: being carried out, so it is not rejected
    const p = rejectPlan(joao, { ...pl, thread: TH, reason: ' Changed my mind ' });
    const rej = p.ops.filter((o) => o.path.includes('inboxOutcomes')).map((o) => o.path);
    expect(rej).toEqual([O('s3'), O('s4'), O('s5')]);
    expect(at(p.ops, O('s4'))!.data).toMatchObject({ state: 'rejected', revise: null });
    expect(at(p.ops, P)!.data).toMatchObject({ state: 'stopped' });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'investigating' });
  });
  it('reorders only steps that have not started', () => {
    const pl = plan(['done', 'approved', 'proposed', 'proposed', 'proposed'], 1);
    expect(() =>
      editPlan(joao, { ...pl, thread: TH, edit: { op: 'move', from: 1, to: 3 } }),
    ).toThrow(/have not started/);
    const p = editPlan(joao, { ...pl, thread: TH, edit: { op: 'move', from: 4, to: 2 } });
    expect(at(p.ops, P)!.data).toMatchObject({ steps: ['s1', 's2', 's5', 's3', 's4'] });
    const fresh = plan(Array(5).fill('proposed'), 0, 'proposed');
    const q = editPlan(joao, { ...fresh, thread: TH, edit: { op: 'move', from: 0, to: 4 } });
    expect(at(q.ops, P)!.data).toMatchObject({ steps: ['s2', 's3', 's4', 's5', 's1'] });
  });
  it('removes a step that has not started', () => {
    const pl = plan(['done', 'proposed', 'proposed', 'proposed', 'proposed'], 1);
    expect(() => editPlan(joao, { ...pl, thread: TH, edit: { op: 'remove', index: 0 } })).toThrow(
      /has not started/,
    );
    const p = editPlan(joao, { ...pl, thread: TH, edit: { op: 'remove', index: 3 } });
    expect(at(p.ops, O('s4'))!.data).toMatchObject({
      state: 'rejected',
      decision: { reason: 'removed' },
    });
    expect(at(p.ops, P)!.data).toMatchObject({ steps: ['s1', 's2', 's3', 's5'] });
  });
  it('adds an approval step after what has started, up to 8 steps', () => {
    const pl = plan(['done', 'approved', 'proposed', 'proposed', 'proposed'], 1);
    expect(() =>
      editPlan(joao, {
        ...pl,
        thread: TH,
        edit: { op: 'add', index: 1, fields: { what: 'x' } },
      }),
    ).toThrow(/after the steps that have started/);
    const p = editPlan(joao, {
      ...pl,
      thread: TH,
      edit: { op: 'add', index: 2, fields: { what: ' Check the quote ' }, outcomeId: 'g1' },
    });
    expect(p.outcomeId).toBe('g1');
    expect(at(p.ops, O('g1'))!.data).toMatchObject({
      type: 'approval',
      fields: { what: 'Check the quote' },
      proposedBy: 'joao',
      executor: null,
      planId: 'p1',
      state: 'proposed',
    });
    expect(at(p.ops, P)!.data).toMatchObject({ steps: ['s1', 's2', 'g1', 's3', 's4', 's5'] });
    expect(() =>
      editPlan(maria, { ...pl, thread: TH, edit: { op: 'add', index: 2, fields: { what: 'x' } } }),
    ).toThrow(/Only the person/);
  });
});
