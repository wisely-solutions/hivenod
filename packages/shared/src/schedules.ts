/**
 * Scheduled tasks, slice 1: the schedule rule library. Pure code, no I/O, no outside dependency
 * (local time to UTC uses only `Intl.DateTimeFormat` offsets, available in Node 22 and browsers).
 * Used by the web (timeline, sentences), the notifier's scheduler (when is the next run) and the
 * CLI contract. Timing is decided here and only here: never by an LLM, never by an agent's cron.
 *
 * Time rules (design section 3):
 * - A wall time inside a DST gap (e.g. 01:30 on 29 Mar 2026 in Lisbon) moves forward by the gap
 *   (02:30). An ambiguous wall time (01:30 on 25 Oct 2026 in Lisbon) runs at its first occurrence.
 * - Day 29-31 in a shorter month falls back to that month's last day; yearly 29 Feb → 28 Feb in
 *   common years. `monthDay: -1` is always the last day.
 * - `weekend: 'before' | 'after'` (monthly, quarterly, yearly) moves a Saturday/Sunday run to the
 *   Friday before / Monday after, after the clamp. The run key stays the period's.
 * - One run key per period: `once`; daily and weekly the local date; monthly `2026-11`;
 *   quarterly `2026-Q4`; yearly `2026`. Changing the time never changes the key, so an edit, a DST
 *   overlap or a weekend shift never fires the same period twice.
 * - `date` (recurring: the first possible run day) and `until` (the last one, inclusive) compare
 *   with the run's actual local date, after the weekend shift.
 *
 * Cost: everything is computed on demand; one `nextDue` call per timer, a handful of cached
 * `Intl` formatter calls per occurrence.
 */

export const SCHEDULE_FREQS = [
  'once',
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'yearly',
] as const;
export type ScheduleFreq = (typeof SCHEDULE_FREQS)[number];
export type WeekendShift = 'keep' | 'before' | 'after';
/** ISO weekday: 1 = Monday … 7 = Sunday. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const DEFAULT_SCHEDULE_TZ = 'Europe/Lisbon';
/** How far back the scheduler looks for missed runs (design 5.4). */
export const CATCH_UP_WINDOW_MS = 35 * 24 * 3_600_000;

export interface ScheduleRule {
  freq: ScheduleFreq;
  /** Local wall time 'HH:MM' (00:00..23:59). */
  at: string;
  /** IANA zone; default Europe/Lisbon. */
  tz?: string;
  /** once: the day; recurring: the first possible run day. 'YYYY-MM-DD'. */
  date?: string;
  /** daily: optional subset (e.g. Mon-Fri); weekly: required, 1..7 entries. */
  weekdays?: number[];
  /** monthly/quarterly/yearly: 1..31, or -1 for the last day. */
  monthDay?: number;
  /** yearly: the month (required); quarterly: the anchor month (default 1 = Jan, Apr, Jul, Oct). */
  month?: number;
  /** monthly/quarterly/yearly: a Saturday/Sunday run moves to Friday / Monday. Default keep. */
  weekend?: WeekendShift;
  /** Last possible run day, inclusive. */
  until?: string | null;
}

export interface Occurrence {
  /** Deterministic run key, one per period (see `runKey`). */
  key: string;
  /** When it is due, UTC ms. */
  dueMs: number;
  /** Local wall time it runs at, 'YYYY-MM-DD HH:MM' (after a DST gap shift). */
  local: string;
  /** The run's local date 'YYYY-MM-DD' (after the weekend shift). */
  date: string;
  /** The period label: '6 Nov 2026', 'Nov 2026', 'Q4 2026', '2026'. */
  period: string;
  /** The period's year, month (1..12) and quarter (1..4); for daily/weekly/once the run date's. */
  year: number;
  month: number;
  quarter: number;
}

/** What the scheduler knows about one schedule (design 5.2). */
export interface ScheduleClock {
  rule: ScheduleRule;
  /** Approval or last rule change, UTC ms: nothing earlier ever fires. */
  activeFromMs?: number | null;
  /** dueMs of the last run created for this schedule, if any. */
  lastDueMs?: number | null;
}

export type ScheduleUrgency = 'urgent' | 'high' | 'normal' | 'low';

// ---------------------------------------------------------------------------------------------
// Calendar arithmetic (proleptic Gregorian, via Date.UTC; no zone involved)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 86_400_000;
const monthName = (m: number) => MONTHS[m - 1] ?? '?';
const dayName = (d: number) => WEEKDAYS[d - 1] ?? '?';

interface Ymd {
  y: number;
  m: number;
  d: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const ymdStr = (v: Ymd) => `${pad(v.y, 4)}-${pad(v.m)}-${pad(v.d)}`;
const dayNum = (v: Ymd) => Date.UTC(v.y, v.m - 1, v.d) / DAY_MS;
function fromDayNum(n: number): Ymd {
  const t = new Date(n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
const addDays = (v: Ymd, n: number) => fromDayNum(dayNum(v) + n);
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
/** ISO weekday of a calendar date (1 = Monday … 7 = Sunday). */
function isoWeekday(v: Ymd): IsoWeekday {
  const w = new Date(Date.UTC(v.y, v.m - 1, v.d)).getUTCDay();
  return (w === 0 ? 7 : w) as IsoWeekday;
}
const cmpYmd = (a: Ymd, b: Ymd) => dayNum(a) - dayNum(b);

function parseYmd(s: unknown): Ymd | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const v = { y: +m[1]!, m: +m[2]!, d: +m[3]! };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) return null;
  return v;
}
function parseAt(s: unknown): { h: number; min: number } | null {
  if (typeof s !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? { h: +m[1]!, min: +m[2]! } : null;
}

// ---------------------------------------------------------------------------------------------
// Zones: offsets from Intl only

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** True when the runtime knows this IANA zone. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

interface LocalParts extends Ymd {
  h: number;
  min: number;
}

/** The wall clock in `tz` at UTC instant `ms`. */
export function localParts(ms: number, tz: string): LocalParts {
  const p = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const part of formatter(tz).formatToParts(new Date(ms))) {
    if (part.type in p) p[part.type as keyof typeof p] = Number(part.value);
  }
  return { y: p.year, m: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, min: p.minute };
}

/** The zone's offset from UTC at instant `ms`, in ms (Lisbon summer: +3_600_000). */
export function tzOffsetMs(ms: number, tz: string): number {
  const whole = Math.floor(ms / 60_000) * 60_000; // offsets are whole minutes
  const l = localParts(whole, tz);
  return Date.UTC(l.y, l.m - 1, l.d, l.h, l.min) - whole;
}

/**
 * The UTC instant of a local wall time. In a DST gap the time moves forward by the gap; in an
 * overlap the first occurrence wins. Assumes at most one offset change within ±12 h (true for
 * every real zone).
 */
export function localToUtc(v: Ymd, h: number, min: number, tz: string): number {
  const naive = Date.UTC(v.y, v.m - 1, v.d, h, min);
  const before = naive - tzOffsetMs(naive - 12 * 3_600_000, tz);
  const after = naive - tzOffsetMs(naive + 12 * 3_600_000, tz);
  const valid = [before, after].filter((t) => {
    const l = localParts(t, tz);
    return l.y === v.y && l.m === v.m && l.d === v.d && l.h === h && l.min === min;
  });
  if (valid.length) return Math.min(...valid);
  // Gap: read the wall time with the offset before the change, i.e. shift forward by the gap.
  return before;
}

// ---------------------------------------------------------------------------------------------
// Checking a rule

/** Plain errors for a rule; empty when it is valid. */
export function checkRule(rule: ScheduleRule): string[] {
  const errors: string[] = [];
  const r = rule as Partial<ScheduleRule> | null | undefined;
  if (!r || typeof r !== 'object') return ['rule: required'];
  const freq = r.freq as string;
  if (!(SCHEDULE_FREQS as readonly string[]).includes(freq)) {
    return [`freq: one of ${SCHEDULE_FREQS.join(', ')}`];
  }
  if (!parseAt(r.at)) errors.push('at: HH:MM between 00:00 and 23:59');
  if (r.tz !== undefined && !isTimeZone(r.tz)) errors.push('tz: unknown time zone');
  if (r.date !== undefined && !parseYmd(r.date)) errors.push('date: a real day as YYYY-MM-DD');
  if (r.until !== undefined && r.until !== null && !parseYmd(r.until)) {
    errors.push('until: a real day as YYYY-MM-DD');
  }
  if (freq === 'once' && r.date === undefined) errors.push('once needs date');
  if (freq === 'once' && r.until != null) errors.push('until: not for once');
  const start = parseYmd(r.date);
  const end = parseYmd(r.until);
  if (start && end && cmpYmd(end, start) < 0) errors.push('until: on or after date');

  const usesWeekdays = freq === 'daily' || freq === 'weekly';
  if (r.weekdays !== undefined) {
    const w = r.weekdays;
    if (!usesWeekdays) errors.push('weekdays: only for daily or weekly');
    else if (
      !Array.isArray(w) ||
      w.length < 1 ||
      w.length > 7 ||
      w.some((d) => !Number.isInteger(d) || d < 1 || d > 7) ||
      new Set(w).size !== w.length
    ) {
      errors.push('weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday');
    }
  } else if (freq === 'weekly') {
    errors.push('weekly needs weekdays');
  }

  const usesMonthDay = freq === 'monthly' || freq === 'quarterly' || freq === 'yearly';
  if (usesMonthDay) {
    const d = r.monthDay;
    if (d === undefined) errors.push(`${freq} needs monthDay`);
    else if (!Number.isInteger(d) || !(d === -1 || (d >= 1 && d <= 31))) {
      errors.push('monthDay: 1..31 or -1');
    }
  } else if (r.monthDay !== undefined) {
    errors.push('monthDay: only for monthly, quarterly or yearly');
  }

  if (freq === 'yearly' || freq === 'quarterly') {
    const m = r.month;
    if (m === undefined) {
      if (freq === 'yearly') errors.push('yearly needs month');
    } else if (!Number.isInteger(m) || m < 1 || m > 12) {
      errors.push('month: 1..12');
    } else if (
      freq === 'yearly' &&
      typeof r.monthDay === 'number' &&
      r.monthDay > daysInMonth(2028, m) // 2028: a leap year, so 29 Feb is allowed
    ) {
      errors.push(`monthDay: ${monthName(m)} has at most ${daysInMonth(2028, m)} days`);
    }
  } else if (r.month !== undefined) {
    errors.push('month: only for quarterly or yearly');
  }

  if (r.weekend !== undefined) {
    if (!['keep', 'before', 'after'].includes(r.weekend as string)) {
      errors.push('weekend: keep, before or after');
    } else if (!usesMonthDay && r.weekend !== 'keep') {
      errors.push('weekend: only for monthly, quarterly or yearly');
    }
  }
  return errors;
}

function assertRule(rule: ScheduleRule): void {
  const errors = checkRule(rule);
  if (errors.length) throw new Error(`Invalid schedule rule: ${errors.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------
// Periods and occurrences

const tzOf = (rule: ScheduleRule) => rule.tz ?? DEFAULT_SCHEDULE_TZ;
const quarterOf = (m: number) => Math.floor((m - 1) / 3) + 1;

/** A period's nominal key parts: for daily/weekly/once the date, otherwise year (+ month). */
interface Period {
  y: number;
  m: number;
  /** The run's local date (after clamp and weekend shift). */
  run: Ymd;
}

/**
 * The deterministic key of a run: `once`; daily and weekly the local date ('2026-11-06');
 * monthly '2026-11'; quarterly '2026-Q4'; yearly '2026'. Depends only on the frequency and the
 * period, never on the time, so editing the time keeps the keys.
 */
export function runKey(
  rule: Pick<ScheduleRule, 'freq'>,
  occ: Pick<Occurrence, 'date' | 'year' | 'month'>,
): string {
  switch (rule.freq) {
    case 'once':
      return 'once';
    case 'daily':
    case 'weekly':
      return occ.date;
    case 'monthly':
      return `${pad(occ.year, 4)}-${pad(occ.month)}`;
    case 'quarterly':
      return `${pad(occ.year, 4)}-Q${quarterOf(occ.month)}`;
    case 'yearly':
      return pad(occ.year, 4);
  }
}

function periodLabel(freq: ScheduleFreq, p: Period): string {
  switch (freq) {
    case 'once':
    case 'daily':
    case 'weekly':
      return `${p.run.d} ${monthName(p.run.m)} ${p.run.y}`;
    case 'monthly':
      return `${monthName(p.m)} ${p.y}`;
    case 'quarterly':
      return `Q${quarterOf(p.m)} ${p.y}`;
    case 'yearly':
      return String(p.y);
  }
}

function monthRun(rule: ScheduleRule, y: number, m: number): Ymd {
  const last = daysInMonth(y, m);
  const day = rule.monthDay === -1 || (rule.monthDay ?? 1) > last ? last : (rule.monthDay ?? 1);
  let run: Ymd = { y, m, d: day };
  const wd = isoWeekday(run);
  if (wd >= 6 && rule.weekend === 'before') run = addDays(run, -(wd - 5));
  if (wd >= 6 && rule.weekend === 'after') run = addDays(run, 8 - wd);
  return run;
}

/** Periods in order, starting with the one that contains `from` (or a little before it). */
function* periods(rule: ScheduleRule, from: Ymd): Generator<Period> {
  switch (rule.freq) {
    case 'once': {
      const d = parseYmd(rule.date)!;
      yield { y: d.y, m: d.m, run: d };
      return;
    }
    case 'daily':
    case 'weekly': {
      const days = new Set(rule.weekdays ?? [1, 2, 3, 4, 5, 6, 7]);
      for (let n = dayNum(from); ; n++) {
        const d = fromDayNum(n);
        if (days.has(isoWeekday(d))) yield { y: d.y, m: d.m, run: d };
      }
    }
    case 'monthly':
    case 'quarterly': {
      const step = rule.freq === 'monthly' ? 1 : 3;
      const anchor = rule.freq === 'monthly' ? 1 : (rule.month ?? 1);
      // Start one period before `from`'s month: an 'after' shift can carry it into range.
      let idx = from.y * 12 + (from.m - 1) - step;
      idx -= (((idx - (anchor - 1)) % step) + step) % step; // align to the anchor
      for (; ; idx += step) {
        const y = Math.floor(idx / 12);
        const m = (idx % 12) + 1;
        yield { y, m, run: monthRun(rule, y, m) };
      }
    }
    case 'yearly': {
      for (let y = from.y - 1; ; y++)
        yield { y, m: rule.month!, run: monthRun(rule, y, rule.month!) };
    }
  }
}

function toOccurrence(rule: ScheduleRule, p: Period, dueMs: number): Occurrence {
  const tz = tzOf(rule);
  const l = localParts(dueMs, tz);
  const date = ymdStr(p.run);
  const daily = rule.freq === 'once' || rule.freq === 'daily' || rule.freq === 'weekly';
  const year = daily ? p.run.y : p.y;
  const month = daily ? p.run.m : p.m;
  const base = { date, year, month };
  return {
    key: runKey(rule, base),
    dueMs,
    local: `${ymdStr(l)} ${pad(l.h)}:${pad(l.min)}`,
    date,
    period: periodLabel(rule.freq, p),
    year,
    month,
    quarter: quarterOf(month),
  };
}

/** Hard stop for a pathological search (e.g. a range of centuries). */
const MAX_PERIODS = 20_000;

/**
 * The runs of `rule` due in [fromMs, toMs] (both inclusive), in order, at most `max`.
 * `toMs` may be Infinity when `max` is finite (the next N runs for the timeline).
 */
export function occurrences(
  rule: ScheduleRule,
  fromMs: number,
  toMs: number,
  max = 1000,
): Occurrence[] {
  assertRule(rule);
  if (!Number.isFinite(fromMs)) throw new Error('occurrences: fromMs must be a finite time');
  const out: Occurrence[] = [];
  if (max <= 0 || toMs < fromMs) return out;
  const tz = tzOf(rule);
  const { h, min } = parseAt(rule.at)!;
  const start = parseYmd(rule.date);
  const until = parseYmd(rule.until ?? undefined);
  // A local day starts at most 14 h from UTC; three days back also covers a weekend shift.
  let from = addDays(localParts(fromMs, tz), -3);
  if (start && cmpYmd(start, from) > 0) from = start;
  let seen = 0;
  for (const p of periods(rule, from)) {
    if (++seen > MAX_PERIODS) break;
    if (until && cmpYmd(p.run, until) > 0) break;
    if (start && cmpYmd(p.run, start) < 0) continue;
    const dueMs = localToUtc(p.run, h, min, tz);
    if (dueMs > toMs) break;
    if (dueMs < fromMs) continue;
    out.push(toOccurrence(rule, p, dueMs));
    if (out.length >= max) break;
  }
  return out;
}

/** The first run strictly after `afterMs`, or null when there is none (once passed, until passed). */
export function nextRun(rule: ScheduleRule, afterMs: number): Occurrence | null {
  return occurrences(rule, afterMs + 1, Infinity, 1)[0] ?? null;
}

/** The next `n` runs from `fromMs` (inclusive): the timeline and the proposal card's "next 3". */
export function nextRuns(rule: ScheduleRule, fromMs: number, n: number): Occurrence[] {
  return occurrences(rule, fromMs, Infinity, n);
}

/** Where the scheduler's search starts: after the last run, not before activeFrom, within the window. */
function clockFrom(s: ScheduleClock, nowMs: number): number {
  return Math.max(
    s.activeFromMs ?? -Infinity,
    s.lastDueMs != null ? s.lastDueMs + 1 : -Infinity,
    nowMs - CATCH_UP_WINDOW_MS,
  );
}

/**
 * The one call the scheduler makes per timer: the earliest run of this schedule not handled yet
 * (after `lastDueMs`, not before `activeFromMs`, at most `CATCH_UP_WINDOW_MS` old). When its
 * `dueMs <= nowMs` it is due (or overdue: see `dueNow`); otherwise set the timer to `dueMs`.
 * Null when the schedule has no run left.
 */
export function nextDue(s: ScheduleClock, nowMs: number): Occurrence | null {
  return occurrences(s.rule, clockFrom(s, nowMs), Infinity, 1)[0] ?? null;
}

/** Every run not handled yet that is due at `nowMs` (catch-up after downtime), oldest first. */
export function dueNow(s: ScheduleClock, nowMs: number, max = 1000): Occurrence[] {
  return occurrences(s.rule, clockFrom(s, nowMs), nowMs, max);
}

// ---------------------------------------------------------------------------------------------
// Words

/** The city of an IANA zone: 'America/New_York' → 'New York'. */
export function tzCity(tz: string): string {
  return (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

function weekdayList(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1]! + 1) last.push(d);
    else runs.push([d]);
  }
  return runs
    .map((r) =>
      r.length >= 3 ? `${dayName(r[0]!)}–${dayName(r[r.length - 1]!)}` : r.map(dayName).join(', '),
    )
    .join(', ');
}

const dayWord = (d: number) => (d === -1 ? 'last day' : `day ${d}`);
const dateWord = (v: Ymd) => `${v.d} ${monthName(v.m)} ${v.y}`;

/**
 * A human sentence for a rule: 'Monthly · day 1 · 09:00', 'Weekly · Fri · 16:00',
 * 'Daily · Mon–Fri · 08:30', 'Yearly · 2 Mar · 09:00', 'Once · Thu 12 Nov 2026 · 10:00',
 * 'Quarterly · last day · 17:00 (Jan, Apr, Jul, Oct)'. The zone's city is added when it differs
 * from `viewerTz` (default Europe/Lisbon): 'Weekly · Fri · 16:00 New York'.
 */
export function ruleSentence(rule: ScheduleRule, opts: { viewerTz?: string } = {}): string {
  const tz = tzOf(rule);
  const time = rule.at + (tz !== (opts.viewerTz ?? DEFAULT_SCHEDULE_TZ) ? ` ${tzCity(tz)}` : '');
  const shift =
    rule.weekend === 'before'
      ? ' · Fri if weekend'
      : rule.weekend === 'after'
        ? ' · Mon if weekend'
        : '';
  const until =
    rule.until && parseYmd(rule.until) ? ` · until ${dateWord(parseYmd(rule.until)!)}` : '';
  switch (rule.freq) {
    case 'once': {
      const d = parseYmd(rule.date);
      const day = d ? `${dayName(isoWeekday(d))} ${dateWord(d)}` : '?';
      return `Once · ${day} · ${time}`;
    }
    case 'daily': {
      const w = rule.weekdays;
      const days = w && new Set(w).size < 7 ? ` · ${weekdayList(w)}` : '';
      return `Daily${days} · ${time}${until}`;
    }
    case 'weekly':
      return `Weekly · ${weekdayList(rule.weekdays ?? [])} · ${time}${until}`;
    case 'monthly':
      return `Monthly · ${dayWord(rule.monthDay ?? 1)} · ${time}${shift}${until}`;
    case 'quarterly': {
      const a = rule.month ?? 1;
      const months = [0, 3, 6, 9].map((k) => ((a - 1 + k) % 12) + 1).sort((x, y) => x - y);
      return `Quarterly · ${dayWord(rule.monthDay ?? 1)} · ${time} (${months.map((m) => monthName(m)).join(', ')})${shift}${until}`;
    }
    case 'yearly': {
      const m = monthName(rule.month ?? 1);
      const day = rule.monthDay === -1 ? `last day of ${m}` : `${rule.monthDay} ${m}`;
      return `Yearly · ${day} · ${time}${shift}${until}`;
    }
  }
}

/** How loudly a run that cannot happen is asked (design section 8): the rarer, the louder. */
export function urgencyOf(freq: ScheduleFreq): ScheduleUrgency {
  switch (freq) {
    case 'once':
    case 'yearly':
      return 'urgent';
    case 'quarterly':
    case 'monthly':
      return 'high';
    case 'weekly':
      return 'normal';
    case 'daily':
      return 'low';
  }
}

/**
 * Fills a run title or step text: {date} '1 Nov 2026' (the run's day), {month} 'Nov',
 * {year} '2026', {quarter} 'Q4', {period} the period label. Unknown placeholders stay as written.
 */
export function fillPlaceholders(text: string, occ: Occurrence): string {
  const run = parseYmd(occ.date)!;
  const values: Record<string, string> = {
    date: dateWord(run),
    month: monthName(occ.month),
    year: String(occ.year),
    quarter: `Q${occ.quarter}`,
    period: occ.period,
  };
  return text.replace(/\{(\w+)\}/g, (all, name: string) => values[name] ?? all);
}

/** 'Sat 1 Nov 2026 09:00' for an occurrence, in its own zone: the run message's "Due …" line. */
export function occurrenceWords(occ: Occurrence): string {
  const [date, time] = occ.local.split(' ');
  const d = parseYmd(date)!;
  return `${dayName(isoWeekday(d))} ${dateWord(d)} ${time}`;
}
