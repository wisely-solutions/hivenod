/**
 * Syncing a calendar the agent reads itself into Hivenod (Inbox item fJnu6): the personal agent
 * lists the member's Google Calendar with its own Google access (Hivenod never connects to Google)
 * and hands the events, in the Google Calendar API's own shape, to `hivenod calendar sync`. This
 * plans the writes: which events to add or update (calendar_upsert), which to remove
 * (calendar_delete), which are unchanged, and which are skipped and why.
 *
 * - **full** (default): the events are everything in the window. A synced event of that source in
 *   the window that is no longer listed was deleted at the source: it is removed.
 * - **incremental**: only what changed since the source's last sync token. Nothing is removed for
 *   being absent; cancelled events are.
 *
 * Not busy, so removed (or never added): cancelled events, events shown as free
 * (`transparency: 'transparent'`, e.g. Google's all-day default), events the member declined,
 * working-location entries. All-day dates are taken as UTC days. An event longer than 31 days is
 * clipped to the window.
 *
 * Pure: no Firebase import. The Go port is cli/internal/actions/calendarsync.go (contract-tested).
 */
import { ActionError } from './actions';
import {
  MAX_CALENDAR_ATTENDEE_CHARS,
  MAX_CALENDAR_ATTENDEES,
  MAX_CALENDAR_EVENT_MS,
  MAX_CALENDAR_TITLE_CHARS,
  type CalendarEventInput,
} from './calendar';

/** Events per sync (a Google list page holds at most 2500). */
export const MAX_SYNC_ITEMS = 2500;
/** The default window: from a day ago to 30 days ahead. */
export const SYNC_PAST_MS = 24 * 3_600_000;
export const SYNC_AHEAD_MS = 30 * 24 * 3_600_000;
/** Widest window a full sync may cover. */
export const MAX_SYNC_WINDOW_MS = 62 * 24 * 3_600_000;

/** The parts of a Google Calendar API v3 Event that matter here. */
export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; self?: boolean; resource?: boolean; responseStatus?: string }[];
  transparency?: string;
  eventType?: string;
}

/** A synced event of this member and source as stored in Hivenod. */
export interface SyncedEvent {
  sourceEventId: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  attendees: string[];
  busyOnly: boolean;
  deleted: boolean;
}

export type SyncMode = 'full' | 'incremental';

export interface SyncPlanInput {
  source: string;
  mode: SyncMode;
  from: Date;
  to: Date;
  /** Keep only the time (no titles or attendees) of every event. */
  busyOnly?: boolean;
  existing: SyncedEvent[];
  items: GoogleEvent[];
}

export interface SyncPlan {
  upserts: Required<CalendarEventInput>[];
  /** Source event ids to remove. */
  deletes: string[];
  unchanged: number;
  skipped: { sourceEventId: string; reason: string }[];
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function googleTime(t: GoogleEvent['start']): { at: Date; allDay: boolean } | null {
  if (t?.dateTime !== undefined) {
    const d = RFC3339.test(t.dateTime) ? new Date(t.dateTime) : new Date(NaN);
    return Number.isNaN(d.getTime()) ? null : { at: d, allDay: false };
  }
  const m = DAY.exec(t?.date ?? '');
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Date.UTC rolls 2026-02-31 over to March: refuse such dates.
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return { at: d, allDay: true };
}

/** Why an event is not busy time, or null when it is. */
function notBusy(e: GoogleEvent): string | null {
  if (e.status === 'cancelled') return 'cancelled';
  if (e.eventType === 'workingLocation') return 'working location';
  if (e.transparency === 'transparent') return 'shown as free';
  if ((e.attendees ?? []).some((a) => a.self === true && a.responseStatus === 'declined'))
    return 'declined';
  return null;
}

type Normal =
  | { kind: 'busy'; event: Required<CalendarEventInput> }
  | { kind: 'gone' }
  | { kind: 'skip'; reason: string };

function normalize(e: GoogleEvent, input: SyncPlanInput, source: string): Normal {
  if (notBusy(e)) return { kind: 'gone' };
  const s = googleTime(e.start);
  const en = googleTime(e.end);
  if (!s || !en) return { kind: 'skip', reason: 'no valid start and end' };
  let start = s.at;
  let end = en.at;
  if (end.getTime() <= start.getTime()) return { kind: 'skip', reason: 'ends before it starts' };
  if (end.getTime() - start.getTime() > MAX_CALENDAR_EVENT_MS) {
    start = new Date(Math.max(start.getTime(), input.from.getTime()));
    end = new Date(Math.min(end.getTime(), input.to.getTime()));
    if (end.getTime() <= start.getTime())
      return { kind: 'skip', reason: 'longer than 31 days and outside the window' };
    if (end.getTime() - start.getTime() > MAX_CALENDAR_EVENT_MS)
      return { kind: 'skip', reason: 'longer than 31 days' };
  }
  const busyOnly = input.busyOnly === true;
  const attendees = busyOnly
    ? []
    : (e.attendees ?? [])
        .filter((a) => a.resource !== true)
        .map((a) => (a.email ?? '').trim().slice(0, MAX_CALENDAR_ATTENDEE_CHARS))
        .filter((a) => a !== '')
        .slice(0, MAX_CALENDAR_ATTENDEES);
  return {
    kind: 'busy',
    event: {
      source,
      sourceEventId: e.id!,
      title: busyOnly ? '' : (e.summary ?? '').trim().slice(0, MAX_CALENDAR_TITLE_CHARS),
      start,
      end,
      allDay: s.allDay && en.allDay,
      attendees,
      busyOnly,
    },
  };
}

function same(a: SyncedEvent, b: Required<CalendarEventInput>): boolean {
  return (
    !a.deleted &&
    a.title === b.title &&
    a.start.getTime() === b.start.getTime() &&
    a.end.getTime() === b.end.getTime() &&
    a.allDay === b.allDay &&
    a.busyOnly === b.busyOnly &&
    a.attendees.length === b.attendees.length &&
    a.attendees.every((x, i) => x === b.attendees[i])
  );
}

/** Plans one sync of a member's calendar from a source. */
export function planCalendarSync(input: SyncPlanInput): SyncPlan {
  const source = (input.source ?? '').trim();
  if (!source) throw new ActionError('Give the source (for example google)');
  if (input.mode !== 'full' && input.mode !== 'incremental')
    throw new ActionError('The mode is full or incremental');
  const from = input.from.getTime();
  const to = input.to.getTime();
  if (Number.isNaN(from) || Number.isNaN(to))
    throw new ActionError('from and to must be valid times');
  if (to <= from) throw new ActionError('to must be after from');
  if (to - from > MAX_SYNC_WINDOW_MS) throw new ActionError('Sync at most 62 days at once');
  if (input.items.length > MAX_SYNC_ITEMS)
    throw new ActionError(`At most ${MAX_SYNC_ITEMS} events per sync`);

  const have = new Map<string, SyncedEvent>();
  for (const e of input.existing) have.set(e.sourceEventId, e);

  // The last entry of an event wins; it keeps the place of its first one.
  const latest = new Map<string, Normal>();
  const skipped: SyncPlan['skipped'] = [];
  for (const e of input.items) {
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id.trim()) {
      skipped.push({ sourceEventId: '', reason: 'no id' });
      continue;
    }
    latest.set(id, normalize(e, input, source));
  }

  const upserts: SyncPlan['upserts'] = [];
  const deletes: string[] = [];
  let unchanged = 0;
  for (const [id, n] of latest) {
    const old = have.get(id);
    if (n.kind === 'skip') skipped.push({ sourceEventId: id, reason: n.reason });
    else if (n.kind === 'gone') {
      if (old && !old.deleted) deletes.push(id);
    } else if (old && same(old, n.event)) unchanged++;
    else upserts.push(n.event);
  }
  if (input.mode === 'full')
    for (const e of input.existing)
      if (
        !e.deleted &&
        !latest.has(e.sourceEventId) &&
        e.end.getTime() > from &&
        e.start.getTime() < to &&
        !deletes.includes(e.sourceEventId)
      )
        deletes.push(e.sourceEventId);
  return { upserts, deletes, unchanged, skipped };
}
