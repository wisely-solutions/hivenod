/**
 * Shared bits of the Activity screens (the thread feed, slice 9): paging, the index-building
 * notice, days and times. (The item event feed and agent runs went with Projects, slice 11.)
 */

export const PAGE_SIZE = 50;

/** `Live` error code for a query that needs a Firestore index which is still being built. */
export const INDEX_BUILDING = 'index-building';

/** Firestore answers failed-precondition while a composite index is CREATING (or missing). */
export function isIndexBuilding(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'failed-precondition'
  );
}

export const INDEX_BUILDING_TEXT =
  'Hivenod was just updated and is still preparing this view. Try again in a few minutes.';
const DAY = 86_400_000;

// ---------- days and times ----------

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - DAY)) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(new Date(ms).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function groupByDay<T extends { data: { at: { toMillis: () => number } } }>(
  rows: T[],
  now: number,
): Array<{ key: string; label: string; rows: T[] }> {
  const out: Array<{ key: string; label: string; rows: T[] }> = [];
  for (const r of rows) {
    const ms = r.data.at.toMillis();
    const key = dayKey(ms);
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else out.push({ key, label: dayLabel(ms, now), rows: [r] });
  }
  return out;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
