import type { BellEntry } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { dayLabel, filterRows, groupByDay, liveArrivals, unreadCount, type BellRow } from './logic';

const row = (id: string, over: Partial<BellEntry> = {}): BellRow => ({
  id,
  data: {
    kind: 'inboxCall',
    workspaceId: 'w',
    projectId: 'inbox',
    itemId: 'i',
    projectName: 'Hive',
    itemTitle: 'T',
    stepName: 'Accept',
    actorName: '',
    text: '',
    at: 0,
    readAt: null,
    ...over,
  },
});

const noon = new Date(2026, 9, 28, 12, 0).getTime();

describe('bell logic (item 3ENs)', () => {
  it('filters all, unread and needs you, and counts unread', () => {
    const rows = [
      row('a'),
      row('b', { readAt: 5 }),
      row('c', { kind: 'silence' }),
      row('d', { kind: 'inboxAsk', readAt: 1 }),
    ];
    expect(filterRows(rows, 'all').map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(filterRows(rows, 'unread').map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterRows(rows, 'needs').map((r) => r.id)).toEqual(['a', 'b', 'd']);
    expect(unreadCount(rows)).toBe(2);
  });
  it('groups by day: today, yesterday, then dates', () => {
    expect(dayLabel(noon - 3600_000, noon)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 27, 21, 20).getTime(), noon)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 9, 20, 9).getTime(), noon)).not.toMatch(/Today|Yesterday/);
    const groups = groupByDay(
      [
        row('a', { at: noon - 1000 }),
        row('b', { at: noon - 2000 }),
        row('c', { at: noon - 24 * 3600_000 }),
      ],
      noon,
    );
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
  });
  it('never pops up what was there at sign-in, only what arrives during the session', () => {
    const start = noon;
    const first = [row('old1', { at: start - 3600_000 }), row('old2', { at: start - 7200_000 })];
    // The first snapshot is history, however many unread it holds.
    expect(liveArrivals(null, first, start)).toEqual([]);
    const seen = new Set(first.map((r) => r.id));
    const next = [row('new', { at: start + 5000 }), ...first];
    expect(liveArrivals(seen, next, start).map((r) => r.id)).toEqual(['new']);
    // A late write about something old (the notifier caught up) stays in the bell only.
    const late = [row('late', { at: start - 3600_000 }), ...first];
    expect(liveArrivals(seen, late, start)).toEqual([]);
    // Already read on another device: no pop-up.
    expect(liveArrivals(seen, [row('r', { at: start + 1, readAt: start + 2 })], start)).toEqual([]);
  });
});
