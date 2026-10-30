import { describe, expect, it } from 'vitest';
import {
  bandX,
  chartDomain,
  flowLayout,
  formatValue,
  labelEvery,
  lineDiff,
  lineSegments,
  niceTicks,
  scaleY,
  seriesValues,
  stackSegments,
  timelineEvents,
} from './scale';

describe('niceTicks', () => {
  it('rounds the domain out to nice steps and includes it', () => {
    const t = niceTicks(0, 10.8);
    expect(t.min).toBe(0);
    expect(t.max).toBeGreaterThanOrEqual(10.8);
    expect(t.ticks[0]).toBe(0);
    expect(t.ticks[t.ticks.length - 1]).toBe(t.max);
    expect(t.ticks.length).toBeGreaterThanOrEqual(3);
    expect(t.ticks.length).toBeLessThanOrEqual(6);
    // Evenly spaced.
    const step = t.ticks[1]! - t.ticks[0]!;
    t.ticks.forEach((v, i) => expect(v).toBeCloseTo(t.min + i * step));
  });
  it('handles negatives and a flat series', () => {
    const n = niceTicks(-3, 7);
    expect(n.min).toBeLessThanOrEqual(-3);
    expect(n.max).toBeGreaterThanOrEqual(7);
    expect(n.ticks).toContain(0);
    const flat = niceTicks(5, 5);
    expect(flat.max).toBeGreaterThan(flat.min);
  });
  it('keeps big numbers finite', () => {
    const t = niceTicks(0, 1e12);
    expect(Number.isFinite(t.max)).toBe(true);
    expect(t.max).toBeGreaterThanOrEqual(1e12);
  });
});

describe('chartDomain', () => {
  it('bars start at zero; nulls are skipped', () => {
    expect(chartDomain('bar', [[3, null, 9]])).toEqual({ min: 0, max: 9 });
    expect(chartDomain('bar', [[-2, 4]])).toEqual({ min: -2, max: 4 });
  });
  it('lines follow the data (padded to zero only when close)', () => {
    const d = chartDomain('line', [[100, 120, 110]]);
    expect(d.min).toBe(100);
    expect(d.max).toBe(120);
  });
  it('stacked bars sum each x', () => {
    expect(
      chartDomain('stacked_bar', [
        [1, 2],
        [3, null],
      ]),
    ).toEqual({ min: 0, max: 4 });
  });
  it('no data at all is a unit domain', () => {
    expect(chartDomain('bar', [[null, null]])).toEqual({ min: 0, max: 1 });
  });
});

describe('scaleY and bandX', () => {
  it('maps the domain onto the height (top is 0)', () => {
    expect(scaleY(0, { min: 0, max: 10 }, 160)).toBe(160);
    expect(scaleY(10, { min: 0, max: 10 }, 160)).toBe(0);
    expect(scaleY(5, { min: 0, max: 10 }, 160)).toBe(80);
  });
  it('splits the width into bands with a gap', () => {
    const a = bandX(0, 4, 400);
    const b = bandX(1, 4, 400);
    expect(a.x).toBeGreaterThan(0);
    expect(a.w).toBeGreaterThan(0);
    expect(b.x).toBeCloseTo(a.x + 100);
    expect(a.cx).toBeCloseTo(50);
  });
});

describe('seriesValues', () => {
  it('pads or cuts the values to the x length and drops non-numbers', () => {
    expect(seriesValues([1, 2], 3)).toEqual([1, 2, null]);
    expect(seriesValues([1, 2, 3, 4], 2)).toEqual([1, 2]);
    expect(seriesValues([1, Number.NaN, 2] as (number | null)[], 3)).toEqual([1, null, 2]);
  });
});

describe('lineSegments', () => {
  it('breaks the line at a gap', () => {
    const segs = lineSegments([1, 2, null, 4, 5], { min: 0, max: 5 }, 400, 100);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toHaveLength(2);
    expect(segs[1]).toHaveLength(2);
    expect(segs[0]![0]![1]).toBe(80);
  });
});

describe('stackSegments', () => {
  it('stacks positive values upwards from zero', () => {
    const s = stackSegments(
      [
        [1, 2],
        [3, 4],
      ],
      1,
    );
    expect(s).toEqual([
      { series: 0, from: 0, to: 2 },
      { series: 1, from: 2, to: 6 },
    ]);
  });
  it('skips nulls', () => {
    expect(
      stackSegments(
        [
          [null, 1],
          [2, 1],
        ],
        0,
      ),
    ).toEqual([{ series: 1, from: 0, to: 2 }]);
  });
});

describe('labelEvery', () => {
  it('thins x labels to fit the width', () => {
    expect(labelEvery(6, 600)).toBe(1);
    expect(labelEvery(24, 300)).toBeGreaterThan(1);
  });
});

describe('formatValue', () => {
  it('writes the unit after, % and currency symbols tight', () => {
    expect(formatValue(10.8, 'min')).toBe('10.8 min');
    expect(formatValue(12, '%')).toBe('12%');
    expect(formatValue(1200, '€')).toBe('€1.2K');
    expect(formatValue(3, null)).toBe('3');
    expect(formatValue(-0.5, null)).toBe('-0.5');
    expect(formatValue(1234567, null)).toBe('1.2M');
  });
});

describe('flowLayout', () => {
  const n = (id: string) => ({ id, label: id, who: null, state: null });
  it('a straight sequence in node order when there are no edges', () => {
    const l = flowLayout([n('a'), n('b'), n('c')], []);
    expect(l.layers).toEqual([['a'], ['b'], ['c']]);
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a>b', 'b>c']);
  });
  it('layers by longest path, one branch level', () => {
    const l = flowLayout(
      [n('a'), n('b'), n('c'), n('d')],
      [
        { from: 'a', to: 'b', label: 'yes' },
        { from: 'a', to: 'c', label: 'no' },
        { from: 'b', to: 'd', label: null },
        { from: 'c', to: 'd', label: null },
      ],
    );
    expect(l.layers).toEqual([['a'], ['b', 'c'], ['d']]);
  });
  it('drops edges to unknown nodes and survives a cycle', () => {
    const l = flowLayout(
      [n('a'), n('b')],
      [
        { from: 'a', to: 'b', label: null },
        { from: 'b', to: 'a', label: null },
        { from: 'a', to: 'zz', label: null },
      ],
    );
    expect(l.layers.flat().sort()).toEqual(['a', 'b']);
    expect(l.edges.some((e) => e.to === 'zz')).toBe(false);
  });
  it('places unconnected nodes too', () => {
    const l = flowLayout([n('a'), n('b'), n('c')], [{ from: 'a', to: 'b', label: null }]);
    expect(l.layers.flat().sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('lineDiff', () => {
  it('marks removed lines on the left and added lines on the right', () => {
    const d = lineDiff(['one', 'two', 'three'], ['one', 'three', 'four']);
    expect(d.before).toEqual([
      { text: 'one', changed: false },
      { text: 'two', changed: true },
      { text: 'three', changed: false },
    ]);
    expect(d.after).toEqual([
      { text: 'one', changed: false },
      { text: 'three', changed: false },
      { text: 'four', changed: true },
    ]);
  });
});

describe('timelineEvents', () => {
  it('sorts by date and labels each one', () => {
    const e = timelineEvents([
      { at: '2026-10-30', label: 'b', state: null },
      { at: '2026-10-29T14:02', label: 'a', state: 'done' },
    ]);
    expect(e.map((x) => x.label)).toEqual(['a', 'b']);
    expect(e[0]!.when).toMatch(/29 Oct/);
    expect(e[0]!.when).toMatch(/14:02/);
    expect(e[1]!.when).not.toMatch(/:/);
  });
});
