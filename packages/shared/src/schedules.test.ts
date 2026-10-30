import { describe, expect, it } from 'vitest';
import {
  CATCH_UP_WINDOW_MS,
  checkRule,
  dueNow,
  fillPlaceholders,
  localToUtc,
  nextDue,
  nextRun,
  nextRuns,
  occurrences,
  occurrenceWords,
  ruleSentence,
  runKey,
  tzOffsetMs,
  urgencyOf,
  type Occurrence,
  type ScheduleRule,
} from './schedules';

const utc = (s: string) => Date.parse(s.endsWith('Z') ? s : `${s}Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16) + 'Z';
const NY = 'America/New_York';
const LIS = 'Europe/Lisbon';

/** Local date, key and UTC instant of the next `n` runs from `from`. */
function runs(rule: ScheduleRule, from: string, n: number) {
  return nextRuns(rule, utc(from), n).map((o) => ({
    local: o.local,
    key: o.key,
    utc: iso(o.dueMs),
  }));
}
const first = (rule: ScheduleRule, fromMs: number): Occurrence => {
  const [o] = nextRuns(rule, fromMs, 1);
  if (!o) throw new Error('no run');
  return o;
};
const full = (rule: ScheduleRule, from: string, n: number) => nextRuns(rule, utc(from), n);
const dates = (rule: ScheduleRule, from: string, n: number) =>
  nextRuns(rule, utc(from), n).map((o) => o.date);

describe('localToUtc and offsets', () => {
  it('reads Lisbon winter and summer offsets', () => {
    expect(tzOffsetMs(utc('2026-01-15T12:00'), LIS)).toBe(0);
    expect(tzOffsetMs(utc('2026-07-15T12:00'), LIS)).toBe(3_600_000);
    expect(tzOffsetMs(utc('2026-07-15T12:00'), NY)).toBe(-4 * 3_600_000);
    expect(tzOffsetMs(utc('2026-07-15T12:00'), 'Asia/Kolkata')).toBe(5.5 * 3_600_000);
  });
  it('moves a time in the spring gap forward by the gap', () => {
    // Lisbon 2026-03-29: 01:00 WET → 02:00 WEST, so 01:30 does not exist → 02:30 WEST = 01:30Z.
    expect(iso(localToUtc({ y: 2026, m: 3, d: 29 }, 1, 30, LIS))).toBe('2026-03-29T01:30Z');
    // New York 2026-03-08: 02:00 EST → 03:00 EDT, so 02:30 → 03:30 EDT = 07:30Z.
    expect(iso(localToUtc({ y: 2026, m: 3, d: 8 }, 2, 30, NY))).toBe('2026-03-08T07:30Z');
  });
  it('handles a southern zone and a half-hour change', () => {
    // Sydney 2026-10-04: 02:00 AEST → 03:00 AEDT; 02:30 → 03:30 AEDT = 16:30Z the day before.
    expect(iso(localToUtc({ y: 2026, m: 10, d: 4 }, 2, 30, 'Australia/Sydney'))).toBe(
      '2026-10-03T16:30Z',
    );
    // Lord Howe moves 30 minutes: 02:00 → 02:30; 02:15 → 02:45 (+11:00) = 15:45Z.
    expect(iso(localToUtc({ y: 2026, m: 10, d: 4 }, 2, 15, 'Australia/Lord_Howe'))).toBe(
      '2026-10-03T15:45Z',
    );
  });
  it('takes the first occurrence of an autumn time', () => {
    // Lisbon 2026-10-25: 02:00 WEST → 01:00 WET, 01:30 twice; the first is 00:30Z.
    expect(iso(localToUtc({ y: 2026, m: 10, d: 25 }, 1, 30, LIS))).toBe('2026-10-25T00:30Z');
    // New York 2026-11-01: 01:30 EDT (05:30Z) before 01:30 EST (06:30Z).
    expect(iso(localToUtc({ y: 2026, m: 11, d: 1 }, 1, 30, NY))).toBe('2026-11-01T05:30Z');
  });
  it('keeps ordinary times exact on transition days', () => {
    expect(iso(localToUtc({ y: 2026, m: 3, d: 29 }, 0, 59, LIS))).toBe('2026-03-29T00:59Z');
    expect(iso(localToUtc({ y: 2026, m: 3, d: 29 }, 2, 0, LIS))).toBe('2026-03-29T01:00Z');
    expect(iso(localToUtc({ y: 2026, m: 10, d: 25 }, 2, 0, LIS))).toBe('2026-10-25T02:00Z');
    expect(iso(localToUtc({ y: 2026, m: 10, d: 25 }, 0, 30, LIS))).toBe('2026-10-24T23:30Z');
  });
});

describe('checkRule', () => {
  const ok: ScheduleRule[] = [
    { freq: 'once', at: '10:00', date: '2026-11-12' },
    { freq: 'daily', at: '00:00' },
    { freq: 'daily', at: '23:59', weekdays: [1, 2, 3, 4, 5], tz: NY },
    { freq: 'weekly', at: '16:00', weekdays: [5] },
    { freq: 'monthly', at: '09:00', monthDay: 31, weekend: 'before' },
    { freq: 'monthly', at: '09:00', monthDay: -1, until: '2027-12-31', date: '2026-11-01' },
    { freq: 'quarterly', at: '17:00', monthDay: -1 },
    { freq: 'quarterly', at: '17:00', monthDay: 1, month: 2, weekend: 'after' },
    { freq: 'yearly', at: '09:00', monthDay: 29, month: 2 },
    { freq: 'daily', at: '09:00', weekend: 'keep' },
  ];
  it.each(ok)('accepts %j', (rule) => expect(checkRule(rule)).toEqual([]));

  const bad: [string, unknown, string][] = [
    ['weekly without weekdays', { freq: 'weekly', at: '09:00' }, 'weekly needs weekdays'],
    ['monthDay 0', { freq: 'monthly', at: '09:00', monthDay: 0 }, 'monthDay: 1..31 or -1'],
    ['monthDay 32', { freq: 'monthly', at: '09:00', monthDay: 32 }, 'monthDay: 1..31 or -1'],
    ['monthDay 1.5', { freq: 'monthly', at: '09:00', monthDay: 1.5 }, 'monthDay: 1..31 or -1'],
    ['monthly without monthDay', { freq: 'monthly', at: '09:00' }, 'monthly needs monthDay'],
    ['at 24:00', { freq: 'daily', at: '24:00' }, 'at: HH:MM between 00:00 and 23:59'],
    ['at 9:00', { freq: 'daily', at: '9:00' }, 'at: HH:MM between 00:00 and 23:59'],
    ['at 09:60', { freq: 'daily', at: '09:60' }, 'at: HH:MM between 00:00 and 23:59'],
    ['unknown tz', { freq: 'daily', at: '09:00', tz: 'Europe/Atlantis' }, 'tz: unknown time zone'],
    ['once without date', { freq: 'once', at: '09:00' }, 'once needs date'],
    [
      'once with until',
      { freq: 'once', at: '09:00', date: '2026-11-01', until: '2026-12-01' },
      'until: not for once',
    ],
    [
      'date 31 Nov',
      { freq: 'once', at: '09:00', date: '2026-11-31' },
      'date: a real day as YYYY-MM-DD',
    ],
    [
      'date 29 Feb 2027',
      { freq: 'once', at: '09:00', date: '2027-02-29' },
      'date: a real day as YYYY-MM-DD',
    ],
    [
      'until before date',
      { freq: 'daily', at: '09:00', date: '2026-11-02', until: '2026-11-01' },
      'until: on or after date',
    ],
    [
      'until garbage',
      { freq: 'daily', at: '09:00', until: 'soon' },
      'until: a real day as YYYY-MM-DD',
    ],
    [
      'weekday 0',
      { freq: 'weekly', at: '09:00', weekdays: [0] },
      'weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday',
    ],
    [
      'weekday 8',
      { freq: 'weekly', at: '09:00', weekdays: [8] },
      'weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday',
    ],
    [
      'empty weekdays',
      { freq: 'weekly', at: '09:00', weekdays: [] },
      'weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday',
    ],
    [
      'repeated weekdays',
      { freq: 'daily', at: '09:00', weekdays: [1, 1] },
      'weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday',
    ],
    [
      'weekdays on monthly',
      { freq: 'monthly', at: '09:00', monthDay: 1, weekdays: [1] },
      'weekdays: only for daily or weekly',
    ],
    [
      'monthDay on daily',
      { freq: 'daily', at: '09:00', monthDay: 1 },
      'monthDay: only for monthly, quarterly or yearly',
    ],
    ['yearly without month', { freq: 'yearly', at: '09:00', monthDay: 1 }, 'yearly needs month'],
    ['month 13', { freq: 'yearly', at: '09:00', monthDay: 1, month: 13 }, 'month: 1..12'],
    [
      '30 Feb',
      { freq: 'yearly', at: '09:00', monthDay: 30, month: 2 },
      'monthDay: Feb has at most 29 days',
    ],
    [
      '31 Apr',
      { freq: 'yearly', at: '09:00', monthDay: 31, month: 4 },
      'monthDay: Apr has at most 30 days',
    ],
    [
      'month on monthly',
      { freq: 'monthly', at: '09:00', monthDay: 1, month: 1 },
      'month: only for quarterly or yearly',
    ],
    [
      'weekend on daily',
      { freq: 'daily', at: '09:00', weekend: 'after' },
      'weekend: only for monthly, quarterly or yearly',
    ],
    [
      'weekend garbage',
      { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'never' },
      'weekend: keep, before or after',
    ],
    [
      'unknown freq',
      { freq: 'hourly', at: '09:00' },
      'freq: one of once, daily, weekly, monthly, quarterly, yearly',
    ],
  ];
  it.each(bad)('refuses %s', (_name, rule, error) => {
    expect(checkRule(rule as ScheduleRule)).toContain(error);
  });
  it('refuses a missing rule', () =>
    expect(checkRule(null as unknown as ScheduleRule)).toEqual(['rule: required']));
  it('throws on an invalid rule when computing runs', () => {
    expect(() => nextRuns({ freq: 'weekly', at: '09:00' }, 0, 1)).toThrow(/weekly needs weekdays/);
    expect(() => occurrences({ freq: 'daily', at: '09:00' }, -Infinity, 0)).toThrow(/finite/);
  });
});

describe('once', () => {
  const rule: ScheduleRule = { freq: 'once', at: '10:00', date: '2026-11-12' };
  it('runs once at the local time, key once', () => {
    expect(runs(rule, '2026-10-30T00:00', 5)).toEqual([
      { local: '2026-11-12 10:00', key: 'once', utc: '2026-11-12T10:00Z' },
    ]);
  });
  it('has no run after it passed', () => {
    expect(nextRun(rule, utc('2026-11-12T10:00'))).toBeNull();
    expect(nextRun(rule, utc('2026-11-12T09:59'))?.key).toBe('once');
  });
  it('a one-off in the spring gap moves forward', () => {
    expect(
      runs({ freq: 'once', at: '02:15', date: '2026-03-08', tz: NY }, '2026-01-01', 1)[0],
    ).toMatchObject({
      local: '2026-03-08 03:15',
      utc: '2026-03-08T07:15Z',
    });
  });
});

describe('daily', () => {
  it('runs every day at the local time, keyed by local date', () => {
    expect(runs({ freq: 'daily', at: '09:00' }, '2026-10-30T10:00', 3)).toEqual([
      { local: '2026-10-31 09:00', key: '2026-10-31', utc: '2026-10-31T09:00Z' },
      { local: '2026-11-01 09:00', key: '2026-11-01', utc: '2026-11-01T09:00Z' },
      { local: '2026-11-02 09:00', key: '2026-11-02', utc: '2026-11-02T09:00Z' },
    ]);
  });
  it('a weekday subset skips the weekend', () => {
    // Fri 30 Oct 2026 → Mon 2 Nov
    expect(
      dates({ freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5] }, '2026-10-30T09:00', 3),
    ).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
  });
  it('01:30 on the Lisbon spring day runs at 02:30 local', () => {
    expect(runs({ freq: 'daily', at: '01:30' }, '2026-03-28T12:00', 2)).toEqual([
      { local: '2026-03-29 02:30', key: '2026-03-29', utc: '2026-03-29T01:30Z' },
      { local: '2026-03-30 01:30', key: '2026-03-30', utc: '2026-03-30T00:30Z' },
    ]);
  });
  it('01:30 on the Lisbon autumn day runs once, at 00:30 UTC', () => {
    const night = occurrences(
      { freq: 'daily', at: '01:30' },
      utc('2026-10-24T12:00'),
      utc('2026-10-25T12:00'),
    );
    expect(night.map((o) => [o.key, iso(o.dueMs)])).toEqual([['2026-10-25', '2026-10-25T00:30Z']]);
  });
  it('New York daily keeps the local time across both changes', () => {
    const r = { freq: 'daily', at: '09:00', tz: NY } as const;
    expect(runs(r, '2026-03-07T00:00', 2).map((o) => o.utc)).toEqual([
      '2026-03-07T14:00Z',
      '2026-03-08T13:00Z',
    ]);
    expect(runs(r, '2026-10-31T00:00', 2).map((o) => o.utc)).toEqual([
      '2026-10-31T13:00Z',
      '2026-11-01T14:00Z',
    ]);
  });
  it('a key is the local date even when the UTC date differs', () => {
    // Tokyo 23:30 is 14:30Z; New York 20:00 is 01:00Z the next UTC day
    expect(
      runs({ freq: 'daily', at: '23:30', tz: 'Asia/Tokyo' }, '2026-11-01T00:00', 1)[0],
    ).toEqual({
      local: '2026-11-01 23:30',
      key: '2026-11-01',
      utc: '2026-11-01T14:30Z',
    });
    expect(runs({ freq: 'daily', at: '20:00', tz: NY }, '2026-11-01T12:00', 1)[0]).toEqual({
      local: '2026-11-01 20:00',
      key: '2026-11-01',
      utc: '2026-11-02T01:00Z',
    });
  });
  it('respects date (start) and until (inclusive)', () => {
    const r: ScheduleRule = { freq: 'daily', at: '09:00', date: '2026-11-10', until: '2026-11-12' };
    expect(dates(r, '2026-10-01', 10)).toEqual(['2026-11-10', '2026-11-11', '2026-11-12']);
  });
});

describe('weekly', () => {
  it('Fri 16:00 in New York keeps 16:00 local across its DST change', () => {
    expect(
      runs({ freq: 'weekly', at: '16:00', weekdays: [5], tz: NY }, '2026-10-20T00:00', 3),
    ).toEqual([
      { local: '2026-10-23 16:00', key: '2026-10-23', utc: '2026-10-23T20:00Z' },
      { local: '2026-10-30 16:00', key: '2026-10-30', utc: '2026-10-30T20:00Z' },
      { local: '2026-11-06 16:00', key: '2026-11-06', utc: '2026-11-06T21:00Z' },
    ]);
  });
  it('several weekdays, keyed per day', () => {
    expect(dates({ freq: 'weekly', at: '10:00', weekdays: [4, 1] }, '2026-11-02T11:00', 3)).toEqual(
      ['2026-11-05', '2026-11-09', '2026-11-12'],
    );
  });
  it('Lisbon Sunday 01:30 across the autumn change fires once that Sunday', () => {
    const list = occurrences(
      { freq: 'weekly', at: '01:30', weekdays: [7] },
      utc('2026-10-20'),
      utc('2026-11-02'),
    );
    expect(list.map((o) => [o.key, iso(o.dueMs)])).toEqual([
      ['2026-10-25', '2026-10-25T00:30Z'],
      ['2026-11-01', '2026-11-01T01:30Z'],
    ]);
  });
});

describe('monthly', () => {
  it('day 31 falls back to the month end (acceptance 1)', () => {
    expect(runs({ freq: 'monthly', at: '09:00', monthDay: 31 }, '2026-10-01', 5)).toEqual([
      { local: '2026-10-31 09:00', key: '2026-10', utc: '2026-10-31T09:00Z' },
      { local: '2026-11-30 09:00', key: '2026-11', utc: '2026-11-30T09:00Z' },
      { local: '2026-12-31 09:00', key: '2026-12', utc: '2026-12-31T09:00Z' },
      { local: '2027-01-31 09:00', key: '2027-01', utc: '2027-01-31T09:00Z' },
      { local: '2027-02-28 09:00', key: '2027-02', utc: '2027-02-28T09:00Z' },
    ]);
  });
  it('day 29 and 30 in February, common and leap years', () => {
    expect(dates({ freq: 'monthly', at: '09:00', monthDay: 29 }, '2027-02-01', 2)).toEqual([
      '2027-02-28',
      '2027-03-29',
    ]);
    expect(dates({ freq: 'monthly', at: '09:00', monthDay: 29 }, '2028-02-01', 1)).toEqual([
      '2028-02-29',
    ]);
    expect(dates({ freq: 'monthly', at: '09:00', monthDay: 30 }, '2028-02-01', 1)).toEqual([
      '2028-02-29',
    ]);
    expect(dates({ freq: 'monthly', at: '09:00', monthDay: -1 }, '2100-02-01', 1)).toEqual([
      '2100-02-28',
    ]); // not a leap year
    expect(dates({ freq: 'monthly', at: '09:00', monthDay: -1 }, '2000-02-01', 1)).toEqual([
      '2000-02-29',
    ]);
  });
  it('last day (-1)', () => {
    expect(dates({ freq: 'monthly', at: '17:00', monthDay: -1 }, '2026-04-01', 3)).toEqual([
      '2026-04-30',
      '2026-05-31',
      '2026-06-30',
    ]);
  });
  it('weekend after: Sun 1 Nov 2026 → Mon 2 Nov, key stays 2026-11', () => {
    const r: ScheduleRule = { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'after' };
    expect(runs(r, '2026-10-15', 2)).toEqual([
      { local: '2026-11-02 09:00', key: '2026-11', utc: '2026-11-02T09:00Z' },
      { local: '2026-12-01 09:00', key: '2026-12', utc: '2026-12-01T09:00Z' },
    ]);
  });
  it('weekend before: Sun 1 Nov 2026 → Fri 30 Oct, key stays 2026-11', () => {
    const r: ScheduleRule = { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'before' };
    expect(runs(r, '2026-10-02', 2)).toEqual([
      { local: '2026-10-30 09:00', key: '2026-11', utc: '2026-10-30T09:00Z' },
      { local: '2026-12-01 09:00', key: '2026-12', utc: '2026-12-01T09:00Z' },
    ]);
    // Sat 1 Aug 2026 → Fri 31 Jul
    expect(runs(r, '2026-07-02', 1)[0]).toMatchObject({
      local: '2026-07-31 09:00',
      key: '2026-08',
    });
  });
  it('weekend after across a month end: last day Sun 31 Jan 2027 → Mon 1 Feb, then Sun 28 Feb → Mon 1 Mar', () => {
    const r: ScheduleRule = { freq: 'monthly', at: '09:00', monthDay: -1, weekend: 'after' };
    expect(runs(r, '2027-01-15', 3).map((o) => [o.local, o.key])).toEqual([
      ['2027-02-01 09:00', '2027-01'],
      ['2027-03-01 09:00', '2027-02'],
      ['2027-03-31 09:00', '2027-03'],
    ]);
  });
  it('a shifted run that falls before `from` is found from the previous month', () => {
    // From 1 Nov 2026 00:00 (Sun): the Oct period's 31 Oct is a Saturday → Mon 2 Nov.
    const r: ScheduleRule = { freq: 'monthly', at: '09:00', monthDay: 31, weekend: 'after' };
    expect(runs(r, '2026-11-01T00:00', 1)[0]).toMatchObject({
      local: '2026-11-02 09:00',
      key: '2026-10',
    });
  });
  it('until compares with the actual run day', () => {
    const r: ScheduleRule = { freq: 'monthly', at: '09:00', monthDay: 1, until: '2027-01-01' };
    expect(dates(r, '2026-10-15', 10)).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
  });
});

describe('quarterly', () => {
  it('anchor Jan, day 1 (acceptance 1)', () => {
    expect(
      full({ freq: 'quarterly', at: '09:00', monthDay: 1, month: 1 }, '2026-12-15', 4).map((o) => [
        o.date,
        o.key,
      ]),
    ).toEqual([
      ['2027-01-01', '2027-Q1'],
      ['2027-04-01', '2027-Q2'],
      ['2027-07-01', '2027-Q3'],
      ['2027-10-01', '2027-Q4'],
    ]);
  });
  it('anchor Jan, day 31 → 31 Jan, 30 Apr, 31 Jul, 31 Oct', () => {
    expect(dates({ freq: 'quarterly', at: '09:00', monthDay: 31 }, '2027-01-01', 4)).toEqual([
      '2027-01-31',
      '2027-04-30',
      '2027-07-31',
      '2027-10-31',
    ]);
  });
  it('anchor Feb, last day, one key per calendar quarter', () => {
    expect(
      full({ freq: 'quarterly', at: '17:00', monthDay: -1, month: 2 }, '2028-01-01', 5).map((o) => [
        o.date,
        o.key,
      ]),
    ).toEqual([
      ['2028-02-29', '2028-Q1'],
      ['2028-05-31', '2028-Q2'],
      ['2028-08-31', '2028-Q3'],
      ['2028-11-30', '2028-Q4'],
      ['2029-02-28', '2029-Q1'],
    ]);
  });
  it('anchor Nov is the same cycle as Feb, May, Aug', () => {
    expect(
      dates({ freq: 'quarterly', at: '09:00', monthDay: 15, month: 11 }, '2026-01-01', 4),
    ).toEqual(['2026-02-15', '2026-05-15', '2026-08-15', '2026-11-15']);
  });
  it('quarter boundary: the run just before and just after midnight of a new quarter', () => {
    const r: ScheduleRule = { freq: 'quarterly', at: '23:59', monthDay: -1, month: 3 };
    const [q] = runs(r, '2026-12-31T00:00', 1);
    expect(q).toEqual({ local: '2026-12-31 23:59', key: '2026-Q4', utc: '2026-12-31T23:59Z' });
    expect(first(r, utc('2027-01-01T00:00')).key).toBe('2027-Q1');
  });
  it('weekend shift keeps the quarter key across a year end', () => {
    // Fri 1 Jan 2027 stays; Sat 1 Jan 2028 'before' → Fri 31 Dec 2027 but key 2028-Q1.
    const r: ScheduleRule = { freq: 'quarterly', at: '09:00', monthDay: 1, weekend: 'before' };
    expect(full(r, '2027-10-02', 1)[0]).toMatchObject({
      date: '2027-12-31',
      local: '2027-12-31 09:00',
      key: '2028-Q1',
    });
  });
});

describe('yearly', () => {
  it('29 Feb → 28 Feb 2027, 29 Feb 2028 (acceptance 1)', () => {
    expect(
      full({ freq: 'yearly', at: '09:00', month: 2, monthDay: 29 }, '2026-10-30', 3).map((o) => [
        o.date,
        o.key,
      ]),
    ).toEqual([
      ['2027-02-28', '2027'],
      ['2028-02-29', '2028'],
      ['2029-02-28', '2029'],
    ]);
  });
  it('2 Mar 09:00 → next Tue 2 Mar 2027', () => {
    const r: ScheduleRule = { freq: 'yearly', at: '09:00', month: 3, monthDay: 2 };
    const o = first(r, utc('2026-10-30T12:00'));
    expect(occurrenceWords(o)).toBe('Tue 2 Mar 2027 09:00');
    expect(o.key).toBe('2027');
  });
  it('weekend after on a yearly date', () => {
    // 2 Jan 2027 is a Saturday → Mon 4 Jan
    expect(
      runs(
        { freq: 'yearly', at: '09:00', month: 1, monthDay: 2, weekend: 'after' },
        '2026-12-01',
        1,
      )[0],
    ).toMatchObject({
      local: '2027-01-04 09:00',
      key: '2027',
    });
  });
  it('last day of December, before midnight New York', () => {
    expect(
      runs({ freq: 'yearly', at: '23:00', month: 12, monthDay: -1, tz: NY }, '2026-06-01', 1)[0],
    ).toEqual({
      local: '2026-12-31 23:00',
      key: '2026',
      utc: '2027-01-01T04:00Z',
    });
  });
});

describe('runKey stability', () => {
  it('editing the time keeps the period keys', () => {
    const morning = nextRuns({ freq: 'daily', at: '09:00' }, utc('2026-11-01'), 5).map(
      (o) => o.key,
    );
    const evening = nextRuns({ freq: 'daily', at: '18:00' }, utc('2026-11-01'), 5).map(
      (o) => o.key,
    );
    expect(evening).toEqual(morning);
    const m9 = nextRuns({ freq: 'monthly', at: '09:00', monthDay: 1 }, utc('2026-11-01'), 3).map(
      (o) => o.key,
    );
    const m17 = nextRuns({ freq: 'monthly', at: '17:30', monthDay: 15 }, utc('2026-11-01'), 3).map(
      (o) => o.key,
    );
    expect(m17).toEqual(m9);
  });
  it("moving today's time later after today's run fired gives the same key: no second run", () => {
    const fired = first({ freq: 'daily', at: '09:00' }, utc('2026-11-03T00:00'));
    const edited = occurrences(
      { freq: 'daily', at: '15:00' },
      utc('2026-11-03T10:00'),
      utc('2026-11-03T23:59'),
    )[0];
    expect(edited?.key).toBe(fired.key);
  });
  it('runKey matches the occurrence key for every frequency', () => {
    const rules: ScheduleRule[] = [
      { freq: 'once', at: '09:00', date: '2026-12-01' },
      { freq: 'daily', at: '09:00' },
      { freq: 'weekly', at: '09:00', weekdays: [3] },
      { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'before' },
      { freq: 'quarterly', at: '09:00', monthDay: 1, month: 3 },
      { freq: 'yearly', at: '09:00', monthDay: 1, month: 6 },
    ];
    for (const r of rules) {
      for (const o of nextRuns(r, utc('2026-11-01'), 4)) expect(runKey(r, o)).toBe(o.key);
    }
  });
});

describe('nextDue and dueNow (the scheduler)', () => {
  const daily: ScheduleRule = { freq: 'daily', at: '09:00' };
  it('approving at 09:30 a daily 09:00 first runs tomorrow', () => {
    const now = utc('2026-11-03T09:30');
    expect(nextDue({ rule: daily, activeFromMs: now }, now)?.key).toBe('2026-11-04');
    expect(dueNow({ rule: daily, activeFromMs: now }, now)).toEqual([]);
  });
  it('is due exactly at dueMs and after; the next once lastDueMs is set', () => {
    const due = utc('2026-11-04T09:00');
    const s = { rule: daily, activeFromMs: utc('2026-11-03T09:30') };
    expect(dueNow(s, due - 1)).toEqual([]);
    expect(dueNow(s, due).map((o) => o.key)).toEqual(['2026-11-04']);
    expect(nextDue({ ...s, lastDueMs: due }, due)?.key).toBe('2026-11-05');
  });
  it('lists every missed run after downtime, oldest first, within the window', () => {
    const s = {
      rule: daily,
      activeFromMs: utc('2026-11-01T00:00'),
      lastDueMs: utc('2026-11-01T09:00'),
    };
    expect(dueNow(s, utc('2026-11-04T11:40')).map((o) => o.key)).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
    ]);
    const long = dueNow({ rule: daily, activeFromMs: 0 }, utc('2026-11-04T11:40'));
    expect(long[0]!.dueMs).toBeGreaterThanOrEqual(utc('2026-11-04T11:40') - CATCH_UP_WINDOW_MS);
    expect(long).toHaveLength(35);
  });
  it('a past one-off has nothing left', () => {
    const r: ScheduleRule = { freq: 'once', at: '10:00', date: '2026-11-12' };
    expect(
      nextDue({ rule: r, lastDueMs: utc('2026-11-12T10:00') }, utc('2026-11-12T10:00')),
    ).toBeNull();
  });
  it('the DST overlap night is due once', () => {
    const s = {
      rule: { freq: 'daily', at: '01:30' } as ScheduleRule,
      lastDueMs: utc('2026-10-25T00:30'),
    };
    expect(dueNow(s, utc('2026-10-25T01:45'))).toEqual([]);
    expect(nextDue(s, utc('2026-10-25T01:45'))?.key).toBe('2026-10-26');
  });
});

describe('words', () => {
  const cases: [ScheduleRule, string][] = [
    [{ freq: 'monthly', at: '09:00', monthDay: 1 }, 'Monthly · day 1 · 09:00'],
    [
      { freq: 'monthly', at: '09:00', monthDay: -1, weekend: 'before' },
      'Monthly · last day · 09:00 · Fri if weekend',
    ],
    [
      { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'after', until: '2027-06-30' },
      'Monthly · day 1 · 09:00 · Mon if weekend · until 30 Jun 2027',
    ],
    [{ freq: 'weekly', at: '16:00', weekdays: [5] }, 'Weekly · Fri · 16:00'],
    [{ freq: 'weekly', at: '16:00', weekdays: [5], tz: NY }, 'Weekly · Fri · 16:00 New York'],
    [{ freq: 'weekly', at: '10:00', weekdays: [4, 1] }, 'Weekly · Mon, Thu · 10:00'],
    [{ freq: 'daily', at: '08:30' }, 'Daily · 08:30'],
    [{ freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5, 6, 7] }, 'Daily · 08:30'],
    [{ freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 4, 5] }, 'Daily · Mon–Fri · 08:30'],
    [{ freq: 'daily', at: '08:30', weekdays: [1, 2, 3, 6] }, 'Daily · Mon–Wed, Sat · 08:30'],
    [{ freq: 'yearly', at: '09:00', month: 3, monthDay: 2 }, 'Yearly · 2 Mar · 09:00'],
    [{ freq: 'yearly', at: '09:00', month: 2, monthDay: -1 }, 'Yearly · last day of Feb · 09:00'],
    [
      { freq: 'quarterly', at: '17:00', monthDay: -1 },
      'Quarterly · last day · 17:00 (Jan, Apr, Jul, Oct)',
    ],
    [
      { freq: 'quarterly', at: '17:00', monthDay: 1, month: 11 },
      'Quarterly · day 1 · 17:00 (Feb, May, Aug, Nov)',
    ],
    [{ freq: 'once', at: '10:00', date: '2026-11-12' }, 'Once · Thu 12 Nov 2026 · 10:00'],
  ];
  it.each(cases)('%j → %s', (rule, sentence) => expect(ruleSentence(rule)).toBe(sentence));
  it('shows the zone when it differs from the viewer', () => {
    expect(ruleSentence({ freq: 'daily', at: '09:00' }, { viewerTz: NY })).toBe(
      'Daily · 09:00 Lisbon',
    );
    expect(ruleSentence({ freq: 'daily', at: '09:00', tz: NY }, { viewerTz: NY })).toBe(
      'Daily · 09:00',
    );
  });
  it('urgency by rarity', () => {
    expect(
      ['once', 'yearly', 'quarterly', 'monthly', 'weekly', 'daily'].map((f) =>
        urgencyOf(f as never),
      ),
    ).toEqual(['urgent', 'urgent', 'high', 'high', 'normal', 'low']);
  });
  it('fills placeholders per period', () => {
    const m = first(
      { freq: 'monthly', at: '09:00', monthDay: 1, weekend: 'before' },
      utc('2026-10-02'),
    );
    expect(
      fillPlaceholders(
        'Send invoices · {month} {year} · {period} · {quarter} · {date} · {nope}',
        m,
      ),
    ).toBe('Send invoices · Nov 2026 · Nov 2026 · Q4 · 30 Oct 2026 · {nope}');
    const d = first({ freq: 'daily', at: '09:00' }, utc('2026-11-06'));
    expect(fillPlaceholders('Timesheet {period}', d)).toBe('Timesheet 6 Nov 2026');
    const y = first({ freq: 'yearly', at: '09:00', month: 3, monthDay: 2 }, utc('2026-11-06'));
    expect(fillPlaceholders('Renewal {year} ({period})', y)).toBe('Renewal 2027 (2027)');
    // anchor Jan: 31 Oct 2026 has passed, so the next is 31 Jan 2027
    const q = first({ freq: 'quarterly', at: '09:00', monthDay: -1 }, utc('2026-11-06'));
    expect(fillPlaceholders('VAT {quarter} {year}', q)).toBe('VAT Q1 2027');
  });
});

describe('cost', () => {
  it('a year of daily runs computes quickly', () => {
    const t = performance.now();
    expect(nextRuns({ freq: 'daily', at: '09:00' }, utc('2026-01-01'), 365)).toHaveLength(365);
    expect(performance.now() - t).toBeLessThan(500);
  });
  it('a rule with no runs left stops (until passed)', () => {
    expect(
      nextRun({ freq: 'daily', at: '09:00', until: '2026-01-01' }, utc('2026-06-01')),
    ).toBeNull();
  });
});
