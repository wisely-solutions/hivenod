/**
 * Bookings (Inbox item w9SAf): approving a reply_book outcome books the meeting in the member's
 * calendar, as the member, in the same batch; the executor then reports outcome_done.
 */
import { collection, getDocs } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  busyBlockId,
  calendarEventId,
  calendarPaths,
  calendarUpsert,
  freeSlots,
} from '../src/calendar';
import {
  addInboxMessage,
  approveOutcome,
  bookingEventId,
  finishOutcome,
  inboxPaths,
  proposeOutcome,
  rejectOutcome,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '../src/inbox';
import { AGENTS, as, denied, ok, snap, useEmulator, W } from './harness';

useEmulator();

const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);
const thread = async () => (await snap(T('itr1'))) as unknown as ThreadStateOf;
const outcome = async (oid: string) => (await snap(O(oid))) as unknown as OutcomeStateOf;

const FIELDS = {
  text: 'Thursday 10:00 works, invite on its way.',
  start: '2030-01-10T10:00:00Z',
  end: '2030-01-10T10:30:00Z',
  with: 'Sam Example, sam@example.com',
};

/** agentA brings Sam's message in for alice and proposes reply_book. */
async function proposed(fields: Record<string, unknown> = FIELDS) {
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
    type: 'reply_book',
    fields,
  });
  await ok(a.run(pr));
  return { a, oid: pr.outcomeId };
}

describe('reply_book', () => {
  it('approval books the meeting in the member’s calendar, then the executor reports it done', async () => {
    const { a, oid } = await proposed();
    // Proposing books nothing.
    const id = bookingEventId('alice', oid);
    expect(id).toBe(calendarEventId('alice', 'hivenod', oid));
    expect(await snap(calendarPaths.event(W, id))).toEqual({});

    const alice = as('alice');
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
        }),
      ),
    );
    expect(await snap(calendarPaths.event(W, id))).toMatchObject({
      memberUid: 'alice',
      title: 'Meeting with Sam Example, sam@example.com',
      attendees: ['Sam Example', 'sam@example.com'],
      source: 'hivenod',
      sourceEventId: oid,
      busyOnly: false,
      deleted: false,
      updatedBy: { type: 'human', id: 'alice' },
    });
    const block = await snap(calendarPaths.busyBlock('alice', busyBlockId(W, id)));
    expect(block).toMatchObject({ workspaceId: W, deleted: false });
    expect(block).not.toHaveProperty('title');
    expect(await snap(O(oid))).toMatchObject({ state: 'approved' });

    // The slot is taken at once for the drafting agents.
    const mine = await getDocs(collection(alice.db, calendarPaths.busy('alice')));
    const busy = mine.docs.map((d) => ({
      start: d.data().start.toDate(),
      end: d.data().end.toDate(),
    }));
    expect(
      freeSlots({
        from: new Date('2030-01-10T09:00:00Z'),
        to: new Date('2030-01-10T11:00:00Z'),
        busy,
      }),
    ).toEqual([
      { start: new Date('2030-01-10T09:00:00Z'), end: new Date('2030-01-10T10:00:00Z') },
      { start: new Date('2030-01-10T10:30:00Z'), end: new Date('2030-01-10T11:00:00Z') },
    ]);

    // The executor (the home agent) sends the reply and the invite, then reports it.
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
    expect(await snap(T('itr1'))).toMatchObject({ state: 'waiting' });
  });

  it('an edited time and title are what gets booked', async () => {
    const { oid } = await proposed();
    const alice = as('alice');
    await ok(
      alice.run(
        approveOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          fields: {
            ...FIELDS,
            start: '2030-01-10T15:00:00+01:00',
            end: '2030-01-10T16:00:00+01:00',
            title: 'Review with Sam',
          },
        }),
      ),
    );
    const e = await snap(calendarPaths.event(W, bookingEventId('alice', oid)));
    expect(e).toMatchObject({ title: 'Review with Sam' });
    expect((e.start as { toDate: () => Date }).toDate()).toEqual(new Date('2030-01-10T14:00:00Z'));
  });

  it('a meeting that ends before it starts is refused before anything is written', async () => {
    const { oid } = await proposed({ ...FIELDS, end: '2030-01-10T09:00:00Z' });
    const alice = as('alice');
    expect(() =>
      approveOutcome(alice.ctx, {
        outcomeId: 'x',
        outcome: {
          memberUid: 'alice',
          threadId: 'itr1',
          type: 'reply_book',
          fields: { ...FIELDS, end: '2030-01-10T09:00:00Z' },
          state: 'proposed',
          executor: AGENTS.a,
        } as unknown as OutcomeStateOf,
        thread: { subjectId: null } as unknown as ThreadStateOf,
      }),
    ).toThrow(/end after it starts/);
    expect(await snap(O(oid))).toMatchObject({ state: 'proposed' });
  });

  it('rejecting books nothing; nobody else can book into the member’s calendar', async () => {
    const { oid } = await proposed();
    const alice = as('alice');
    await ok(
      alice.run(
        rejectOutcome(alice.ctx, {
          outcomeId: oid,
          outcome: await outcome(oid),
          thread: await thread(),
          reason: 'Not this week',
          othersPending: false,
        }),
      ),
    );
    expect(await snap(calendarPaths.event(W, bookingEventId('alice', oid)))).toEqual({});
    // Bob (another member) cannot write a booking into Alice's calendar.
    const bob = as('bob');
    const forAlice = calendarUpsert(
      { ...bob.ctx, actor: { ...bob.ctx.actor, id: 'alice' } },
      {
        memberUid: 'alice',
        events: [
          {
            source: 'hivenod',
            sourceEventId: oid,
            title: 'x',
            start: new Date('2030-01-10T10:00:00Z'),
            end: new Date('2030-01-10T11:00:00Z'),
          },
        ],
      },
    );
    await denied(bob.run(forAlice));
  });
});
