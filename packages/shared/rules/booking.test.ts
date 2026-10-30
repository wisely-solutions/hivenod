/**
 * Bookings were retired with Calendar (item OE8FmrTaIxFVGcaeGG3N, slice 5). The reply_book and
 * book outcomes stay readable as old records, but nobody proposes, revises or approves one any
 * more (the rules have no field lists for them); an old one can still be rejected, and an old
 * approved one can still be reported done by its executor.
 */
import { describe, expect, it } from 'vitest';
import type { WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approveOutcome,
  finishOutcome,
  inboxPaths,
  proposeOutcome,
  rejectOutcome,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const thread = async () => (await snap(T('itr1'))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;

const BOOKING = {
  text: 'Thursday 10:00 works, invite on its way.',
  start: '2030-01-10T10:00:00.000Z',
  end: '2030-01-10T10:30:00.000Z',
  with: 'Sam Example',
};

/** agentA brings Sam's message in for alice and proposes a reply. */
async function proposedReply() {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'alice',
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Can we meet on Thursday?',
        threadRef: 'thread-1',
        messageId: 'm-1',
        permalink: 'https://teams.example.com/m/1',
        replyRef: 'conv:1',
        receivedAt: new Date('2030-01-08T09:00:00Z'),
        attachments: [],
      }),
    ),
  );
  const pr = proposeOutcome(a.ctx, {
    threadId: 'itr1',
    thread: await thread(),
    type: 'reply',
    fields: { text: BOOKING.text },
  });
  return { a, pr };
}

/** An old reply_book from before the removal (written with the rules off). */
async function oldBooking(state: 'proposed' | 'approved' = 'proposed') {
  const { a, pr } = await proposedReply();
  await ok(a.run(pr));
  const oid = pr.outcomeId;
  await put({ [O(oid)]: { ...(await snap(O(oid))), type: 'reply_book', fields: BOOKING, state } });
  return { a, oid };
}

describe('retired bookings', () => {
  it('an agent cannot propose one: the action and the rules refuse it', async () => {
    const { a, pr } = await proposedReply();
    expect(() =>
      proposeOutcome(a.ctx, {
        threadId: 'itr1',
        thread: { subjectId: null } as unknown as ThreadStateOf,
        type: 'reply_book',
        fields: BOOKING,
      }),
    ).toThrow(/retired with Calendar/);
    const raw: WriteOp[] = pr.ops.map((op) =>
      op.path === O(pr.outcomeId)
        ? { ...op, data: { ...op.data, type: 'reply_book', fields: BOOKING } }
        : op,
    );
    await denied(a.run(raw));
  });

  it('the member cannot approve an old one, but can reject it', async () => {
    const { oid } = await oldBooking();
    const alice = as('alice');
    const o = await outcome(oid);
    const th = await thread();
    expect(() => approveOutcome(alice.ctx, { outcomeId: oid, outcome: o, thread: th })).toThrow(
      /retired with Calendar/,
    );
    // Built as if it were a reply: the rules still refuse it.
    const asReply = approveOutcome(alice.ctx, {
      outcomeId: oid,
      outcome: { ...o, type: 'reply', fields: { text: BOOKING.text } },
      thread: await thread(),
    });
    await denied(alice.run(asReply));
    await ok(
      alice.run(
        rejectOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: o,
          thread: await thread(),
          reason: 'Not this week',
          othersPending: false,
        }),
      ),
    );
    expect(await snap(O(oid))).toMatchObject({ state: 'rejected' });
  });

  it('an old approved one can still be reported done by its executor', async () => {
    const { a, oid } = await oldBooking('approved');
    await ok(
      a.run(
        finishOutcome(a.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          status: 'done',
          result: { text: 'Sent and invited', permalink: 'https://teams.example.com/m/2' },
        }),
      ),
    );
    expect(await snap(O(oid))).toMatchObject({ state: 'done' });
  });
});
