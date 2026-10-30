import type { InboxOutcome, InboxThread } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { NeedsEntry } from '../needs/logic';
import { briefingList } from './briefing';

const ts = (ms: number) => ({ toMillis: () => ms });
const entry = (key: string, over: Partial<NeedsEntry> & { type?: string; urgent?: boolean }) =>
  ({
    key,
    wid: 'w',
    org: 'W',
    kind: over.kind ?? 'thread',
    since: over.since ?? 0,
    urgent: false,
    who: { only: true },
    group: 'inbox',
    ...(over.kind && over.kind !== 'thread'
      ? {}
      : {
          thread: {
            id: key,
            data: {
              state: 'yourCall',
              urgent: over.urgent,
              updatedAt: ts(over.since ?? 0),
            } as unknown as InboxThread,
          },
          proposals: [{ id: `o-${key}`, data: { type: over.type ?? 'reply' } as InboxOutcome }],
        }),
  }) as NeedsEntry;

describe('briefing (design 2.2)', () => {
  const todo = [
    entry('reply', { since: 1 }),
    entry('book', { since: 2, type: 'nudge' }),
    entry('item', { kind: 'approval', since: 0 }),
    entry('urgent', { since: 3, urgent: true }),
  ];
  it('from Today: the stack order', () => {
    expect(briefingList(todo, 'today', 10).map((e) => e.key)).toEqual([
      'urgent',
      'item',
      'reply',
      'book',
    ]);
  });
});
