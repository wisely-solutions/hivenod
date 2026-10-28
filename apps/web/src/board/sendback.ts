import type { Decision } from '@hive/shared';

/** Quick tags offered in the send-back dialog (SPEC §9.4). Tags used before in a project are added. */
export const DEFAULT_SEND_BACK_TAGS = [
  'Wrong audience',
  'Too long',
  'Off brand voice',
  'Factually wrong',
  'Missing tests',
  'Not what I asked',
] as const;

export const MIN_REASON = 10;

type Past = Pick<Decision, 'stepId' | 'outcome' | 'toStepId' | 'tags'> & {
  at: { toMillis: () => number };
};

/** The target step most often chosen when sending back from `stepId`; ties go to the later step. */
export function mostCommonTarget(
  past: readonly Past[],
  stepId: string,
  order: readonly string[],
): string | null {
  const counts = new Map<string, number>();
  for (const d of past)
    if (d.outcome === 'sentBack' && d.stepId === stepId && d.toStepId)
      counts.set(d.toStepId, (counts.get(d.toStepId) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, n] of counts) {
    const b = best === null ? 0 : (counts.get(best) ?? 0);
    if (n > b || (n === b && order.indexOf(id) > order.indexOf(best ?? ''))) best = id;
  }
  return best;
}

/** Quick tags: the defaults, then any other tag already used in this project. */
export function quickTags(past: readonly Past[]): string[] {
  const out: string[] = [...DEFAULT_SEND_BACK_TAGS];
  for (const d of past) for (const t of d.tags) if (!out.includes(t)) out.push(t);
  return out;
}

const ordinal = (n: number) => {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
};

/**
 * "This is the 3rd 'wrong audience' rejection at Draft this month." Counts earlier send-backs and
 * stops from the same step in the same calendar month (the one with the most for a chosen tag).
 */
export function insightLine(
  past: readonly Past[],
  stepId: string,
  stepName: string,
  tags: readonly string[],
  now: Date,
): string | null {
  const inMonth = past.filter((d) => {
    if (d.stepId !== stepId || (d.outcome !== 'sentBack' && d.outcome !== 'stopped')) return false;
    const at = new Date(d.at.toMillis());
    return at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth();
  });
  let best: { tag: string | null; n: number } | null = null;
  for (const tag of tags) {
    const n = inMonth.filter((d) => d.tags.includes(tag)).length + 1;
    if (!best || n > best.n) best = { tag, n };
  }
  if (!best) {
    if (inMonth.length === 0) return null;
    best = { tag: null, n: inMonth.length + 1 };
  }
  const what = best.tag ? `'${best.tag.toLowerCase()}' rejection` : 'send-back';
  return `This is the ${ordinal(best.n)} ${what} at ${stepName} this month.`;
}

/** "Sent back to Draft from Review", "Approved at Review": a decision in plain words. */
export function decisionText(
  d: Pick<Decision, 'outcome' | 'stepId' | 'toStepId'>,
  stepName: (id: string) => string,
): string {
  const at = stepName(d.stepId);
  switch (d.outcome) {
    case 'approved':
      return `Approved at ${at}`;
    case 'sentBack':
      return `Sent back from ${at} to ${d.toStepId ? stepName(d.toStepId) : 'an earlier step'}`;
    case 'stopped':
      return `Stopped at ${at}`;
    default:
      return `Answered at ${at}`;
  }
}
