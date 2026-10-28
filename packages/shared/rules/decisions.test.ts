/**
 * SPEC §5.1 decision rules: only deciders decide; agents never decide; an item passes a gate
 * only when the approvals satisfy the step's rule (any / atLeast / all / specific + mustInclude);
 * send back and stop obey the reject policy (one / majority). Plus answers and finding triage.
 */
import { doc, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  answer,
  approve,
  createItem,
  sendBack,
  SERVER_TIME,
  stop,
  triageFinding,
  updateItem,
  type ActionPlan,
  type ItemState,
} from '../src/actions';
import type { Gate } from '../src/schema';
import { paths } from '../src/schema';
import {
  AGENTS,
  as,
  atGate,
  denied,
  eventOp,
  I,
  itemDoc,
  now,
  ok,
  P,
  projectDoc,
  put,
  snap,
  steps,
  useEmulator,
  W,
} from './harness';

useEmulator();

/** An untriaged agent finding (a suggestion) at p1's first step, found on i1. */
const suggestion = (over: Record<string, unknown> = {}) =>
  itemDoc({
    stepId: 'intake',
    type: 'finding',
    status: 'suggested',
    parentItemId: 'i1',
    createdBy: { type: 'agent', id: AGENTS.a },
    ...over,
  });

/** Configure p1's review gate and put item `gated` there with the given votes. */
async function gateWith(g: Partial<Gate>, approvals: string[] = [], rejections: string[] = []) {
  await put({ [P('p1')]: projectDoc(g), [I('gated')]: atGate(approvals, rejections) });
  const item = (await snap(I('gated'))) as unknown as ItemState;
  return { project: { steps: steps(g) }, item };
}

function approveAs(
  uid: string,
  ctx: { project: { steps: ReturnType<typeof steps> }; item: ItemState },
) {
  const a = as(uid);
  return {
    a,
    plan: approve(a.ctx, {
      project: ctx.project,
      projectId: 'p1',
      itemId: 'gated',
      item: ctx.item,
      rationale: 'Looks right',
    }),
  };
}

/** Rewrites the item op of a plan. */
function withItem(plan: ActionPlan, data: Record<string, unknown>, replace = false): ActionPlan {
  return {
    ...plan,
    ops: plan.ops.map((op) =>
      op.path === I('gated') ? { ...op, data: replace ? data : { ...op.data, ...data } } : op,
    ),
  };
}
const advanceTo = { stepId: 'publish', status: 'queued', claim: null, gate: null };
/** Forge a plan's item op into a full advance to the next step (what a cheating client sends). */
const forceAdvance = (plan: ActionPlan) =>
  withItem(plan, { ...advanceTo, updatedAt: SERVER_TIME, lastEventId: plan.eventId }, true);
/** Turn a plan built for a fake 'human' actor back into what the agent identity really sends. */
const asAgentEvent = (plan: ActionPlan): ActionPlan => ({
  ...plan,
  ops: plan.ops.map((op) =>
    op.path.includes('/events/')
      ? { ...op, data: { ...op.data, actor: { ...(op.data!.actor as object), type: 'agent' } } }
      : op,
  ),
});

describe('who may decide', () => {
  it('stores how long the item waited, and refuses a forged value', async () => {
    const g = await gateWith({ rule: 'any' });
    const a = as('alice');
    const plan = approve(a.ctx, {
      project: g.project,
      projectId: 'p1',
      itemId: 'gated',
      item: g.item,
      waitedMs: 90_000,
    });
    const forged = {
      ...plan,
      ops: plan.ops.map((op) =>
        op.path.includes('/decisions/') ? { ...op, data: { ...op.data, waitMs: -5 } } : op,
      ),
    };
    await denied(a.run(forged));
    await ok(a.run(plan));
    expect((await snap(paths.decision(W, 'p1', plan.eventId))).waitMs).toBe(90_000);
  });
  it('allows a decider to approve (any → advances to the next step)', async () => {
    const g = await gateWith({ rule: 'any' });
    const { a, plan } = approveAs('alice', g);
    expect(plan.advanced).toBe(true);
    await ok(a.run(plan));
    expect((await snap(I('gated'))).stepId).toBe('publish');
    expect((await snap(paths.decision(W, 'p1', plan.eventId))).outcome).toBe('approved');
  });
  it('ATTACK: denies an agent approving (via the action, raw gate write, or a decision doc)', async () => {
    const g = await gateWith({ rule: 'any', deciderUids: ['alice', AGENTS.a] });
    const ag = as(AGENTS.a);
    const human = approve(
      { ...ag.ctx, actor: { ...ag.ctx.actor, type: 'human' } },
      {
        project: g.project,
        projectId: 'p1',
        itemId: 'gated',
        item: g.item,
      },
    );
    await denied(ag.run(human));
    await denied(ag.run(asAgentEvent(human)));
    const raw = withItem(
      human,
      { [`gate.approvals.${AGENTS.a}`]: { at: SERVER_TIME, rationale: '' } },
      true,
    );
    await denied(ag.run(raw.ops.filter((op) => !op.path.includes('/decisions/'))));
    await denied(
      ag.run(
        human.ops.filter((op) => op.path.includes('/decisions/') || op.path.includes('/events/')),
      ),
    );
  });
  it('ATTACK: denies a human who is not a decider approving', async () => {
    const g = await gateWith({ rule: 'any', deciderUids: ['alice', 'bob'] });
    const { a, plan } = approveAs('dave', g);
    await denied(a.run(plan));
    await denied(
      a.run(
        withItem(
          plan,
          {
            'gate.approvals.dave': { at: SERVER_TIME, rationale: '' },
            updatedAt: SERVER_TIME,
            lastEventId: plan.eventId,
          },
          true,
        ),
      ),
    );
  });
  it('ATTACK: denies a non-member (or removed member) approving even if listed as decider', async () => {
    const g = await gateWith({ rule: 'any', deciderUids: ['alice', 'eve'] });
    const { a, plan } = approveAs('eve', g);
    await denied(a.run(plan));
  });
  it('ATTACK: denies approving twice, or approving on behalf of someone else', async () => {
    const g = await gateWith({ rule: 'all' }, ['alice']);
    const twice = approveAs('alice', g);
    await denied(twice.a.run(twice.plan));
    const { a, plan } = approveAs('bob', g);
    const forCarol = {
      'gate.approvals.carol': { at: SERVER_TIME, rationale: '' },
      updatedAt: SERVER_TIME,
      lastEventId: plan.eventId,
    };
    await denied(a.run(withItem(plan, forCarol, true)));
  });
  it('denies an approval without its decision doc, and a decision without the item change', async () => {
    const g = await gateWith({ rule: 'all' });
    const { a, plan } = approveAs('alice', g);
    await denied(a.run(plan.ops.filter((op) => !op.path.includes('/decisions/'))));
    await denied(a.run(plan.ops.filter((op) => op.path !== I('gated'))));
  });
});

describe('gate rules', () => {
  it('ATTACK: atLeast 2 — denies advancing with one approval; allows recording it', async () => {
    const g = await gateWith({ rule: 'atLeast', n: 2 });
    const { a, plan } = approveAs('alice', g);
    expect(plan.advanced).toBe(false);
    await denied(a.run(forceAdvance(plan)));
    await ok(a.run(plan));
  });
  it('atLeast 2 — allows the second approver to advance', async () => {
    const g = await gateWith({ rule: 'atLeast', n: 2 }, ['alice']);
    const { a, plan } = approveAs('bob', g);
    expect(plan.advanced).toBe(true);
    await ok(a.run(plan));
  });
  it('ATTACK: atLeast 2 — a non-decider approval does not count towards n', async () => {
    await put({
      [I('gated')]: {
        ...atGate(['alice']),
        gate: {
          stepId: 'review',
          approvals: { alice: { at: now(), rationale: '' }, dave: { at: now(), rationale: '' } },
          rejections: {},
        },
      },
    });
    await put({ [P('p1')]: projectDoc({ rule: 'atLeast', n: 3 }) });
    const item = (await snap(I('gated'))) as unknown as ItemState;
    const { a, plan } = approveAs('bob', {
      project: { steps: steps({ rule: 'atLeast', n: 3 }) },
      item,
    });
    await denied(a.run(forceAdvance(plan)));
  });
  it('all — denies advancing until everyone approved; allows the last one', async () => {
    const two = await gateWith({ rule: 'all' }, ['alice']);
    const early = approveAs('bob', two);
    await denied(early.a.run(forceAdvance(early.plan)));
    const last = await gateWith({ rule: 'all' }, ['alice', 'bob']);
    const fin = approveAs('carol', last);
    expect(fin.plan.advanced).toBe(true);
    await ok(fin.a.run(fin.plan));
  });
  it('specific — needs every listed person', async () => {
    const g = { rule: 'specific' as const, deciderUids: ['alice', 'carol'] };
    const one = await gateWith(g);
    const early = approveAs('alice', one);
    await denied(early.a.run(forceAdvance(early.plan)));
    const two = await gateWith(g, ['alice']);
    const fin = approveAs('carol', two);
    await ok(fin.a.run(fin.plan));
  });
  it('mustInclude — denies advancing without the required person; allows with them', async () => {
    const g = { rule: 'any' as const, mustInclude: ['carol'] };
    const without = await gateWith(g);
    const alice = approveAs('alice', without);
    expect(alice.plan.advanced).toBe(false);
    await denied(alice.a.run(forceAdvance(alice.plan)));
    await ok(alice.a.run(alice.plan));
    const withCarol = await gateWith(g, ['alice']);
    const carol = approveAs('carol', withCarol);
    await ok(carol.a.run(carol.plan));
  });
  it('ATTACK: denies advancing two steps, or to a step that is not next', async () => {
    const g = await gateWith({ rule: 'any' });
    const { a, plan } = approveAs('alice', g);
    expect(plan.advanced).toBe(true);
    await denied(a.run(withItem(plan, { stepId: 'intake', status: 'queued', gate: null })));
    await denied(a.run(withItem(plan, { status: 'done', gate: null })));
  });
  it('allows the last gate to finish the item (status done)', async () => {
    const s = steps().slice(0, 3);
    await put({
      [P('p1')]: { ...projectDoc(), steps: s, stepIndex: { intake: 0, draft: 1, review: 2 } },
    });
    const item = (await snap(I('gated'))) as unknown as ItemState;
    const a = as('alice');
    const plan = approve(a.ctx, { project: { steps: s }, projectId: 'p1', itemId: 'gated', item });
    await ok(a.run(plan));
    expect((await snap(I('gated'))).status).toBe('done');
  });
});

describe('send back and stop', () => {
  it('one — allows any single decider to send back to an earlier step', async () => {
    const g = await gateWith({ rejectPolicy: 'one' });
    const a = as('alice');
    const plan = sendBack(a.ctx, {
      ...g,
      projectId: 'p1',
      itemId: 'gated',
      toStepId: 'draft',
      rationale: 'Wrong audience for this',
      tags: ['Wrong audience'],
    });
    expect(plan.moved).toBe(true);
    await ok(a.run(plan));
    const after = await snap(I('gated'));
    expect([after.stepId, after.status, after.sendBackCount]).toEqual(['draft', 'queued', 1]);
  });
  it('denies sending forward, to the same step, without the counter, or with a short reason', async () => {
    const g = await gateWith({ rejectPolicy: 'one' });
    const a = as('alice');
    const plan = sendBack(a.ctx, {
      ...g,
      projectId: 'p1',
      itemId: 'gated',
      toStepId: 'draft',
      rationale: 'Wrong audience for this',
    });
    await denied(a.run(withItem(plan, { stepId: 'publish' })));
    await denied(
      a.run(
        withItem(plan, {
          stepId: 'review',
          status: 'waiting',
          gate: { stepId: 'review', approvals: {}, rejections: {} },
        }),
      ),
    );
    await denied(a.run(withItem(plan, { sendBackCount: 0 })));
    const short = {
      ...plan,
      ops: plan.ops.map((op) =>
        op.path.includes('/decisions/') ? { ...op, data: { ...op.data, rationale: 'meh' } } : op,
      ),
    };
    await denied(a.run(short));
  });
  it('ATTACK: denies a non-decider or an agent sending back', async () => {
    const g = await gateWith({ rejectPolicy: 'one', deciderUids: ['alice'] });
    const d = as('dave');
    await denied(
      d.run(
        sendBack(d.ctx, {
          ...g,
          projectId: 'p1',
          itemId: 'gated',
          toStepId: 'draft',
          rationale: 'Not what I asked for',
        }),
      ),
    );
    const ag = as(AGENTS.a);
    const forged = sendBack(
      { ...ag.ctx, actor: { ...ag.ctx.actor, type: 'human' } },
      {
        ...g,
        projectId: 'p1',
        itemId: 'gated',
        toStepId: 'draft',
        rationale: 'Not what I asked for',
      },
    );
    await denied(ag.run(forged));
    await denied(ag.run(asAgentEvent(forged)));
  });
  it('majority — one of three records a rejection but cannot move the item', async () => {
    const g = await gateWith({ rejectPolicy: 'majority' });
    const a = as('alice');
    const plan = sendBack(a.ctx, {
      ...g,
      projectId: 'p1',
      itemId: 'gated',
      toStepId: 'draft',
      rationale: 'Too long for the blog',
    });
    expect(plan.moved).toBe(false);
    const forcedMove = withItem(
      plan,
      {
        stepId: 'draft',
        status: 'queued',
        gate: null,
        claim: null,
        sendBackCount: 1,
        updatedAt: SERVER_TIME,
        lastEventId: plan.eventId,
      },
      true,
    );
    await denied(a.run(forcedMove));
    await ok(a.run(plan));
  });
  it('majority — the second of three rejections moves it', async () => {
    const g = await gateWith({ rejectPolicy: 'majority' }, [], ['alice']);
    const b = as('bob');
    const plan = sendBack(b.ctx, {
      ...g,
      projectId: 'p1',
      itemId: 'gated',
      toStepId: 'intake',
      rationale: 'Factually wrong in two places',
    });
    expect(plan.moved).toBe(true);
    await ok(b.run(plan));
  });
  it('stop — allowed for a decider under one; majority needs a majority', async () => {
    const one = await gateWith({ rejectPolicy: 'one' });
    const a = as('alice');
    await ok(
      a.run(
        stop(a.ctx, {
          ...one,
          projectId: 'p1',
          itemId: 'gated',
          rationale: 'Not doing this any more',
        }),
      ),
    );
    const maj = await gateWith({ rejectPolicy: 'majority' });
    const plan = stop(a.ctx, {
      ...maj,
      projectId: 'p1',
      itemId: 'gated',
      rationale: 'Not doing this any more',
    });
    await denied(
      a.run(
        withItem(
          plan,
          {
            status: 'stopped',
            gate: null,
            claim: null,
            updatedAt: SERVER_TIME,
            lastEventId: plan.eventId,
          },
          true,
        ),
      ),
    );
  });
});

describe('human edits, answers, findings', () => {
  it('allows a member to create an item in Intake; denies later steps and fake findings', async () => {
    const a = as('alice');
    const project = { steps: steps() };
    await ok(
      a.run(createItem(a.ctx, { project, projectId: 'p1', title: 'New idea', type: 'idea' })),
    );
    const later = createItem(a.ctx, {
      project: { steps: steps().slice(2) },
      projectId: 'p1',
      title: 'Skip',
      type: 'idea',
    });
    await denied(a.run(later));
    const p = createItem(a.ctx, { project, projectId: 'p1', title: 'Fake', type: 'idea' });
    await denied(
      a.run({
        ...p,
        ops: p.ops.map((op) =>
          op.path.includes('/items/') ? { ...op, data: { ...op.data, type: 'finding' } } : op,
        ),
      }),
    );
    // nor a fake suggestion
    await denied(
      a.run({
        ...p,
        ops: p.ops.map((op) =>
          op.path.includes('/items/') ? { ...op, data: { ...op.data, status: 'suggested' } } : op,
        ),
      }),
    );
  });
  it('allows editing title/summary/order; ATTACK: denies a human moving an item past a gate', async () => {
    const a = as('alice');
    await ok(
      a.run(
        updateItem(a.ctx, {
          projectId: 'p1',
          itemId: 'gated',
          changes: { title: 'Better title', order: 3 },
        }),
      ),
    );
    const drag = updateItem(a.ctx, { projectId: 'p1', itemId: 'gated', changes: { title: 'x' } });
    await denied(a.run(withItem(drag, { stepId: 'publish', status: 'queued', gate: null })));
    await denied(a.run(withItem(drag, { status: 'done' })));
    const i1 = updateItem(a.ctx, { projectId: 'p1', itemId: 'i1', changes: {} });
    await denied(
      a.run({
        ...i1,
        ops: i1.ops.map((op) =>
          op.path === I('i1')
            ? {
                ...op,
                data: {
                  ...op.data,
                  claim: { runId: 'r', agentUid: 'alice', heartbeatAt: SERVER_TIME },
                },
              }
            : op,
        ),
      }),
    );
  });
  it('allows a member to answer an agent question; denies a non-member', async () => {
    await put({
      [paths.message(W, 'p1', 'i1', 'q1')]: {
        workspaceId: W,
        projectId: 'p1',
        itemId: 'i1',
        by: { type: 'agent', id: AGENTS.a },
        kind: 'question',
        text: 'Which audience?',
        at: now(),
        answered: false,
        replyTo: null,
        lastEventId: 'seed',
      },
    });
    const e = as('eve');
    await denied(
      e.run(
        answer(e.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: { title: 't', stepId: 'draft' },
          questionId: 'q1',
          text: 'Developers',
        }),
      ),
    );
    const d = as('dave');
    await ok(
      d.run(
        answer(d.ctx, {
          projectId: 'p1',
          itemId: 'i1',
          item: { title: 't', stepId: 'draft' },
          questionId: 'q1',
          text: 'Developers',
        }),
      ),
    );
    expect((await snap(paths.message(W, 'p1', 'i1', 'q1'))).answered).toBe(true);
  });
  it('allows triaging a suggestion (add to first step / add to item / dismiss); denies agents and short dismissals', async () => {
    const finding = suggestion();
    await put({ [I('f1')]: finding, [I('f2')]: finding, [I('f3')]: finding });
    const a = as('owner');
    const f = { title: 'Broken link', summary: 'On /about', parentItemId: 'i1' };
    const project = { steps: steps() };
    await ok(
      a.run(
        triageFinding(a.ctx, {
          project,
          projectId: 'p1',
          itemId: 'f1',
          finding: f,
          outcome: 'intake',
          newType: 'bug',
        }),
      ),
    );
    expect(await snap(I('f1'))).toMatchObject({
      type: 'bug',
      status: 'queued',
      stepId: 'intake',
      gate: null,
      claim: null,
    });
    await ok(
      a.run(
        triageFinding(a.ctx, {
          project,
          projectId: 'p1',
          itemId: 'f2',
          finding: f,
          outcome: 'addedToItem',
          parentSummary: '',
        }),
      ),
    );
    expect(String((await snap(I('i1'))).summary)).toContain('Broken link');
    const short = triageFinding(a.ctx, {
      project,
      projectId: 'p1',
      itemId: 'f3',
      finding: f,
      outcome: 'dismissed',
      reason: 'Not needed at all',
    });
    await denied(
      a.run({
        ...short,
        ops: short.ops.map((op) =>
          op.path === I('f3')
            ? {
                ...op,
                data: {
                  ...op.data,
                  triage: { outcome: 'dismissed', reason: 'no', byUid: 'owner', at: SERVER_TIME },
                },
              }
            : op,
        ),
      }),
    );
    await ok(a.run(short));
    expect(await snap(I('f3'))).toMatchObject({ status: 'stopped', type: 'finding' });
    const ag = as(AGENTS.a);
    await put({ [I('f4')]: finding });
    await denied(
      ag.run(
        triageFinding(
          { ...ag.ctx, actor: { ...ag.ctx.actor, type: 'human' } },
          { project, projectId: 'p1', itemId: 'f4', finding: f, outcome: 'intake' },
        ),
      ),
    );
  });
  describe('suggestions: who may triage (canTriage, one place)', () => {
    const f = { title: 'Broken link', summary: '', parentItemId: 'i1' };
    const dismiss = (uid: string, project: { steps: ReturnType<typeof steps> }) => {
      const x = as(uid);
      return x.run(
        triageFinding(x.ctx, {
          project,
          projectId: 'p1',
          itemId: 'f1',
          finding: f,
          outcome: 'dismissed',
          reason: 'We do not want this now',
        }),
      );
    };
    const add = (uid: string, project: { steps: ReturnType<typeof steps> }) => {
      const x = as(uid);
      return x.run(
        triageFinding(x.ctx, {
          project,
          projectId: 'p1',
          itemId: 'f1',
          finding: f,
          outcome: 'intake',
        }),
      );
    };
    it('admins and the project creator may; a plain member may not when the first step is an agent step', async () => {
      const project = { steps: steps() };
      await put({ [I('f1')]: suggestion() });
      await denied(add('alice', project));
      await denied(dismiss('dave', project));
      await ok(add('owner', project));
      await put({ [P('p1')]: projectDoc({}, { createdBy: 'alice' }), [I('f1')]: suggestion() });
      await ok(dismiss('alice', project));
    });
    it('deciders of the first step may when it is a gate; other members may not', async () => {
      const gated = [
        {
          id: 'ideas',
          name: 'Ideas',
          kind: 'human' as const,
          description: 'Pick',
          gate: {
            deciderUids: ['bob'],
            groupIds: [],
            rule: 'any' as const,
            n: 1,
            mustInclude: [],
            rejectPolicy: 'one' as const,
            remindAfterHours: 24,
          },
        },
        ...steps(),
      ];
      await put({
        [P('p1')]: projectDoc(
          {},
          { steps: gated, stepIndex: Object.fromEntries(gated.map((x, i) => [x.id, i])) },
        ),
        [I('f1')]: suggestion({ stepId: 'ideas' }),
      });
      const project = { steps: gated };
      await denied(add('dave', project));
      await ok(add('bob', project));
      // added at a gate: it waits there with a fresh gate
      expect(await snap(I('f1'))).toMatchObject({
        status: 'waiting',
        stepId: 'ideas',
        gate: { stepId: 'ideas', approvals: {}, rejections: {} },
      });
    });
    it('ATTACK: denies triaging twice, an already triaged finding, or adding it past the first step', async () => {
      const project = { steps: steps() };
      await put({ [I('f1')]: suggestion() });
      await ok(dismiss('owner', project));
      await denied(add('owner', project));
      await put({ [I('f1')]: suggestion() });
      const o = as('owner');
      const p = triageFinding(o.ctx, {
        project,
        projectId: 'p1',
        itemId: 'f1',
        finding: f,
        outcome: 'intake',
      });
      await denied(
        o.run({
          ...p,
          ops: p.ops.map((op) =>
            op.path === I('f1') ? { ...op, data: { ...op.data, stepId: 'draft' } } : op,
          ),
        }),
      );
    });
  });
  it('ATTACK: denies a member editing someone else’s decision mark or an existing decision', async () => {
    const g = await gateWith({ rule: 'all' }, ['alice']);
    const b = as('bob');
    const { plan } = approveAs('bob', g);
    await ok(b.run(plan));
    await denied(
      updateDoc(doc(b.db, paths.decision(W, 'p1', plan.eventId)), { rationale: 'changed' }),
    );
    await denied(
      b.run([
        eventOp(b, 'e-x', { itemId: 'gated', type: 'decision.approved' }),
        {
          kind: 'update',
          path: I('gated'),
          data: {
            'gate.approvals.alice': { at: SERVER_TIME, rationale: 'x' },
            updatedAt: SERVER_TIME,
            lastEventId: 'e-x',
          },
        },
      ]),
    );
  });
});
