import { describe, expect, it } from 'vitest';
import {
  addDays,
  cantRunCards,
  comingUp,
  dayHead,
  isoWeekday,
  listRows,
  monthTitle,
  nextN,
  rangeMs,
  runWords,
  schedulerBanner,
  shiftAnchor,
  timeline,
  viewDays,
  weekStart,
  weekTitle,
  whenWords,
  type RunLite,
  type SchedLite,
} from './logic';

const TZ = 'Europe/Lisbon';
// Fri 30 Oct 2026 11:20 in Lisbon (winter time: UTC+0), as in the mockup.
const NOW = Date.UTC(2026, 9, 30, 11, 20);
const H = 3_600_000;

const sched = (id: string, over: Partial<SchedLite> = {}): SchedLite => ({
  wid: 'w1',
  id,
  title: id,
  what: `Do ${id}`,
  agentUid: 'a1',
  rule: { freq: 'daily', at: '08:00', tz: TZ },
  runTitle: `${id} · {period}`,
  steps: [{ type: 'approval', fields: { what: 'Send {period}' } }],
  state: 'active',
  activeFromMs: Date.UTC(2026, 0, 1),
  subjectId: null,
  replaces: null,
  ...over,
});
const run = (sid: string, key: string, dueMs: number, over: Partial<RunLite> = {}): RunLite => ({
  wid: 'w1',
  id: `${sid}_${key}`,
  scheduleId: sid,
  key,
  period: key,
  dueMs,
  title: `${sid} · ${key}`,
  state: 'done',
  why: null,
  threadId: `t-${sid}-${key}`,
  laterAtMs: null,
  decision: null,
  ...over,
});

const invoices = sched('Send invoices', {
  rule: { freq: 'monthly', at: '09:00', tz: TZ, monthDay: 1 },
  runTitle: 'Send invoices · {month} {year}',
});
const timesheet = sched('Timesheet', {
  agentUid: 'a2',
  rule: { freq: 'weekly', at: '16:00', tz: TZ, weekdays: [5] },
});
const tidy = sched('Inbox tidy-up', {
  rule: { freq: 'daily', at: '08:00', tz: TZ, weekdays: [1, 2, 3, 4, 5] },
});
const domain = sched('Renew the domain', {
  rule: { freq: 'yearly', at: '09:00', tz: TZ, month: 3, monthDay: 2 },
});
const newsletter = sched('Newsletter draft', {
  state: 'paused',
  rule: { freq: 'monthly', at: '10:00', tz: TZ, monthDay: 25 },
});

describe('dates', () => {
  it('weeks start on Monday', () => {
    expect(isoWeekday('2026-10-30')).toBe(5);
    expect(isoWeekday('2026-11-01')).toBe(7);
    expect(weekStart('2026-10-30')).toBe('2026-10-26');
    expect(weekStart('2026-10-26')).toBe('2026-10-26');
    expect(weekStart('2026-11-01')).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
  it('a week view is Mon–Sun, a month view covers whole weeks of the month', () => {
    expect(viewDays('week', '2026-10-30')).toEqual([
      '2026-10-26',
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
    ]);
    const m = viewDays('month', '2026-10-30');
    expect(m[0]).toBe('2026-09-28');
    expect(m[m.length - 1]).toBe('2026-11-01');
    expect(m.length % 7).toBe(0);
  });
  it('moves by a week or a month', () => {
    expect(shiftAnchor('week', '2026-10-30', 1)).toBe('2026-11-06');
    expect(shiftAnchor('month', '2026-12-15', 1)).toBe('2027-01-01');
    expect(shiftAnchor('month', '2026-01-15', -1)).toBe('2025-12-01');
  });
  it('titles', () => {
    expect(weekTitle('2026-10-26')).toBe('Week of 26 Oct – 1 Nov 2026');
    expect(weekTitle('2026-12-28')).toBe('Week of 28 Dec 2026 – 3 Jan 2027');
    expect(monthTitle('2026-10-30')).toBe('October 2026');
    expect(dayHead('2026-11-01')).toBe('Sun 1');
    expect(dayHead('2026-11-01', true)).toBe('Sun 1 Nov');
  });
  it('a range of local days in a zone', () => {
    // Lisbon is UTC+1 in summer: the day starts at 23:00 UTC the day before.
    expect(rangeMs('2026-06-15', '2026-06-15', TZ)).toEqual({
      fromMs: Date.UTC(2026, 5, 14, 23),
      toMs: Date.UTC(2026, 5, 15, 23),
    });
  });
  it('when, in words', () => {
    expect(whenWords('2026-10-30 16:00', NOW, TZ)).toBe('Today 16:00');
    expect(whenWords('2026-10-31 09:00', NOW, TZ)).toBe('Tomorrow 09:00');
    expect(whenWords('2026-11-01 09:00', NOW, TZ)).toBe('Sun 1 Nov 09:00');
    expect(whenWords('2027-03-02 09:00', NOW, TZ)).toBe('Tue 2 Mar 2027 09:00');
  });
});

describe('timeline', () => {
  const days = viewDays('week', '2026-10-30');
  const runs = [
    run('Inbox tidy-up', '2026-10-26', Date.UTC(2026, 9, 26, 8)),
    run('Inbox tidy-up', '2026-10-28', Date.UTC(2026, 9, 28, 8), { state: 'expired' }),
    run('Inbox tidy-up', '2026-10-30', Date.UTC(2026, 9, 30, 8)),
    run('Timesheet', '2026-W43', Date.UTC(2026, 9, 23, 15), { state: 'done' }),
  ];
  const t = timeline([invoices, timesheet, tidy, domain, newsletter], runs, days, NOW, TZ);

  it('shows stored runs with their result and the planned ones from now on', () => {
    expect(t.get('2026-10-26')!.map((c) => [c.title, c.time, c.state])).toEqual([
      ['Inbox tidy-up', '08:00', 'done'],
    ]);
    expect(t.get('2026-10-28')!.map((c) => c.state)).toEqual(['expired']);
    // Today: the morning run is done; the timesheet at 16:00 is still to come.
    expect(t.get('2026-10-30')!.map((c) => [c.title, c.time, c.state])).toEqual([
      ['Inbox tidy-up', '08:00', 'done'],
      ['Timesheet', '16:00', 'planned'],
    ]);
    expect(t.get('2026-11-01')!.map((c) => [c.title, c.time, c.state, c.freq])).toEqual([
      ['Send invoices', '09:00', 'planned', 'monthly'],
    ]);
  });
  it('never plans a past run without a stored one, nor a paused schedule', () => {
    // Tue 27 had no stored tidy-up run: nothing is invented in the past.
    expect(t.get('2026-10-27')).toEqual([]);
    expect([...t.values()].flat().some((c) => c.title === 'Newsletter draft')).toBe(false);
  });
  it('a stored run replaces the planned one of its period', () => {
    const fired = run('Timesheet', '2026-W44', Date.UTC(2026, 9, 30, 16), { state: 'running' });
    const t2 = timeline([timesheet], [fired], days, NOW + 5 * H, TZ);
    expect(t2.get('2026-10-30')!.map((c) => c.state)).toEqual(['running']);
  });
  it('a month shows every planned run of the weeks it covers', () => {
    const m = timeline([tidy], [], viewDays('month', '2026-11-15'), NOW, TZ);
    const n = [...m.values()].flat().length;
    // Weekdays from Mon 2 Nov to Sun 6 Dec (5 weeks).
    expect(n).toBe(25);
  });
  it('does not plan before the schedule became active', () => {
    const fresh = sched('New', { activeFromMs: Date.UTC(2026, 9, 31, 12) });
    const t3 = timeline([fresh], [], days, NOW, TZ);
    expect(t3.get('2026-10-31')).toEqual([]);
    expect(t3.get('2026-11-01')!.length).toBe(1);
  });
});

describe('the list', () => {
  const runs = [
    run('Send invoices', '2026-10', Date.UTC(2026, 9, 1, 9)),
    run('Newsletter draft', '2026-09', Date.UTC(2026, 8, 25, 9), { state: 'skipped' }),
    run('Inbox tidy-up', '2026-10-29', Date.UTC(2026, 9, 29, 8)),
    run('Inbox tidy-up', '2026-10-30', Date.UTC(2026, 9, 30, 8)),
  ];
  const rows = listRows([newsletter, invoices, domain, timesheet, tidy], runs, NOW, TZ);
  it('sorts by next run, paused at the bottom', () => {
    expect(rows.map((r) => r.s.title)).toEqual([
      'Timesheet',
      'Send invoices',
      'Inbox tidy-up',
      'Renew the domain',
      'Newsletter draft',
    ]);
  });
  it('says the rule, the next run and the last run', () => {
    const inv = rows.find((r) => r.s.title === 'Send invoices')!;
    expect(inv.sentence).toBe('Monthly · day 1 · 09:00');
    expect(inv.next?.words).toBe('Sun 1 Nov 09:00');
    expect(inv.last?.day).toBe('1 Oct');
    expect(inv.last?.words.word).toBe('done');
    expect(rows.find((r) => r.s.title === 'Timesheet')!.next?.words).toBe('Today 16:00');
    expect(rows.find((r) => r.s.title === 'Inbox tidy-up')!.last?.day).toBe('30 Oct');
    expect(rows.find((r) => r.s.title === 'Renew the domain')!.next?.words).toBe(
      'Tue 2 Mar 2027 09:00',
    );
    const nl = rows.find((r) => r.s.title === 'Newsletter draft')!;
    expect(nl.next).toBeNull();
    expect(nl.last?.words.word).toBe('skipped');
  });
  it('hides proposals and proposed changes', () => {
    const p = sched('Proposed', { state: 'proposed', activeFromMs: null });
    expect(listRows([p], [], NOW, TZ)).toEqual([]);
  });
  it('the next runs of the detail', () => {
    expect(nextN(invoices, NOW, 3).map((o) => o.local)).toEqual([
      '2026-11-01 09:00',
      '2026-12-01 09:00',
      '2027-01-01 09:00',
    ]);
    expect(nextN(newsletter, NOW, 3)).toEqual([]);
  });
});

describe('Today: coming up', () => {
  it('lists the runs still to come today and tomorrow, in order', () => {
    const vat = sched('VAT prep', { rule: { freq: 'daily', at: '17:00', tz: TZ } });
    const c = comingUp([invoices, timesheet, tidy, vat], NOW, TZ);
    expect(c.map((r) => r.words)).toEqual(['Today 16:00', 'Today 17:00', 'Tomorrow 17:00']);
    expect(c[0]!.title).toBe('Timesheet · 30 Oct 2026');
    expect(c[0]!.today).toBe(true);
    expect(c[2]!.today).toBe(false);
  });
  it('caps the strip', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      sched(`s${i}`, { rule: { freq: 'daily', at: '20:00', tz: TZ } }),
    );
    expect(comingUp(many, NOW, TZ, 6)).toHaveLength(6);
  });
});

describe("can't run", () => {
  const retainer = sched('Pay supplier retainer', {
    rule: { freq: 'monthly', at: '10:00', tz: TZ, monthDay: 28 },
  });
  const runs = [
    run('Timesheet', '2026-W44', Date.UTC(2026, 9, 30, 16), {
      title: 'Timesheet · week 44',
      state: 'cantRun',
      why: { code: 'off', text: 'Agents are Off since 14:02.' },
    }),
    run('Pay supplier retainer', '2026-10', Date.UTC(2026, 9, 28, 10), {
      title: 'Pay supplier retainer · Oct 2026',
      state: 'cantRun',
      why: { code: 'failed', text: 'Books could not do it: bank sign-in expired' },
    }),
    run('Renew the domain', '2026', Date.UTC(2026, 2, 2, 9), { state: 'done' }),
  ];
  const cards = cantRunCards(runs, [timesheet, retainer, domain], NOW + 6 * H, TZ);
  it('orders the cards by level: the rarer, the louder', () => {
    expect(cards.map((c) => c.level)).toEqual(['high', 'normal']);
    expect(cards[0]!.kicker).toBe('High · Monthly run didn’t happen');
    expect(cards[0]!.headline).toBe('Pay supplier retainer · Oct 2026 did not run on Wed 28 Oct at 10:00');
    expect(cards[0]!.why).toBe('Books could not do it: bank sign-in expired');
    expect(cards[0]!.skip).toBe('If skipped, the next run is Sat 28 Nov 10:00.');
    expect(cards[1]!.kicker).toBe('Normal · Weekly run didn’t happen');
    expect(cards[1]!.headline).toBe('Timesheet · week 44 did not run today at 16:00');
  });
  it('a one-off says skipping drops it', () => {
    const once = sched('Board review', {
      rule: { freq: 'once', at: '10:00', tz: TZ, date: '2026-10-29' },
    });
    const c = cantRunCards(
      [run('Board review', 'once', Date.UTC(2026, 9, 29, 10), { state: 'cantRun' })],
      [once],
      NOW,
      TZ,
    );
    expect(c[0]!.level).toBe('urgent');
    expect(c[0]!.kicker).toBe('Urgent · One-off run didn’t happen');
    expect(c[0]!.skip).toMatch(/one-off/);
  });
});

describe('the scheduler-offline banner', () => {
  it('stays away while the beat is fresh, or without active schedules', () => {
    expect(schedulerBanner(NOW - 10 * 60_000, [invoices], NOW, TZ)).toBeNull();
    expect(schedulerBanner(null, [newsletter], NOW, TZ)).toBeNull();
    expect(schedulerBanner(null, [], NOW, TZ)).toBeNull();
  });
  it('says since when, what could not fire and what is next', () => {
    const b = schedulerBanner(Date.UTC(2026, 9, 30, 7, 40), [tidy, timesheet], NOW, TZ);
    expect(b).toBe(
      'Scheduler offline since 07:40 · 1 run couldn’t fire · the run due at 16:00 can’t fire',
    );
  });
  it('without any beat', () => {
    expect(schedulerBanner(null, [invoices], NOW, TZ)).toBe(
      'Scheduler offline · scheduled runs can’t fire until it is back',
    );
  });
});

describe('run words', () => {
  it('has a word and a tone for every state', () => {
    expect(runWords('done')).toEqual({ sym: '✓', word: 'done', tone: 'approve' });
    expect(runWords('cantRun').tone).toBe('sendback');
    expect(runWords('running').sym).toBe('●');
    expect(runWords('planned').word).toBe('planned');
  });
});
