/**
 * Shared helpers of Decision insights (the thread view, slice 9): the range, the median and the
 * wait. (The project decision log went with Projects, slice 11.)
 */
export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DAY = 86_400_000;

export function parseRange(v: unknown): Range {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as Range) : 30;
}

/** Start of the window: the local midnight `days` days back, so the query key is stable all day. */
export function rangeStart(days: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - (days - 1) * DAY;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function formatWait(ms: number | null): string {
  if (ms === null) return 'n/a';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}
