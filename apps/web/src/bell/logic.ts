/** The bell's pure parts (item 3ENs): filters, day groups and which entries are live. */
import { bellNeedsYou, type BellEntry } from '@hive/shared';

export interface BellRow {
  id: string;
  data: BellEntry;
}

export type BellFilter = 'all' | 'unread' | 'needs';

/** The bell's query, shared with the index test: equality on workspaceId, newest first by at. */
export const BELL_QUERY = { equal: 'workspaceId', range: 'at', direction: 'desc' } as const;

export function filterRows(rows: readonly BellRow[], f: BellFilter): BellRow[] {
  if (f === 'unread') return rows.filter((r) => r.data.readAt === null);
  if (f === 'needs') return rows.filter((r) => bellNeedsYou(r.data.kind));
  return [...rows];
}

export function unreadCount(rows: readonly BellRow[]): number {
  return rows.reduce((n, r) => n + (r.data.readAt === null ? 1 : 0), 0);
}

const startOfDay = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", or a short date in the person's own time zone. */
export function dayLabel(at: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day >= today) return 'Today';
  if (day >= startOfDay(today - 1)) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** Rows (already newest first) in day groups, in order. */
export function groupByDay(
  rows: readonly BellRow[],
  now: number,
): { label: string; rows: BellRow[] }[] {
  const out: { label: string; rows: BellRow[] }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.data.at, now);
    const last = out[out.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else out.push({ label, rows: [r] });
  }
  return out;
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** How far before the session started an event may lie and still pop up (writes take a moment). */
export const LIVE_SLACK_MS = 60_000;

/**
 * The entries that should pop up as a toast: new since the previous snapshot (never the first
 * one: whatever was there at sign-in is history), unread, and from this session.
 */
export function liveArrivals(
  previous: ReadonlySet<string> | null,
  rows: readonly BellRow[],
  sessionStart: number,
): BellRow[] {
  if (!previous) return [];
  return rows.filter(
    (r) =>
      !previous.has(r.id) && r.data.readAt === null && r.data.at >= sessionStart - LIVE_SLACK_MS,
  );
}
