/**
 * Re-check (item bmNoIvvqKCdAorLSShE9): only the member asks the thread's home agent to check it
 * again; only that agent answers, once per request; "still good" stamps checkedAt only in the
 * answering batch, only on open proposals and unrun live-plan steps; on a pending re-check the
 * agent may revise an open proposal (or an unrun approved step, whose approval it clears) unasked.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approvePlan,
  inboxPaths,
  proposeOutcome,
  proposePlan,
  recheckDone,
  rejectOutcome,
  requestRecheck,
  reviseOutcome,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);
const thread = async () => (await snap(T('itr1'))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;
const FAR = Date.now() + 3_600_000 * 24;

async function brought() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we move the review to Thursday?',
        threadRef: 'thread-1',
        messageId: 'm-1',
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return a;
}

/** agentA brings a message in for alice and proposes a reply. */
async function proposed() {
  const a = await brought();
  const pr = proposeOutcome(a.ctx, {
    threadId: 'itr1',
    thread: await thread(),
    type: 'reply',
    fields: { text: 'Thursday works for me.' },
    note: 'They asked.',
  });
  await ok(a.run(pr));
  return pr.outcomeId;
}

/** agentA proposes a three-step plan; alice approves it (step 1 at the cursor). */
async function planned(): Promise<PlanInput> {
  const a = await brought();
  await ok(
    a.run(
      proposePlan(a.ctx, {
        threadId: 'itr1',
        thread: await thread(),
        note: 'Reply, then book',
        planId: 'pl1',
        stepIds: ['st1', 'st2', 'st3'],
        steps: [
          { type: 'reply', fields: { text: 'Thursday works.' } },
          {
            type: 'book',
            fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', with: 'Sam' },
          },
          { type: 'reply', fields: { text: 'Booked.' } },
        ],
      }),
    ),
  );
  const alice = as('alice');
  await ok(alice.run(approvePlan(alice.ctx, { ...(await load()), thread: await thread() })));
  return load();
}
async function load(): Promise<PlanInput> {
  const plan = (await snap(PL('pl1'))) as unknown as PlanOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = await outcome(id);
  return { planId: 'pl1', plan, outcomes };
}

async function ask(who: As = as('alice')) {
  return who.run(requestRecheck(who.ctx, { threadId: 'itr1', thread: await thread() }));
}
async function answer(result: string, who: As = as(AGENTS.a), oids: string[] = []) {
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of oids) outcomes[id] = await outcome(id);
  const pl = (await snap(PL('pl1')).catch(() => null)) as unknown as PlanOf | null;
  return recheckDone(who.ctx, {
    threadId: 'itr1',
    thread: { ...(await thread()), fetchedBy: who.ctx.actor.id },
    result,
    note: 'Looked again.',
    outcomes,
    ...(pl && pl.steps ? { plans: { pl1: pl } } : {}),
  });
}
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));
const evOf = (ops: WriteOp[]) => ops.find((o) => o.path.includes('/inboxEvents/'))!;

describe('re-check: the member asks', () => {
  it('pending on the thread; not again while pending; again once answered', async () => {
    await proposed();
    await ok(ask());
    expect((await thread()).recheck).toMatchObject({
      state: 'pending',
      by: 'alice',
      result: null,
    });
    // The action refuses a second ask; forged (as if 30 minutes had passed), the rules too.
    const alice = as('alice');
    await denied(
      alice.run(
        requestRecheck(alice.ctx, { threadId: 'itr1', thread: await thread(), nowMs: FAR }),
      ),
    );
    await ok(as(AGENTS.a).run(await answer('revised')));
    await ok(ask());
  });

  it('refused: another member, an agent, a thread with nothing open, a forged request', async () => {
    await proposed();
    const t = await thread();
    const bob = as('bob');
    await denied(
      bob.run(requestRecheck(bob.ctx, { threadId: 'itr1', thread: { ...t, memberUid: 'bob' } })),
    );
    // An agent writing the member's request.
    const a = as(AGENTS.a);
    const asAgent = requestRecheck(
      { ...a.ctx, actor: { ...a.ctx.actor, type: 'human', id: 'alice' } },
      {
        threadId: 'itr1',
        thread: t,
      },
    );
    await denied(a.run(asAgent));
    const alice = as('alice');
    const good = requestRecheck(alice.ctx, { threadId: 'itr1', thread: t });
    const R = {
      state: 'pending',
      by: 'alice',
      requestedAt: SERVER_TIME,
      result: null,
      note: null,
      at: null,
    };
    await denied(
      alice.run({ ...good, ops: forge(good.ops, T('itr1'), { recheck: { ...R, by: 'bob' } }) }),
    );
    await denied(
      alice.run({ ...good, ops: forge(good.ops, T('itr1'), { recheck: { ...R, state: 'done' } }) }),
    );
    await denied(
      alice.run({
        ...good,
        ops: forge(good.ops, T('itr1'), { recheck: { ...R, result: 'still_good' } }),
      }),
    );
    await denied(
      alice.run({ ...good, ops: forge(good.ops, T('itr1'), { recheck: { ...R, extra: 1 } }) }),
    );
    // With another field changed in the same write.
    await denied(alice.run({ ...good, ops: forge(good.ops, T('itr1'), { state: 'done' }) }));
    // Investigating: nothing to re-check.
    await put({ [T('itr1')]: { ...(await snap(T('itr1'))), state: 'investigating' } });
    await denied(
      alice.run(
        requestRecheck(alice.ctx, {
          threadId: 'itr1',
          thread: { ...(await thread()), state: 'yourCall' },
        }),
      ),
    );
  });
});

describe('re-check: the home agent answers', () => {
  it('still good stamps checkedAt on the open proposal and closes the request', async () => {
    const oid = await proposed();
    await ok(ask());
    await ok(as(AGENTS.a).run(await answer('still_good', as(AGENTS.a), [oid])));
    expect((await thread()).recheck).toMatchObject({
      state: 'done',
      result: 'still_good',
      note: 'Looked again.',
      by: 'alice',
    });
    expect((await snap(O(oid))).checkedAt).toBeTruthy();
    // Once: a second answer is refused.
    const again = recheckDone(as(AGENTS.a).ctx, {
      threadId: 'itr1',
      thread: { ...(await thread()), recheck: { state: 'pending' } },
      result: 'revised',
      outcomes: {},
    });
    await denied(as(AGENTS.a).run(again));
  });

  it('refused: another agent, the member, nothing pending, a result its event does not name', async () => {
    const oid = await proposed();
    // Nothing pending yet.
    const early = recheckDone(as(AGENTS.a).ctx, {
      threadId: 'itr1',
      thread: { ...(await thread()), recheck: { state: 'pending' } },
      result: 'still_good',
      outcomes: { [oid]: await outcome(oid) },
    });
    await denied(as(AGENTS.a).run(early));
    await ok(ask());
    // Not the home agent.
    await denied(as(AGENTS.star).run(await answer('revised', as(AGENTS.star))));
    // The member.
    const alice = as('alice');
    const p = await answer('revised');
    await denied(alice.run(p));
    // The thread says revised, its event still good.
    const ev = evOf(p.ops);
    await denied(
      as(AGENTS.a).run({
        ...p,
        ops: p.ops.map((op) =>
          op === ev
            ? {
                ...op,
                data: { ...op.data, data: { result: 'still_good', note: null, checked: [] } },
              }
            : op,
        ),
      }),
    );
    // A bad result, a long note.
    await denied(
      as(AGENTS.a).run({ ...p, ops: forge(p.ops, T('itr1'), { 'recheck.result': 'fine' }) }),
    );
    await denied(
      as(AGENTS.a).run({
        ...p,
        ops: forge(p.ops, T('itr1'), { 'recheck.note': 'x'.repeat(501) }),
      }),
    );
    // Changing who asked.
    await denied(as(AGENTS.a).run({ ...p, ops: forge(p.ops, T('itr1'), { 'recheck.by': 'bob' }) }));
    await ok(as(AGENTS.a).run(p));
  });

  it('checkedAt only in the answering batch, only with still good, only on open proposals', async () => {
    const oid = await proposed();
    await ok(ask());
    const a = as(AGENTS.a);
    const p = await answer('still_good', a, [oid]);
    const stamp = p.ops.find((o) => o.path === O(oid))!;
    // Without the thread's answer in the batch.
    await denied(a.run({ ...p, ops: p.ops.filter((o) => o.path !== T('itr1')) }));
    // With a revised answer.
    const rev = await answer('revised', a);
    await denied(
      a.run({
        ...rev,
        ops: [{ ...stamp, data: { ...stamp.data, lastEventId: rev.eventId } }, ...rev.ops],
      }),
    );
    // Something else changed with it.
    await denied(a.run({ ...p, ops: forge(p.ops, O(oid), { note: 'changed' }) }));
    // By the member.
    await denied(as('alice').run(p));
    // A decided outcome is not stamped.
    const alice = as('alice');
    await ok(
      alice.run(
        rejectOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          othersPending: true,
        }),
      ),
    );
    const late = recheckDone(a.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      result: 'still_good',
      outcomes: { [oid]: { ...(await outcome(oid)), state: 'proposed' } },
    });
    await denied(a.run(late));
  });

  it('on a live plan: only steps that have not run are stamped', async () => {
    await planned();
    await ok(ask());
    const a = as(AGENTS.a);
    const p = await answer('still_good', a, ['st1', 'st2', 'st3']);
    expect(p.checked).toEqual(['st2', 'st3']);
    // Forged: the step at the cursor (being carried out) stamped too.
    const st1 = {
      kind: 'update' as const,
      path: O('st1'),
      data: { ...p.ops.find((o) => o.path === O('st2'))!.data },
    };
    const ev = evOf(p.ops);
    const withSt1 = p.ops.map((op) =>
      op === ev
        ? {
            ...op,
            data: {
              ...op.data,
              data: { result: 'still_good', note: 'Looked again.', checked: ['st1', 'st2', 'st3'] },
            },
          }
        : op,
    );
    await denied(a.run({ ...p, ops: [st1, ...withSt1] }));
    await ok(a.run(p));
    expect((await snap(O('st2'))).checkedAt).toBeTruthy();
    expect((await snap(O('st1'))).checkedAt).toBeUndefined();
  });
});

describe('re-check: the agent revises unasked', () => {
  const f = { text: 'Friday works better.' };
  it('an open proposal, while the request is pending; v2 has no ask', async () => {
    const oid = await proposed();
    const a = as(AGENTS.a);
    // Not before the member asks (forged as if pending).
    const before = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: { ...(await thread()), recheck: { state: 'pending' } },
      fields: f,
    });
    await denied(a.run(before));
    await ok(ask());
    const p = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: await thread(),
      fields: f,
    });
    // A made-up ask on the version.
    const forged = p.ops.map((op) =>
      op.path === O(oid)
        ? {
            ...op,
            data: {
              ...op.data,
              versions: (op.data!.versions as Record<string, unknown>[]).map((v, i) =>
                i === 1 ? { ...v, asked: { instruction: 'x', chips: [] } } : v,
              ),
            },
          }
        : op,
    );
    await denied(a.run({ ...p, ops: forged }));
    // Another agent's proposal on the thread: only the home agent revises unasked.
    const star = as(AGENTS.star);
    const sp = proposeOutcome(star.ctx, {
      threadId: 'itr1',
      thread: await thread(),
      type: 'nudge',
      fields: { text: 'Any news?' },
      note: 'Quiet.',
    });
    await ok(star.run(sp));
    const sr = reviseOutcome(star.ctx, {
      outcomeId: sp.outcomeId,
      outcome: await outcome(sp.outcomeId),
      thread: { ...(await thread()), fetchedBy: AGENTS.star },
      fields: { text: 'Any news on Thursday?' },
    });
    await denied(star.run(sr));
    await ok(a.run(p));
    expect(await outcome(oid)).toMatchObject({ state: 'proposed', fields: f });
    // Once answered, no more unasked revisions.
    await ok(a.run(await answer('revised')));
    const after = reviseOutcome(a.ctx, {
      outcomeId: oid,
      outcome: await outcome(oid),
      thread: { ...(await thread()), recheck: { state: 'pending' } },
      fields: { text: 'Monday' },
    });
    await denied(a.run(after));
  });

  it('an approved step that has not run: back to proposed, approval cleared; not the one at its turn', async () => {
    const pl = await planned();
    await ok(ask());
    const a = as(AGENTS.a);
    const p = reviseOutcome(a.ctx, {
      outcomeId: 'st3',
      outcome: pl.outcomes.st3!,
      thread: await thread(),
      fields: { text: 'Booked, see you Friday.' },
      plan: pl,
    });
    // Keeping the approval is refused.
    await denied(
      a.run({ ...p, ops: forge(p.ops, O('st3'), { decision: (await snap(O('st3'))).decision }) }),
    );
    await ok(a.run(p));
    expect(await outcome('st3')).toMatchObject({ state: 'proposed', decision: null });
    // The step at the cursor, forged past the action.
    const cur = reviseOutcome(a.ctx, {
      outcomeId: 'st1',
      outcome: pl.outcomes.st1!,
      thread: await thread(),
      fields: { text: 'Friday.' },
      plan: { ...pl, plan: { ...pl.plan, cursor: 2 } },
    });
    await denied(a.run(cur));
  });
});
