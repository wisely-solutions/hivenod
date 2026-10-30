import type { InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { recheckTargets, rowKey, rowStatus, waitingThreads } from './bulkRecheck';
import type { ThreadRow } from './logic';

const ts = (ms: number) => ({ toMillis: () => ms, seconds: ms / 1000, nanoseconds: 0 });
const NOW = 10 * 3_600_000;
const MIN = 60_000;

function thread(id: string, data: Partial<InboxThread> = {}, wid = 'w'): ThreadRow {
  return {
    wid,
    id,
    data: {
      memberUid: 'u',
      subjectId: null,
      state: 'waiting',
      waiting: { on: 'them', until: null },
      question: null,
      title: id,
      refs: [],
      lastMessageAt: ts(NOW - 60 * MIN),
      fetchedBy: 'a',
      createdAt: ts(0),
      updatedAt: ts(NOW - 60 * MIN),
      lastEventId: 'e',
      ...data,
    } as InboxThread,
  };
}
const pending = (requestedAt: number) =>
  ({
    state: 'pending',
    by: 'u',
    requestedAt: ts(requestedAt),
    result: null,
    note: null,
    at: null,
  }) as unknown as InboxThread['recheck'];
const done = (requestedAt: number, at: number, result: 'still_good' | 'revised' | 'asked') =>
  ({
    state: 'done',
    by: 'u',
    requestedAt: ts(requestedAt),
    result,
    note: null,
    at: ts(at),
  }) as unknown as InboxThread['recheck'];
const summary = (version: number, at: number) =>
  ({
    version,
    at: ts(at),
    headline: 'h',
    ask: null,
    answer: null,
    recAction: null,
    confidence: null,
  }) as unknown as InboxThread['summary'];

describe('waitingThreads', () => {
  it('keeps the waiting threads (on them, a third party, an item, a date, the agent), latest first', () => {
    const rows = [
      thread('them', { updatedAt: ts(NOW - 3 * MIN) }),
      thread('mine', { state: 'yourCall', waiting: null }),
      thread('agent', { waiting: { on: 'agent', until: null }, updatedAt: ts(NOW - MIN) }),
      thread('date', {
        waiting: { on: 'date', until: ts(NOW + MIN) },
        updatedAt: ts(NOW - 2 * MIN),
      }),
      thread('done', { state: 'done', waiting: null }),
      thread('item', { waiting: { on: 'item', until: null }, updatedAt: ts(NOW - 5 * MIN) }),
      thread('third', { waiting: { on: 'thirdParty', until: null }, updatedAt: ts(NOW - 4 * MIN) }),
    ];
    expect(waitingThreads(rows).map((t) => t.id)).toEqual([
      'agent',
      'date',
      'them',
      'third',
      'item',
    ]);
  });
});

describe('recheckTargets', () => {
  const a = thread('a');
  const b = thread('b', { recheck: pending(NOW - 5 * MIN) });
  const c = thread('c', { recheck: pending(NOW - 40 * MIN) });
  const d = thread('d', { recheck: done(NOW - 50 * MIN, NOW - 45 * MIN, 'still_good') });
  const e = thread('e', {}, 'x');
  const rows = [a, b, c, d, e];

  it('all: every waiting thread whose re-check is not pending (an unanswered one after 30 min)', () => {
    expect(recheckTargets(rows, 'all', NOW).map(rowKey)).toEqual(['w/a', 'w/c', 'w/d', 'x/e']);
  });
  it('the selection only, never one already pending', () => {
    const sel = new Set(['w/a', 'w/b', 'x/e']);
    expect(recheckTargets(rows, sel, NOW).map(rowKey)).toEqual(['w/a', 'x/e']);
  });
  it('a thread that is no longer waiting is left out', () => {
    const moved = thread('m', { state: 'yourCall', waiting: null });
    expect(recheckTargets([moved], new Set(['w/m']), NOW)).toEqual([]);
  });
});

describe('rowStatus', () => {
  it('re-checking while the request waits for its agent', () => {
    expect(rowStatus(thread('a', { recheck: pending(NOW - MIN) }).data, NOW)).toEqual({
      kind: 'rechecking',
    });
  });
  it('re-checking after the answer until the summary moves to a new version', () => {
    const t = thread('a', {
      recheck: done(NOW - 5 * MIN, NOW - MIN, 'revised'),
      summary: summary(3, NOW - 60 * MIN),
    });
    expect(rowStatus(t.data, NOW)).toEqual({ kind: 'rechecking' });
  });
  it('updated · vN once the summary was written after the request', () => {
    const t = thread('a', {
      recheck: done(NOW - 5 * MIN, NOW - MIN, 'revised'),
      summary: summary(4, NOW - 30_000),
    });
    expect(rowStatus(t.data, NOW)).toEqual({ kind: 'updated', version: 4, at: NOW - 30_000 });
  });
  it('checked · still good when the agent answered with no new summary for 2 minutes', () => {
    const t = thread('a', {
      recheck: done(NOW - 10 * MIN, NOW - 3 * MIN, 'still_good'),
      summary: summary(2, NOW - 60 * MIN),
    });
    expect(rowStatus(t.data, NOW)).toEqual({
      kind: 'checked',
      result: 'still_good',
      at: NOW - 3 * MIN,
    });
  });
  it('idle: the last summary (or nothing) when no re-check was asked or it lapsed', () => {
    expect(rowStatus(thread('a', { summary: summary(2, NOW - 60 * MIN) }).data, NOW)).toEqual({
      kind: 'idle',
      version: 2,
      at: NOW - 60 * MIN,
    });
    expect(rowStatus(thread('a', { recheck: pending(NOW - 40 * MIN) }).data, NOW)).toEqual({
      kind: 'idle',
      version: null,
      at: null,
    });
  });
});
