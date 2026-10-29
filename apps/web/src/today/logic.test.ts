import type { InboxOutcome, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { bandOf, rankThreads } from '../threads/logic';
import {
  greeting,
  isTidyUp,
  proposalSentence,
  replaceSlotText,
  slotOptions,
  tidySummary,
} from './logic';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const H = 3_600_000;
const NOW = new Date(2026, 9, 29, 9, 12).getTime(); // Thu 29 Oct 2026, 09:12 local

const thread = (over: Partial<InboxThread> & { at?: number } = {}) =>
  ({
    memberUid: 'u',
    subjectId: null,
    state: 'yourCall',
    waiting: null,
    question: null,
    title: 't',
    refs: [],
    fetchedBy: 'a',
    lastMessageAt: ts(over.at ?? NOW),
    createdAt: ts(over.at ?? NOW),
    updatedAt: ts(over.at ?? NOW),
    lastEventId: 'e',
    ...over,
  }) as unknown as InboxThread;

describe('rank bands (design 3.5)', () => {
  it('urgent or due within 24 h is band 1; within 7 days band 2; then questions, then proposals', () => {
    expect(bandOf(thread({ urgent: true }), NOW)).toBe(1);
    expect(bandOf(thread({ due: ts(NOW + 20 * H) as never }), NOW)).toBe(1);
    expect(bandOf(thread({ due: ts(NOW - H) as never }), NOW)).toBe(1);
    expect(bandOf(thread({ due: ts(NOW + 3 * 24 * H) as never }), NOW)).toBe(2);
    expect(bandOf(thread({ due: ts(NOW + 9 * 24 * H) as never, state: 'needsYou' }), NOW)).toBe(3);
    expect(bandOf(thread({ due: null }), NOW)).toBe(4);
  });

  it('orders by band, earlier due first in bands 1-2, longest waiting first in 3-4', () => {
    const rows = [
      { id: 'call-new', data: thread({ updatedAt: ts(NOW - H) as never }) },
      { id: 'call-old', data: thread({ updatedAt: ts(NOW - 5 * H) as never }) },
      { id: 'ask', data: thread({ state: 'needsYou' }) },
      { id: 'due-5d', data: thread({ due: ts(NOW + 5 * 24 * H) as never }) },
      { id: 'due-2d', data: thread({ due: ts(NOW + 2 * 24 * H) as never }) },
      { id: 'urgent', data: thread({ urgent: true }) },
      { id: 'due-1h', data: thread({ due: ts(NOW + H) as never }) },
    ];
    expect(rankThreads(rows, NOW).map((r) => r.id)).toEqual([
      'due-1h',
      'urgent',
      'due-2d',
      'due-5d',
      'ask',
      'call-old',
      'call-new',
    ]);
  });
});

const outcome = (over: Partial<InboxOutcome> = {}) =>
  ({
    memberUid: 'u',
    threadId: 't1',
    type: 'ignore',
    fields: {},
    state: 'proposed',
    note: '',
    proposedBy: 'a',
    executor: null,
    decision: null,
    result: null,
    confidence: 'high',
    createdAt: ts(NOW),
    updatedAt: ts(NOW),
    lastEventId: 'e',
    ...over,
  }) as unknown as InboxOutcome;

describe('tidy-ups (design 3.4)', () => {
  it('a batchable, high-confidence, lone proposal on a calm thread', () => {
    expect(isTidyUp(outcome(), thread(), 1, NOW)).toBe(true);
    expect(isTidyUp(outcome({ type: 'no_reply' }), thread(), 1, NOW)).toBe(true);
  });
  it('never a sending type, a less sure one, an urgent or soon-due thread, or one of several', () => {
    expect(isTidyUp(outcome({ type: 'reply', fields: { text: 'x' } }), thread(), 1, NOW)).toBe(
      false,
    );
    expect(isTidyUp(outcome({ confidence: 'medium' }), thread(), 1, NOW)).toBe(false);
    expect(isTidyUp(outcome({ confidence: undefined }), thread(), 1, NOW)).toBe(false);
    expect(isTidyUp(outcome(), thread({ urgent: true }), 1, NOW)).toBe(false);
    expect(isTidyUp(outcome(), thread({ due: ts(NOW + 6 * 24 * H) as never }), 1, NOW)).toBe(false);
    expect(isTidyUp(outcome(), thread({ due: ts(NOW + 8 * 24 * H) as never }), 1, NOW)).toBe(true);
    expect(isTidyUp(outcome(), thread(), 2, NOW)).toBe(false);
    // A plan's step (item qwFAW) is decided in its plan.
    expect(isTidyUp({ ...outcome(), planId: 'p1' }, thread(), 1, NOW)).toBe(false);
  });
  it('sums them up in one line', () => {
    const t = (title: string) => thread({ title });
    expect(
      tidySummary([
        { outcome: outcome({ type: 'ignore' }), thread: t('OPS-221 done') },
        { outcome: outcome({ type: 'ignore' }), thread: t('OPS-222 done') },
        {
          outcome: outcome({
            type: 'snooze',
            fields: { until: new Date(2026, 10, 2, 9).toISOString() },
          }),
          thread: t('Hiring summary'),
        },
        { outcome: outcome({ type: 'no_reply' }), thread: t('Thanks!') },
      ]),
    ).toBe('ignore 2, snooze “Hiring summary” to Mon, close 1 FYI');
  });
});

describe('the proposal as one sentence', () => {
  it('reads each type as a sentence, not a form', () => {
    expect(proposalSentence('reply', { text: 'Thursday works.' })).toBe('Reply: “Thursday works.”');
    expect(
      proposalSentence('reply_book', {
        text: 'Booked.',
        start: new Date(2026, 9, 29, 10).toISOString(),
        end: new Date(2026, 9, 29, 11).toISOString(),
        with: 'Sam Okafor',
      }),
    ).toBe('Reply and book Thu 29 Oct, 10:00–11:00 with Sam Okafor: “Booked.”');
    expect(proposalSentence('make_it_work', { title: 'Sign off the price list' })).toBe(
      'Create the item “Sign off the price list”',
    );
    expect(proposalSentence('handover', { to: 'Nina Park' })).toBe('Hand it over to Nina Park');
    expect(
      proposalSentence('snooze', { until: new Date(2026, 10, 2, 9).toISOString(), reason: 'x' }),
    ).toBe('Snooze until Mon 2 Nov, 09:00: x');
    expect(proposalSentence('no_reply', {})).toBe('Close it, no reply needed');
    expect(proposalSentence('ignore', { reason: 'Status update' })).toBe(
      'Ignore it: Status update',
    );
    expect(proposalSentence('nudge', { text: 'Any news?' })).toBe('Send a reminder: “Any news?”');
  });
});

describe('greeting', () => {
  it('follows the hour', () => {
    expect(greeting(new Date(2026, 9, 29, 9).getTime())).toBe('Good morning');
    expect(greeting(new Date(2026, 9, 29, 13).getTime())).toBe('Good afternoon');
    expect(greeting(new Date(2026, 9, 29, 19).getTime())).toBe('Good evening');
  });
});

describe('slot options for a reply_book (design 3.6)', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
  const block = (d: number, h1: number, h2: number) => ({ start: at(d, h1), end: at(d, h2) });
  it('the agent’s slot, then up to 2 more free same-length slots that day in working hours', () => {
    const slots = slotOptions({
      start: at(29, 10),
      end: at(29, 11),
      busy: [block(29, 9, 10), block(29, 10, 11), block(29, 11, 14)],
      now: at(29, 9, 12).getTime(),
    });
    expect(slots.map((s) => [s.start.getHours(), s.end.getHours(), s.start.getDate()])).toEqual([
      [10, 11, 29],
      [14, 15, 29],
      [15, 16, 29],
    ]);
  });
  it('looks at the next working day when the day is full (Friday to Monday)', () => {
    const slots = slotOptions({
      start: at(30, 16),
      end: at(30, 17),
      busy: [block(30, 9, 16), block(30, 17, 18)],
      now: at(30, 8).getTime(),
    });
    expect(slots.map((s) => [s.start.getDate(), s.start.getHours()])).toEqual([
      [30, 16],
      [2, 9],
      [2, 10],
    ]);
  });
});

describe('the reply’s time text follows the slot', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m);
  it('replaces the old range when it appears exactly once, keeping the dash', () => {
    expect(
      replaceSlotText('I booked 10:00–11:00, see you.', at(10), at(11), at(14), at(15, 30)),
    ).toBe('I booked 14:00–15:30, see you.');
    expect(replaceSlotText('Booked 10:00-11:00.', at(10), at(11), at(14), at(15))).toBe(
      'Booked 14:00-15:00.',
    );
  });
  it('gives up when it is missing or there twice', () => {
    expect(replaceSlotText('Thursday morning works.', at(10), at(11), at(14), at(15))).toBeNull();
    expect(
      replaceSlotText('10:00-11:00 or 10:00–11:00', at(10), at(11), at(14), at(15)),
    ).toBeNull();
  });
});
