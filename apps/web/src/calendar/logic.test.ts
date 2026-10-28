import { describe, expect, it } from 'vitest';
import { allDayOn, layoutDay, rangeOf, shift, startOfWeek, type CalBlock } from './logic';

const D = (day: number, h = 0, m = 0) => new Date(2026, 10, day, h, m); // November 2026
const block = (id: string, s: Date, e: Date, over: Partial<CalBlock> = {}): CalBlock => ({
  id,
  start: s,
  end: e,
  title: id,
  kind: 'event',
  label: '',
  allDay: false,
  ...over,
});

describe('ranges', () => {
  it('weeks start on Monday', () => {
    expect(startOfWeek(D(4, 15))).toEqual(D(2)); // Wed 4 Nov -> Mon 2 Nov
    expect(startOfWeek(D(8))).toEqual(D(2)); // Sunday
    expect(startOfWeek(D(2))).toEqual(D(2));
  });
  it('a day and a week', () => {
    expect(rangeOf('day', D(4, 15))).toMatchObject({ from: D(4), to: D(5) });
    const w = rangeOf('week', D(4, 15));
    expect(w.from).toEqual(D(2));
    expect(w.to).toEqual(D(9));
    expect(w.days).toHaveLength(7);
    expect(shift('week', D(4), 1)).toEqual(D(11));
    expect(shift('day', D(4), -1)).toEqual(D(3));
  });
});

describe('layoutDay', () => {
  it('places blocks in minutes from midnight and shares width when they overlap', () => {
    const placed = layoutDay(
      [
        block('a', D(2, 9), D(2, 10)),
        block('b', D(2, 9, 30), D(2, 11)),
        block('c', D(2, 10), D(2, 10, 30)),
        block('d', D(2, 13), D(2, 13, 5)),
        block('other day', D(3, 9), D(3, 10)),
      ],
      D(2),
    );
    const by = Object.fromEntries(placed.map((p) => [p.block.id, p]));
    expect(Object.keys(by).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(by.a).toMatchObject({ top: 540, height: 60, lane: 0, lanes: 2 });
    expect(by.b).toMatchObject({ top: 570, lane: 1, lanes: 2 });
    expect(by.c).toMatchObject({ top: 600, lane: 0, lanes: 2 });
    // short blocks stay readable; alone, full width
    expect(by.d).toMatchObject({ height: 15, lane: 0, lanes: 1 });
  });
  it('clips blocks that cross midnight', () => {
    const [p] = layoutDay([block('late', D(2, 23), D(3, 1))], D(3));
    expect(p).toMatchObject({ top: 0, height: 60 });
  });
  it('keeps all-day blocks out of the grid', () => {
    const all = block('trip', D(2), D(4), { allDay: true });
    expect(layoutDay([all], D(2))).toEqual([]);
    expect(allDayOn([all], D(3))).toEqual([all]);
    expect(allDayOn([all], D(4))).toEqual([]);
  });
});
