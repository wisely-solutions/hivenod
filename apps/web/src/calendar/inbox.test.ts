import type { InboxOutcome, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { deadlines, proposedBlocks, proposedBookings } from './inbox';

const ts = (ms: number) => ({ toMillis: () => ms });
const H = 3_600_000;
const NOW = new Date(2026, 9, 29, 9).getTime();
const outcome = (
  threadId: string,
  type: string,
  fields: Record<string, string>,
  state = 'proposed',
) => ({ threadId, type, fields, state }) as unknown as InboxOutcome;
const thread = (over: Partial<InboxThread>) =>
  ({
    memberUid: 'me',
    state: 'yourCall',
    title: 't',
    updatedAt: ts(0),
    ...over,
  }) as unknown as InboxThread;

describe('the calendar from the Inbox (item kt3E7)', () => {
  const inputs = [
    {
      wid: 'w',
      openOutcomes: [
        {
          id: 'o1',
          data: outcome('t1', 'reply_book', {
            start: new Date(NOW + 25 * H).toISOString(),
            end: new Date(NOW + 26 * H).toISOString(),
            with: 'Sam',
          }),
        },
        { id: 'o2', data: outcome('t2', 'reply', { text: 'x' }) },
        { id: 'o3', data: outcome('t3', 'reply_book', { start: 'soon', end: 'later', with: 'x' }) },
      ],
      threads: [
        { id: 't1', data: thread({ title: 'Payments review' }) },
        {
          id: 't4',
          data: thread({ title: 'Price list', urgent: true, due: ts(NOW + 3 * H) as never }),
        },
        { id: 't5', data: thread({ title: 'Closed', state: 'done', due: ts(NOW) as never }) },
        { id: 't6', data: thread({ title: 'Other', memberUid: 'ann', due: ts(NOW) as never }) },
      ],
    },
  ];
  it('lists open reply_book proposals with a valid slot as bookings', () => {
    const p = proposedBookings(inputs);
    expect(p.map((x) => [x.oid, x.title, x.thread?.id])).toEqual([
      ['o1', 'Meeting with Sam', 't1'],
    ]);
    expect(proposedBlocks(p, () => 'W')[0]).toMatchObject({
      kind: 'proposed',
      proposal: { wid: 'w', tid: 't1', oid: 'o1' },
    });
  });
  it('lists the member’s open threads with a deadline, with their band', () => {
    expect(deadlines(inputs, 'me', NOW).map((d) => [d.tid, d.band])).toEqual([['t4', 1]]);
  });
});
