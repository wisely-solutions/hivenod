/**
 * The Calendar view (Inbox item w9SAf): what to show for a day or a week, and where. Pure, local
 * time (the browser's zone), so it is unit-tested without Firestore.
 */

export type CalView = 'day' | 'week';

export interface CalBlock {
  id: string;
  start: Date;
  end: Date;
  /** '' for busy time. */
  title: string;
  /**
   * busy: time from another organization, or a busy-only event: no details, greyed. proposed: a
   * booking an agent proposed (a reply_book waiting for the member's OK), dashed (item kt3E7).
   */
  kind: 'event' | 'busy' | 'proposed';
  /** Where it is from (organization, or the member when it is someone else's). */
  label: string;
  allDay: boolean;
  /** The organization's colour (item kt3E7). */
  color?: string;
  /** For a proposed booking: the thread it opens. */
  proposal?: { wid: string; tid: string; oid: string };
}

export interface Placed {
  block: CalBlock;
  /** Minutes from the day's midnight, clipped to the day. */
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

const DAY_MS = 86_400_000;

/**
 * Working hours (item kt3E7u9EliL3q2veDDI0): Monday to Friday, 09:00-18:00 in the browser's zone.
 * A constant: a setting is out of scope. Free time and the slot strip count only this time.
 */
export const WORK_HOURS = { days: [1, 2, 3, 4, 5], start: 9, end: 18 } as const;
export const isWorkDay = (d: Date) => (WORK_HOURS.days as readonly number[]).includes(d.getDay());

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** Weeks start on Monday. */
export function startOfWeek(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

export function rangeOf(view: CalView, anchor: Date): { from: Date; to: Date; days: Date[] } {
  const from = view === 'day' ? startOfDay(anchor) : startOfWeek(anchor);
  const n = view === 'day' ? 1 : 7;
  const days = Array.from({ length: n }, (_, i) => addDays(from, i));
  return { from, to: addDays(from, n), days };
}

export function shift(view: CalView, anchor: Date, dir: -1 | 1): Date {
  return addDays(anchor, dir * (view === 'day' ? 1 : 7));
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Blocks that touch [from, to), not all-day. */
function overlapping(blocks: readonly CalBlock[], from: Date, to: Date) {
  return blocks.filter((b) => b.end > from && b.start < to);
}

/** All-day blocks shown in the strip above a day. */
export function allDayOn(blocks: readonly CalBlock[], day: Date): CalBlock[] {
  return overlapping(
    blocks.filter((b) => b.allDay),
    day,
    addDays(day, 1),
  ).sort((a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title));
}

/**
 * Timed blocks of one day, placed: overlapping blocks share the width in lanes (a cluster of
 * overlaps gets as many lanes as it needs at most at once). Blocks shorter than 15 minutes are
 * drawn 15 minutes tall so they stay readable and tappable.
 */
export function layoutDay(blocks: readonly CalBlock[], day: Date): Placed[] {
  const lo = day.getTime();
  const hi = addDays(day, 1).getTime();
  const list = overlapping(
    blocks.filter((b) => !b.allDay),
    day,
    addDays(day, 1),
  )
    .map((block) => {
      const s = Math.max(block.start.getTime(), lo);
      const e = Math.min(block.end.getTime(), hi);
      const top = (s - lo) / 60_000;
      return { block, top, height: Math.max((e - s) / 60_000, 15) };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height || a.block.id.localeCompare(b.block.id));
  const out: Placed[] = [];
  let cluster: Placed[] = [];
  let clusterEnd = -1;
  let laneEnds: number[] = [];
  const flush = () => {
    const lanes = laneEnds.length;
    for (const p of cluster) p.lanes = lanes;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };
  for (const x of list) {
    if (cluster.length && x.top >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= x.top);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = x.top + x.height;
    const p: Placed = { ...x, lane, lanes: 1 };
    cluster.push(p);
    clusterEnd = Math.max(clusterEnd, x.top + x.height);
  }
  if (cluster.length) flush();
  return out;
}

const time = (d: Date) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

/** "09:00–09:30". */
export function timeRange(b: Pick<CalBlock, 'start' | 'end' | 'allDay'>): string {
  if (b.allDay) return 'All day';
  return `${time(b.start)}–${time(b.end)}`;
}

/** What a screen reader hears for a block. */
export function blockLabel(b: CalBlock): string {
  const what =
    b.kind === 'busy'
      ? 'Busy'
      : b.kind === 'proposed'
        ? `${b.title || 'Meeting'} · proposed`
        : b.title || '(no title)';
  return `${what}, ${timeRange(b)}${b.label ? `, ${b.label}` : ''}`;
}

/** The heading of the shown range: "Mon 2 Nov 2026" or "2–8 Nov 2026". */
export function rangeTitle(view: CalView, anchor: Date): string {
  const { from, to } = rangeOf(view, anchor);
  if (view === 'day')
    return from.toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  const last = new Date(to.getTime() - DAY_MS / 2);
  const a = from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const b = last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${a} – ${b}`;
}

/** Merged [start, end) intervals (ms) of the timed blocks, clipped to [lo, hi). */
function merged(blocks: readonly CalBlock[], lo: number, hi: number): Array<[number, number]> {
  const xs = blocks
    .filter((b) => !b.allDay)
    .map(
      (b) => [Math.max(b.start.getTime(), lo), Math.min(b.end.getTime(), hi)] as [number, number],
    )
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of xs) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Free time in a day's working hours (item kt3E7, design 2.6): the gaps of at least 30 minutes
 * between the timed blocks, from 09:00 to 18:00 on working days.
 */
export function freeInWorkHours(
  blocks: readonly CalBlock[],
  day: Date,
  minMinutes = 30,
): Array<{ start: Date; end: Date }> {
  if (!isWorkDay(day)) return [];
  const lo = new Date(day).setHours(WORK_HOURS.start, 0, 0, 0);
  const hi = new Date(day).setHours(WORK_HOURS.end, 0, 0, 0);
  const out: Array<{ start: Date; end: Date }> = [];
  let cursor = lo;
  const push = (s: number, e: number) => {
    if (e - s >= minMinutes * 60_000) out.push({ start: new Date(s), end: new Date(e) });
  };
  for (const [s, e] of merged(blocks, lo, hi)) {
    push(cursor, s);
    cursor = Math.max(cursor, e);
  }
  push(cursor, hi);
  return out;
}

/** The header totals of a range: time booked (overlaps once) and free in working hours. */
export function weekTotals(
  blocks: readonly CalBlock[],
  days: readonly Date[],
): { bookedMinutes: number; freeMinutes: number } {
  let booked = 0;
  let free = 0;
  for (const d of days) {
    const lo = startOfDay(d).getTime();
    for (const [s, e] of merged(blocks, lo, lo + DAY_MS)) booked += e - s;
    for (const f of freeInWorkHours(blocks, d)) free += f.end.getTime() - f.start.getTime();
  }
  return { bookedMinutes: Math.round(booked / 60_000), freeMinutes: Math.round(free / 60_000) };
}

/** "2 h 15", "30 min", "0 h". */
export function hoursText(minutes: number): string {
  if (minutes > 0 && minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m}` : `${h} h`;
}
