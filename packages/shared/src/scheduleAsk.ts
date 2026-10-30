/**
 * Scheduled tasks, slices 3 and 4: the scheduler's timing constants and "can't run" asks (design
 * ~/drafts/schedules/design.md, sections 5 and 8). Pure: the notifier's scheduler decides with
 * these, the web (banner, Today cards, Try later) and the CLI read the same words and times.
 *
 * The urgency ladder (urgencyOf in ./schedules.ts: the rarer, the louder):
 *   urgent  (once, yearly)       at once, even in quiet hours; again every 2 h (outside quiet
 *                                hours) until decided
 *   high    (monthly, quarterly) at once (quiet hours respected), again after 4 h, then daily 09:00
 *   normal  (weekly)             once
 *   low     (daily)              a line in the daily digest; after today's digest a silent line at
 *                                once; the third miss in a row is a normal message
 */
import type { NotifyPrefs } from './notify';
import { DEFAULT_SCHEDULE_TZ, localParts, localToUtc, type ScheduleUrgency } from './schedules';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The scheduler stamps `config/scheduler.beatAt` this often (João, 2026-10-30: as cheap as possible). */
export const SCHEDULER_BEAT_MS = 15 * MIN;
/** A beat older than this: the web and the agents say the scheduler is down. */
export const SCHEDULER_DOWN_MS = 35 * MIN;
/** The heartbeat document (root config: every signed-in person reads it). */
export const SCHEDULER_BEAT_PATH = 'config/scheduler';
/** A run may fire this late (a restart, a slow minute); later than that it is a miss. */
export const RUN_GRACE_MS = 15 * MIN;
/** An offline agent is waited for this long after the run was due. */
export const RUN_WAIT_AGENT_MS = 15 * MIN;
/** While waiting, the agent's presence is read again this often (one read each). */
export const RUN_WAIT_RECHECK_MS = MIN;
/** A fired run whose first agent step has not started after this is asked about (noStart). */
export const RUN_NO_START_MS = 30 * MIN;
/** Misses found on start: at most this many per schedule are asked, older ones expire. */
export const RUN_CATCH_UP_ASKS = 3;
/** Daily misses in a row that turn the digest line into a message of its own. */
export const DAILY_MISSES_LOUD = 3;
/** The urgent repeat, the high repeat, and when the high level asks after that (local). */
export const ASK_URGENT_EVERY_MS = 2 * HOUR;
export const ASK_HIGH_AGAIN_MS = 4 * HOUR;
export const ASK_HIGH_DAILY_AT = '09:00';
/** The daily digest goes out at the end of quiet hours, else at this local time. */
export const DIGEST_AT = '08:30';
/** Try later · Tomorrow at this local time. */
export const LATER_TOMORROW_AT = '09:00';

/** True when the scheduler's last beat is too old (or it never beat). */
export function schedulerDown(beatAtMs: number | null | undefined, nowMs: number): boolean {
  return !beatAtMs || nowMs - beatAtMs > SCHEDULER_DOWN_MS;
}

const pad = (n: number) => String(n).padStart(2, '0');
const hm = (s: string) => {
  const m = /^(\d\d):(\d\d)$/.exec(s);
  return m ? { h: Number(m[1]), min: Number(m[2]) } : { h: 9, min: 0 };
};

/** The local date 'YYYY-MM-DD' of an instant. */
export function localDate(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return `${l.y}-${pad(l.m)}-${pad(l.d)}`;
}

/** 'HH:MM' of an instant in a zone. */
export function localClock(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return `${pad(l.h)}:${pad(l.min)}`;
}

/** The first instant strictly after `afterMs` whose wall time in `tz` is `at` ('HH:MM'). */
export function nextLocalTime(afterMs: number, tz: string, at: string): number {
  const { h, min } = hm(at);
  const l = localParts(afterMs, tz);
  for (let k = 0; k < 3; k++) {
    const day = new Date(Date.UTC(l.y, l.m - 1, l.d + k));
    const t = localToUtc(
      { y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate() },
      h,
      min,
      tz,
    );
    if (t > afterMs) return t;
  }
  return afterMs + 24 * HOUR;
}

function minutesOf(s: string) {
  const { h, min } = hm(s);
  return h * 60 + min;
}

/** True while the person asked not to be disturbed (same rule as notify.ts inQuietHours). */
function quietAt(quiet: NotifyPrefs['quiet'], ms: number): boolean {
  if (!quiet.enabled) return false;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return false;
  let m: number;
  try {
    const l = localParts(ms, quiet.tz);
    m = l.h * 60 + l.min;
  } catch {
    const d = new Date(ms);
    m = d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  return from < to ? m >= from && m < to : m >= from || m < to;
}

/** `ms` itself when it is outside quiet hours, else the moment they end. */
export function afterQuiet(quiet: NotifyPrefs['quiet'], ms: number): number {
  if (!quietAt(quiet, ms)) return ms;
  try {
    return nextLocalTime(ms, quiet.tz, quiet.to);
  } catch {
    return ms + HOUR;
  }
}

/** The zone a member's own times are read in: their quiet-hours zone, unless it is the default. */
export function memberTz(prefs: Pick<NotifyPrefs, 'quiet'> | null, fallback?: string): string {
  const tz = prefs?.quiet.tz;
  return tz && tz !== 'UTC' ? tz : (fallback ?? DEFAULT_SCHEDULE_TZ);
}

/** The next daily digest after `afterMs`: the end of quiet hours, else 08:30, in the member's zone. */
export function nextDigestAt(prefs: Pick<NotifyPrefs, 'quiet'>, tz: string, afterMs: number) {
  const at =
    prefs.quiet.enabled && prefs.quiet.from !== prefs.quiet.to ? prefs.quiet.to : DIGEST_AT;
  return nextLocalTime(afterMs, prefs.quiet.enabled ? prefs.quiet.tz : tz, at);
}

/** What the scheduler knows of an ask already sent. */
export interface AskSent {
  n: number;
  lastAtMs: number;
}

/**
 * When the next message of a can't-run ask is due, or null when no more are (normal after its
 * one, low: the digest's job). `breaksQuiet`: the first urgent message goes out in quiet hours.
 */
export function nextAskAt(
  level: ScheduleUrgency,
  sent: AskSent | null,
  nowMs: number,
  quiet: NotifyPrefs['quiet'],
  tz: string,
): { atMs: number; breaksQuiet: boolean } | null {
  const n = sent?.n ?? 0;
  const last = sent?.lastAtMs ?? nowMs;
  switch (level) {
    case 'urgent':
      if (n === 0) return { atMs: nowMs, breaksQuiet: true };
      return { atMs: afterQuiet(quiet, last + ASK_URGENT_EVERY_MS), breaksQuiet: false };
    case 'high':
      if (n === 0) return { atMs: afterQuiet(quiet, nowMs), breaksQuiet: false };
      if (n === 1) return { atMs: afterQuiet(quiet, last + ASK_HIGH_AGAIN_MS), breaksQuiet: false };
      return {
        atMs: afterQuiet(quiet, nextLocalTime(last, tz, ASK_HIGH_DAILY_AT)),
        breaksQuiet: false,
      };
    case 'normal':
      return n === 0 ? { atMs: afterQuiet(quiet, nowMs), breaksQuiet: false } : null;
    case 'low':
      return null;
  }
}

/** The last line of an ask: what happens if he doesn't answer. */
export function askRepeatLine(level: ScheduleUrgency): string {
  switch (level) {
    case 'urgent':
      return 'I’ll remind you every 2 hours until you decide.';
    case 'high':
      return 'I’ll ask again in 4 hours, then daily at 09:00, until you decide.';
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Words

const FREQ_WORD: Record<string, string> = {
  once: 'One-off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
};

/** Why a run could not happen, in one plain line (≤ 300 characters). */
export function whyText(
  w:
    | { code: 'offline'; agent: string; lastSeenMs: number | null; tz: string }
    | { code: 'off'; sinceMs: number | null; tz: string }
    | { code: 'paused'; agent: string; reason?: string | null; removed?: boolean }
    | { code: 'hostDown'; fromMs: number | null; toMs: number; tz: string; more?: number }
    | { code: 'noStart'; agent: string }
    | { code: 'failed'; agent: string; error?: string | null }
    | { code: 'cliOld'; agent: string; version: string | null },
): string {
  const at = (ms: number, tz: string) => {
    try {
      return localClock(ms, tz);
    } catch {
      return new Date(ms).toISOString().slice(11, 16);
    }
  };
  let s: string;
  switch (w.code) {
    case 'offline':
      s = w.lastSeenMs
        ? `${w.agent} was offline (last seen ${at(w.lastSeenMs, w.tz)}).`
        : `${w.agent} was offline (never seen online).`;
      break;
    case 'off':
      s = `Agents are Off${w.sinceMs ? ` since ${at(w.sinceMs, w.tz)}` : ''}: nothing automated runs until you turn them on.`;
      break;
    case 'paused':
      s = w.removed
        ? `${w.agent} was removed from the organization.`
        : `${w.agent} is paused${w.reason ? ` (${w.reason})` : ''}.`;
      break;
    case 'hostDown':
      s = `Hivenod’s scheduler was down${w.fromMs ? ` from ${at(w.fromMs, w.tz)}` : ''} to ${at(w.toMs, w.tz)}.${
        w.more ? ` And ${w.more} earlier ${w.more === 1 ? 'run' : 'runs'} of it were missed.` : ''
      }`;
      break;
    case 'noStart':
      s = `${w.agent} did not start it within 30 minutes.`;
      break;
    case 'failed':
      s = `${w.agent} could not do it${w.error ? `: ${w.error.replace(/\s+/g, ' ').trim()}` : '.'}`;
      break;
    case 'cliOld':
      s = `${w.agent}’s Hivenod CLI${w.version ? ` ${w.version}` : ''} is too old for scheduled runs: update it (hivenod update).`;
      break;
  }
  return s.length > 300 ? `${s.slice(0, 299)}…` : s;
}

/** A run that could not happen, as the ask shows it. */
export interface RunAskFacts {
  level: ScheduleUrgency;
  freq: string;
  /** The schedule's title and rule sentence. */
  title: string;
  sentence: string;
  dueMs: number;
  tz: string;
  why: string;
  /** The next run if this one is skipped (null: none, e.g. a one-off). */
  nextMs: number | null;
  nowMs: number;
  /** How many messages of this ask went out before (0: the first). */
  n: number;
  url: string;
}

function whenWords(ms: number, nowMs: number, tz: string): string {
  const l = localParts(ms, tz);
  const day = localDate(ms, tz) === localDate(nowMs, tz) ? 'today' : null;
  const date = new Date(Date.UTC(l.y, l.m - 1, l.d));
  const words = date.toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  return `${day ?? `on ${words.replace(',', '')}`} at ${pad(l.h)}:${pad(l.min)}`;
}

function dateWords(ms: number, tz: string): string {
  const l = localParts(ms, tz);
  return new Date(Date.UTC(l.y, l.m - 1, l.d)).toLocaleDateString('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The ask's message (design 8): the bold first line says the level and that the run didn't
 * happen; then what, when, why, what skipping means, and when it asks again.
 */
export function runAskNotice(f: RunAskFacts): { title: string; body: string; url: string } {
  const freq = FREQ_WORD[f.freq] ?? 'Scheduled';
  const head =
    f.level === 'urgent'
      ? `URGENT · ${freq} run didn't happen`
      : f.level === 'high'
        ? `Important · ${freq} run didn't happen`
        : `${freq} run didn't happen`;
  const again = f.n > 0 ? ' (reminder)' : '';
  const skip =
    f.nextMs === null
      ? 'It was a one-off: if skipped, it does not happen at all.'
      : `If skipped, the next run is ${dateWords(f.nextMs, f.tz)}.`;
  const lines = [
    `${f.title} (${f.sentence}) did not run ${whenWords(f.dueMs, f.nowMs, f.tz)}.`,
    `Why: ${f.why}`,
    skip,
    askRepeatLine(f.level),
  ].filter(Boolean);
  return { title: `${head}${again}`, body: lines.join('\n'), url: f.url };
}

/** One line of the daily digest: a daily run that couldn't happen, or one coming up today. */
export function digestNotice(d: {
  dateMs: number;
  tz: string;
  missed: { title: string; sentence: string; why: string }[];
  coming: { atMs: number; title: string }[];
}): { title: string; body: string; url: string } {
  const day = new Date(d.dateMs).toLocaleDateString('en-GB', {
    timeZone: d.tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const lines = d.missed.map((m) => `Couldn't run: ${m.title} (${m.sentence}): ${m.why}`);
  if (d.coming.length)
    lines.push(
      `Coming up today: ${d.coming.map((c) => `${localClock(c.atMs, d.tz)} ${c.title}`).join(' · ')}`,
    );
  return { title: `Daily digest · ${day.replace(',', '')}`, body: lines.join('\n'), url: '/' };
}

/** The two fixed Try later choices: in 1 hour, tomorrow at 09:00 (the member's zone). */
export function laterChoices(nowMs: number, tz: string): { inHourMs: number; tomorrowMs: number } {
  let tomorrow = nextLocalTime(nowMs, tz, LATER_TOMORROW_AT);
  // "Tomorrow" is the next calendar day, also when it is before 09:00 now.
  if (localDate(tomorrow, tz) === localDate(nowMs, tz))
    tomorrow = nextLocalTime(tomorrow, tz, LATER_TOMORROW_AT);
  return { inHourMs: nowMs + HOUR, tomorrowMs: tomorrow };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * A typed Try later time, read in the member's zone: '14:30' (today, or tomorrow when passed),
 * 'tomorrow 10:00', '3 Nov 9:00' (this year, or next when passed), '2026-11-03 09:00'. Refused when
 * in the past or more than 35 days ahead.
 */
export function parseLaterTime(
  text: string,
  nowMs: number,
  tz: string,
): { ok: true; atMs: number } | { ok: false; error: string } {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const time = (s: string) => {
    const m = /^(\d{1,2})[:h.](\d{2})$/.exec(s) ?? /^(\d{1,2})$/.exec(s);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    return h <= 23 && min <= 59 ? { h, min } : null;
  };
  const at = (y: number, m: number, d: number, h: number, min: number) =>
    localToUtc({ y, m, d }, h, min, tz);
  const now = localParts(nowMs, tz);
  let ms: number | null = null;
  let m: RegExpExecArray | null;
  if ((m = /^(?:today )?(\S+)$/.exec(t)) && time(m[1]!)) {
    const c = time(m[1]!)!;
    ms = at(now.y, now.m, now.d, c.h, c.min);
    if (ms <= nowMs && !t.startsWith('today')) {
      const d = new Date(Date.UTC(now.y, now.m - 1, now.d + 1));
      ms = at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), c.h, c.min);
    }
  } else if ((m = /^tomorrow(?: at)? (\S+)$/.exec(t)) && time(m[1]!)) {
    const c = time(m[1]!)!;
    const d = new Date(Date.UTC(now.y, now.m - 1, now.d + 1));
    ms = at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), c.h, c.min);
  } else if (
    (m = /^(\d{1,2}) ([a-z]{3})[a-z]*(?: (\d{4}))?(?: at)? (\S+)$/.exec(t)) &&
    time(m[4]!)
  ) {
    const mon = MONTHS.indexOf(m[2]!) + 1;
    const day = Number(m[1]);
    if (mon > 0 && day >= 1 && day <= 31) {
      const c = time(m[4]!)!;
      ms = at(m[3] ? Number(m[3]) : now.y, mon, day, c.h, c.min);
      if (!m[3] && ms <= nowMs) ms = at(now.y + 1, mon, day, c.h, c.min);
    }
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})(?: |t)(\S+)$/.exec(t)) && time(m[4]!)) {
    const c = time(m[4]!)!;
    ms = at(Number(m[1]), Number(m[2]), Number(m[3]), c.h, c.min);
  }
  if (ms === null || Number.isNaN(ms))
    return {
      ok: false,
      error: 'I could not read that time. Try “14:30”, “tomorrow 10:00” or “3 Nov 9:00”.',
    };
  if (ms <= nowMs) return { ok: false, error: 'That time has passed. Pick a later one.' };
  if (ms > nowMs + 35 * 24 * HOUR)
    return { ok: false, error: 'Pick a time within the next 35 days.' };
  return { ok: true, atMs: ms };
}
