/**
 * The Off switch backstop (scheduled tasks slice 7, design 7): while the member has an agent Off,
 * the agent cannot start (or finish straight away) a step he approved before turning it Off. A
 * step he approves while Off goes, a running step still reports, a failure is always reported,
 * and Off for another agent changes nothing.
 */
import { describe, it } from 'vitest';
import {
  addInboxMessage,
  approveOutcome,
  createMemberThread,
  finishOutcome,
  inboxPaths,
  proposeOutcome,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type ThreadStateOf,
} from '../src/inbox';
import { setAgentsOff } from '../src/scheduleActions';
import { AGENTS, as, denied, ok, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);
const thread = async (tid: string) => (await snap(T(tid))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;

async function off(input: { all: boolean; agents?: string[] } = { all: true }) {
  const m = as('alice');
  await ok(m.run(setAgentsOff(m.ctx, input)));
}

/** agentA brings in a message for alice and proposes a reply. */
async function proposedReply(): Promise<string> {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im-r1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we meet Thursday?',
        threadRef: 'thread-r1',
        messageId: 'm-1',
        permalink: null,
        replyRef: null,
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  const p = proposeOutcome(a.ctx, {
    threadId: 'itr1',
    thread: await thread('itr1'),
    type: 'reply',
    fields: { text: 'Thursday works.' },
  });
  await ok(a.run(p));
  return p.outcomeId;
}
async function approve(oid: string) {
  const m = as('alice');
  await ok(
    m.run(
      approveOutcome(m.ctx, {
        outcomeId: oid,
        outcome: await outcome(oid),
        thread: await thread('itr1'),
      }),
    ),
  );
}
const report = async (a: As, oid: string, status: 'done' | 'failed') =>
  a.run(
    finishOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread('itr1'),
      status,
      ...(status === 'failed' ? { result: { error: 'Off: stopped' } } : {}),
    }),
  );

describe('Off backstop: a single outcome', () => {
  it('approved before Off: refused while Off, a failure goes, done again once On', async () => {
    const oid = await proposedReply();
    await approve(oid);
    await off();
    const a = as(AGENTS.a);
    await denied(report(a, oid, 'done'));
    await off({ all: false });
    await ok(report(a, oid, 'done'));
  });

  it('Off for this agent by name: done refused, reporting it failed goes', async () => {
    const oid = await proposedReply();
    await approve(oid);
    await off({ all: false, agents: [AGENTS.a] });
    await denied(report(as(AGENTS.a), oid, 'done'));
    await ok(report(as(AGENTS.a), oid, 'failed'));
  });

  it('approved while Off (the member said so) goes', async () => {
    const oid = await proposedReply();
    await off();
    await approve(oid);
    await ok(report(as(AGENTS.a), oid, 'done'));
  });

  it('Off for another agent only: this one carries out', async () => {
    const oid = await proposedReply();
    await approve(oid);
    await off({ all: false, agents: [AGENTS.star] });
    await ok(report(as(AGENTS.a), oid, 'done'));
  });
});

const IDS = ['dv1', 'dv2', 'dv3', 'dv4', 'dv5', 'dv6', 'dv7'];
async function load(): Promise<PlanInput> {
  const plan = (await snap(PL('pd1'))) as unknown as PlanOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = await outcome(id);
  return { planId: 'pd1', plan, outcomes };
}
async function step(i: number, status: 'started' | 'done', a: As = as(AGENTS.a)) {
  const pl = await load();
  const id = pl.plan.steps[i]!;
  return a.run(
    finishOutcome(a.ctx, {
      outcomeId: id,
      outcome: pl.outcomes[id]!,
      thread: await thread('nt1'),
      status,
      result: { permalink: 'https://github.com/example/repo/pull/1' },
      plan: pl,
    }),
  );
}
async function devThread() {
  const m = as('alice');
  await ok(
    m.run(
      createMemberThread(m.ctx, {
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
  return m;
}

describe('Off backstop: plan steps', () => {
  it('a step approved before Off (by the thread made before Off) is not started while Off', async () => {
    await devThread();
    await off();
    await denied(step(0, 'done'));
    await off({ all: false });
    await ok(step(0, 'done'));
  });

  it('a long step started before Off still reports done while Off', async () => {
    const m = await devThread();
    await ok(step(0, 'done'));
    const pl = await load();
    await ok(
      m.run(
        approveOutcome(m.ctx, {
          outcomeId: 'dv2',
          outcome: pl.outcomes.dv2!,
          thread: await thread('nt1'),
          plan: pl,
        }),
      ),
    );
    await ok(step(2, 'started'));
    await off();
    await ok(step(2, 'done'));
    // The next step (approved with the thread, before Off) waits.
    await denied(step(3, 'started'));
  });
});
