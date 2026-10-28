import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  computeKpis,
  filterLog,
  formatWait,
  inRange,
  latestRationales,
  median,
  NO_FILTER,
  parseRange,
  rangeStart,
  tagCounts,
  toCsv,
  type DecisionRow,
} from './logic';

let n = 0;
function row(o: Partial<DecisionRow['d']> & { t?: number; pid?: string }): DecisionRow {
  const { t = 1000 + n, pid = 'p1', ...rest } = o;
  n += 1;
  return {
    id: `d${n}`,
    pid,
    d: {
      workspaceId: 'w',
      projectId: pid,
      itemId: 'i1',
      itemTitle: 'Item',
      stepId: 'review',
      outcome: 'approved',
      toStepId: null,
      byUid: 'u1',
      rationale: '',
      tags: [],
      lastEventId: `d${n}`,
      ...rest,
      at: { toMillis: () => t },
    },
  };
}

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe('computeKpis', () => {
  const rows = [
    // item a: sent back at review, then approved second time -> not first time
    row({
      itemId: 'a',
      outcome: 'sentBack',
      toStepId: 'draft',
      t: 1,
      tags: ['Too long'],
      waitMs: 60_000,
    }),
    row({ itemId: 'a', outcome: 'approved', t: 2, waitMs: 180_000 }),
    // item b: approved first time
    row({ itemId: 'b', outcome: 'approved', t: 3, waitMs: 120_000 }),
    // item c: stopped
    row({ itemId: 'c', outcome: 'stopped', t: 4 }),
    // item d: approved first time at another step
    row({ itemId: 'd', stepId: 'plan', outcome: 'approved', t: 5 }),
    row({ itemId: 'd', outcome: 'answered', t: 6 }),
  ];
  const k = computeKpis(rows);
  it('counts gate decisions, not answers', () => {
    expect(k.made).toBe(5);
    expect(k.approved).toBe(3);
    expect(k.sentBack).toBe(1);
    expect(k.stopped).toBe(1);
  });
  it('first-time approval is per item and step', () => {
    // pairs: a/review (first = sentBack), b/review (approved), c/review (stopped), d/plan (approved)
    expect(k.firstTimePct).toBe(50);
  });
  it('where items were sent back', () => {
    expect(k.sentBackTo).toEqual([{ step: 'draft', count: 1 }]);
  });
  it('median wait ignores decisions without a recorded wait', () => {
    expect(k.medianWaitMs).toBe(120_000);
  });
  it('is empty-safe', () => {
    const e = computeKpis([]);
    expect(e).toMatchObject({ made: 0, firstTimePct: null, medianWaitMs: null });
  });
});

describe('tagCounts', () => {
  it('counts tags on send backs only (a tagged stop does not count), once per decision', () => {
    const rows = [
      row({ outcome: 'sentBack', toStepId: 'x', tags: ['Too long', 'Too long', 'Wrong audience'] }),
      row({ outcome: 'stopped', tags: ['Too long'] }),
      row({ outcome: 'approved', tags: ['Too long'] }),
    ];
    expect(tagCounts(rows)).toEqual([
      { tag: 'Too long', count: 1 },
      { tag: 'Wrong audience', count: 1 },
    ]);
  });
});

describe('filters', () => {
  const rows = [
    row({
      t: 10,
      outcome: 'sentBack',
      toStepId: 'draft',
      rationale: 'Wrong tone for CFO',
      tags: ['Tone'],
    }),
    row({ t: 20, stepId: 'plan', outcome: 'approved', byUid: 'u2', rationale: 'Good' }),
    row({ t: 30, outcome: 'stopped', rationale: 'Dead end' }),
  ];
  it('sorts newest first and filters', () => {
    expect(filterLog(rows, NO_FILTER).map((r) => r.d.rationale)).toEqual([
      'Dead end',
      'Good',
      'Wrong tone for CFO',
    ]);
    expect(filterLog(rows, { ...NO_FILTER, step: 'plan' })).toHaveLength(1);
    expect(filterLog(rows, { ...NO_FILTER, outcome: 'stopped' })).toHaveLength(1);
    expect(filterLog(rows, { ...NO_FILTER, person: 'u2' })).toHaveLength(1);
    expect(filterLog(rows, { ...NO_FILTER, tag: 'Tone' })).toHaveLength(1);
    expect(filterLog(rows, { ...NO_FILTER, search: 'cfo' })).toHaveLength(1);
  });
  it('latest rationales skip empty ones', () => {
    const l = latestRationales([...rows, row({ t: 99, rationale: '  ' })], 2);
    expect(l.map((r) => r.d.rationale)).toEqual(['Dead end', 'Good']);
  });
});

describe('range', () => {
  it('parses and defaults to 30', () => {
    expect(parseRange('7')).toBe(7);
    expect(parseRange('x')).toBe(30);
  });
  it('window starts at local midnight', () => {
    const now = new Date(2026, 9, 25, 15, 30).getTime();
    expect(new Date(rangeStart(7, now)).getDate()).toBe(19);
    expect(new Date(rangeStart(7, now)).getHours()).toBe(0);
  });
  it('inRange', () => {
    expect(inRange([row({ t: 5 }), row({ t: 15 })], 10)).toHaveLength(1);
  });
});

describe('formatWait', () => {
  it('reads naturally', () => {
    expect(formatWait(null)).toBe('n/a');
    expect(formatWait(20_000)).toBe('<1 min');
    expect(formatWait(25 * 60_000)).toBe('25 min');
    expect(formatWait(90 * 60_000)).toBe('1.5 h');
    expect(formatWait(3 * 86_400_000)).toBe('3 d');
  });
});

describe('toCsv', () => {
  const names = {
    step: (s: string) => s.toUpperCase(),
    person: (u: string) => `Person ${u}`,
    project: () => 'Proj',
  };
  it('starts with a BOM, uses ISO dates and CRLF', () => {
    const csv = toCsv(
      [row({ t: Date.UTC(2026, 0, 2, 3, 4, 5), rationale: 'Olá, "mundo"\nok' })],
      names,
    );
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain('2026-01-02T03:04:05.000Z');
    expect(csv).toContain('"Olá, ""mundo""\nok"');
    expect(csv.split('\r\n')).toHaveLength(3);
  });
  it('uses app labels and leaves Sent back to empty unless sent back', () => {
    const csv = toCsv(
      [
        row({ outcome: 'approved', toStepId: 'review' }),
        row({ outcome: 'sentBack', toStepId: 'draft' }),
        row({ outcome: 'stopped', toStepId: null }),
      ],
      names,
    );
    const [, a, b, c] = csv.trim().split('\r\n') as [string, string, string, string];
    const cols = (l: string) => l.split(',');
    expect(cols(a)[4]).toBe('Approved');
    expect(cols(a)[5]).toBe('');
    expect(cols(b)[4]).toBe('Sent back');
    expect(cols(b)[5]).toBe('DRAFT');
    expect(cols(c)[4]).toBe('Stopped');
    expect(cols(c)[5]).toBe('');
    expect(csv).not.toContain('sentBack');
  });
  it('defuses formulas', () => {
    const csv = toCsv([row({ rationale: '=HYPERLINK("x")' })], names);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
