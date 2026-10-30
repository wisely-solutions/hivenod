/**
 * Today (item kt3E7u9EliL3q2veDDI0, design D): the decision logic of the Today page, free of React
 * and Firestore. Tidy-ups, the proposal as one readable sentence, the greeting.
 */
import {
  outcomeType,
  type InboxOutcome,
  type InboxThread,
  type OutcomeConfidence,
} from '@hive/shared';

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
      return `Booking (retired)${slot}${who}${quote(str(f.text))}`;
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

/** The texts of a Their reply draft on Today's card (the mockup: tag, one-liner, sub line). */
export interface TheirDraftText {
  /** "Their reply · step 3 of 5", "Their reply · follow-up" or "Their reply · reminder". */
  tag: string;
  /** "Send to Ana (Acme legal)?" or "Follow up with Ana?" */
  question: string;
  /** What it is about and how it goes: the need, the channel, or what they said. */
  sub: string;
  /** Mark done is offered on follow-ups and reminders (they already replied or were nudged). */
  canMarkDone: boolean;
}

export function theirDraftText(
  v: {
    who: string;
    org: string | null;
    need: string;
    channel: string;
    quote: string | null;
    ask: { kind: string } | null;
  },
  step: { number: number; total: number },
): TheirDraftText {
  const kind = v.ask?.kind ?? 'ask';
  const by = v.channel ? ` · by ${v.channel}` : '';
  if (kind === 'follow_up')
    return {
      tag: 'Their reply · follow-up',
      question: `Follow up with ${v.who}?`,
      sub: v.quote ? `${v.who} said: “${v.quote}”` : `${v.need}${by}`,
      canMarkDone: true,
    };
  if (kind === 'nudge')
    return {
      tag: 'Their reply · reminder',
      question: `Remind ${v.who}?`,
      sub: `${v.need}${by}`,
      canMarkDone: true,
    };
  return {
    tag: `Their reply · step ${step.number} of ${step.total}`,
    question: `Send to ${v.who}${v.org ? ` (${v.org})` : ''}?`,
    sub: `${v.need}${by}`,
    canMarkDone: false,
  };
}
