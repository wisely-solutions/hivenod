/**
 * Scheduled tasks, slice 5: what the proposal card shows of a proposed schedule (design 9.2,
 * propose.png). Pure: the rule in words, the next 3 runs (computed, never read), each run's
 * thread title, the plan of each run and what happens when a run can't happen.
 */
import {
  DEFAULT_SCHEDULE_TZ,
  fillPlaceholders,
  nextRuns,
  outcomeType,
  ruleSentence,
  tzCity,
  urgencyOf,
  type Occurrence,
  type ScheduleOf,
  type ScheduleFreq,
  type ScheduleRule,
} from '@hive/shared';
import { stepTitle } from './plan';

const EVERY: Record<ScheduleFreq, string> = {
  once: 'once',
  daily: 'every day',
  weekly: 'every week',
  monthly: 'every month',
  quarterly: 'every quarter',
  yearly: 'every year',
};

const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Monthly · day 1 · 09:00 (Lisbon)": the rule with its zone always named. */
export function sentenceWithZone(rule: ScheduleRule): string {
  const tz = rule.tz ?? DEFAULT_SCHEDULE_TZ;
  return `${ruleSentence(rule, { viewerTz: tz })} (${tzCity(tz)})`;
}

/** The person's line when a run can't happen (design 8: the rarer, the louder). */
export function cantRunText(freq: ScheduleFreq): string {
  switch (urgencyOf(freq)) {
    case 'urgent':
      return 'You’re told at once (urgent), then every 2 h until you decide.';
    case 'high':
      return 'You’re told at once (high), reminded after 4 h, then daily at 09:00.';
    case 'normal':
      return 'You’re told once, with Run now, Try later or Skip.';
    case 'low':
      return 'A line in your daily digest; a message after 3 misses in a row.';
  }
}

export interface ScheduleCard {
  /** "Set up “Send invoices” every month?" (a change: "Change “Send invoices”?"). */
  ask: string;
  /** The rule in words with its zone. */
  sentence: string;
  /** "Sun 1 Nov 2026 · 09:00", up to 3 (none left: empty). */
  runs: string[];
  /** The first run's thread title ("Send invoices · Nov 2026"), or the template. */
  runTitle: string;
  steps: ScheduleStepView[];
  cantRun: string;
}

/** "Sun 1 Nov 2026 · 09:00" from an occurrence's local "YYYY-MM-DD HH:MM". */
export function runDayWords(local: string): string {
  const [date, time] = local.split(' ');
  const [y, m, d] = date!.split('-').map(Number);
  const wd = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return `${WEEKDAY[(wd + 6) % 7]} ${d} ${MONTH[m! - 1]} ${y} · ${time}`;
}

export interface ScheduleStepView {
  title: string;
  who: 'agent' | 'you';
}

/**
 * The plan of each run in words, placeholders read as `occ`'s ("{period}" → "Nov 2026"), like
 * its thread title; without an occurrence they stay as written.
 */
export function scheduleSteps(
  steps: ScheduleOf['steps'],
  occ: Occurrence | null,
): ScheduleStepView[] {
  const fill = (v: unknown) => (typeof v === 'string' && occ ? fillPlaceholders(v, occ) : v);
  return steps.map((st) => {
    const fields = Object.fromEntries(Object.entries(st.fields).map(([k, v]) => [k, fill(v)]));
    return {
      title:
        st.type === 'approval'
          ? String(fields.what ?? '') || 'Your approval'
          : stepTitle(st.type, fields) || (outcomeType(st.type)?.label ?? st.type),
      who: st.type === 'approval' ? 'you' : 'agent',
    };
  });
}

/** The card of a proposed schedule, at `now`. */
export function scheduleCard(s: ScheduleOf, now: number): ScheduleCard {
  let occ: ReturnType<typeof nextRuns> = [];
  try {
    occ = nextRuns(s.rule, now, 3);
  } catch {
    occ = [];
  }
  const runs = occ.map((o) => runDayWords(o.local));
  const steps = scheduleSteps(s.steps, occ[0] ?? null);
  return {
    ask: s.replaces
      ? `Change “${s.title}”?`
      : s.rule.freq === 'once' && runs[0]
        ? `Set up “${s.title}” on ${runs[0].split(' · ')[0]}?`
        : `Set up “${s.title}” ${EVERY[s.rule.freq]}?`,
    sentence: sentenceWithZone(s.rule),
    runs,
    runTitle: occ[0] ? fillPlaceholders(s.runTitle, occ[0]) : s.runTitle,
    steps,
    cantRun: cantRunText(s.rule.freq),
  };
}
