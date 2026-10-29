/**
 * Inbox plans (item qwFAWxZM5xkcE7PPjAzi): a plan orders outcomes of one thread. Agents propose
 * whole plans in one batch; nothing runs before the member approves it; steps run strictly in
 * order (the cursor); a person step (approval) is decided by the member alone, at its turn.
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approveOutcome,
  approvePlan,
  editPlan,
  finishOutcome,
  inboxPaths,
  proposeOutcome,
  proposePlan,
  rejectOutcome,
  rejectPlan,
  retryPlanStep,
  skipPlanStep,
  stopPlan,
  wakeThread,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type PlanStepInput,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, ok, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);

async function started(ref = 'r1', threadRef = 'thread-1') {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: `im-${ref}`,
        ref,
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef,
        messageId: 'm-1',
        permalink: 'https://teams.example.com/m/1',
        replyRef: 'conv:1',
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}
const thread = async (tid = 'itr1') => (await snap(T(tid))) as unknown as ThreadStateOf;

// The design's example: reply → book → you approve → Build it → reply "done".
const EXAMPLE: PlanStepInput[] = [
  { type: 'reply', fields: { text: 'Thursday works.' } },
  {
    type: 'book',
    fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', with: 'Sam' },
  },
  { type: 'approval', fields: { what: 'The price-list change', detail: '€10 → €12' } },
  { type: 'make_it_work', fields: { title: 'Update the price list', project: 'Website' } },
  { type: 'reply', fields: { text: 'Done: the new prices are live.' } },
];
const IDS = ['st1', 'st2', 'st3', 'st4', 'st5'];

async function proposed(steps = EXAMPLE, ids = IDS, tid = 'itr1', pid = 'pl1') {
  const a = as(AGENTS.a);
  const p = proposePlan(a.ctx, {
    threadId: tid,
    thread: await thread(tid),
    note: 'Thursday, then the price list',
    steps,
    planId: pid,
    stepIds: ids,
  });
  await ok(a.run(p));
  return a;
}
async function load(pid = 'pl1'): Promise<PlanInput> {
  const plan = (await snap(PL(pid))) as unknown as PlanOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = (await snap(O(id))) as unknown as OutcomeStateOf;
  return { planId: pid, plan, outcomes };
}
const stepOf = async (i: number, pid = 'pl1') => {
  const pl = await load(pid);
  const id = pl.plan.steps[i]!;
  return { outcomeId: id, outcome: pl.outcomes[id]!, thread: await thread(), plan: pl };
};
/** A step as if its plan were live at `cursor` (to build batches the actions refuse). */
const live = (st: Awaited<ReturnType<typeof stepOf>>, cursor: number) => ({
  ...st,
  outcome: { ...st.outcome, state: 'approved' as const },
  plan: { ...st.plan, plan: { ...st.plan.plan, state: 'active' as const, cursor } },
});
/** Replace the data of the op at `path` (forging a batch the actions refuse to build). */
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));

async function approvedAll(alice: As) {
  await ok(alice.run(approvePlan(alice.ctx, { ...(await load()), thread: await thread() })));
}
async function done(a: As, i: number, status: 'done' | 'failed' | 'started' = 'done') {
  await ok(
    a.run(
      finishOutcome(a.ctx, {
        ...(await stepOf(i)),
        status,
        result:
          status === 'failed'
            ? { error: 'It broke' }
            : status === 'started'
              ? { itemId: 'item9' }
              : { permalink: 'https://teams.example.com/m/2' },
      }),
    ),
  );
}

describe('proposing a plan', () => {
  it('an agent proposes the whole plan in one batch; the thread waits for the member', async () => {
    await started();
    await proposed();
    expect(await snap(PL('pl1'))).toMatchObject({ steps: IDS, cursor: 0, state: 'proposed' });
    expect(await snap(O('st3'))).toMatchObject({ type: 'approval', executor: null, planId: 'pl1' });
    expect(await snap(O('st2'))).toMatchObject({ type: 'book', executor: AGENTS.a });
    expect(await snap(T('itr1'))).toMatchObject({ state: 'yourCall' });
  });
  it('not by the member; not half a plan; not with a forged start', async () => {
    await started();
    const a = as(AGENTS.a);
    const p = proposePlan(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      steps: EXAMPLE,
      planId: 'pl1',
      stepIds: IDS,
    });
    // a step left out of the batch
    await denied(a.run(p.ops.filter((op) => op.path !== O('st4'))));
    // already at step 2, or already approved
    await denied(a.run(forge(p.ops, PL('pl1'), { cursor: 1 })));
    await denied(a.run(forge(p.ops, PL('pl1'), { state: 'active' })));
    await denied(a.run(forge(p.ops, O('st1'), { state: 'approved' })));
    // a gate an agent would carry out, a step that ends the thread
    await denied(a.run(forge(p.ops, O('st3'), { executor: AGENTS.a })));
    await denied(a.run(forge(p.ops, O('st1'), { type: 'ignore', fields: {} })));
    // the member cannot propose a plan
    const alice = as('alice');
    await denied(
      alice.run(
        proposePlan(
          { ...a.ctx, actor: { type: 'agent', id: 'alice', name: 'Alice' } },
          {
            threadId: 'itr1',
            thread: await thread(),
            steps: EXAMPLE,
            planId: 'pl1',
            stepIds: IDS,
          },
        ).ops,
      ),
    );
    await ok(a.run(p));
  });
  it('at most 8 steps', async () => {
    await started();
    const a = as(AGENTS.a);
    const eight = Array.from({ length: 8 }, (_, i) => `s${i}`);
    const p = proposePlan(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      steps: eight.map(() => EXAMPLE[0]!),
      planId: 'pl1',
      stepIds: eight,
    });
    // a ninth step, listed and created in the same batch
    const nine = [...eight, 's8'];
    const ninth: WriteOp = { ...p.ops[0]!, path: O('s8') };
    const ops = [ninth, ...p.ops].map((op) =>
      op.path === PL('pl1') ? { ...op, data: { ...op.data, steps: nine } } : op,
    );
    const ev = ops.at(-1)!;
    await denied(
      a.run([
        ...ops.slice(0, -1),
        { ...ev, data: { ...ev.data, data: { ...(ev.data.data as object), steps: nine } } },
      ]),
    );
    await ok(a.run(p));
  });
  it('a step cannot point at a plan of another thread', async () => {
    await started();
    await started('r2', 'thread-2');
    await proposed();
    const a = as(AGENTS.a);
    const p = proposePlan(a.ctx, {
      threadId: 'itr2',
      thread: await thread('itr2'),
      steps: [EXAMPLE[0]!],
      planId: 'pl2',
      stepIds: ['x1'],
    });
    await denied(a.run(forge(p.ops, O('x1'), { planId: 'pl1' })));
    await ok(a.run(p));
  });
  it('a single outcome still works as before', async () => {
    await started();
    const a = as(AGENTS.a);
    await ok(
      a.run(
        proposeOutcome(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          type: 'reply',
          fields: { text: 'Hi' },
        }),
      ),
    );
  });
});

describe('approving', () => {
  it('Approve plan approves the agent steps only, within the read limit', async () => {
    await started();
    // 8 steps: 7 agent steps (two bookings) and a gate
    const steps = [...EXAMPLE, EXAMPLE[1]!, EXAMPLE[0]!, EXAMPLE[0]!];
    const ids = [...IDS, 'st6', 'st7', 'st8'];
    await proposed(steps, ids);
    const alice = as('alice');
    await approvedAll(alice);
    const pl = await load();
    expect(pl.plan.state).toBe('active');
    expect(ids.map((id) => pl.outcomes[id]!.state)).toEqual([
      'approved',
      'approved',
      'proposed',
      'approved',
      'approved',
      'approved',
      'approved',
      'approved',
    ]);
  });
  it('the worst case fits the 20 reads of a batch: 8 bookings approved, then rejected', async () => {
    await started();
    const ids = Array.from({ length: 8 }, (_, i) => `bk${i}`);
    const steps = ids.map((_, i) => ({
      type: 'book',
      fields: {
        start: `2026-11-0${i + 1}T10:00:00Z`,
        end: `2026-11-0${i + 1}T11:00:00Z`,
        with: 'Sam',
      },
    }));
    await proposed(steps, ids);
    const alice = as('alice');
    await approvedAll(alice);
    expect((await load()).outcomes.bk7!.state).toBe('approved');
    // Reject plan with 7 approved steps not started (the first is at the cursor, being carried out)
    await ok(alice.run(rejectPlan(alice.ctx, { ...(await load()), thread: await thread() })));
    expect((await load()).outcomes.bk7!.state).toBe('rejected');
    expect((await load()).outcomes.bk0!.state).toBe('approved');
  });
  it('the agent cannot approve; nothing is carried out before approval', async () => {
    const a = await started();
    await proposed();
    const pl = await load();
    // an agent writing the member's approval
    const asAgent = approvePlan(
      { ...a.ctx, actor: { type: 'human', id: AGENTS.a, name: 'A' } },
      {
        ...pl,
        plan: { ...pl.plan, memberUid: AGENTS.a },
        thread: await thread(),
      },
    );
    await denied(a.run(asAgent.ops));
    // carrying out step 1 unapproved
    await denied(
      a.run(
        finishOutcome(a.ctx, {
          ...(await stepOf(0)),
          outcome: { ...(await stepOf(0)).outcome, state: 'approved' },
          status: 'done',
        }).ops,
      ),
    );
  });
  it('a step may be pre-approved; the gate only at its turn, by the member', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    // pre-approve step 5
    await ok(alice.run(approveOutcome(alice.ctx, await stepOf(4))));
    expect(await snap(O('st5'))).toMatchObject({ state: 'approved' });
    // the gate before its turn
    const early = await stepOf(2);
    const plan = { ...early.plan, plan: { ...early.plan.plan, cursor: 2 } };
    await denied(alice.run(approveOutcome(alice.ctx, { ...early, plan }).ops));
    await denied(alice.run(rejectOutcome(alice.ctx, { ...early, plan, othersPending: false }).ops));
    // through steps 1 and 2
    await approvedAll(alice);
    await done(a, 0);
    await done(a, 1);
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 2 });
    // the agent cannot pass the gate
    const gate = approveOutcome(alice.ctx, await stepOf(2));
    await denied(
      a.run(
        gate.ops.map((op) =>
          op.path.includes('inboxEvents')
            ? {
                ...op,
                data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } },
              }
            : op,
        ),
      ),
    );
    await ok(alice.run(gate));
    expect(await snap(O('st3'))).toMatchObject({ state: 'done' });
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 3, state: 'active' });
  });
  it('Not approved on the gate stops the plan and hands the thread back', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    await done(a, 0);
    await done(a, 1);
    await ok(
      alice.run(
        rejectOutcome(alice.ctx, { ...(await stepOf(2)), othersPending: false, reason: 'No' }),
      ),
    );
    expect(await snap(PL('pl1'))).toMatchObject({ state: 'stopped' });
    expect(await snap(T('itr1'))).toMatchObject({ state: 'investigating' });
    // nothing more runs
    await denied(a.run(finishOutcome(a.ctx, { ...live(await stepOf(3), 3), status: 'done' }).ops));
  });
  it('Reject plan sets aside what has not started', async () => {
    await started();
    await proposed();
    const alice = as('alice');
    await ok(alice.run(rejectPlan(alice.ctx, { ...(await load()), thread: await thread() })));
    const pl = await load();
    expect(pl.plan.state).toBe('stopped');
    expect(IDS.map((id) => pl.outcomes[id]!.state)).toEqual(Array(5).fill('rejected'));
    expect(await snap(T('itr1'))).toMatchObject({ state: 'investigating' });
  });
});

describe('order', () => {
  it('only the step at the cursor is carried out, and the cursor moves by one', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    // step 2 before step 1
    const s2 = await stepOf(1);
    await denied(
      a.run(
        finishOutcome(a.ctx, {
          ...s2,
          plan: { ...s2.plan, plan: { ...s2.plan.plan, cursor: 1 } },
          status: 'done',
        }).ops,
      ),
    );
    // cursor +2
    const s1 = finishOutcome(a.ctx, { ...(await stepOf(0)), status: 'done' });
    await denied(a.run(forge(s1.ops, PL('pl1'), { cursor: 2 })));
    // reporting it but leaving the cursor
    await denied(a.run(s1.ops.filter((op) => op.path !== PL('pl1'))));
    await ok(a.run(s1));
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 1, state: 'active' });
    expect(await snap(T('itr1'))).toMatchObject({ state: 'waiting', waiting: { on: 'them' } });
    // another agent cannot report it
    const star = as(AGENTS.star);
    await denied(
      star.run(
        finishOutcome(star.ctx, {
          ...(await stepOf(1)),
          outcome: { ...(await stepOf(1)).outcome, executor: AGENTS.star },
          status: 'done',
        }).ops,
      ),
    );
  });
  it('the thread cannot hide a gate that waits for the member', async () => {
    const a = await started();
    await proposed();
    await approvedAll(as('alice'));
    await done(a, 0);
    const s2 = finishOutcome(a.ctx, { ...(await stepOf(1)), status: 'done' });
    await denied(a.run(forge(s2.ops, T('itr1'), { state: 'done', waiting: null })));
    await ok(a.run(s2));
    expect(await snap(T('itr1'))).toMatchObject({ state: 'yourCall' });
  });
  it('Build it: started with its item, running, then done', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    await done(a, 0);
    await done(a, 1);
    await ok(alice.run(approveOutcome(alice.ctx, await stepOf(2))));
    // a reply step cannot be started
    await done(a, 3, 'started');
    expect(await snap(O('st4'))).toMatchObject({ state: 'running', result: { itemId: 'item9' } });
    expect(await snap(T('itr1'))).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 3 });
    await done(a, 3);
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 4 });
    await done(a, 4);
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 5, state: 'done' });
  });
  it('a failed step blocks the plan: retry, skip or stop', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    await done(a, 0, 'failed');
    expect(await snap(PL('pl1'))).toMatchObject({ state: 'blocked' });
    expect(await snap(T('itr1'))).toMatchObject({ state: 'yourCall' });
    // blocked: nothing runs
    await denied(a.run(finishOutcome(a.ctx, { ...live(await stepOf(0), 0), status: 'done' }).ops));
    // the agent cannot retry it
    const retry = retryPlanStep(alice.ctx, { ...(await load()), thread: await thread() });
    await denied(
      a.run(
        retry.ops.map((op) =>
          op.path.includes('inboxEvents')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } } }
            : op,
        ),
      ),
    );
    await ok(alice.run(retry));
    expect(await snap(O('st1'))).toMatchObject({ state: 'approved' });
    await done(a, 0, 'failed');
    await ok(alice.run(skipPlanStep(alice.ctx, { ...(await load()), thread: await thread() })));
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 1, state: 'active' });
    expect(await snap(O('st1'))).toMatchObject({ state: 'rejected' });
    await ok(alice.run(stopPlan(alice.ctx, { ...(await load()), thread: await thread() })));
    expect(await snap(PL('pl1'))).toMatchObject({ state: 'stopped' });
  });
  it('a wait-until step is done when the thread wakes', async () => {
    const a = await started();
    const past = new Date(Date.now() - 60_000).toISOString();
    await proposed(
      [
        { type: 'snooze', fields: { until: past } },
        { type: 'nudge', fields: { text: 'Any news?' } },
      ],
      ['w1', 'w2'],
    );
    const alice = as('alice');
    await approvedAll(alice);
    // the plan waits until the date
    expect(await snap(T('itr1'))).toMatchObject({ state: 'waiting', waiting: { on: 'date' } });
    await ok(
      a.run(
        wakeThread(a.ctx, {
          threadId: 'itr1',
          thread: await thread(),
          nowMs: Date.now(),
          plan: await load(),
        }),
      ),
    );
    expect(await snap(O('w1'))).toMatchObject({ state: 'done' });
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 1 });
  });
});

describe('editing a plan', () => {
  it('the member reorders, removes and adds approval steps after what has started', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    await done(a, 0);
    const run = async (edit: Parameters<typeof editPlan>[1]['edit']) =>
      alice.run(editPlan(alice.ctx, { ...(await load()), thread: await thread(), edit }));
    // step 1 is done, step 2 is being carried out (approved at the cursor): neither moves
    await expect(run({ op: 'move', from: 1, to: 3 })).rejects.toThrow(/have not started/);
    await ok(run({ op: 'move', from: 4, to: 2 }));
    expect((await snap(PL('pl1'))).steps).toEqual(['st1', 'st2', 'st5', 'st3', 'st4']);
    await ok(run({ op: 'add', index: 2, fields: { what: 'Check the quote' }, outcomeId: 'g1' }));
    expect((await snap(PL('pl1'))).steps).toEqual(['st1', 'st2', 'g1', 'st5', 'st3', 'st4']);
    expect(await snap(O('g1'))).toMatchObject({ type: 'approval', proposedBy: 'alice' });
    await ok(run({ op: 'remove', index: 3 }));
    expect((await snap(PL('pl1'))).steps).toEqual(['st1', 'st2', 'g1', 'st3', 'st4']);
    expect(await snap(O('st5'))).toMatchObject({
      state: 'rejected',
      decision: { reason: 'removed' },
    });
  });
  it('a done step never moves, and an agent never edits the steps', async () => {
    const a = await started();
    await proposed();
    const alice = as('alice');
    await approvedAll(alice);
    await done(a, 0);
    await done(a, 1);
    const pl = await load();
    // forge a move of the done step 1 to the end
    const p = editPlan(alice.ctx, {
      ...pl,
      thread: await thread(),
      edit: { op: 'move', from: 3, to: 4 },
    });
    const ev = p.ops.at(-1)!;
    const moved = ['st2', 'st3', 'st4', 'st5', 'st1'];
    await denied(
      alice.run([
        ...forge(p.ops.slice(0, -1), PL('pl1'), { steps: moved }),
        { ...ev, data: { ...ev.data, data: { planId: 'pl1', op: 'move', from: 0, to: 4 } } },
      ]),
    );
    // the agent reorders
    await denied(
      a.run(
        p.ops.map((op) =>
          op.path.includes('inboxEvents')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } } }
            : op,
        ),
      ),
    );
    await ok(alice.run(p));
  });
});

describe('plan-only outcome types', () => {
  it('an agent cannot propose an approval gate or a bare booking alone', async () => {
    const a = await started();
    const p = proposeOutcome(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      type: 'reply',
      fields: { text: 'Thursday works.' },
    });
    const o = O(p.outcomeId);
    // approval: executor none, like the immediate types; still refused alone
    await denied(
      a.run(forge(p.ops, o, { type: 'approval', fields: { what: 'New prices' }, executor: null })),
    );
    await denied(
      a.run(
        forge(p.ops, o, {
          type: 'book',
          fields: {
            start: '2026-11-05T10:00:00.000Z',
            end: '2026-11-05T11:00:00.000Z',
            with: 'Sam',
          },
        }),
      ),
    );
    // a single outcome carries no planId
    await denied(a.run(forge(p.ops, o, { planId: 'pl1' })));
    await ok(a.run(p));
    expect(await snap(o)).toMatchObject({ type: 'reply', state: 'proposed' });
  });
});
