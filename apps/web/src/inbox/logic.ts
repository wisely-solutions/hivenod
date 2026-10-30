/**
 * Small helpers of the Today stack. Projects (and their items in Needs you) were removed in item
 * OE8FmrTaIxFVGcaeGG3N, slice 10: Today lists only Inbox threads.
 */

/** The kind filter: decisions (Your call) or questions (Needs you). */
export type InboxFilter = 'all' | 'approvals' | 'questions';

export function parseFilter(v: unknown): InboxFilter {
  return v === 'approvals' || v === 'questions' ? v : 'all';
}

/** "3 h", "2 d", "5 min": how long something has waited, short. */
export function waitLabel(since: number, now: number): string {
  const m = Math.max(0, Math.floor((now - since) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** After the entry at `key` leaves the list, which key takes focus: the one below, else above. */
export function nextKey(list: readonly { key: string }[], key: string): string | null {
  const i = list.findIndex((e) => e.key === key);
  if (i < 0) return list[0]?.key ?? null;
  return (list[i + 1] ?? list[i - 1])?.key ?? null;
}

export const SWIPE_THRESHOLD = 96;
export type SwipeAction = 'approve' | 'iterate' | null;
export function swipeAction(offsetX: number): SwipeAction {
  if (offsetX >= SWIPE_THRESHOLD) return 'approve';
  if (offsetX <= -SWIPE_THRESHOLD) return 'iterate';
  return null;
}
