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
const IDS = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
const TYPES = ['shape', 'approval', 'build', 'approval', 'release', 'approval'];
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
): PlanInput & { plan: PlanOf & SendBackOf } {
  return {
    planId: 'p1',
    plan: {
      memberUid: 'joao',
      threadId: 't1',
      steps: IDS,
      cursor,
      state,
      sendBackTo: templateSendBack('dev', IDS),
      ...(sent ? { sentBack: { n: sent } } : {}),
    },
    outcomes: Object.fromEntries(
      IDS.map((id, i) => [
        id,
        {
          memberUid: 'joao',
          threadId: 't1',
          type: TYPES[i]!,
          fields: (TYPES[i] === 'approval' ? { what: 'x' } : {}) as Record<string, string>,
          state: states[i]!,
          executor: TYPES[i] === 'approval' ? null : 'agentA',
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
  it('has the development step types, plan-only, agent, build and release long', () => {
    for (const k of ['shape', 'build', 'release'] as const) {
      expect(PLAN_TYPES).toContain(k);
      expect(SINGLE_TYPES).not.toContain(k);
      expect(OUTCOMES[k].executor).toBe('agent');
      expect(outcomeKind(k)).toBe('agent');
    }
    expect('long' in OUTCOMES.shape).toBe(false);
    expect(OUTCOMES.build.long).toBe(true);
    expect(OUTCOMES.release.long).toBe(true);
  });
  it('the Development template: six steps, gates sending back to Shape, Build, Build', () => {
    const t = PLAN_TEMPLATES.dev;
    expect(t.steps.map((s) => s.type)).toEqual(TYPES);
    expect(t.steps.length).toBeLessThanOrEqual(PLAN_LIMITS.steps);
    expect(t.steps.filter((s) => s.type === 'approval').map((s) => s.fields.what)).toEqual([
      'Approve idea',
      'Ship it?',
      'Accept on live',
    ]);
    expect(templateSendBack('dev', IDS)).toEqual({ d2: 'd1', d4: 'd3', d6: 'd3' });
    expect(planTemplate('nope')).toBeNull();
    expect(() => templateSteps('nope')).toThrow(/Unknown template nope. Templates: dev/);
    expect(templateSteps('dev', [{ idea: 'A' }])[0]).toEqual({
      type: 'shape',
      fields: { idea: 'A' },
    });
    expect(() => templateSteps('dev', Array(7).fill({}))).toThrow(/has 6 steps/);
  });
  it('sendBackTarget: the template target, else the nearest earlier agent step', () => {
    const types = Object.fromEntries(IDS.map((id, i) => [id, TYPES[i]]));
    const map = templateSendBack('dev', IDS);
    expect(sendBackTarget(IDS, types, 1, map)).toBe(0);
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
      stepIds: IDS,
    });
    expect(at(p.ops, P)!.data).toMatchObject({
      state: 'proposed',
      templateId: 'dev',
      sendBackTo: { d2: 'd1', d4: 'd3', d6: 'd3' },
      proposedBy: 'agentA',
    });
    expect(at(p.ops, O('d1'))!.data).toMatchObject({
      type: 'shape',
      fields: { idea: 'Dark mode' },
      state: 'proposed',
      note: 'S',
    });
    expect(at(p.ops, O('d4'))!.data).toMatchObject({
      type: 'approval',
      fields: { what: 'Ship it?' },
    });
    // Agents never make approved steps.
    for (const id of IDS) expect(at(p.ops, O(id))!.data!.state).toBe('proposed');
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
      stepIds: IDS,
    });
    expect(p.planId).toBe('p1');
    expect(at(p.ops, P)!.data).toMatchObject({
      proposedBy: 'joao',
      state: 'active',
      cursor: 0,
      steps: IDS,
      templateId: 'dev',
      sendBackTo: { d2: 'd1', d4: 'd3', d6: 'd3' },
    });
    expect(IDS.map((id) => at(p.ops, O(id))!.data!.state)).toEqual([A, Pr, A, Pr, A, Pr]);
    expect(at(p.ops, O('d1'))!.data).toMatchObject({
      fields: { idea: 'Add a dark mode' },
      executor: 'agentA',
      proposedBy: 'joao',
      decision: null,
    });
    expect(at(p.ops, O('d2'))!.data).toMatchObject({ executor: null });
    // Shape is at its turn and approved: the agent carries it out; the thread is not waiting.
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'yourCall', waiting: null });
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'thread.created',
      data: { planId: 'p1', steps: IDS, templateId: 'dev' },
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
    // While Build runs, the thread waits on the work.
    expect(at(ap.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
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
    expect(at(p.ops, T)!.data).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
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
