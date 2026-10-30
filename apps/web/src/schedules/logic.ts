/**
 * Scheduled tasks, slice 6: what the Schedules page and Today show of the member's schedules
 * (design ~/drafts/schedules/design.md, 9.1 and 9.3). Pure. Upcoming runs are computed from the
 * rules (nextRuns/occurrences), never read: the only stored runs are the ones the scheduler made
 * (past, running, or that could not happen). Times are each schedule's own wall time (its zone);
 * "today" is the viewer's.
 */
import {
  DEFAULT_SCHEDULE_TZ,
  fillPlaceholders,
  localClock,
  localDate,
  localParts,
  localToUtc,
  nextRun,
  occurrences,
  ruleSentence,
  schedulerDown,
  urgencyOf,
  type Occurrence,
  type RunChoice,
  type RunState,
  type RunWhy,
  type ScheduleRule,
  type ScheduleState,
  type ScheduleStep,
  type ScheduleUrgency,
} from '@hive/shared';
import type { Tone } from '../ui/badge';

const DAY = 86_400_000;
const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A schedule as the views need it (from the listener; times in ms). */
export interface SchedLite {
  wid: string;
  id: string;
  title: string;
  what: string;
  agentUid: string;
  rule: ScheduleRule;
  runTitle: string;
  steps: ScheduleStep[];
  state: ScheduleState;
  activeFromMs: number | null;
  subjectId: string | null;
  /** A proposed change of another schedule (hidden: it shows on its thread). */
  replaces: string | null;
}

/** A run the scheduler made. */
export interface RunLite {
  wid: string;
  id: string;
  scheduleId: string;
  key: string;
  period: string;
  dueMs: number;
  title: string;
  state: RunState;
  why: { code: RunWhy; text: string } | null;
  threadId: string | null;
  laterAtMs: number | null;
  decision: { choice: RunChoice; atMs: number } | null;
}

export const viewerTz = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_SCHEDULE_TZ;
  } catch {
    return DEFAULT_SCHEDULE_TZ;
  }
};

const tzOf = (rule: ScheduleRule) => rule.tz ?? DEFAULT_SCHEDULE_TZ;
const skey = (wid: string, id: string) => `${wid}/${id}`;

// ---------- dates ('YYYY-MM-DD', no zone) ----------

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(date: string): { y: number; m: number; d: number } {
  const [y, m, d] = date.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}
const dayNum = (date: string) => {
  const v = ymd(date);
  return Date.UTC(v.y, v.m - 1, v.d) / DAY;
};
const fromDayNum = (n: number) => {
  const t = new Date(n * DAY);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
export const addDays = (date: string, n: number) => fromDayNum(dayNum(date) + n);
/** 1 = Monday … 7 = Sunday. */
export const isoWeekday = (date: string) => ((((dayNum(date) + 3) % 7) + 7) % 7) + 1;
/** The Monday of the week `date` is in. */
export const weekStart = (date: string) => addDays(date, 1 - isoWeekday(date));

/** "Mon 26" (a column head), "Sun 1 Nov" with `month`. */
export function dayHead(date: string, month = false): string {
  const v = ymd(date);
  return `${WEEKDAY[isoWeekday(date) - 1]} ${v.d}${month ? ` ${MONTH[v.m - 1]}` : ''}`;
}

/** "Week of 26 Oct – 1 Nov 2026". */
export function weekTitle(start: string): string {
  const a = ymd(start);
  const b = ymd(addDays(start, 6));
  const left = a.y !== b.y ? `${a.d} ${MONTH[a.m - 1]} ${a.y}` : `${a.d} ${MONTH[a.m - 1]}`;
  return `Week of ${left} – ${b.d} ${MONTH[b.m - 1]} ${b.y}`;
}

/** "October 2026". */
export function monthTitle(date: string): string {
  const v = ymd(date);
  return `${MONTH_LONG[v.m - 1]} ${v.y}`;
}

export type View = 'week' | 'month';

/** The days a view shows around `anchor`: a week (Mon–Sun), or whole weeks covering the month. */
export function viewDays(view: View, anchor: string): string[] {
  if (view === 'week') {
    const s = weekStart(anchor);
    return Array.from({ length: 7 }, (_, i) => addDays(s, i));
  }
  const v = ymd(anchor);
  const first = `${v.y}-${pad(v.m)}-01`;
  const nextMonth = v.m === 12 ? `${v.y + 1}-01-01` : `${v.y}-${pad(v.m + 1)}-01`;
  const last = addDays(nextMonth, -1);
  const from = weekStart(first);
  const to = addDays(weekStart(last), 6);
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Moves the anchor one view back or on. */
export function shiftAnchor(view: View, anchor: string, dir: 1 | -1): string {
  if (view === 'week') return addDays(anchor, 7 * dir);
  const v = ymd(anchor);
  const m = v.m + dir;
  const y = v.y + (m < 1 ? -1 : m > 12 ? 1 : 0);
  return `${y}-${pad(((m + 11) % 12) + 1)}-01`;
}

/** The instants a range of local days covers in `tz`: [first day 00:00, day after last 00:00). */
export function rangeMs(from: string, to: string, tz: string): { fromMs: number; toMs: number } {
  return {
    fromMs: localToUtc(ymd(from), 0, 0, tz),
    toMs: localToUtc(ymd(addDays(to, 1)), 0, 0, tz),
  };
}

// ---------- runs ----------

export type ChipState = RunState | 'planned';

export interface RunWords {
  /** The symbol before the word ("✓ done"). */
  sym: string;
  word: string;
  tone: Tone;
}

/** How a run's state reads on a chip, the list and the detail (design 9.1). */
export function runWords(state: ChipState): RunWords {
  switch (state) {
    case 'done':
      return { sym: '✓', word: 'done', tone: 'approve' };
    case 'cantRun':
      return { sym: '!', word: 'can’t run', tone: 'sendback' };
    case 'skipped':
      return { sym: '–', word: 'skipped', tone: 'neutral' };
    case 'later':
      return { sym: '→', word: 'later', tone: 'gate' };
    case 'expired':
      return { sym: '–', word: 'missed · expired', tone: 'neutral' };
    case 'stopped':
      return { sym: '–', word: 'stopped', tone: 'neutral' };
    case 'waitingAgent':
      return { sym: '●', word: 'waiting for the agent', tone: 'agent' };
    case 'fired':
    case 'running':
    case 'runNow':
      return { sym: '●', word: 'running', tone: 'agent' };
    case 'planned':
      return { sym: '', word: 'planned', tone: 'neutral' };
  }
}

/** One run on the timeline: made by the scheduler, or planned (computed). */
export interface Chip {
  key: string;
  wid: string;
  scheduleId: string;
  title: string;
  /** Its local day and time in its schedule's zone. */
  date: string;
  time: string;
  dueMs: number;
  state: ChipState;
  agentUid: string | null;
  runId: string | null;
  threadId: string | null;
  /** "monthly", "weekly"…: under a planned chip. */
  freq: string | null;
}

const FREQ_WORD: Record<string, string> = {
  once: 'once',
  daily: 'daily',
  weekly: 'weekly',
  monthly: 'monthly',
  quarterly: 'quarterly',
  yearly: 'yearly',
};

/** The instant activeFrom allows (null: never fires, a proposal). */
function startOf(s: SchedLite): number | null {
  return s.state === 'active' && s.activeFromMs !== null ? s.activeFromMs : null;
}

function safeOccurrences(rule: ScheduleRule, fromMs: number, toMs: number, max = 400) {
  try {
    return occurrences(rule, fromMs, toMs, max);
  } catch {
    return [];
  }
}

/**
 * The timeline of the days `days` (consecutive, in the viewer's zone): every stored run due in
 * them, plus the planned runs of active schedules from now on (a planned run whose period
 * already has a stored run is that run). By day, in time order.
 */
export function timeline(
  schedules: readonly SchedLite[],
  runs: readonly RunLite[],
  days: readonly string[],
  now: number,
  tz: string,
): Map<string, Chip[]> {
  const out = new Map<string, Chip[]>(days.map((d) => [d, []]));
  if (!days.length) return out;
  const { fromMs, toMs } = rangeMs(days[0]!, days[days.length - 1]!, tz);
  const byId = new Map(schedules.map((s) => [skey(s.wid, s.id), s]));
  const stored = new Set<string>();
  const put = (c: Chip) => out.get(c.date)?.push(c);
  for (const r of runs) {
    stored.add(`${r.wid}/${r.scheduleId}/${r.key}`);
    if (r.dueMs < fromMs || r.dueMs >= toMs) continue;
    const s = byId.get(skey(r.wid, r.scheduleId));
    const date = localDate(r.dueMs, tz);
    put({
      key: `r:${r.wid}/${r.id}`,
      wid: r.wid,
      scheduleId: r.scheduleId,
      title: s?.title ?? r.title,
      date,
      time: s ? localClock(r.dueMs, tzOf(s.rule)) : localClock(r.dueMs, tz),
      dueMs: r.dueMs,
      state: r.state,
      agentUid: s?.agentUid ?? null,
      runId: r.id,
      threadId: r.threadId,
      freq: s ? FREQ_WORD[s.rule.freq]! : null,
    });
  }
  for (const s of schedules) {
    const start = startOf(s);
    if (start === null) continue;
    // A run due a moment ago may still be firing (the beat is minutes): show it as planned.
    const from = Math.max(fromMs, start, now - 15 * 60_000);
    for (const o of safeOccurrences(s.rule, from, toMs - 1)) {
      if (stored.has(`${s.wid}/${s.id}/${o.key}`)) continue;
      put(plannedChip(s, o, tz));
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.dueMs - b.dueMs || a.key.localeCompare(b.key));
  return out;
}

function plannedChip(s: SchedLite, o: Occurrence, tz: string): Chip {
  return {
    key: `p:${s.wid}/${s.id}/${o.key}`,
    wid: s.wid,
    scheduleId: s.id,
    title: s.title,
    date: localDate(o.dueMs, tz),
    time: o.local.slice(11),
    dueMs: o.dueMs,
    state: 'planned',
    agentUid: s.agentUid,
    runId: null,
    threadId: null,
    freq: FREQ_WORD[s.rule.freq]!,
  };
}

// ---------- when, in words ----------

/**
 * "Today 16:00", "Tomorrow 09:00", "Sun 1 Nov 09:00", "Tue 2 Mar 2027 09:00": a run's local day
 * and time (its schedule's zone) against the viewer's today.
 */
export function whenWords(local: string, now: number, tz: string): string {
  const [date, time] = local.split(' ');
  const today = localDate(now, tz);
  if (date === today) return `Today ${time}`;
  if (date === addDays(today, 1)) return `Tomorrow ${time}`;
  const v = ymd(date!);
  const year = v.y !== ymd(today).y ? ` ${v.y}` : '';
  return `${dayHead(date!, true)}${year} ${time}`;
}

/** "28 Oct" (this year) or "2 Mar 2025": a past run's day in the list. */
export function shortDay(ms: number, now: number, tz: string): string {
  const d = localDate(ms, tz);
  const v = ymd(d);
  return `${v.d} ${MONTH[v.m - 1]}${v.y !== ymd(localDate(now, tz)).y ? ` ${v.y}` : ''}`;
}

/** The next run of a schedule from now (null: paused, a proposal, or none left). */
export function nextOf(s: SchedLite, now: number): Occurrence | null {
  const start = startOf(s);
  if (start === null) return null;
  try {
    return nextRun(s.rule, Math.max(now, start) - 1);
  } catch {
    return null;
  }
}

/** The next `n` runs of a schedule (the detail's list). */
export function nextN(s: SchedLite, now: number, n: number): Occurrence[] {
  const start = startOf(s);
  if (start === null) return [];
  return safeOccurrences(s.rule, Math.max(now, start), Infinity, n);
}

// ---------- the list ----------

export interface ListRow {
  key: string;
  s: SchedLite;
  sentence: string;
  next: { ms: number; words: string; occ: Occurrence } | null;
  last: { run: RunLite; day: string; words: RunWords } | null;
}

/** The latest stored run of each schedule (by `wid/sid`). */
export function lastRuns(runs: readonly RunLite[], now: number): Map<string, RunLite> {
  const out = new Map<string, RunLite>();
  for (const r of runs) {
    if (r.dueMs > now) continue;
    const k = skey(r.wid, r.scheduleId);
    const cur = out.get(k);
    if (!cur || cur.dueMs < r.dueMs) out.set(k, r);
  }
  return out;
}

/**
 * One row per schedule the member has (proposals and proposed changes stay on their threads):
 * sorted by next run, the paused and finished ones at the bottom.
 */
export function listRows(
  schedules: readonly SchedLite[],
  runs: readonly RunLite[],
  now: number,
  tz: string,
): ListRow[] {
  const last = lastRuns(runs, now);
  const rows = schedules
    .filter((s) => s.state === 'active' || s.state === 'paused')
    .map((s): ListRow => {
      const occ = nextOf(s, now);
      const l = last.get(skey(s.wid, s.id));
      return {
        key: skey(s.wid, s.id),
        s,
        sentence: ruleSentence(s.rule, { viewerTz: tz }),
        next: occ ? { ms: occ.dueMs, words: whenWords(occ.local, now, tz), occ } : null,
        last: l ? { run: l, day: shortDay(l.dueMs, now, tz), words: runWords(l.state) } : null,
      };
    });
  const rank = (r: ListRow) => (r.s.state !== 'active' ? 2 : r.next ? 0 : 1);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.next?.ms ?? 0) - (b.next?.ms ?? 0) ||
      a.s.title.localeCompare(b.s.title),
  );
}

// ---------- Today: coming up ----------

export interface ComingRun {
  key: string;
  wid: string;
  scheduleId: string;
  title: string;
  /** "Today 16:00" / "Tomorrow 09:00". */
  words: string;
  time: string;
  today: boolean;
  dueMs: number;
  agentUid: string;
}

/** The runs still to come today and tomorrow (the viewer's days), at most `max`, in order. */
export function comingUp(
  schedules: readonly SchedLite[],
  now: number,
  tz: string,
  max = 6,
): ComingRun[] {
  const today = localDate(now, tz);
  const { toMs } = rangeMs(today, addDays(today, 1), tz);
  const out: ComingRun[] = [];
  for (const s of schedules) {
    const start = startOf(s);
    if (start === null) continue;
    for (const o of safeOccurrences(s.rule, Math.max(now, start), toMs - 1, max)) {
      out.push({
        key: `${s.wid}/${s.id}/${o.key}`,
        wid: s.wid,
        scheduleId: s.id,
        title: fillPlaceholders(s.runTitle, o),
        words: whenWords(o.local, now, tz),
        time: o.local.slice(11),
        today: localDate(o.dueMs, tz) === today,
        dueMs: o.dueMs,
        agentUid: s.agentUid,
      });
    }
  }
  return out.sort((a, b) => a.dueMs - b.dueMs || a.key.localeCompare(b.key)).slice(0, max);
}

// ---------- can't run ----------

const LEVEL_RANK: Record<ScheduleUrgency, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const LEVEL_WORD: Record<ScheduleUrgency, string> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};
const FREQ_HEAD: Record<string, string> = {
  once: 'One-off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

export interface CantRunCard {
  key: string;
  wid: string;
  run: RunLite;
  level: ScheduleUrgency;
  /** "High · Monthly run didn't happen". */
  kicker: string;
  /** "Pay supplier retainer · Oct 2026 did not run on Wed 28 Oct at 10:00". */
  headline: string;
  why: string;
  /** "If skipped, the next run is Sat 28 Nov." */
  skip: string;
  /** The schedule's zone (Try later times are read in the viewer's). */
  scheduleTitle: string;
}

/** The runs that could not happen and wait for the member, loudest first (design 8, 9.3). */
export function cantRunCards(
  runs: readonly RunLite[],
  schedules: readonly SchedLite[],
  now: number,
  tz: string,
): CantRunCard[] {
  const byId = new Map(schedules.map((s) => [skey(s.wid, s.id), s]));
  const cards = runs
    .filter((r) => r.state === 'cantRun')
    .map((r): CantRunCard => {
      const s = byId.get(skey(r.wid, r.scheduleId)) ?? null;
      const freq = s?.rule.freq ?? 'daily';
      const level = urgencyOf(freq);
      const stz = s ? tzOf(s.rule) : tz;
      const local = `${localDate(r.dueMs, stz)} ${localClock(r.dueMs, stz)}`;
      const when = whenWords(local, now, tz);
      const on = /^(Today|Tomorrow) /.test(when)
        ? when.replace(/^Today /, 'today at ').replace(/^Tomorrow /, 'tomorrow at ')
        : `on ${when.replace(/ (\d\d:\d\d)$/, ' at $1')}`;
      let skip: string;
      if (!s || freq === 'once')
        skip = 'It was a one-off: if skipped, it does not happen at all.';
      else {
        const n = s.state === 'active' ? nextOf(s, Math.max(now, r.dueMs)) : null;
        skip = n
          ? `If skipped, the next run is ${whenWords(n.local, now, tz).replace(/^Today/, 'today').replace(/^Tomorrow/, 'tomorrow')}.`
          : 'If skipped, no run is left.';
      }
      return {
        key: skey(r.wid, r.id),
        wid: r.wid,
        run: r,
        level,
        kicker: `${LEVEL_WORD[level]} · ${FREQ_HEAD[freq] ?? 'Scheduled'} run didn’t happen`,
        headline: `${r.title} did not run ${on}`,
        why: r.why?.text ?? 'Hivenod could not start it.',
        skip,
        scheduleTitle: s?.title ?? r.title,
      };
    });
  return cards.sort(
    (a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.run.dueMs - b.run.dueMs,
  );
}

/** A card's colours: urgent red, high amber, the rest plain (design 8 table). */
export function cardTone(level: ScheduleUrgency): 'red' | 'amber' | 'plain' {
  return level === 'urgent' ? 'red' : level === 'high' ? 'amber' : 'plain';
}

// ---------- the scheduler-offline banner ----------

/**
 * The red banner on Today and Schedules (design 5.4) while the scheduler's beat is too old, only
 * for a member with an active schedule: "Scheduler offline since 13:40 · 1 run due at 14:00
 * can't fire". Null when all is well.
 */
export function schedulerBanner(
  beatMs: number | null,
  schedules: readonly SchedLite[],
  now: number,
  tz: string,
): string | null {
  const active = schedules.filter((s) => startOf(s) !== null);
  if (!active.length || !schedulerDown(beatMs, now)) return null;
  const since = beatMs
    ? `since ${localDate(beatMs, tz) === localDate(now, tz) ? localClock(beatMs, tz) : whenWords(`${localDate(beatMs, tz)} ${localClock(beatMs, tz)}`, now, tz)}`
    : '';
  // The runs due while it is down (since the last beat), and the next one within a day.
  const from = beatMs ?? now;
  let missed = 0;
  let next: Occurrence | null = null;
  for (const s of active) {
    const start = startOf(s)!;
    missed += safeOccurrences(s.rule, Math.max(from, start), now).length;
    const n = nextOf(s, now);
    if (n && n.dueMs <= now + DAY && (!next || n.dueMs < next.dueMs)) next = n;
  }
  const parts = [`Scheduler offline${since ? ` ${since}` : ''}`];
  if (missed) parts.push(`${missed} ${missed === 1 ? 'run' : 'runs'} couldn’t fire`);
  if (next) parts.push(`the run due ${whenWords(next.local, now, tz).replace(/^Today /, 'at ').replace(/^Tomorrow /, 'tomorrow at ')} can’t fire`);
  else if (!missed) parts.push('scheduled runs can’t fire until it is back');
  return parts.join(' · ');
}

// ---------- Try later ----------

/** "Today 14:30" / "Tomorrow 09:00" for a Try later choice, in the viewer's zone. */
export function laterWords(ms: number, now: number, tz: string): string {
  const l = localParts(ms, tz);
  return whenWords(`${l.y}-${pad(l.m)}-${pad(l.d)} ${pad(l.h)}:${pad(l.min)}`, now, tz);
}
