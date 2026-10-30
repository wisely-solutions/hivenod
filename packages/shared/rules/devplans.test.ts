/**
 * Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): New thread (the member's own thread and
 * template plan, agent steps approved by the creation), the gates of the Development template,
 * the gate pinning the summary version, and send back (member and agent, blocked from the 3rd).
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  approveOutcome,
  createMemberThread,
  finishOutcome,
  inboxPaths,
  proposePlan,
  retryPlanStep,
  sendBackPlan,
  stepProgress,
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
const IDS = ['dv1', 'dv2', 'dv3', 'dv4', 'dv5', 'dv6', 'dv7'];
const thread = async (tid = 'nt1') => (await snap(T(tid))) as unknown as ThreadStateOf;
async function load(pid = 'pd1'): Promise<PlanInput & { plan: PlanOf & SendBackOf }> {
  const plan = (await snap(PL(pid))) as unknown as PlanOf & SendBackOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = (await snap(O(id))) as unknown as OutcomeStateOf;
  return { planId: pid, plan, outcomes };
}
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));

async function newDev(alice = as('alice')) {
  await ok(
    alice.run(
      createMemberThread(alice.ctx, {
        title: 'Dark mode',
        text: 'Add a dark mode to the board',
        agentUid: AGENTS.a,
        template: 'dev',
        threadId: 'nt1',
        planId: 'pd1',
        stepIds: IDS,
      }),
    ),
  );
  return alice;
}
async function finish(i: number, a: As = as(AGENTS.a)) {
  const pl = await load();
  const id = pl.plan.steps[i]!;
  await ok(
    a.run(
      finishOutcome(a.ctx, {
        outcomeId: id,
        outcome: pl.outcomes[id]!,
        thread: await thread(),
        status: 'done',
        result: { permalink: 'https://github.com/example/repo/pull/1' },
        plan: pl,
      }),
    ),
  );
}
async function gate(i: number, alice: As, summaryVersion?: number) {
  const pl = await load();
  const id = pl.plan.steps[i]!;
  await ok(
    alice.run(
      approveOutcome(alice.ctx, {
        outcomeId: id,
        outcome: pl.outcomes[id]!,
        thread: await thread(),
        plan: pl,
        ...(summaryVersion ? { summaryVersion } : {}),
      }),
    ),
  );
}
/** Shape done, Approve idea, Build and Keep green done: the plan waits at Ship it?. */
async function atShipIt() {
  const alice = await newDev();
  await finish(0);
  await gate(1, alice, 2);
  await finish(2);
  await finish(3);
  return alice;
}

describe('New thread', () => {
  it('the member writes to an org agent: thread, message, event; it starts investigating', async () => {
    const alice = as('alice');
    await ok(
      alice.run(
        createMemberThread(alice.ctx, {
          title: 'Question',
          text: 'What is our churn?',
          agentUid: AGENTS.a,
          threadId: 'nt0',
        }),
      ),
    );
    expect(await snap(T('nt0'))).toMatchObject({
      memberUid: 'alice',
      fetchedBy: AGENTS.a,
      state: 'investigating',
    });
  });
  it('not for a revoked or unknown agent, not for another member, not by an agent', async () => {
    const alice = as('alice');
    const base = { title: 'x', text: 'y', threadId: 'nt2' };
    await denied(alice.run(createMemberThread(alice.ctx, { ...base, agentUid: AGENTS.revoked })));
    await denied(alice.run(createMemberThread(alice.ctx, { ...base, agentUid: 'agentNobody' })));
    const p = createMemberThread(alice.ctx, { ...base, agentUid: AGENTS.a });
    const bob = as('bob');
    await denied(bob.run(p.ops));
    // Forged: the thread says another agent than the event, or a state that skips the agent.
    await denied(alice.run(forge(p.ops, T('nt2'), { fetchedBy: AGENTS.star })));
    await denied(alice.run(forge(p.ops, T('nt2'), { state: 'done' })));
  });
  it('from the Development template: the member’s plan, active, agent steps approved', async () => {
    await newDev();
    expect(await snap(PL('pd1'))).toMatchObject({
      proposedBy: 'alice',
      state: 'active',
      cursor: 0,
      templateId: 'dev',
      sendBackTo: { dv2: 'dv1', dv5: 'dv3', dv7: 'dv3' },
    });
    const states = await Promise.all(IDS.map(async (id) => (await snap(O(id))).state));
    expect(states).toEqual([
      'approved',
      'proposed',
      'approved',
      'approved',
      'proposed',
      'approved',
      'proposed',
    ]);
    expect(await snap(O('dv1'))).toMatchObject({ executor: AGENTS.a, type: 'shape' });
  });
  it('an agent never makes a plan with approved steps; a member never a gate approved', async () => {
    const alice = as('alice');
    const p = createMemberThread(alice.ctx, {
      title: 'x',
      text: 'y',
      agentUid: AGENTS.a,
      template: 'dev',
      threadId: 'nt3',
      planId: 'pd3',
      stepIds: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'],
    });
    await denied(alice.run(forge(p.ops, O('g2'), { state: 'done' })));
    await denied(alice.run(forge(p.ops, O('g2'), { state: 'approved' })));
    await denied(alice.run(forge(p.ops, O('g1'), { executor: AGENTS.star })));
    // The agent proposing the template: proposed, never approved.
    await newDev();
    const a = as(AGENTS.a);
    const pp = proposePlan(a.ctx, {
      threadId: 'nt1',
      thread: { ...(await thread()), state: 'investigating' },
      template: 'dev',
      steps: [],
      planId: 'pa9',
      stepIds: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'],
    });
    await denied(a.run(forge(pp.ops, O('a1'), { state: 'approved' })));
    await denied(a.run(forge(pp.ops, PL('pa9'), { state: 'active' })));
  });
});

describe('the Development plan runs gate by gate', () => {
  it('Shape runs at once; Build waits for Approve idea, which pins the summary version', async () => {
    const alice = await newDev();
    await finish(0);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 1 });
    // Build is not at its turn yet.
    const a = as(AGENTS.a);
    const pl = await load();
    const forged = finishOutcome(a.ctx, {
      outcomeId: 'dv3',
      outcome: pl.outcomes.dv3!,
      thread: await thread(),
      status: 'done',
      plan: { ...pl, plan: { ...pl.plan, cursor: 2 } },
    });
    await denied(a.run(forged));
    await gate(1, alice, 3);
    expect(await snap(O('dv2'))).toMatchObject({ state: 'done', decision: { summaryVersion: 3 } });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'waiting', waiting: { on: 'agent' } });
    await finish(2);
    // Keep green (slice 6c) runs next: the thread still waits on the work.
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 3, state: 'active' });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
    await finish(3);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 4, state: 'active' });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'yourCall' });
  });
  it('a gate pins only a whole summary version; a send back decides gates again', async () => {
    const alice = await newDev();
    await finish(0);
    const pl = await load();
    const ap = approveOutcome(alice.ctx, {
      outcomeId: 'dv2',
      outcome: pl.outcomes.dv2!,
      thread: await thread(),
      plan: pl,
      summaryVersion: 2,
    });
    const dec = (ap.ops.find((o) => o.path === O('dv2'))!.data as { decision: object }).decision;
    await denied(
      alice.run(forge(ap.ops, O('dv2'), { decision: { ...dec, summaryVersion: 'v2' } })),
    );
    await ok(alice.run(ap));
    await finish(2);
    await finish(3);
    await gate(4, alice);
    await finish(5);
    // Accept on live → Build: Ship it? must be decided again, never left passed.
    const sp = sendBackPlan(alice.ctx, { ...(await load()), thread: await thread(), reason: 'No' });
    await denied(alice.run(forge(sp.ops, O('dv5'), { state: 'done' })));
    await ok(alice.run(sp));
    expect(await snap(O('dv5'))).toMatchObject({ state: 'proposed', decision: null });
    expect(await snap(O('dv4'))).toMatchObject({ state: 'approved' });
    expect(await snap(O('dv6'))).toMatchObject({ state: 'approved' });
  });
  it('Release waits for Ship it?; the plan is done only after Accept on live', async () => {
    const alice = await atShipIt();
    await gate(4, alice);
    await finish(5);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 6, state: 'active' });
    await gate(6, alice);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 7, state: 'done' });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'done' });
  });
});

describe('send back', () => {
  it('Ask for changes on Ship it? sends the plan back to Build with the text', async () => {
    const alice = await atShipIt();
    await ok(
      alice.run(
        sendBackPlan(alice.ctx, {
          ...(await load()),
          thread: await thread(),
          reason: 'Bigger button',
        }),
      ),
    );
    expect(await snap(PL('pd1'))).toMatchObject({
      cursor: 2,
      state: 'active',
      sentBack: { n: 1, to: 'dv3', reason: 'Bigger button', by: 'alice' },
    });
    expect(await snap(O('dv3'))).toMatchObject({ state: 'approved' });
    // Build again, then Ship it? again.
    await finish(2);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 3 });
  });
  it('not by another member, not by an agent at a gate, not to a person step or a later step', async () => {
    const alice = await atShipIt();
    const pl = await load();
    const p = sendBackPlan(alice.ctx, { ...pl, thread: await thread(), reason: 'x' });
    await denied(as('bob').run(p.ops));
    const a = as(AGENTS.a);
    await denied(
      a.run(
        sendBackPlan(alice.ctx, { ...pl, thread: await thread(), reason: 'x' }).ops.map((op) =>
          op.path.includes('/inboxEvents/')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } } }
            : op.path === PL('pd1')
              ? {
                  ...op,
                  data: {
                    ...op.data,
                    sentBack: { ...(op.data?.sentBack as object), by: AGENTS.a },
                  },
                }
              : op,
        ),
      ),
    );
    // Forged counts and targets.
    await denied(alice.run(forge(p.ops, PL('pd1'), { state: 'blocked' })));
    const sb = (p.ops.find((o) => o.path === PL('pd1'))!.data as { sentBack: object }).sentBack;
    await denied(alice.run(forge(p.ops, PL('pd1'), { sentBack: { ...sb, n: 2 } })));
    await denied(alice.run(forge(p.ops, PL('pd1'), { sentBack: { ...sb, to: 'dv1' } })));
    await denied(alice.run(forge(p.ops, PL('pd1'), { cursor: 1 })));
  });
  it('Release sends the plan back to Build (the agent)', async () => {
    const alice = await atShipIt();
    await gate(4, alice);
    const a = as(AGENTS.a);
    await ok(
      a.run(
        sendBackPlan(a.ctx, {
          ...(await load()),
          thread: await thread(),
          reason: 'e2e fails',
          toStep: 2,
        }),
      ),
    );
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 2, sentBack: { n: 1, by: AGENTS.a } });
    expect(await snap(O('dv5'))).toMatchObject({ state: 'proposed', decision: null });
    // Another agent may not.
    await finish(2);
    await finish(3);
    await gate(4, alice);
    const star = as(AGENTS.star);
    const pl = await load();
    // As if it carried Release out (the action's own check passes; the rules know better).
    const fake = {
      ...pl,
      outcomes: { ...pl.outcomes, dv6: { ...pl.outcomes.dv6!, executor: AGENTS.star } },
    };
    await denied(
      star.run(sendBackPlan(star.ctx, { ...fake, thread: await thread(), reason: 'x', toStep: 2 })),
    );
  });
  it('the third send back blocks the plan for the member; Retry goes on', async () => {
    const alice = await atShipIt();
    for (let i = 0; i < 3; i++) {
      await ok(
        alice.run(
          sendBackPlan(alice.ctx, {
            ...(await load()),
            thread: await thread(),
            reason: `round ${i + 1}`,
          }),
        ),
      );
      if (i < 2) {
        await finish(2);
        await finish(3);
      }
    }
    expect(await snap(PL('pd1'))).toMatchObject({
      state: 'blocked',
      cursor: 2,
      sentBack: { n: 3 },
    });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'yourCall' });
    // Blocked: the agent cannot report Build.
    const a = as(AGENTS.a);
    const pl = await load();
    await denied(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: 'dv3',
          outcome: pl.outcomes.dv3!,
          thread: await thread(),
          status: 'done',
          plan: { ...pl, plan: { ...pl.plan, state: 'active' } },
        }),
      ),
    );
    await ok(alice.run(retryPlanStep(alice.ctx, { ...pl, thread: await thread() })));
    expect(await snap(PL('pd1'))).toMatchObject({ state: 'active', cursor: 2 });
    await finish(2);
  });
});

describe('long steps (slice 6b)', () => {
  async function started(a: As = as(AGENTS.a)) {
    const alice = await newDev();
    await finish(0, a);
    await gate(1, alice);
    const pl = await load();
    await ok(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: 'dv3',
          outcome: pl.outcomes.dv3!,
          thread: await thread(),
          status: 'started',
          plan: pl,
        }),
      ),
    );
    return alice;
  }
  const progress = async (a: As, line: string, percent: number | null = null) => {
    const pl = await load();
    return stepProgress(a.ctx, {
      outcomeId: 'dv3',
      outcome: pl.outcomes.dv3!,
      thread: await thread(),
      line,
      percent,
      plan: pl,
    });
  };
  it('Build starts with no item, reports progress, ends done from running', async () => {
    await started();
    expect(await snap(O('dv3'))).toMatchObject({ state: 'running' });
    expect(await snap(T('nt1'))).toMatchObject({ state: 'waiting', waiting: { on: 'item' } });
    const a = as(AGENTS.a);
    await ok(a.run(await progress(a, 'Tests green, writing the PR', 70)));
    expect(await snap(O('dv3'))).toMatchObject({
      progress: { line: 'Tests green, writing the PR', percent: 70 },
    });
    await finish(2);
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 3 });
  });
  it('progress only by its executor, on its running long step, within bounds', async () => {
    await started();
    const a = as(AGENTS.a);
    const p = await progress(a, 'Halfway', 50);
    // Another agent of the org, its own event and all: not its step.
    await denied(
      as(AGENTS.star).run(
        p.ops.map((op) =>
          op.path.includes('/inboxEvents/')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.star, name: 'S' } } }
            : op,
        ),
      ),
    );
    await denied(
      a.run(
        p.ops.map((op) =>
          op.path === O('dv3')
            ? { ...op, data: { ...op.data, progress: { line: 'x', percent: 101, at: null } } }
            : op,
        ),
      ),
    );
    const bad = p.ops.map((op) =>
      op.path === O('dv3')
        ? {
            ...op,
            data: {
              ...op.data,
              progress: { ...(op.data?.progress as object), percent: 101 },
            },
          }
        : op,
    );
    await denied(a.run(bad));
    const other = p.ops.map((op) =>
      op.path === O('dv3') ? { ...op, data: { ...op.data, state: 'done' } } : op,
    );
    await denied(a.run(other));
    await ok(a.run(p));
  });
  it('not on a step that is not running, nor a short one', async () => {
    await newDev();
    const a = as(AGENTS.a);
    const pl = await load();
    // Shape is approved, not started, and not long: no progress.
    const p = stepProgress(a.ctx, {
      outcomeId: 'dv1',
      outcome: { ...pl.outcomes.dv1!, state: 'running', type: 'build' },
      thread: await thread(),
      line: 'x',
      plan: pl,
    });
    await denied(a.run(p));
  });
});

describe('Keep green (slice 6c)', () => {
  const check = async (a: As, line: string, c: 'green' | 'rechecking' | 'blocked' | null) => {
    const pl = await load();
    return stepProgress(a.ctx, {
      outcomeId: 'dv4',
      outcome: pl.outcomes.dv4!,
      thread: await thread(),
      line,
      check: c,
      plan: pl,
    });
  };
  it('while Ship it? waits, its executor re-checks on the done step; the gate stays open', async () => {
    const alice = await atShipIt();
    const a = as(AGENTS.a);
    await ok(a.run(await check(a, 'main moved to 9b1e2d3: rebasing', 'rechecking')));
    expect(await snap(O('dv4'))).toMatchObject({
      state: 'done',
      progress: { line: 'main moved to 9b1e2d3: rebasing', check: 'rechecking' },
    });
    expect(await snap(PL('pd1'))).toMatchObject({ cursor: 4 });
    await ok(a.run(await check(a, 'green on 9b1e2d3', 'green')));
    const p = await check(a, 'x', 'blocked');
    await denied(
      a.run(
        forge(p.ops, O('dv4'), {
          progress: {
            ...(p.ops.find((o) => o.path === O('dv4'))!.data!.progress as object),
            check: 'red',
          },
        }),
      ),
    );
    // Only the progress: never the state, never by another agent.
    await denied(a.run(forge(p.ops, O('dv4'), { state: 'running' })));
    await denied(
      as(AGENTS.star).run(
        p.ops.map((op) =>
          op.path.includes('/inboxEvents/')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.star, name: 'S' } } }
            : op,
        ),
      ),
    );
    await ok(a.run(p));
    // A done Build takes no progress.
    const pl = await load();
    const b = stepProgress(a.ctx, {
      outcomeId: 'dv3',
      outcome: { ...pl.outcomes.dv3!, type: 'keepgreen' },
      thread: await thread(),
      line: 'x',
      plan: { ...pl, plan: { ...pl.plan, cursor: 3 } },
    });
    await denied(a.run(b));
    await gate(4, alice);
  });
  it('unsolvable: failed blocks the plan; the member sends it back to Build, not the agent', async () => {
    const alice = await newDev();
    await finish(0);
    await gate(1, alice);
    await finish(2);
    const a = as(AGENTS.a);
    let pl = await load();
    await ok(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: 'dv4',
          outcome: pl.outcomes.dv4!,
          thread: await thread(),
          status: 'failed',
          result: { error: 'lint fails after 3 fixes' },
          plan: pl,
        }),
      ),
    );
    expect(await snap(PL('pd1'))).toMatchObject({ state: 'blocked', cursor: 3 });
    pl = await load();
    const sp = sendBackPlan(alice.ctx, {
      ...pl,
      thread: await thread(),
      reason: 'Fix it in Build',
    });
    // The agent may not (as if it were the member's action).
    await denied(
      a.run(
        sp.ops.map((op) =>
          op.path.includes('/inboxEvents/')
            ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'A' } } }
            : op.path === PL('pd1')
              ? {
                  ...op,
                  data: {
                    ...op.data,
                    sentBack: { ...(op.data?.sentBack as object), by: AGENTS.a },
                  },
                }
              : op,
        ),
      ),
    );
    await denied(alice.run(forge(sp.ops, O('dv4'), { state: 'failed' })));
    await ok(alice.run(sp));
    expect(await snap(PL('pd1'))).toMatchObject({ state: 'active', cursor: 2, sentBack: { n: 1 } });
    expect(await snap(O('dv4'))).toMatchObject({ state: 'approved' });
  });
});
