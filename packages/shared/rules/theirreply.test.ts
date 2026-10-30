/**
 * Their reply (packages/shared/src/theirreply.ts): a plan step that waits on someone outside
 * Hivenod. The agent drafts every message, the member approves it before it is sent, and the
 * step is reported done only with their reply (a message from them newer than the last send).
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approvePlan,
  finishOutcome,
  inboxPaths,
  proposePlan,
  type OutcomeStateOf,
  type PlanInput,
  type PlanOf,
  type ThreadStateOf,
} from '../src/inbox';
import { approveStepAsk, markStepDone, stepAsk, stepSent } from '../src/theirreply';
import { AGENTS, as, denied, ok, snap, useEmulator, W, type As } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const PL = (pid: string) => inboxPaths.plan(W, pid);
const TID = 'itr1';
const thread = async () => (await snap(T(TID))) as unknown as ThreadStateOf;
async function load(): Promise<PlanInput> {
  const plan = (await snap(PL('pl1'))) as unknown as PlanOf;
  const outcomes: Record<string, OutcomeStateOf> = {};
  for (const id of plan.steps) outcomes[id] = (await snap(O(id))) as unknown as OutcomeStateOf;
  return { planId: 'pl1', plan, outcomes };
}
const step = async () => {
  const pl = await load();
  return { outcomeId: 'tr1', outcome: pl.outcomes.tr1!, thread: await thread(), plan: pl };
};
const forge = (ops: WriteOp[], path: string, over: Record<string, unknown>) =>
  ops.map((op) => (op.path === path ? { ...op, data: { ...op.data, ...over } } : op));

let n = 0;
async function message(a: As, direction: 'in' | 'out' = 'in', text = 'Yes, approved.') {
  n++;
  const id = `im-m${n}`;
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: id,
        ref: 'r1',
        memberUid: 'alice',
        source: 'mail',
        sender: { name: 'Ana Example', handle: 'ana@example.com' },
        direction,
        text,
        threadRef: 'thread-1',
        messageId: `m-${n}`,
        receivedAt: new Date('2026-10-28T09:00:00Z'),
        thread: { threadId: TID, state: await thread() },
      }),
    ),
  );
  return id;
}

/** A thread, a plan [their_reply, reply] approved by alice: the step's turn. */
async function atTurn() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im-0',
        ref: 'r1',
        memberUid: 'alice',
        source: 'mail',
        sender: { name: 'Ana Example', handle: 'ana@example.com' },
        text: 'Send me the contract.',
        threadRef: 'thread-1',
        messageId: 'm-0',
        receivedAt: new Date('2026-10-28T08:00:00Z'),
      }),
    ),
  );
  await ok(
    a.run(
      proposePlan(a.ctx, {
        threadId: TID,
        thread: await thread(),
        note: 'Ask Ana, then confirm',
        steps: [
          {
            type: 'their_reply',
            fields: {
              who: 'Ana',
              channel: 'mail',
              address: 'ana@example.com',
              need: 'Her OK on the contract',
            },
          },
          { type: 'reply', fields: { text: 'Thanks, all set.' } },
        ],
        planId: 'pl1',
        stepIds: ['tr1', 'tr2'],
      }),
    ),
  );
  const alice = as('alice');
  await ok(alice.run(approvePlan(alice.ctx, { ...(await load()), thread: await thread() })));
  return { a, alice };
}
const ask = async (
  a: As,
  kind: 'ask' | 'follow_up' | 'nudge' = 'ask',
  text = 'Hi Ana, is the contract OK?',
) => stepAsk(a.ctx, { ...(await step()), kind, text });
/** Asked, approved and sent: the step waits on them. */
async function waiting() {
  const { a, alice } = await atTurn();
  await ok(a.run(await ask(a)));
  await ok(alice.run(approveStepAsk(alice.ctx, await step())));
  await ok(a.run(stepSent(a.ctx, await step())));
  return { a, alice };
}

describe('their reply: the ask', () => {
  it('the agent drafts the ask at its turn: the step runs, the thread is the member’s call', async () => {
    const { a } = await atTurn();
    await ok(a.run(await ask(a)));
    expect(await snap(O('tr1'))).toMatchObject({
      state: 'running',
      ext: { ask: { n: 1, kind: 'ask', state: 'proposed' }, sent: 0, outAt: null },
    });
    expect(await snap(T(TID))).toMatchObject({ state: 'yourCall', waiting: null });
  });
  it('nothing is sent before approval: step_sent on a draft is refused', async () => {
    const { a } = await atTurn();
    await ok(a.run(await ask(a)));
    const s = await step();
    const draft = s.outcome.ext!;
    const forged = stepSent(a.ctx, {
      ...s,
      outcome: { ...s.outcome, ext: { ...draft, ask: { ...draft.ask!, state: 'approved' } } },
    });
    await denied(a.run(forged));
  });
  it('the member approves (edited), the agent sends: the step waits on them', async () => {
    const { a, alice } = await atTurn();
    await ok(a.run(await ask(a)));
    await ok(alice.run(approveStepAsk(alice.ctx, { ...(await step()), text: 'Hi Ana, OK?' })));
    expect(await snap(T(TID))).toMatchObject({ state: 'waiting', waiting: { on: 'agent' } });
    await ok(a.run(stepSent(a.ctx, await step())));
    expect(await snap(O('tr1'))).toMatchObject({
      ext: { ask: { state: 'sent', text: 'Hi Ana, OK?' }, sent: 1 },
    });
    expect(await snap(T(TID))).toMatchObject({ state: 'waiting', waiting: { on: 'them' } });
  });
  it('the agent may not approve its own draft', async () => {
    const { a, alice } = await atTurn();
    await ok(a.run(await ask(a)));
    const ap = approveStepAsk(alice.ctx, await step());
    const ops = ap.ops.map((op) =>
      op.path.includes('/inboxEvents/')
        ? { ...op, data: { ...op.data, actor: { type: 'agent', id: AGENTS.a, name: 'Agent A' } } }
        : op,
    );
    await denied(a.run(ops));
  });
  it('another member may not approve the draft', async () => {
    const { a } = await atTurn();
    await ok(a.run(await ask(a)));
    const bob = as('bob');
    const s = await step();
    // As if the step were bob's: the rules still see alice's.
    const p = approveStepAsk(bob.ctx, { ...s, outcome: { ...s.outcome, memberUid: 'bob' } });
    await denied(bob.run(p));
  });
  it('the first message is an ask; the member may not edit an approval into a sent', async () => {
    const { a, alice } = await atTurn();
    const s = await step();
    const p = stepAsk(a.ctx, {
      ...s,
      outcome: { ...s.outcome, ext: { ask: null, outAt: null, sent: 1, reply: null } },
      kind: 'nudge',
      text: 'x',
    });
    await denied(a.run(p));
    await ok(a.run(await ask(a)));
    const ap = approveStepAsk(alice.ctx, await step());
    const o = ap.ops.find((op) => op.path === O('tr1'))!;
    const ext = o.data.ext as Record<string, unknown>;
    await denied(
      alice.run(
        forge(ap.ops, O('tr1'), {
          ext: { ...ext, ask: { ...(ext.ask as object), state: 'sent' } },
        }),
      ),
    );
  });
});

describe('their reply: done only on their reply', () => {
  it('a reply from them after the send: done with the quote, the plan moves on', async () => {
    const { a } = await waiting();
    const mid = await message(a);
    expect(await snap(T(TID))).toMatchObject({ state: 'investigating' });
    const m = await snap(inboxPaths.message(W, mid));
    await ok(
      a.run(
        finishOutcome(a.ctx, {
          ...(await step()),
          status: 'done',
          evidence: { messageDocId: mid, quote: 'Yes, approved.', confidence: 'high' },
          evidenceMessage: {
            threadId: TID,
            direction: 'in',
            createdAtMs: (m.createdAt as { toMillis(): number }).toMillis(),
          },
        }),
      ),
    );
    expect(await snap(O('tr1'))).toMatchObject({
      state: 'done',
      result: { text: 'Yes, approved.' },
    });
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 1 });
  });
  it('refused with a message from before the send, from the member, or none', async () => {
    const { a, alice } = await atTurn();
    const before = await message(a);
    await ok(a.run(await ask(a)));
    await ok(alice.run(approveStepAsk(alice.ctx, await step())));
    await ok(a.run(stepSent(a.ctx, await step())));
    const out = await message(a, 'out', 'My own note');
    for (const mid of [before, out, 'im-nope']) {
      const p = finishOutcome(a.ctx, {
        ...(await step()),
        status: 'done',
        evidence: { messageDocId: mid, quote: 'Yes' },
        // The action's own check bypassed: the rules alone decide.
        evidenceMessage: { threadId: TID, direction: 'in', createdAtMs: Date.now() + 60_000 },
      });
      await denied(a.run(p));
    }
  });
  it('before anything was sent, done is refused', async () => {
    const { a } = await atTurn();
    const mid = await message(a);
    await ok(a.run(await ask(a)));
    const s = await step();
    const p = finishOutcome(a.ctx, {
      ...s,
      outcome: {
        ...s.outcome,
        ext: {
          ...s.outcome.ext!,
          ask: { ...s.outcome.ext!.ask!, state: 'sent' },
          outAt: { toMillis: () => 0 },
        },
      },
      status: 'done',
      evidence: { messageDocId: mid, quote: 'Yes' },
      evidenceMessage: { threadId: TID, direction: 'in', createdAtMs: Date.now() },
    });
    await denied(a.run(p));
  });
  it('a follow-up quotes their reply; the member may mark the step done anyway', async () => {
    const { a, alice } = await waiting();
    const mid = await message(a, 'in', 'Maybe, let me check.');
    await ok(
      a.run(
        stepAsk(a.ctx, {
          ...(await step()),
          kind: 'follow_up',
          text: 'Thanks Ana, by Friday?',
          reply: { messageDocId: mid, quote: 'Maybe, let me check.' },
          replyMessage: { threadId: TID, direction: 'in' },
        }),
      ),
    );
    expect(await snap(O('tr1'))).toMatchObject({
      ext: {
        ask: { n: 2, kind: 'follow_up', state: 'proposed' },
        sent: 1,
        reply: { messageDocId: mid },
      },
    });
    await ok(alice.run(markStepDone(alice.ctx, await step())));
    expect(await snap(O('tr1'))).toMatchObject({ state: 'done' });
    expect(await snap(PL('pl1'))).toMatchObject({ cursor: 1 });
  });
});
