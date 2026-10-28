/**
 * The per-member Calendar (Inbox item w9SAfpJGEf4OnAz37epg, design 2026-10-28-hivenod-inbox-design).
 *
 * - Calendar events live in the organization they came from: `workspaces/{wid}/calendar/{id}`.
 *   Each belongs to one member (`memberUid`) and carries the details (title, attendees). Members
 *   and agents of that organization read them; nobody else does.
 * - Every event is mirrored, in the same batch, to the member's own busy store:
 *   `users/{uid}/busy/{wid}_{id}`, holding only start, end and the organization id (never a title).
 *   The member reads all their blocks; an agent reads the blocks of the members of its own
 *   organization (through its `agentHomes/{agentUid}` doc), across every organization, so
 *   `calendar_free` sees real availability without details and without any server.
 * - Deleting is a soft delete (`deleted: true`, details cleared) so every write stays an
 *   update tracked by one `calendar.changed` event (rules §5.3), whatever the batch size.
 *
 * Pure: no Firebase import. The Go port is cli/internal/actions/calendar.go (contract-tested).
 */
import { z } from 'zod';
import { ActionError, plan, SERVER_TIME, type ActionContext, type ActionPlan } from './actions';
import { actorRef, id, timestamp, uid } from './schema';

/** Events per calendar_upsert / calendar_delete batch (each also writes a busy block). */
export const MAX_CALENDAR_EVENTS_PER_WRITE = 100;
export const MAX_CALENDAR_TITLE_CHARS = 300;
export const MAX_CALENDAR_ATTENDEES = 50;
export const MAX_CALENDAR_ATTENDEE_CHARS = 320;
export const MAX_CALENDAR_SOURCE_CHARS = 40;
/** UTF-8 bytes of a source event id (keeps the derived document ids well under 1500 bytes). */
export const MAX_SOURCE_EVENT_ID_BYTES = 600;
/** Longest single event. */
export const MAX_CALENDAR_EVENT_MS = 31 * 24 * 3_600_000;
/** Widest range calendar_free looks at. */
export const MAX_FREE_RANGE_MS = 62 * 24 * 3_600_000;
export const DEFAULT_FREE_MIN_MINUTES = 30;

export const calendarPaths = {
  events: (w: string) => `workspaces/${w}/calendar`,
  event: (w: string, e: string) => `workspaces/${w}/calendar/${e}`,
  busy: (u: string) => `users/${u}/busy`,
  busyBlock: (u: string, b: string) => `users/${u}/busy/${b}`,
  agentHome: (a: string) => `agentHomes/${a}`,
} as const;

export const calendarEventSchema = z.object({
  memberUid: uid,
  title: z.string().max(MAX_CALENDAR_TITLE_CHARS),
  start: timestamp,
  end: timestamp,
  allDay: z.boolean(),
  attendees: z.array(z.string().max(MAX_CALENDAR_ATTENDEE_CHARS)).max(MAX_CALENDAR_ATTENDEES),
  /** Where it came from: 'google', 'outlook', 'hivenod' (a booking), … */
  source: z.string().min(1).max(MAX_CALENDAR_SOURCE_CHARS),
  sourceEventId: z.string().min(1),
  /** Only free/busy is known (or shared): no title, no attendees, shown as "Busy". */
  busyOnly: z.boolean(),
  deleted: z.boolean(),
  updatedBy: actorRef,
  updatedAt: timestamp,
  lastEventId: id,
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;

export const busyBlockSchema = z.object({
  workspaceId: id,
  start: timestamp,
  end: timestamp,
  deleted: z.boolean(),
  updatedAt: timestamp,
  lastEventId: id,
});
export type BusyBlock = z.infer<typeof busyBlockSchema>;

export interface CalendarEventInput {
  source: string;
  sourceEventId: string;
  title?: string;
  start: Date;
  end: Date;
  allDay?: boolean;
  attendees?: string[];
  busyOnly?: boolean;
}

export interface Slot {
  start: Date;
  end: Date;
}

// ---------- ids ----------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** base64url without padding. */
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The document id of a member's event from a source: the same source event always lands on the
 * same document (upserts deduplicate), and two members who share a meeting get one each.
 */
export function calendarEventId(memberUid: string, source: string, sourceEventId: string): string {
  return `${memberUid}_${b64url(utf8(`${source}\n${sourceEventId}`))}`;
}

/** The busy block mirroring event `eventId` of organization `workspaceId`. */
export function busyBlockId(workspaceId: string, eventId: string): string {
  return `${workspaceId}_${eventId}`;
}

// ---------- writes ----------

function requireCalendarWriter(ctx: ActionContext, memberUid: string) {
  if (!memberUid) throw new ActionError('Name the member whose calendar this is');
  if (ctx.actor.type === 'human' && memberUid !== ctx.actor.id)
    throw new ActionError('People change only their own calendar');
}

function checkCount(n: number) {
  if (n === 0) throw new ActionError('No events given');
  if (n > MAX_CALENDAR_EVENTS_PER_WRITE)
    throw new ActionError(
      `At most ${MAX_CALENDAR_EVENTS_PER_WRITE} events per call; send the rest in another call`,
    );
}

function validDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

interface CleanEvent {
  id: string;
  doc: Record<string, unknown>;
  start: Date;
  end: Date;
}

function cleanEvent(ctx: ActionContext, memberUid: string, e: CalendarEventInput, n: number) {
  const at = `Event ${n}`;
  const source = (e.source ?? '').trim();
  if (!source) throw new ActionError(`${at}: source is required (for example google or outlook)`);
  if (source.length > MAX_CALENDAR_SOURCE_CHARS)
    throw new ActionError(`${at}: source is at most ${MAX_CALENDAR_SOURCE_CHARS} characters`);
  const sourceEventId = e.sourceEventId ?? '';
  if (!sourceEventId.trim()) throw new ActionError(`${at}: sourceEventId is required`);
  if (utf8(sourceEventId).length > MAX_SOURCE_EVENT_ID_BYTES)
    throw new ActionError(`${at}: sourceEventId is at most ${MAX_SOURCE_EVENT_ID_BYTES} bytes`);
  if (!validDate(e.start) || !validDate(e.end))
    throw new ActionError(`${at}: start and end must be valid times`);
  const len = e.end.getTime() - e.start.getTime();
  if (len <= 0) throw new ActionError(`${at}: end must be after start`);
  if (len > MAX_CALENDAR_EVENT_MS) throw new ActionError(`${at}: an event lasts at most 31 days`);
  const busyOnly = e.busyOnly === true;
  const attendees = busyOnly
    ? []
    : (e.attendees ?? [])
        .map((a) => a.trim().slice(0, MAX_CALENDAR_ATTENDEE_CHARS))
        .filter((a) => a !== '')
        .slice(0, MAX_CALENDAR_ATTENDEES);
  const id = calendarEventId(memberUid, source, sourceEventId);
  return {
    id,
    start: e.start,
    end: e.end,
    doc: {
      memberUid,
      title: busyOnly ? '' : (e.title ?? '').trim().slice(0, MAX_CALENDAR_TITLE_CHARS),
      start: e.start,
      end: e.end,
      allDay: e.allDay === true,
      attendees,
      source,
      sourceEventId,
      busyOnly,
      deleted: false,
      updatedBy: { type: ctx.actor.type, id: ctx.actor.id },
      updatedAt: SERVER_TIME,
    },
  } satisfies CleanEvent;
}

/**
 * Adds or replaces events of one member's calendar in this organization (deduplicated by source
 * + source event id), each mirrored to the member's busy store. Agents write for any member of
 * their organization; a person only for themselves (a booking).
 */
export function calendarUpsert(
  ctx: ActionContext,
  input: { memberUid: string; events: CalendarEventInput[] },
): ActionPlan & { ids: string[] } {
  requireCalendarWriter(ctx, input.memberUid);
  checkCount(input.events.length);
  const clean: CleanEvent[] = input.events.map((e, i) =>
    cleanEvent(ctx, input.memberUid, e, i + 1),
  );
  const seen = new Set<string>();
  for (const [i, c] of clean.entries()) {
    if (seen.has(c.id))
      throw new ActionError(`Event ${i + 1}: the same source event is given twice`);
    seen.add(c.id);
  }
  const ids = clean.map((c) => c.id);
  return {
    ids,
    ...plan(
      ctx,
      'calendar.changed',
      {},
      { memberUids: [input.memberUid], upserted: clean.length, deleted: 0 },
      (eventId) => clean.flatMap((c) => upsertOps(ctx, input.memberUid, c, eventId)),
    ),
  };
}

function upsertOps(ctx: ActionContext, memberUid: string, c: CleanEvent, eventId: string) {
  return [
    {
      kind: 'set' as const,
      path: calendarPaths.event(ctx.workspaceId, c.id),
      data: { ...c.doc, lastEventId: eventId },
    },
    {
      kind: 'set' as const,
      path: calendarPaths.busyBlock(memberUid, busyBlockId(ctx.workspaceId, c.id)),
      data: {
        workspaceId: ctx.workspaceId,
        start: c.start,
        end: c.end,
        deleted: false,
        updatedAt: SERVER_TIME,
        lastEventId: eventId,
      },
    },
  ];
}

function deleteOps(ctx: ActionContext, e: { id: string; memberUid: string }, eventId: string) {
  return [
    {
      kind: 'update' as const,
      path: calendarPaths.event(ctx.workspaceId, e.id),
      data: {
        title: '',
        attendees: [],
        deleted: true,
        updatedBy: { type: ctx.actor.type, id: ctx.actor.id },
        updatedAt: SERVER_TIME,
        lastEventId: eventId,
      },
    },
    {
      kind: 'update' as const,
      path: calendarPaths.busyBlock(e.memberUid, busyBlockId(ctx.workspaceId, e.id)),
      data: { deleted: true, updatedAt: SERVER_TIME, lastEventId: eventId },
    },
  ];
}

/**
 * Removes events (soft delete: the details are cleared and the busy block freed). The caller
 * read them first, so each comes with its member.
 */
export function calendarDelete(
  ctx: ActionContext,
  input: { events: { id: string; memberUid: string }[] },
): ActionPlan {
  checkCount(input.events.length);
  const members: string[] = [];
  const seen = new Set<string>();
  for (const e of input.events) {
    requireCalendarWriter(ctx, e.memberUid);
    if (!e.id) throw new ActionError('An event id is missing');
    if (seen.has(e.id)) throw new ActionError(`The event ${e.id} is given twice`);
    seen.add(e.id);
    if (!members.includes(e.memberUid)) members.push(e.memberUid);
  }
  return plan(
    ctx,
    'calendar.changed',
    {},
    { memberUids: members, upserted: 0, deleted: input.events.length },
    (eventId) => input.events.flatMap((e) => deleteOps(ctx, e, eventId)),
  );
}

/**
 * Replaces one event by its copy in another calendar, in one batch (Inbox item fJnu6): after the
 * agent has put an approved booking (source hivenod) into the member's own calendar (for example
 * Google), the booking becomes that calendar's event, so the next sync updates it instead of
 * adding the same meeting twice. The replaced event is soft-deleted, its busy block freed.
 */
export function calendarMirror(
  ctx: ActionContext,
  input: { memberUid: string; replacedId: string; event: CalendarEventInput },
): ActionPlan & { id: string } {
  requireCalendarWriter(ctx, input.memberUid);
  if (!input.replacedId) throw new ActionError('Name the event it replaces');
  const c = cleanEvent(ctx, input.memberUid, input.event, 1);
  if (c.id === input.replacedId)
    throw new ActionError("That is the same event: give the other calendar's event id");
  const replaced = { id: input.replacedId, memberUid: input.memberUid };
  return {
    id: c.id,
    ...plan(
      ctx,
      'calendar.changed',
      {},
      { memberUids: [input.memberUid], upserted: 1, deleted: 1 },
      (eventId) => [
        ...upsertOps(ctx, input.memberUid, c, eventId),
        ...deleteOps(ctx, replaced, eventId),
      ],
    ),
  };
}

// ---------- free time ----------

/**
 * The free slots of `[from, to)` around busy blocks (from any organization), at least
 * `minMinutes` long, oldest first. Overlapping and touching blocks merge; blocks outside the
 * range are ignored.
 */
export function freeSlots(input: {
  from: Date;
  to: Date;
  busy: { start: Date; end: Date }[];
  minMinutes?: number;
}): Slot[] {
  const { from, to } = input;
  if (!validDate(from) || !validDate(to)) throw new ActionError('from and to must be valid times');
  const range = to.getTime() - from.getTime();
  if (range <= 0) throw new ActionError('to must be after from');
  if (range > MAX_FREE_RANGE_MS) throw new ActionError('Look at most 62 days ahead at once');
  const min = input.minMinutes ?? DEFAULT_FREE_MIN_MINUTES;
  if (!Number.isInteger(min) || min < 1 || min > 1440)
    throw new ActionError('minMinutes is a whole number from 1 to 1440');
  const lo = from.getTime();
  const hi = to.getTime();
  const blocks = input.busy
    .map((b) => [Math.max(b.start.getTime(), lo), Math.min(b.end.getTime(), hi)] as const)
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Slot[] = [];
  let cursor = lo;
  const push = (s: number, e: number) => {
    if (e - s >= min * 60_000) out.push({ start: new Date(s), end: new Date(e) });
  };
  for (const [s, e] of blocks) {
    if (s > cursor) push(cursor, s);
    if (e > cursor) cursor = e;
  }
  if (hi > cursor) push(cursor, hi);
  return out;
}
