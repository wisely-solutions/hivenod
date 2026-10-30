/** Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): templates, New thread, send back. */
import { describe, expect, it } from 'vitest';
import type { ActionContext, WriteOp } from './actions';
import {
  approveOutcome,
  createMemberThread,
  finishOutcome,
  MAX_PLAN_SEND_BACKS,
  proposePlan,
  retryPlanStep,
  sendBackPlan,
  stepProgress,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type SendBackOf,
  type ThreadStateOf,
} from './inbox';
import { OUTCOMES, outcomeKind, PLAN_TYPES, SINGLE_TYPES } from './outcomes';
import {
  PLAN_TEMPLATES,
  planTemplate,
  sendBackTarget,
  templateSendBack,
  templateSteps,
} from './planTemplates';
import { PLAN_LIMITS, planThreadState, planView } from './plans';

let n = 0;
const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Hive' },
  newId: () => `id${++n}`,
};
const other: ActionContext = { ...agent, actor: { type: 'agent', id: 'agentB', name: 'B' } };
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => `id${++n}`,
};
const maria: ActionContext = { ...joao, actor: { type: 'human', id: 'maria', name: 'Maria' } };
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: null,
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: [],
};
// A dev plan made before Keep green (slice 6c): six steps; existing plans keep them.
const IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const TYPES = ['shape', 'approval', 'build', 'approval', 'release', 'approval'];
// The Development template since slice 6c: Keep green between Build and Ship it?.
const IDS7 = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
const TYPES7 = ['shape', 'approval', 'build', 'keepgreen', 'approval', 'release', 'approval'];
const at = (ops: WriteOp[], path: string) => ops.find((o) => o.path === path);
const O = (id: string) => `workspaces/w1/inboxOutcomes/${id}`;
const P = 'workspaces/w1/inboxPlans/p1';
const T = 'workspaces/w1/inboxThreads/t1';

/** The dev plan with step states, a cursor and send backs so far. */
function dev(
  states: OutcomeStateOf['state'][],
  cursor: number,
  state: PlanInput['plan']['state'] = 'active',
  sent = 0,
  ids: readonly string[] = IDS,
  types: readonly string[] = TYPES,
): PlanInput & { plan: PlanOf & SendBackOf } {
  return {
    planId: 'p1',
    plan: {
      memberUid: 'joao',
      threadId: 't1',
      steps: [...ids],
      cursor,
      state,
      sendBackTo:
        ids.length === 7 ? templateSendBack('dev', ids) : { d2: 'd1', d4: 'd3', d6: 'd3' },
      ...(sent ? { sentBack: { n: sent } } : {}),
    },
    outcomes: Object.fromEntries(
      ids.map((id, i) => [
        id,
        {
          memberUid: 'joao',
          threadId: 't1',
          type: types[i]!,
          fields: (types[i] === 'approval' ? { what: 'x' } : {}) as Record<string, string>,
          state: states[i]!,
          executor: types[i] === 'approval' ? null : 'agentA',
          planId: 'p1',
        },
      ]),
    ),
  };
}
const D = 'done' as const;
const A = 'approved' as const;
const Pr = 'proposed' as const;

describe('registry and templates', () => {
  it('has the development step types, plan-only, agent, build, keep green and release long', () => {
    for (const k of ['shape', 'build', 'keepgreen', 'release'] as const) {
      expect(PLAN_TYPES).toContain(k);
      expect(SINGLE_TYPES).not.toContain(k);
      expect(OUTCOMES[k].executor).toBe('agent');
      expect(outcomeKind(k)).toBe('agent');
    }
    expect('long' in OUTCOMES.shape).toBe(false);
    expect(OUTCOMES.build.long).toBe(true);
    expect(OUTCOMES.release.long).toBe(true);
    expect(OUTCOMES.keepgreen.long).toBe(true);
  });
  it('the Development template: seven steps, gates sending back to Shape, Build, Build', () => {
    const t = PLAN_TEMPLATES.dev;
    expect(t.steps.map((s) => s.type)).toEqual(TYPES7);
    expect(t.steps.length).toBeLessThanOrEqual(PLAN_LIMITS.steps);
    expect(t.steps.filter((s) => s.type === 'approval').map((s) => s.fields.what)).toEqual([
      'Approve idea',
      'Ship it?',
      'Accept on live',
    ]);
    expect(templateSendBack('dev', IDS7)).toEqual({ d2: 'd1', d5: 'd3', d7: 'd3' });
    expect(planTemplate('nope')).toBeNull();
    expect(() => templateSteps('nope')).toThrow(/Unknown template nope. Templates: dev/);
    expect(templateSteps('dev', [{ idea: 'A' }])[0]).toEqual({
      type: 'shape',
      fields: { idea: 'A' },
    });
    expect(() => templateSteps('dev', Array(8).fill({}))).toThrow(/has 7 steps/);
  });
  it('sendBackTarget: the template target, else the nearest earlier agent step', () => {
    const types7 = Object.fromEntries(IDS7.map((id, i) => [id, TYPES7[i]]));
    const map7 = templateSendBack('dev', IDS7);
    expect(sendBackTarget(IDS7, types7, 1, map7)).toBe(0);
    // Ship it? and Accept on live → Build, past Keep green (it re-greens after Build anyway).
    expect(sendBackTarget(IDS7, types7, 4, map7)).toBe(2);
    expect(sendBackTarget(IDS7, types7, 6, map7)).toBe(2);
    expect(sendBackTarget(IDS7, types7, 4, null)).toBe(3);
    // A plan made before slice 6c keeps its own map.
    const types = Object.fromEntries(IDS.map((id, i) => [id, TYPES[i]]));
    const map = { d2: 'd1', d4: 'd3', d6: 'd3' };
    expect(sendBackTarget(IDS, types, 3, map)).toBe(2);
    expect(sendBackTarget(IDS, types, 5, map)).toBe(2);
    expect(sendBackTarget(IDS, types, 5, null)).toBe(4);
    expect(sendBackTarget(['a', 'b'], { a: 'approval', b: 'approval' }, 1)).toBeNull();
    // A map naming a later or a person step falls back to the nearest agent step.
    expect(sendBackTarget(IDS, types, 3, { d4: 'd6' })).toBe(2);
    expect(sendBackTarget(IDS, types, 3, { d4: 'd2' })).toBe(2);
  });
});

describe('plan_propose with a template', () => {
  it('makes the template plan, the agent filling fields in', () => {
    const p = proposePlan(agent, {
      threadId: 't1',
      thread: { ...TH, state: 'investigating' },
      template: 'dev',
      steps: [{ type: 'shape', fields: { idea: 'Dark mode' }, note: 'S' }],
      planId: 'p1',
      stepIds: IDS7,
    });
    expect(at(p.ops, P)!.data).toMatchObject({
      state: 'proposed',
      templateId: 'dev',
      sendBackTo: { d2: 'd1', d5: 'd3', d7: 'd3' },
      proposedBy: 'agentA',
    });
    expect(at(p.ops, O('d1'))!.data).toMatchObject({
      type: 'shape',
      fields: { idea: 'Dark mode' },
      state: 'proposed',
      note: 'S',
    });
    expect(at(p.ops, O('d4'))!.data).toMatchObject({ type: 'keepgreen', fields: {} });
    expect(at(p.ops, O('d5'))!.data).toMatchObject({
      type: 'approval',
      fields: { what: 'Ship it?' },
    });
    // Agents never make approved steps.
    for (const id of IDS7) expect(at(p.ops, O(id))!.data!.state).toBe('proposed');
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'plan.proposed',
      data: { templateId: 'dev' },
    });
  });
  it('refuses a step of another type or an unknown template', () => {
    const base = { threadId: 't1', thread: TH };
    expect(() =>
      proposePlan(agent, { ...base, template: 'dev', steps: [{ type: 'reply', fields: {} }] }),
    ).toThrow(/Step 1 of the Development template is shape, not reply/);
    expect(() => proposePlan(agent, { ...base, template: 'x', steps: [] })).toThrow(
      /Unknown template x/,
    );
  });
});

describe('createMemberThread', () => {
  it('without a template: thread + first message, investigating, for the agent', () => {
    const p = createMemberThread(joao, {
      title: '  Dark   mode ',
      text: ' Add a dark mode ',
      agentUid: 'agentA',
      threadId: 't1',
    });
    expect(p.planId).toBeNull();
    const t = at(p.ops, T)!.data;
    expect(t).toMatchObject({
      memberUid: 'joao',
      state: 'investigating',
      waiting: null,
      title: 'Dark mode',
      fetchedBy: 'agentA',
      refs: ['t1'],
      subjectId: null,
      question: null,
    });
    const m = p.ops.find((o) => o.path.includes('/inboxMessages/'))!.data;
    expect(m).toMatchObject({
      direction: 'in',
      source: 'hivenod',
      sender: { name: 'João', handle: null },
      text: 'Add a dark mode',
      fetchedBy: 'joao',
      threadId: 't1',
    });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'thread.created',
      threadId: 't1',
      actor: { type: 'human', id: 'joao' },
      data: { agentUid: 'agentA' },
    });
  });
  it('with the Development template: the plan is the member’s, agent steps approved', () => {
    const p = createMemberThread(joao, {
      title: 'Dark mode',
      text: 'Add a dark mode',
      agentUid: 'agentA',
      template: 'dev',
      threadId: 't1',
      planId: 'p1',
      stepIds: IDS7,
    });
    expect(p.planId).toBe('p1');
    expect(at(p.ops, P)!.data).toMatchObject({
      proposedBy: 'joao',
      state: 'active',
      cursor: 0,
      steps: IDS7,
      templateId: 'dev',
      sendBackTo: { d2: 'd1', d5: 'd3', d7: 'd3' },
    });
    expect(IDS7.map((id) => at(p.ops, O(id))!.data!.state)).toEqual([A, Pr, A, A, Pr, A, Pr]);
    expect(at(p.ops, O('d1'))!.data).toMatchObject({
      fields: { idea: 'Add a dark mode' },
      executor: 'agentA',
      proposedBy: 'joao',
      decision: null,
    });
    expect(at(p.ops, O('d2'))!.data).toMatchObject({ executor: null });
    // Shape is at its turn and approved: the agent carries it out; the thread waits on it.
    expect(at(p.ops, T)!.data).toMatchObject({
      state: 'waiting',
      waiting: { on: 'agent', until: null },
    });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'thread.created',
      data: { planId: 'p1', steps: IDS7, templateId: 'dev' },
    });
  });
  it('refuses agents, an empty text and a missing agent', () => {
    const base = { title: 'x', text: 'y', agentUid: 'agentA' };
    expect(() => createMemberThread(agent, base)).toThrow();
    expect(() => createMemberThread(joao, { ...base, text: ' ' })).toThrow(/message/i);
    expect(() => createMemberThread(joao, { ...base, title: '' })).toThrow(/title/i);
    expect(() => createMemberThread(joao, { ...base, agentUid: '' })).toThrow(/agent/);
    expect(() => createMemberThread(joao, { ...base, template: 'nope' })).toThrow(
      /Unknown template/,
    );
  });
});

describe('a dev plan runs gate by gate', () => {
  it('Build never starts before Approve idea; the gate pins the summary version', () => {
    // Shape done → cursor at Approve idea: the thread is the member's call.
    const pl = dev([D, Pr, A, Pr, A, Pr], 1);
    expect(planView(pl.plan, pl.outcomes).waitingForYou?.number).toBe(2);
    expect(planThreadState(pl.plan, pl.outcomes).state).toBe('yourCall');
    // Build is approved but not at its turn: reporting it is refused.
    expect(() =>
      finishOutcome(agent, {
        outcomeId: 'd3',
        outcome: pl.outcomes.d3!,
        thread: TH,
        status: 'done',
        plan: pl,
      }),
    ).toThrow(/Not its turn/);
    const ap = approveOutcome(joao, {
      outcomeId: 'd2',
      outcome: pl.outcomes.d2!,
      thread: TH,
      plan: pl,
      summaryVersion: 4,
    });
    expect(at(ap.ops, O('d2'))!.data).toMatchObject({
      state: 'done',
      decision: { summaryVersion: 4 },
    });
    expect(at(ap.ops, P)!.data).toMatchObject({ cursor: 2 });
    // Build is approved and its turn: the thread waits on the agent (on the work once started).
    expect(at(ap.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'agent' } });
    expect(ap.ops.at(-1)!.data).toMatchObject({ data: { summaryVersion: 4 } });
    expect(() =>
      approveOutcome(joao, {
        outcomeId: 'd2',
        outcome: pl.outcomes.d2!,
        thread: TH,
        plan: pl,
        summaryVersion: 0,
      }),
    ).toThrow(/summary version/);
  });
  it('the plan is done only after Accept on live', () => {
    const pl = dev([D, D, D, D, D, Pr], 5);
    const ap = approveOutcome(joao, {
      outcomeId: 'd6',
      outcome: pl.outcomes.d6!,
      thread: TH,
      plan: pl,
    });
    expect(at(ap.ops, P)!.data).toMatchObject({ cursor: 6, state: 'done' });
    expect(at(ap.ops, T)!.data).toMatchObject({ state: 'done', waiting: null });
  });
});

describe('sendBackPlan', () => {
  it('Ship it? → Build: the member’s text, Build approved again, the gate decided again', () => {
    const pl = dev([D, D, D, Pr, A, Pr], 3);
    const p = sendBackPlan(joao, { ...pl, thread: TH, reason: ' Make the button bigger ' });
    expect(p.toStep).toBe(2);
    expect(p.blocked).toBe(false);
    expect(at(p.ops, O('d3'))!.data).toMatchObject({ state: 'approved' });
    // The gate at the cursor was proposed already: not written. Shape and Approve idea stay done.
    expect(at(p.ops, O('d4'))).toBeUndefined();
    expect(at(p.ops, O('d1'))).toBeUndefined();
    expect(at(p.ops, P)!.data).toMatchObject({
      cursor: 2,
      state: 'active',
      sentBack: { n: 1, to: 'd3', reason: 'Make the button bigger', by: 'joao' },
    });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'agent' } });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'plan.sent_back',
      data: {
        planId: 'p1',
        outcomeId: 'd3',
        from: 3,
        to: 2,
        reset: ['d3'],
        reason: 'Make the button bigger',
        n: 1,
      },
    });
  });
  it('Accept on live → Build resets Release and Ship it? too', () => {
    const pl = dev([D, D, D, D, D, Pr], 5, 'active', 1);
    const p = sendBackPlan(joao, { ...pl, thread: TH, reason: 'Broken on phone' });
    expect(p.toStep).toBe(2);
    expect(at(p.ops, O('d3'))!.data).toMatchObject({ state: 'approved' });
    expect(at(p.ops, O('d4'))!.data).toMatchObject({ state: 'proposed', decision: null });
    expect(at(p.ops, O('d5'))!.data).toMatchObject({ state: 'approved' });
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 2, sentBack: { n: 2 } });
  });
  it('the member may pick another earlier agent step', () => {
    const pl = dev([D, D, D, D, D, Pr], 5);
    const p = sendBackPlan(joao, { ...pl, thread: TH, reason: 'Rethink', toStep: 0 });
    expect(p.toStep).toBe(0);
    expect(at(p.ops, O('d2'))!.data).toMatchObject({ state: 'proposed', decision: null });
    expect(() => sendBackPlan(joao, { ...pl, thread: TH, reason: 'x', toStep: 1 })).toThrow(
      /earlier agent step that is done/,
    );
    expect(() => sendBackPlan(joao, { ...pl, thread: TH, reason: 'x', toStep: 5 })).toThrow(
      /earlier agent step/,
    );
  });
  it('Release finds a bug: the agent sends the plan back to Build', () => {
    const pl = dev([D, D, D, D, A, Pr], 4);
    const p = sendBackPlan(agent, { ...pl, thread: TH, reason: 'e2e fails on main', toStep: 2 });
    expect(at(p.ops, O('d3'))!.data).toMatchObject({ state: 'approved' });
    expect(at(p.ops, O('d4'))!.data).toMatchObject({ state: 'proposed', decision: null });
    expect(at(p.ops, O('d5'))).toBeUndefined();
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 2, sentBack: { by: 'agentA' } });
    expect(p.ops.at(-1)!.data).toMatchObject({ actor: { type: 'agent' }, type: 'plan.sent_back' });
    // Its default: the nearest earlier agent step.
    expect(sendBackPlan(agent, { ...pl, thread: TH, reason: 'x' }).toStep).toBe(2);
    // Not its step, not at a gate, not someone else's.
    expect(() => sendBackPlan(other, { ...pl, thread: TH, reason: 'x' })).toThrow(/Only the agent/);
    const gate = dev([D, D, D, Pr, A, Pr], 3);
    expect(() => sendBackPlan(agent, { ...gate, thread: TH, reason: 'x' })).toThrow(
      /Only the agent/,
    );
  });
  it('the member only at an approval at its turn; never another member', () => {
    const pl = dev([D, D, D, D, A, Pr], 4);
    expect(() => sendBackPlan(joao, { ...pl, thread: TH, reason: 'x' })).toThrow(
      /Only an approval at its turn/,
    );
    const g = dev([D, D, D, Pr, A, Pr], 3);
    expect(() => sendBackPlan(maria, { ...g, thread: TH, reason: 'x' })).toThrow();
    expect(() => sendBackPlan(joao, { ...g, thread: TH, reason: ' ' })).toThrow(
      /what should change/,
    );
    expect(() => sendBackPlan(joao, { ...g, thread: TH, reason: 'x'.repeat(1001) })).toThrow(
      /1000/,
    );
    const stopped = dev([D, D, D, Pr, A, Pr], 3, 'stopped');
    expect(() => sendBackPlan(joao, { ...stopped, thread: TH, reason: 'x' })).toThrow(/stopped/);
  });
  it(`the ${MAX_PLAN_SEND_BACKS}rd send back blocks the plan for the member; Retry goes on`, () => {
    const pl = dev([D, D, D, Pr, A, Pr], 3, 'active', 2);
    const p = sendBackPlan(joao, { ...pl, thread: TH, reason: 'Again' });
    expect(p.blocked).toBe(true);
    expect(at(p.ops, P)!.data).toMatchObject({ cursor: 2, state: 'blocked', sentBack: { n: 3 } });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'yourCall', waiting: null });
    // Blocked: no send back, no report of the step until the member goes on.
    const bl = dev([D, D, A, Pr, A, Pr], 2, 'blocked', 3);
    expect(() => sendBackPlan(agent, { ...bl, thread: TH, reason: 'x' })).toThrow(/blocked/);
    expect(() =>
      finishOutcome(agent, {
        outcomeId: 'd3',
        outcome: bl.outcomes.d3!,
        thread: TH,
        status: 'done',
        plan: bl,
      }),
    ).toThrow(/blocked/);
    const r = retryPlanStep(joao, { ...bl, thread: TH });
    expect(at(r.ops, O('d3'))).toBeUndefined();
    expect(at(r.ops, P)!.data).toMatchObject({ state: 'active' });
    expect(r.ops.at(-1)!.data).toMatchObject({ type: 'plan.retried', data: { outcomeId: 'd3' } });
  });
});

describe('long steps (slice 6b)', () => {
  it('Build starts with no item: running, the thread waits on the work', () => {
    const pl = dev([D, D, A, Pr, A, Pr], 2);
    const p = finishOutcome(agent, {
      outcomeId: 'd3',
      outcome: pl.outcomes.d3!,
      thread: TH,
      status: 'started',
      plan: pl,
    });
    expect(at(p.ops, O('d3'))!.data).toMatchObject({ state: 'running' });
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
    // Shape is not long: no start without an item.
    const sh = dev([A, Pr, A, Pr, A, Pr], 0);
    expect(() =>
      finishOutcome(agent, {
        outcomeId: 'd1',
        outcome: sh.outcomes.d1!,
        thread: TH,
        status: 'started',
        plan: sh,
      }),
    ).toThrow(/Give the item/);
  });
  it('outcome_done records the usage on its event', () => {
    const pl = dev([D, D, 'running', Pr, A, Pr], 2);
    const p = finishOutcome(agent, {
      outcomeId: 'd3',
      outcome: pl.outcomes.d3!,
      thread: TH,
      status: 'done',
      plan: pl,
      usage: { tokens: 120000, costEur: 1.234567 },
    });
    expect(p.ops.at(-1)!.data).toMatchObject({
      data: { usage: { tokens: 120000, costEur: 1.2346 } },
    });
    expect(() =>
      finishOutcome(agent, {
        outcomeId: 'd3',
        outcome: pl.outcomes.d3!,
        thread: TH,
        status: 'done',
        plan: pl,
        usage: { tokens: -1 },
      }),
    ).toThrow(/usage.tokens/);
  });
  it('step_progress: a line and a percent on the running long step, nothing else', () => {
    const pl = dev([D, D, 'running', Pr, A, Pr], 2);
    const base = { outcomeId: 'd3', outcome: pl.outcomes.d3!, thread: TH, plan: pl };
    const p = stepProgress(agent, { ...base, line: '  Tests   green ', percent: 70 });
    expect(p.ops.map((o) => o.path)).toEqual([O('d3'), `workspaces/w1/inboxEvents/${p.eventId}`]);
    expect(at(p.ops, O('d3'))!.data).toMatchObject({
      progress: { line: 'Tests green', percent: 70 },
    });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'step.progress',
      data: { line: 'Tests green', percent: 70 },
    });
    expect(() => stepProgress(agent, { ...base, line: ' ' })).toThrow(/where it stands/);
    expect(() => stepProgress(agent, { ...base, line: 'x'.repeat(141) })).toThrow(/140/);
    expect(() => stepProgress(agent, { ...base, line: 'x', percent: 101 })).toThrow(/percent/);
    expect(() => stepProgress(other, { ...base, line: 'x' })).toThrow(/Only the agent/);
    const ap = dev([D, D, A, Pr, A, Pr], 2);
    expect(() =>
      stepProgress(agent, {
        outcomeId: 'd3',
        outcome: ap.outcomes.d3!,
        thread: TH,
        plan: ap,
        line: 'x',
      }),
    ).toThrow(/started first/);
  });
});

describe('Keep green (slice 6c)', () => {
  const K = (
    states: OutcomeStateOf['state'][],
    cursor: number,
    state: PlanInput['plan']['state'] = 'active',
    sent = 0,
  ) => dev(states, cursor, state, sent, IDS7, TYPES7);
  const R = 'running' as const;
  it('runs as a long step after Build: started, progress, done offers Ship it?', () => {
    const pl = K([D, D, D, A, Pr, A, Pr], 3);
    const st = finishOutcome(agent, {
      outcomeId: 'd4',
      outcome: pl.outcomes.d4!,
      thread: TH,
      status: 'started',
      plan: pl,
    });
    expect(at(st.ops, O('d4'))!.data).toMatchObject({ state: 'running' });
    const run = K([D, D, D, R, Pr, A, Pr], 3);
    const base = { outcomeId: 'd4', outcome: run.outcomes.d4!, thread: TH, plan: run };
    const p = stepProgress(agent, {
      ...base,
      line: 'rebased on main 4f2a1c0, 212/214 green, fixing lint',
      percent: 60,
    });
    expect(at(p.ops, O('d4'))!.data).toMatchObject({ progress: { percent: 60 } });
    const done = finishOutcome(agent, {
      ...base,
      status: 'done',
      result: { text: 'Green on 4f2a1c0' },
    });
    expect(at(done.ops, P)!.data).toMatchObject({ cursor: 4 });
    expect(at(done.ops, T)!.data).toMatchObject({ state: 'yourCall', waiting: null });
  });
  it('while Ship it? waits: re-checks on the done step (rechecking, green, blocked)', () => {
    const pl = K([D, D, D, D, Pr, A, Pr], 4);
    const base = { outcomeId: 'd4', outcome: pl.outcomes.d4!, thread: TH, plan: pl };
    const p = stepProgress(agent, {
      ...base,
      line: 'main moved to 9b1e2d3: rebasing',
      check: 'rechecking',
    });
    expect(at(p.ops, O('d4'))!.data).toEqual({
      progress: {
        line: 'main moved to 9b1e2d3: rebasing',
        percent: null,
        check: 'rechecking',
        at: expect.anything(),
      },
      updatedAt: expect.anything(),
      lastEventId: p.eventId,
    });
    // Only the step: the plan, the thread and the gate stay as they are.
    expect(p.ops.map((o) => o.path)).toEqual([O('d4'), `workspaces/w1/inboxEvents/${p.eventId}`]);
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'step.progress',
      data: { check: 'rechecking' },
    });
    for (const c of ['green', 'blocked'] as const)
      expect(
        at(stepProgress(agent, { ...base, line: 'x', check: c }).ops, O('d4'))!.data,
      ).toMatchObject({
        progress: { check: c },
      });
    expect(() => stepProgress(agent, { ...base, line: 'x', check: 'red' as never })).toThrow(
      /check is/,
    );
    expect(() => stepProgress(other, { ...base, line: 'x' })).toThrow(/Only the agent/);
  });
  it('Keep green ends once Ship it? is decided; other done steps take no progress', () => {
    const rel = K([D, D, D, D, D, A, Pr], 5);
    expect(() =>
      stepProgress(agent, {
        outcomeId: 'd4',
        outcome: rel.outcomes.d4!,
        thread: TH,
        plan: rel,
        line: 'x',
        check: 'rechecking',
      }),
    ).toThrow(/Keep green ended/);
    // Build is done before the cursor too, but it is not Keep green.
    const pl = K([D, D, D, R, Pr, A, Pr], 3);
    expect(() =>
      stepProgress(agent, {
        outcomeId: 'd3',
        outcome: { ...pl.outcomes.d3!, state: 'done' },
        thread: TH,
        plan: pl,
        line: 'x',
      }),
    ).toThrow(/started first/);
    // A check only on Keep green.
    const b = K([D, D, R, A, Pr, A, Pr], 2);
    expect(() =>
      stepProgress(agent, {
        outcomeId: 'd3',
        outcome: b.outcomes.d3!,
        thread: TH,
        plan: b,
        line: 'x',
        check: 'green',
      }),
    ).toThrow(/Keep green/);
  });
  it('unsolvable: failed blocks the plan; the member may send it back to Build', () => {
    const run = K([D, D, D, R, Pr, A, Pr], 3);
    const f = finishOutcome(agent, {
      outcomeId: 'd4',
      outcome: run.outcomes.d4!,
      thread: TH,
      status: 'failed',
      plan: run,
      result: { error: 'lint fails after 3 fixes: no-unused-vars in a.ts' },
    });
    expect(at(f.ops, P)!.data).toMatchObject({ state: 'blocked' });
    const bl = K([D, D, D, 'failed', Pr, A, Pr], 3, 'blocked');
    const p = sendBackPlan(joao, { ...bl, thread: TH, reason: 'Fix it in Build' });
    expect(p.toStep).toBe(2);
    expect(at(p.ops, O('d3'))!.data).toMatchObject({ state: 'approved' });
    expect(at(p.ops, O('d4'))!.data).toEqual({
      state: 'approved',
      updatedAt: expect.anything(),
      lastEventId: p.eventId,
    });
    expect(at(p.ops, P)!.data).toMatchObject({
      cursor: 2,
      state: 'active',
      sentBack: { n: 1, to: 'd3' },
    });
    // The agent never sends a blocked plan back; a blocked plan without a failed step neither.
    expect(() => sendBackPlan(agent, { ...bl, thread: TH, reason: 'x' })).toThrow(/blocked/);
    const b3 = K([D, D, A, Pr, Pr, A, Pr], 2, 'blocked', 3);
    expect(() => sendBackPlan(joao, { ...b3, thread: TH, reason: 'x' })).toThrow(/blocked/);
  });
});
