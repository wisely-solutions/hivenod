/**
 * The calendar tools (Inbox item w9SAf): calendar_upsert, calendar_delete and calendar_free, as
 * the agent. The Go port is cli/internal/hive/calendar.go; both give the same answers
 * (test/go.integration.test.ts).
 */
import {
  ActionError,
  calendarDelete,
  calendarEventId,
  calendarPaths,
  calendarUpsert,
  DEFAULT_FREE_MIN_MINUTES,
  freeSlots,
  MAX_CALENDAR_EVENTS_PER_WRITE,
  paths,
  planCalendarSync,
  SYNC_AHEAD_MS,
  SYNC_PAST_MS,
  type GoogleEvent,
  type SyncedEvent,
  type SyncMode,
  type ActionContext,
  type ActionPlan,
  type CalendarEventInput,
} from '@hive/shared';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  Timestamp,
  where,
  type Firestore,
} from 'firebase/firestore';
import { writeFileSync } from 'node:fs';
import { HiveError } from './errors';

/** RFC 3339 with a zone (Z or ±hh:mm), seconds optional: what both CLIs read the same way. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

export function parseTime(v: string, what: string): Date {
  const d = RFC3339.test(v ?? '') ? new Date(v) : new Date(NaN);
  if (Number.isNaN(d.getTime()))
    throw new HiveError(
      `${what} must be a time like 2026-11-02T09:00:00Z or 2026-11-02T10:00:00+01:00 (got ${JSON.stringify(v ?? '')}).`,
    );
  return d;
}

const iso = (d: Date) => d.toISOString();

export interface CalendarEventArg {
  source: string;
  sourceEventId: string;
  title?: string;
  start: string;
  end: string;
  allDay?: boolean;
  attendees?: string[];
  busyOnly?: boolean;
}

interface Deps {
  db: Firestore;
  ctx: ActionContext;
  write: (p: Pick<ActionPlan, 'ops'>) => Promise<void>;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ActionError) throw new HiveError(e.message);
    throw e;
  }
}

/** Uid of a member of this organization, from their uid, email or exact name (any case). */
export async function resolveMember(d: Deps, member: string | undefined): Promise<string> {
  const ws = await getDoc(doc(d.db, paths.workspace(d.ctx.workspaceId)));
  const uids = Object.keys((ws.data()?.memberRoles ?? {}) as Record<string, string>).sort();
  const want = (member ?? '').trim();
  if (!want) {
    if (uids.length === 1) return uids[0]!;
    throw new HiveError(
      'Name the member (their uid, email or name): this organization has more than one.',
    );
  }
  if (uids.includes(want)) return want;
  const cards = await Promise.all(
    uids.map(async (u) => {
      const s = await getDoc(doc(d.db, paths.member(d.ctx.workspaceId, u)));
      const c = s.data() as { name?: string; email?: string } | undefined;
      return { uid: u, name: c?.name ?? '', email: c?.email ?? '' };
    }),
  );
  const low = want.toLowerCase();
  const hits = cards.filter((c) => c.email.toLowerCase() === low || c.name.toLowerCase() === low);
  if (hits.length === 1) return hits[0]!.uid;
  throw new HiveError(
    hits.length > 1
      ? `More than one member is called ${JSON.stringify(want)}: use their email or uid.`
      : `${JSON.stringify(want)} is not a member of this organization.`,
  );
}

export async function upsertEvents(
  d: Deps,
  member: string | undefined,
  events: CalendarEventArg[],
) {
  const memberUid = await resolveMember(d, member);
  const input: CalendarEventInput[] = events.map((e, i) => ({
    source: e.source,
    sourceEventId: e.sourceEventId,
    title: e.title,
    start: parseTime(e.start, `Event ${i + 1}: start`),
    end: parseTime(e.end, `Event ${i + 1}: end`),
    allDay: e.allDay,
    attendees: e.attendees,
    busyOnly: e.busyOnly,
  }));
  const p = wrap(() => calendarUpsert(d.ctx, { memberUid, events: input }));
  await d.write(p);
  return {
    member: memberUid,
    ids: p.ids,
    upserted: p.ids.length,
    note: `Saved ${p.ids.length} event${p.ids.length === 1 ? '' : 's'} in this organization's calendar of the member, with their busy time (no details) for the other organizations they are in. The same source event id updates the same event.`,
  };
}

export async function deleteEvents(
  d: Deps,
  args: { ids?: string[]; member?: string; source?: string; sourceEventIds?: string[] },
) {
  const ids = [...(args.ids ?? [])];
  if ((args.sourceEventIds ?? []).length > 0) {
    if (!(args.source ?? '').trim())
      throw new HiveError('Give the source of the sourceEventIds (for example google).');
    const memberUid = await resolveMember(d, args.member);
    for (const s of args.sourceEventIds!)
      ids.push(calendarEventId(memberUid, args.source!.trim(), s));
  }
  if (ids.length === 0) throw new HiveError('Give ids, or source and sourceEventIds.');
  const found: { id: string; memberUid: string }[] = [];
  const notFound: string[] = [];
  for (const id of [...new Set(ids)]) {
    const s = await getDoc(doc(d.db, calendarPaths.event(d.ctx.workspaceId, id)));
    const data = s.data() as { memberUid?: string; deleted?: boolean } | undefined;
    if (!data || data.deleted || !data.memberUid) notFound.push(id);
    else found.push({ id, memberUid: data.memberUid });
  }
  if (found.length > 0) await d.write(wrap(() => calendarDelete(d.ctx, { events: found })));
  return {
    deleted: found.length,
    ids: found.map((f) => f.id),
    notFound,
    note:
      found.length > 0
        ? `Removed ${found.length} event${found.length === 1 ? '' : 's'} and freed the busy time.`
        : 'Nothing to remove: no such events in this organization.',
  };
}

/** Says once which organization this agent is in, so it may read its members' busy time. */
async function ensureHome(d: Deps): Promise<void> {
  const ref = doc(d.db, calendarPaths.agentHome(d.ctx.actor.id));
  const s = await getDoc(ref);
  if (s.exists()) return;
  await setDoc(ref, { workspaceId: d.ctx.workspaceId });
}

export async function freeTime(
  d: Deps,
  args: { member?: string; from: string; to: string; minMinutes?: number },
) {
  const memberUid = await resolveMember(d, args.member);
  const from = parseTime(args.from, 'from');
  const to = parseTime(args.to, 'to');
  const minMinutes = args.minMinutes ?? DEFAULT_FREE_MIN_MINUTES;
  wrap(() => freeSlots({ from, to, busy: [], minMinutes }));
  await ensureHome(d);
  const snap = await getDocs(
    query(
      collection(d.db, 'users', memberUid, 'busy'),
      where('end', '>', Timestamp.fromDate(from)),
    ),
  );
  const busy: { start: Date; end: Date }[] = [];
  for (const s of snap.docs) {
    const b = s.data() as { start: Timestamp; end: Timestamp; deleted: boolean };
    if (b.deleted) continue;
    const start = b.start.toDate();
    if (start >= to) continue;
    busy.push({ start, end: b.end.toDate() });
  }
  const free = wrap(() => freeSlots({ from, to, busy, minMinutes }));
  return {
    member: memberUid,
    from: iso(from),
    to: iso(to),
    minMinutes,
    free: free.map((f) => ({ start: iso(f.start), end: iso(f.end) })),
    busyBlocks: busy.length,
    note: 'Free time across all the organizations the member is in (busy time only, never details). Times are UTC; propose slots in the member’s own time zone and working hours.',
  };
}

// ---------- sync (item fJnu6) ----------

/**
 * What the agent read from the source with its own access: a Google Calendar API events list
 * (`{ items, nextSyncToken }`, single events expanded) or a plain array of events. Hivenod never
 * connects to Google; the personal agent fills this, and tests use a stub.
 */
export interface SyncFeed {
  items: GoogleEvent[];
  nextSyncToken?: string;
}

/** Reads a feed from JSON text: `{ "items": [...], "nextSyncToken": "…" }` or `[...]`. */
export function parseFeed(text: string, name: string): SyncFeed {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new HiveError(`${name}: not JSON.`);
  }
  if (Array.isArray(v)) return { items: v as GoogleEvent[] };
  const o = v as { items?: unknown; nextSyncToken?: unknown } | null;
  if (!o || typeof o !== 'object' || !Array.isArray(o.items))
    throw new HiveError(
      `${name}: give a Google Calendar events list ({"items": [...]}) or an array of events.`,
    );
  return {
    items: o.items as GoogleEvent[],
    ...(typeof o.nextSyncToken === 'string' ? { nextSyncToken: o.nextSyncToken } : {}),
  };
}

export interface SyncArgs {
  member?: string;
  source?: string;
  incremental?: boolean;
  busyOnly?: boolean;
  from?: string;
  to?: string;
  feed: SyncFeed;
  /** For tests: the clock. */
  now?: number;
}

/**
 * Syncs a member's calendar from a source into this organization: adds and updates what
 * changed, removes what is gone (cancelled, declined, free, or, in a full sync, no longer listed in
 * the window), in batches of 100, each with its busy blocks.
 */
export async function syncEvents(d: Deps, a: SyncArgs) {
  const memberUid = await resolveMember(d, a.member);
  const source = (a.source ?? 'google').trim();
  const now = a.now ?? Date.now();
  const from = a.from ? parseTime(a.from, 'from') : new Date(now - SYNC_PAST_MS);
  const to = a.to ? parseTime(a.to, 'to') : new Date(now + SYNC_AHEAD_MS);
  const mode: SyncMode = a.incremental ? 'incremental' : 'full';
  wrap(() => planCalendarSync({ source, mode, from, to, existing: [], items: [] }));
  const snap = await getDocs(
    query(
      collection(d.db, `workspaces/${d.ctx.workspaceId}/calendar`),
      where('memberUid', '==', memberUid),
      where('end', '>', Timestamp.fromDate(from)),
    ),
  );
  const existing: SyncedEvent[] = [];
  for (const s of snap.docs) {
    const e = s.data() as {
      source: string;
      sourceEventId: string;
      title: string;
      start: Timestamp;
      end: Timestamp;
      allDay: boolean;
      attendees: string[];
      busyOnly: boolean;
      deleted: boolean;
    };
    if (e.source !== source) continue;
    existing.push({
      sourceEventId: e.sourceEventId,
      title: e.title,
      start: e.start.toDate(),
      end: e.end.toDate(),
      allDay: e.allDay,
      attendees: e.attendees,
      busyOnly: e.busyOnly,
      deleted: e.deleted,
    });
  }
  existing.sort((x, y) =>
    x.sourceEventId < y.sourceEventId ? -1 : x.sourceEventId > y.sourceEventId ? 1 : 0,
  );
  const p = wrap(() =>
    planCalendarSync({
      source,
      mode,
      from,
      to,
      busyOnly: a.busyOnly,
      existing,
      items: a.feed.items,
    }),
  );
  const n = MAX_CALENDAR_EVENTS_PER_WRITE;
  for (let i = 0; i < p.upserts.length; i += n)
    await d.write(
      wrap(() => calendarUpsert(d.ctx, { memberUid, events: p.upserts.slice(i, i + n) })),
    );
  for (let i = 0; i < p.deletes.length; i += n)
    await d.write(
      wrap(() =>
        calendarDelete(d.ctx, {
          events: p.deletes
            .slice(i, i + n)
            .map((sid) => ({ id: calendarEventId(memberUid, source, sid), memberUid })),
        }),
      ),
    );
  return {
    member: memberUid,
    source,
    mode,
    from: iso(from),
    to: iso(to),
    upserted: p.upserts.length,
    deleted: p.deletes.length,
    unchanged: p.unchanged,
    skipped: p.skipped,
    nextSyncToken: a.feed.nextSyncToken ?? null,
    note: `Synced ${source} (${mode}): ${p.upserts.length} added or updated, ${p.deletes.length} removed, ${p.unchanged} unchanged${p.skipped.length ? `, ${p.skipped.length} skipped` : ''}.`,
  };
}

/**
 * `--state FILE`: keeps the source's sync token for the next incremental run (mode 600). Only the
 * token, the source, the member and when: never events. Nothing is written without a token.
 */
export function saveSyncState(
  file: string,
  r: { source: string; member: string; nextSyncToken: string | null },
): void {
  if (!r.nextSyncToken) return;
  writeFileSync(
    file,
    `${JSON.stringify({ source: r.source, member: r.member, syncToken: r.nextSyncToken, syncedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
