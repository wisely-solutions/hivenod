/**
 * Today (item kt3E7u9EliL3q2veDDI0, design D): the decision logic of the Today page, free of React
 * and Firestore. Tidy-ups, the proposal as one readable sentence, the greeting, the slot choices
 * of a reply_book and how its reply text follows a new slot.
 */
import {
  outcomeType,
  type InboxOutcome,
  type InboxThread,
  type OutcomeConfidence,
} from '@hive/shared';
import { addDays, isWorkDay, startOfDay, WORK_HOURS } from '../calendar/logic';

const DAY = 86_400_000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "10:00" in the browser's zone. */
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** "Thu 29 Oct". */
export const dayLabel = (d: Date) =>
  `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
/** "Fri", or "Fri 6 Nov" beyond a week, for a due date. */
export function dueShort(ms: number, now: number): string {
  const d = new Date(ms);
  return Math.abs(ms - now) < 6 * DAY ? WEEKDAYS[d.getDay()]! : dayLabel(d);
}

export function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/** "THURSDAY 29 OCTOBER · 09:12" (shown in capitals by CSS). */
export function dateLine(now: number): string {
  const d = new Date(now);
  const day = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = d.toLocaleDateString('en-GB', { month: 'long' });
  return `${day} ${d.getDate()} ${month} · ${hhmm(d)}`;
}

/** "Sure", "Likely", "Unsure", and the bars lit (of 3). */
export const CONFIDENCE: Record<OutcomeConfidence, { word: string; bars: number }> = {
  high: { word: 'Sure', bars: 3 },
  medium: { word: 'Likely', bars: 2 },
  low: { word: 'Unsure', bars: 1 },
};

/**
 * A tidy-up (design 3.4): a batchable type (sends nothing), proposed with high confidence, on a
 * thread that is not urgent and not due within 7 days, as its only open proposal.
 */
export function isTidyUp(
  o: Pick<InboxOutcome, 'type' | 'confidence'> & { planId?: string | null },
  t: Pick<InboxThread, 'urgent' | 'due'>,
  openOnThread: number,
  now: number,
): boolean {
  const type = outcomeType(o.type);
  // A plan's step is decided in its plan (item qwFAWxZM5xkcE7PPjAzi), never in a tidy-up batch.
  if (o.planId) return false;
  if (!type?.batchable || o.confidence !== 'high' || openOnThread !== 1 || t.urgent) return false;
  const due = t.due ? t.due.toMillis() : null;
  return due === null || due > now + 7 * DAY;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const when = (iso: unknown) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? '' : `${dayLabel(new Date(t))}, ${hhmm(new Date(t))}`;
};
const quote = (s: string) => (s ? `: “${s}”` : '');
const tail = (s: string) => (s ? `: ${s}` : '');

/** The proposal's fields as one readable sentence (not a form). */
export function proposalSentence(
  type: string,
  f: Readonly<Record<string, string | boolean | undefined>>,
): string {
  switch (type) {
    case 'reply':
      return `${f.holding ? 'Holding reply' : 'Reply'}${quote(str(f.text))}`;
    case 'reply_book': {
      const s = typeof f.start === 'string' ? new Date(f.start) : null;
      const e = typeof f.end === 'string' ? new Date(f.end) : null;
      const slot =
        s && e && !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime())
          ? ` ${dayLabel(s)}, ${hhmm(s)}–${hhmm(e)}`
          : '';
      const who = str(f.with) ? ` with ${str(f.with)}` : '';
      return `Reply and book${slot}${who}${quote(str(f.text))}`;
    }
    case 'no_reply':
      return `Close it, no reply needed${tail(str(f.reason))}`;
    case 'make_it_work':
      return `Create the item “${str(f.title)}”${str(f.project) ? ` in ${str(f.project)}` : ''}`;
    case 'handover':
      return `Hand it over to ${str(f.to)}${tail(str(f.note))}`;
    case 'snooze':
      return `Snooze until ${when(f.until)}${tail(str(f.reason))}`;
    case 'nudge':
      return `Send a reminder${quote(str(f.text))}`;
    case 'ignore':
      return `Ignore it${tail(str(f.reason))}`;
    default:
      return outcomeType(type)?.label ?? type;
  }
}

/** "ignore 2, snooze “Hiring summary” to Mon, close 1 FYI". */
export function tidySummary(
  list: ReadonlyArray<{
    outcome: Pick<InboxOutcome, 'type' | 'fields'>;
    thread: { title: string };
  }>,
): string {
  const of = (t: string) => list.filter((x) => x.outcome.type === t);
  const parts: string[] = [];
  const ignore = of('ignore');
  if (ignore.length) parts.push(`ignore ${ignore.length}`);
  const snooze = of('snooze');
  if (snooze.length === 1) {
    const until = Date.parse(String(snooze[0]!.outcome.fields.until ?? ''));
    const to = Number.isNaN(until) ? '' : ` to ${WEEKDAYS[new Date(until).getDay()]}`;
    const title = snooze[0]!.thread.title || 'a thread';
    const short = title.length > 28 ? `${title.slice(0, 27).trimEnd()}…` : title;
    parts.push(`snooze “${short}”${to}`);
  } else if (snooze.length) parts.push(`snooze ${snooze.length}`);
  const close = of('no_reply');
  if (close.length) parts.push(`close ${close.length} ${close.length === 1 ? 'FYI' : 'FYIs'}`);
  return parts.join(', ');
}

export interface Slot {
  start: Date;
  end: Date;
}

/** Working hours of a day, from `now` on (rounded up to the half hour). */
function workWindow(day: Date, now: number): Slot | null {
  if (!isWorkDay(day)) return null;
  const from = new Date(day);
  from.setHours(WORK_HOURS.start, 0, 0, 0);
  const to = new Date(day);
  to.setHours(WORK_HOURS.end, 0, 0, 0);
  const half = 30 * 60_000;
  const lo = Math.max(from.getTime(), Math.ceil(now / half) * half);
  return lo < to.getTime() ? { start: new Date(lo), end: to } : null;
}

/**
 * The slots a reply_book card offers (design 3.6): the agent's slot, then up to 2 more free slots
 * of the same length in working hours, on that day or else the next working day.
 */
export function slotOptions(input: {
  start: Date;
  end: Date;
  busy: ReadonlyArray<{ start: Date; end: Date }>;
  now: number;
}): Slot[] {
  const len = input.end.getTime() - input.start.getTime();
  const out: Slot[] = [{ start: input.start, end: input.end }];
  if (!(len > 0)) return out;
  const taken = [...input.busy, { start: input.start, end: input.end }];
  const free = (s: number, e: number) =>
    !taken.some((b) => b.start.getTime() < e && b.end.getTime() > s);
  // That day, then the next working day.
  const days = [startOfDay(input.start)];
  for (let d = addDays(days[0]!, 1), n = 0; n < 7; d = addDays(d, 1), n++)
    if (isWorkDay(d)) {
      days.push(d);
      break;
    }
  for (const day of days) {
    if (out.length >= 3) break;
    const w = workWindow(day, input.now);
    if (!w) continue;
    for (let s = w.start.getTime(); s + len <= w.end.getTime() && out.length < 3;) {
      if (free(s, s + len)) {
        out.push({ start: new Date(s), end: new Date(s + len) });
        s += len;
      } else s += 30 * 60_000;
    }
  }
  return out;
}

/**
 * The reply with its time range moved to the new slot, when the old range ("10:00–11:00" or
 * "10:00-11:00") appears in it exactly once; otherwise null (the member checks it in Edit).
 */
export function replaceSlotText(
  text: string,
  oldStart: Date,
  oldEnd: Date,
  newStart: Date,
  newEnd: Date,
): string | null {
  const a = hhmm(oldStart);
  const b = hhmm(oldEnd);
  const re = new RegExp(`${a}\\s?([–-])\\s?${b}`, 'g');
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) return null;
  const dash = hits[0]![1];
  return text.replace(re, `${hhmm(newStart)}${dash}${hhmm(newEnd)}`);
}
