import { describe, expect, it } from 'vitest';
import {
  afterQuiet,
  digestNotice,
  laterChoices,
  localClock,
  localDate,
  memberTz,
  nextAskAt,
  nextDigestAt,
  nextLocalTime,
  parseLaterTime,
  runAskNotice,
  schedulerDown,
  SCHEDULER_BEAT_MS,
  SCHEDULER_DOWN_MS,
  whyText,
} from './scheduleAsk';

const L = 'Europe/Lisbon';
const H = 3_600_000;
const M = 60_000;
// Fri 30 Oct 2026 10:00 Lisbon (UTC+0 since 25 Oct).
const NOW = Date.UTC(2026, 9, 30, 10, 0);
const quietOff = { enabled: false, from: '22:00', to: '08:00', tz: L };
const quiet = { enabled: true, from: '22:00', to: '08:00', tz: L };

describe('scheduler beat', () => {
  it('beats every 15 minutes and is down after about 35', () => {
    expect(SCHEDULER_BEAT_MS).toBe(15 * M);
    expect(SCHEDULER_DOWN_MS).toBe(35 * M);
    expect(schedulerDown(NOW - 15 * M, NOW)).toBe(false);
    expect(schedulerDown(NOW - 34 * M, NOW)).toBe(false);
    expect(schedulerDown(NOW - 36 * M, NOW)).toBe(true);
    expect(schedulerDown(null, NOW)).toBe(true);
  });
});

describe('local times', () => {
  it('finds the next wall time, across a DST change', () => {
    expect(nextLocalTime(NOW, L, '09:00')).toBe(Date.UTC(2026, 9, 31, 9, 0));
    expect(nextLocalTime(NOW, L, '11:00')).toBe(Date.UTC(2026, 9, 30, 11, 0));
    // Sat 24 Oct 12:00 Lisbon (UTC+1) → Sun 25 Oct 09:00 (UTC+0 after the change).
    expect(nextLocalTime(Date.UTC(2026, 9, 24, 11), L, '09:00')).toBe(Date.UTC(2026, 9, 25, 9));
    expect(localDate(NOW, L)).toBe('2026-10-30');
    expect(localClock(NOW, 'America/New_York')).toBe('06:00');
  });

  it('moves a time in quiet hours to their end', () => {
    expect(afterQuiet(quietOff, Date.UTC(2026, 9, 30, 23))).toBe(Date.UTC(2026, 9, 30, 23));
    expect(afterQuiet(quiet, NOW)).toBe(NOW);
    expect(afterQuiet(quiet, Date.UTC(2026, 9, 30, 23))).toBe(Date.UTC(2026, 9, 31, 8));
    expect(afterQuiet(quiet, Date.UTC(2026, 9, 31, 3))).toBe(Date.UTC(2026, 9, 31, 8));
  });

  it('sends the digest at the end of quiet hours, else 08:30', () => {
    expect(nextDigestAt({ quiet }, L, NOW)).toBe(Date.UTC(2026, 9, 31, 8, 0));
    expect(nextDigestAt({ quiet: quietOff }, L, NOW)).toBe(Date.UTC(2026, 9, 31, 8, 30));
    expect(nextDigestAt({ quiet: quietOff }, L, Date.UTC(2026, 9, 30, 7))).toBe(
      Date.UTC(2026, 9, 30, 8, 30),
    );
  });

  it('reads the member zone from quiet hours unless it is the UTC default', () => {
    expect(memberTz({ quiet: { ...quiet, tz: 'America/New_York' } })).toBe('America/New_York');
    expect(memberTz({ quiet: { ...quiet, tz: 'UTC' } })).toBe(L);
    expect(memberTz(null, 'Asia/Tokyo')).toBe('Asia/Tokyo');
  });
});

describe('the urgency ladder', () => {
  it('urgent: at once through quiet hours, then every 2 h outside them', () => {
    const night = Date.UTC(2026, 9, 30, 23);
    expect(nextAskAt('urgent', null, night, quiet, L)).toEqual({ atMs: night, breaksQuiet: true });
    expect(nextAskAt('urgent', { n: 1, lastAtMs: NOW }, NOW, quiet, L)).toEqual({
      atMs: NOW + 2 * H,
      breaksQuiet: false,
    });
    // A repeat that would fall in quiet hours waits for their end.
    expect(nextAskAt('urgent', { n: 1, lastAtMs: night }, night, quiet, L)!.atMs).toBe(
      Date.UTC(2026, 9, 31, 8),
    );
  });

  it('high: at once (quiet respected), after 4 h, then daily at 09:00', () => {
    expect(nextAskAt('high', null, NOW, quiet, L)).toEqual({ atMs: NOW, breaksQuiet: false });
    expect(nextAskAt('high', null, Date.UTC(2026, 9, 30, 23), quiet, L)!.atMs).toBe(
      Date.UTC(2026, 9, 31, 8),
    );
    expect(nextAskAt('high', { n: 1, lastAtMs: NOW }, NOW, quiet, L)!.atMs).toBe(NOW + 4 * H);
    expect(nextAskAt('high', { n: 2, lastAtMs: NOW + 4 * H }, NOW, quiet, L)!.atMs).toBe(
      Date.UTC(2026, 9, 31, 9),
    );
  });

  it('normal: once; low: the digest decides', () => {
    expect(nextAskAt('normal', null, NOW, quietOff, L)).toEqual({ atMs: NOW, breaksQuiet: false });
    expect(nextAskAt('normal', { n: 1, lastAtMs: NOW }, NOW, quietOff, L)).toBeNull();
    expect(nextAskAt('low', null, NOW, quietOff, L)).toBeNull();
  });
});

describe('words', () => {
  it('says why for every cause', () => {
    expect(
      whyText({ code: 'offline', agent: 'Hive', lastSeenMs: Date.UTC(2026, 9, 30, 8, 12), tz: L }),
    ).toBe('Hive was offline (last seen 08:12).');
    expect(whyText({ code: 'offline', agent: 'Hive', lastSeenMs: null, tz: L })).toContain('never');
    expect(whyText({ code: 'off', sinceMs: Date.UTC(2026, 9, 30, 14, 2), tz: L })).toBe(
      'Agents are Off since 14:02: nothing automated runs until you turn them on.',
    );
    expect(whyText({ code: 'paused', agent: 'Hive', reason: '3 failed runs' })).toBe(
      'Hive is paused (3 failed runs).',
    );
    expect(whyText({ code: 'paused', agent: 'Hive', removed: true })).toContain('removed');
    expect(
      whyText({
        code: 'hostDown',
        fromMs: Date.UTC(2026, 9, 30, 2, 10),
        toMs: Date.UTC(2026, 9, 30, 11, 40),
        tz: L,
        more: 4,
      }),
    ).toBe(
      'Hivenod’s scheduler was down from 02:10 to 11:40. And 4 earlier runs of it were missed.',
    );
    expect(whyText({ code: 'noStart', agent: 'Hive' })).toBe(
      'Hive did not start it within 30 minutes.',
    );
    expect(whyText({ code: 'failed', agent: 'Hive', error: 'no  access\nto the portal' })).toBe(
      'Hive could not do it: no access to the portal',
    );
    expect(whyText({ code: 'cliOld', agent: 'Hive', version: '0.2.100' })).toContain('0.2.100');
    expect(whyText({ code: 'failed', agent: 'Hive', error: 'x'.repeat(400) }).length).toBe(300);
  });

  it('writes the urgent ask clearly: what, when, why, skip, repeat', () => {
    const n = runAskNotice({
      level: 'urgent',
      freq: 'yearly',
      title: 'Renew the domain',
      sentence: 'Yearly · 2 Mar · 09:00',
      dueMs: Date.UTC(2027, 2, 2, 9),
      tz: L,
      why: 'Hive was offline (last seen 08:12).',
      nextMs: Date.UTC(2028, 2, 2, 9),
      nowMs: Date.UTC(2027, 2, 2, 9, 20),
      n: 0,
      url: '/x',
    });
    expect(n.title).toBe("URGENT · Yearly run didn't happen");
    expect(n.body).toBe(
      [
        'Renew the domain (Yearly · 2 Mar · 09:00) did not run today at 09:00.',
        'Why: Hive was offline (last seen 08:12).',
        'If skipped, the next run is 2 Mar 2028.',
        'I’ll remind you every 2 hours until you decide.',
      ].join('\n'),
    );
    const later = runAskNotice({
      level: 'high',
      freq: 'monthly',
      title: 'Send invoices',
      sentence: 'Monthly · day 1 · 09:00',
      dueMs: Date.UTC(2026, 10, 1, 9),
      tz: L,
      why: 'x',
      nextMs: null,
      nowMs: Date.UTC(2026, 10, 2, 9),
      n: 1,
      url: '/',
    });
    expect(later.title).toBe("Important · Monthly run didn't happen (reminder)");
    expect(later.body).toContain('did not run on Sun 1 Nov at 09:00');
    expect(later.body).toContain('one-off');
    expect(later.body).toContain('4 hours');
  });

  it('writes the daily digest', () => {
    const d = digestNotice({
      dateMs: Date.UTC(2026, 9, 30, 8, 30),
      tz: L,
      missed: [{ title: 'Inbox clean-up', sentence: 'Daily · 08:00', why: 'Hive was offline.' }],
      coming: [
        { atMs: Date.UTC(2026, 9, 30, 9), title: 'Send invoices' },
        { atMs: Date.UTC(2026, 9, 30, 16), title: 'Timesheet' },
      ],
    });
    expect(d.title).toBe('Daily digest · Fri 30 Oct');
    expect(d.body).toBe(
      "Couldn't run: Inbox clean-up (Daily · 08:00): Hive was offline.\nComing up today: 09:00 Send invoices · 16:00 Timesheet",
    );
  });
});

describe('Try later', () => {
  it('offers in 1 hour and tomorrow 09:00', () => {
    expect(laterChoices(NOW, L)).toEqual({
      inHourMs: NOW + H,
      tomorrowMs: Date.UTC(2026, 9, 31, 9),
    });
    // At 07:00 "tomorrow" is still the next day, not today's 09:00.
    expect(laterChoices(Date.UTC(2026, 9, 30, 7), L).tomorrowMs).toBe(Date.UTC(2026, 9, 31, 9));
  });

  it('reads typed times in the member zone', () => {
    const ok = (t: string) => {
      const r = parseLaterTime(t, NOW, L);
      if (!r.ok) throw new Error(r.error);
      return r.atMs;
    };
    expect(ok('14:30')).toBe(Date.UTC(2026, 9, 30, 14, 30));
    expect(ok('09:00')).toBe(Date.UTC(2026, 9, 31, 9)); // passed today: tomorrow
    expect(ok('tomorrow 10:00')).toBe(Date.UTC(2026, 9, 31, 10));
    expect(ok('Tomorrow at 7')).toBe(Date.UTC(2026, 9, 31, 7));
    expect(ok('3 Nov 9:00')).toBe(Date.UTC(2026, 10, 3, 9));
    expect(ok('2026-11-03 09:15')).toBe(Date.UTC(2026, 10, 3, 9, 15));
    expect(parseLaterTime('today 09:00', NOW, L)).toMatchObject({
      ok: false,
      error: expect.stringContaining('passed'),
    });
    expect(parseLaterTime('soon', NOW, L)).toMatchObject({ ok: false });
    expect(parseLaterTime('25:00', NOW, L)).toMatchObject({ ok: false });
    expect(parseLaterTime('2027-06-01 09:00', NOW, L)).toMatchObject({
      ok: false,
      error: expect.stringContaining('35'),
    });
  });
});
