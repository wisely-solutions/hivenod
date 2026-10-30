/**
 * Decision facts (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7): every decision on a thread
 * records stepLabel, waitedMs, recommended and summaryVersion on its event, and a plan stamps
 * cursorAt whenever its cursor moves (the rules take only the time of the write).
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  approveOutcome,
  createMemberThread,
  finishOutcome,
  inboxPaths,
  sendBackPlan,
  stopPlan,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type SendBackOf,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, ok, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);
const E = (eid: string) => inboxPaths.event(W, eid);
const IDS = ['df1', 'df2', 'df3', 'df4', 'df5', 'df6'];
const FACTS = ['stepLabel', 'templateId', 'waitedMs', 'recommended', 'summaryVersion'];
const thread = async () => (await snap(T('dt1'))) as unknown as ThreadStateOf;
async function load(): Promise<PlanInput & { plan: PlanOf & SendBackOf }> {
  const plan = (await snap(PL('dp1'))) as unknown as PlanOf & SendBackOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = (await snap(O(id))) as unknown as OutcomeStateOf;
  return { planId: 'dp1', plan, outcomes };
}
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));

async function newDev() {
  const alice = as('alice');
  await ok(
    alice.run(
      createMemberThread(alice.ctx, {
        title: 'Dark mode',
        text: 'Add a dark mode',
        agentUid: AGENTS.a,
        template: 'dev',
        threadId: 'dt1',
        planId: 'dp1',
        stepIds: IDS,
      }),
    ),
  );
  return alice;
}
async function finish(i: number, a: As = as(AGENTS.a)) {
  const pl = await load();
  const id = pl.plan.steps[i]!;
  const p = finishOutcome(a.ctx, {
    outcomeId: id,
    outcome: pl.outcomes[id]!,
    thread: await thread(),
    status: 'done',
    result: { permalink: 'https://github.com/example/repo/pull/1' },
    plan: pl,
  });
  await ok(a.run(p));
}

describe('decision facts', () => {
  it('the cursor stamps cursorAt; Approve idea records the facts on its event', async () => {
    const alice = await newDev();
    await finish(0);
    const plan = await snap(PL('dp1'));
    expect(plan.cursor).toBe(1);
    expect(typeof (plan.cursorAt as { toMillis?: unknown }).toMillis).toBe('function');
    const pl = await load();
    const p = approveOutcome(alice.ctx, {
      outcomeId: 'df2',
      outcome: pl.outcomes.df2!,
      thread: { ...(await thread()), summary: { version: 3, recAction: 'Approve' } },
      plan: pl,
    });
    await ok(alice.run(p));
    const e = await snap(E(p.eventId));
    const d = e.data as Record<string, unknown>;
    for (const k of FACTS) expect(d).toHaveProperty(k);
    expect(d).toMatchObject({
      stepLabel: 'Approve idea',
      templateId: 'dev',
      recommended: 'Approve',
      summaryVersion: 3,
    });
    expect(typeof d.waitedMs).toBe('number');
  });

  it('cursorAt takes only the time of the write', async () => {
    await newDev();
    const a = as(AGENTS.a);
    const pl = await load();
    const p = finishOutcome(a.ctx, {
      outcomeId: 'df1',
      outcome: pl.outcomes.df1!,
      thread: await thread(),
      status: 'done',
      result: { permalink: 'https://github.com/example/repo/pull/1' },
      plan: pl,
    });
    await denied(a.run(forge(p.ops, PL('dp1'), { cursorAt: new Date(Date.now() - 86_400_000) })));
    await ok(a.run(p));
  });

  it('Ask for changes on Ship it? records the target step; stop records the step at the cursor', async () => {
    const alice = await newDev();
    await finish(0);
    let pl = await load();
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: 'df2',
          outcome: pl.outcomes.df2!,
          thread: await thread(),
          plan: pl,
        }),
      ),
    );
    await finish(2);
    pl = await load();
    const back = sendBackPlan(alice.ctx, { ...pl, thread: await thread(), reason: 'Bigger' });
    await ok(alice.run(back));
    expect((await snap(E(back.eventId))).data).toMatchObject({
      stepLabel: 'Ship it?',
      toLabel: 'Build',
      templateId: 'dev',
      recommended: null,
      summaryVersion: null,
    });
    const plan = await snap(PL('dp1'));
    expect(typeof (plan.cursorAt as { toMillis?: unknown }).toMillis).toBe('function');
    const stop = stopPlan(alice.ctx, { ...(await load()), thread: await thread() });
    await ok(alice.run(stop));
    expect((await snap(E(stop.eventId))).data).toMatchObject({ stepLabel: 'Build' });
  });
});
