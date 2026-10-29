/**
 * Inbox view logic (item 4PEHrOW5IfXBQWgOK9wo, part 3), free of React and Firestore: state chips,
 * the order of subjects, Find, and the timeline of a thread or a subject.
 */
import {
  THREAD_FOR_MEMBER,
  THREAD_OPEN,
  outcomeType,
  searchSubjects,
  SEARCH_LIMIT,
  type InboxEvent,
  type InboxRelation,
  type InboxMessage,
  type InboxSubject,
  type InboxThread,
  type ThreadState,
} from '@hive/shared';
import type { Tone } from '../ui/badge';

export const STATE_CHIP: Record<ThreadState, { label: string; tone: Tone }> = {
  investigating: { label: 'Investigating', tone: 'agent' },
  needsYou: { label: 'Needs you', tone: 'gate' },
  yourCall: { label: 'Your call', tone: 'gate' },
  waiting: { label: 'Waiting', tone: 'neutral' },
  done: { label: 'Done', tone: 'approve' },
  ignored: { label: 'Ignored', tone: 'neutral' },
};

type Ms = { toMillis(): number };
const ms = (t: Ms | null | undefined) => (t ? t.toMillis() : 0);

/** "Waiting on them", "Waiting until 3 Nov, 09:00", … */
export function waitingText(w: InboxThread['waiting']): string {
  if (!w) return 'Waiting';
  switch (w.on) {
    case 'them':
      return 'Waiting on them';
    case 'thirdParty':
      return 'Waiting on someone else';
    case 'item':
      return 'Waiting on the item';
    case 'date':
      return w.until
        ? `Waiting until ${new Date(ms(w.until)).toLocaleString(undefined, {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}`
        : 'Waiting';
  }
}

export const forMember = (s: ThreadState) => THREAD_FOR_MEMBER.includes(s);

const DAY = 86_400_000;
/** How pressing a thread is (design 3.5): 1 red, 2 amber, 3-4 grey. */
export type Band = 1 | 2 | 3 | 4;
type Rankable = Pick<InboxThread, 'state' | 'urgent' | 'due' | 'updatedAt'>;
/** 1: urgent, or due within 24 h (or past); 2: due within 7 days; 3: a question; 4: proposals. */
export function bandOf(t: Rankable, now: number): Band {
  const due = t.due ? t.due.toMillis() : null;
  if (t.urgent || (due !== null && due <= now + DAY)) return 1;
  if (due !== null && due <= now + 7 * DAY) return 2;
  return t.state === 'needsYou' ? 3 : 4;
}
/**
 * Threads by band; in bands 1 and 2 the earlier due date first (urgent without one after them),
 * in bands 3 and 4 the one waiting longest first. Stable for equal keys.
 */
export function rankThreads<T extends { id: string; data: Rankable }>(
  rows: readonly T[],
  now: number,
): T[] {
  const key = (r: T) => {
    const band = bandOf(r.data, now);
    const due = r.data.due ? r.data.due.toMillis() : Infinity;
    return { band, k: band <= 2 ? due : ms(r.data.updatedAt) };
  };
  return rows
    .map((r, i) => ({ r, i, ...key(r) }))
    .sort((a, b) => a.band - b.band || a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}
export const isOpen = (s: ThreadState) => THREAD_OPEN.includes(s);

export interface ThreadRow {
  wid: string;
  id: string;
  data: InboxThread;
}
export interface SubjectRow {
  wid: string;
  /** null: the threads not filed under a subject yet. */
  id: string | null;
  name: string;
  /** The subject's area or tag; null: none. */
  area: string | null;
  /** The subject's label (the kind of request); null: none. */
  label: string | null;
  /** True while the label is the agent's guess, not confirmed by the person yet. */
  labelSuggested: boolean;
  /** Latest message on any of its threads (ms); the subject's creation when it has none. */
  activityAt: number;
  /** Threads waiting for the member (Needs you, Your call). */
  waiting: number;
  open: number;
  /** Latest activity (ms). */
  lastAt: number;
  threads: ThreadRow[];
}

/** Waiting for the member first, then open, then closed; newest first within each. */
export function sortThreads(rows: ThreadRow[]): ThreadRow[] {
  const rank = (s: ThreadState) => (forMember(s) ? 0 : isOpen(s) ? 1 : 2);
  return [...rows].sort(
    (a, b) =>
      rank(a.data.state) - rank(b.data.state) ||
      ms(b.data.lastMessageAt) - ms(a.data.lastMessageAt) ||
      (a.id < b.id ? -1 : 1),
  );
}

/**
 * The member's subjects of the given workspaces, with their threads: subjects with threads
 * waiting for the member first, then the rest, newest activity first. Threads not filed yet
 * gather in one row per workspace (id null), which counts like a subject.
 */
export function subjectRows(
  subjects: ReadonlyArray<{ wid: string; id: string; data: InboxSubject }>,
  threads: readonly ThreadRow[],
): SubjectRow[] {
  const by = new Map<string, SubjectRow>();
  const key = (wid: string, id: string | null) => `${wid}/${id ?? ''}`;
  const withThreads = new Set<string>();
  for (const s of subjects)
    by.set(key(s.wid, s.id), {
      wid: s.wid,
      id: s.id,
      name: s.data.name,
      area: s.data.area?.trim() || null,
      label: s.data.label?.trim() || null,
      labelSuggested: Boolean(s.data.label?.trim()) && s.data.labelSuggested === true,
      activityAt: ms(s.data.createdAt),
      waiting: 0,
      open: 0,
      lastAt: ms(s.data.updatedAt),
      threads: [],
    });
  for (const t of threads) {
    const k = key(t.wid, t.data.subjectId);
    let row = by.get(k);
    if (!row) {
      // Not filed yet, or its subject is not loaded (yet): shown with the unfiled ones.
      const u = key(t.wid, null);
      row = by.get(u) ?? {
        wid: t.wid,
        id: null,
        name: 'Not filed yet',
        area: null,
        label: null,
        labelSuggested: false,
        activityAt: 0,
        waiting: 0,
        open: 0,
        lastAt: 0,
        threads: [],
      };
      by.set(u, row);
    }
    row.threads.push(t);
    if (forMember(t.data.state)) row.waiting++;
    if (isOpen(t.data.state)) row.open++;
    // Activity is the latest message; a subject without threads falls back to its creation.
    if (!withThreads.has(row.wid + '/' + (row.id ?? ''))) {
      withThreads.add(row.wid + '/' + (row.id ?? ''));
      row.activityAt = 0;
    }
    row.activityAt = Math.max(row.activityAt, ms(t.data.lastMessageAt));
    row.lastAt = Math.max(row.lastAt, ms(t.data.lastMessageAt), ms(t.data.updatedAt));
  }
  const rows = [...by.values()];
  for (const r of rows) r.threads = sortThreads(r.threads);
  return rows.sort(
    (a, b) =>
      (b.waiting > 0 ? 1 : 0) - (a.waiting > 0 ? 1 : 0) ||
      b.lastAt - a.lastAt ||
      a.name.localeCompare(b.name),
  );
}

/** Threads waiting for the member: the number behind "N threads wait for you" and the Inbox tab. */
export function countWaitingThreads(rows: ReadonlyArray<Pick<SubjectRow, 'waiting'>>): number {
  return rows.reduce((n, r) => n + r.waiting, 0);
}

export interface FindFilters {
  waitingForMe: boolean;
  /** Active in the last N days (0: any time). */
  days: number;
  hasOpen: boolean;
}

/** One workspace's rows, as searchSubjects wants them. */
export interface FindData {
  subjects: ReadonlyArray<{ wid: string; id: string; data: Pick<InboxSubject, 'name'> }>;
  threads: readonly ThreadRow[];
  messages: ReadonlyArray<{
    wid: string;
    data: Pick<InboxMessage, 'threadId' | 'direction' | 'source' | 'sender' | 'text'>;
  }>;
  relations: ReadonlyArray<{
    wid: string;
    data: Pick<InboxRelation, 'a' | 'b' | 'state' | 'note'>;
  }>;
}

/**
 * Find (docs/INBOX.md, "Finding subjects"): searchSubjects per workspace, the same answer the
 * agents' subject_search gives, merged across workspaces (best score first, then waiting for
 * the member, then the latest activity). Threads not filed yet are not subjects: Find skips them.
 */
export function findSubjectRows(
  rows: readonly SubjectRow[],
  wids: readonly string[],
  d: FindData,
  q: string,
  f: FindFilters,
  nowMs: number,
): SubjectRow[] {
  const byKey = new Map(rows.map((r) => [`${r.wid}/${r.id ?? ''}`, r]));
  const hits: { row: SubjectRow; score: number; forYou: number; at: number }[] = [];
  for (const wid of wids) {
    const res = searchSubjects({
      query: q,
      nowMs,
      filters: {
        waitingForMe: f.waitingForMe,
        hasOpen: f.hasOpen,
        ...(f.days > 0 ? { activeDays: f.days } : {}),
        limit: SEARCH_LIMIT.max,
      },
      subjects: d.subjects
        .filter((s) => s.wid === wid)
        .map((s) => ({ id: s.id, name: s.data.name })),
      threads: d.threads
        .filter((t) => t.wid === wid)
        .map((t) => ({
          id: t.id,
          subjectId: t.data.subjectId,
          state: t.data.state,
          title: t.data.title,
          lastMessageAtMs: ms(t.data.lastMessageAt),
        })),
      messages: d.messages
        .filter((m) => m.wid === wid)
        .map((m) => ({
          threadId: m.data.threadId,
          direction: m.data.direction,
          source: m.data.source,
          senderName: m.data.sender.name,
          senderHandle: m.data.sender.handle,
          text: m.data.text,
        })),
      relations: d.relations.filter((r) => r.wid === wid).map((r) => r.data),
    });
    for (const h of res.subjects) {
      const row = byKey.get(`${wid}/${h.subjectId}`);
      if (row)
        hits.push({
          row,
          score: h.score,
          forYou: h.forYou,
          at: h.lastActivityAt ? Date.parse(h.lastActivityAt) : 0,
        });
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || b.forYou - a.forYou || b.at - a.at)
    .map((h) => h.row);
}

export type TimelineEntry =
  | { kind: 'message'; id: string; at: number; message: InboxMessage }
  | { kind: 'event'; id: string; at: number; event: InboxEvent };

/** Events that show on a timeline (the rest is bookkeeping, shown elsewhere on the page). */
const SHOWN = new Set<string>([
  'thread.filed',
  'thread.note',
  'thread.asked',
  'thread.answered',
  'thread.woke',
  'thread.ignored',
  'thread.closed',
  'thread.restored',
  'thread.moved',
  'thread.itemMade',
  'outcome.proposed',
  'outcome.approved',
  'outcome.rejected',
  'outcome.done',
  'outcome.failed',
  'subject.renamed',
  'subject.merged',
  'subject.split',
  'subject.area',
  'subject.label',
  'thread.flagged',
  'thread.due',
  'relation.proposed',
  'relation.accepted',
  'relation.created',
  'relation.rejected',
  'relation.removed',
]);

/** Messages and events, oldest first. */
export function timeline(
  messages: ReadonlyArray<{ id: string; data: InboxMessage }>,
  events: ReadonlyArray<{ id: string; data: InboxEvent }>,
): TimelineEntry[] {
  const out: TimelineEntry[] = [
    ...messages.map((m) => ({
      kind: 'message' as const,
      id: m.id,
      at: ms(m.data.receivedAt),
      message: m.data,
    })),
    ...events
      .filter((e) => SHOWN.has(e.data.type))
      .map((e) => ({ kind: 'event' as const, id: e.id, at: ms(e.data.at), event: e.data })),
  ];
  return out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

const typeLabel = (t: unknown) => outcomeType(String(t))?.label ?? String(t);
const q = (s: unknown) => (typeof s === 'string' && s ? `: “${s}”` : '');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number) => String(n).padStart(2, '0');
/** A deadline in the browser's zone: "Fri 30 Oct 12:00" (item kt3E7u9EliL3q2veDDI0). */
export function dueText(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The word for an outcome's confidence (absent on older outcomes: no meter). */
export function confidenceText(c: string | null | undefined): 'Sure' | 'Likely' | 'Unsure' | null {
  return c === 'high' ? 'Sure' : c === 'medium' ? 'Likely' : c === 'low' ? 'Unsure' : null;
}

/** One line for a timeline event. */
export function eventText(e: Pick<InboxEvent, 'type' | 'data' | 'actor'>): string {
  const who = e.actor.type === 'human' ? 'You' : e.actor.name || 'An agent';
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'thread.filed':
      return d.created ? `${who} filed it under a new subject` : `${who} filed it`;
    case 'thread.note':
      return `${who} noted${q(d.text)}`;
    case 'thread.asked':
      return `${who} asked you${q(d.text)}`;
    case 'thread.answered':
      return `You answered${q(d.answer)}`;
    case 'thread.woke':
      return 'Snooze ended: back to the agent';
    case 'thread.ignored':
      return 'You ignored it';
    case 'thread.closed':
      return 'You marked it done';
    case 'thread.restored':
      return 'You brought it back';
    case 'thread.moved':
      return 'You moved it here';
    case 'thread.itemMade':
      return `You made an item of it${q(d.title)}`;
    case 'outcome.proposed':
      return `${who} proposed ${typeLabel(d.type)}`;
    case 'outcome.approved':
      return `You approved ${typeLabel(d.type)}${d.edited ? ' (edited)' : ''}`;
    case 'outcome.rejected':
      return `You rejected ${typeLabel(d.type)}${q(d.reason)}`;
    case 'outcome.done':
      return `${who} carried out ${typeLabel(d.type)}`;
    case 'outcome.failed':
      return `${who} could not carry out ${typeLabel(d.type)}${q(d.error)}`;
    case 'subject.renamed':
      return `You renamed the subject to “${String(d.name ?? '')}”`;
    case 'subject.merged':
      return `You merged “${String(d.fromName ?? '')}” into this subject`;
    case 'subject.split':
      return `You split this subject off “${String(d.fromName ?? '')}”`;
    case 'subject.label':
      return d.label ? `You set the label to “${String(d.label)}”` : 'You cleared the label';
    case 'subject.area':
      return d.area ? `You set the area to “${String(d.area)}”` : 'You cleared the area';
    case 'thread.flagged':
      return d.urgent ? `${who} marked it urgent${q(d.reason)}` : `${who} marked it not urgent`;
    case 'thread.due': {
      const at = typeof d.due === 'string' ? Date.parse(d.due) : NaN;
      return Number.isNaN(at)
        ? `${who} cleared the due date`
        : `${who} set it due ${dueText(at)}${q(d.reason)}`;
    }
    case 'relation.proposed':
      return `${who} suggested a related subject${q(d.note)}`;
    case 'relation.accepted':
      return 'You OKed a related subject';
    case 'relation.created':
      return `You linked a related subject${q(d.note)}`;
    case 'relation.rejected':
      return 'You turned down a related subject';
    case 'relation.removed':
      return 'You unlinked a related subject';
    default:
      return e.type;
  }
}

/** The values to show in an outcome's form: its fields, with the registry's keys in order. */
export function formValues(
  typeId: string,
  fields: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const t = outcomeType(typeId);
  if (!t) return { ...fields };
  const out: Record<string, string | boolean> = {};
  for (const [k, f] of Object.entries(t.fields))
    out[k] = fields[k] ?? (f.kind === 'boolean' ? false : '');
  return out;
}

/** The edited fields for approveOutcome: empty optional ones left out, false booleans too. */
export function editedFields(
  typeId: string,
  values: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const t = outcomeType(typeId);
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(values)) {
    const f = t?.fields[k];
    if (typeof v === 'string' && v.trim() === '') continue;
    if (v === false && !f?.required) continue;
    out[k] = v;
  }
  return out;
}

/** A datetime-local input's value for an ISO time (local), and back. */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
}

/** "Booked in your calendar: 3 Nov, 10:00 to 10:30, with Sam". */
export function bookedText(f: Readonly<Record<string, string | boolean>>): string {
  const start = typeof f.start === 'string' ? Date.parse(f.start) : NaN;
  const end = typeof f.end === 'string' ? Date.parse(f.end) : NaN;
  const time = (ms: number) =>
    new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const slot = Number.isNaN(start)
    ? ''
    : `${new Date(start).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${time(start)}${Number.isNaN(end) ? '' : ` to ${time(end)}`}`;
  const who = typeof f.with === 'string' && f.with ? `, with ${f.with}` : '';
  return `Booked in your calendar: ${slot}${who}`;
}

export const DEFAULT_QUIET_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * A subject is quiet when none of its threads had a message for `quietDays` days and nothing
 * waits for the member. It is never deleted: the next message makes it active again (activity
 * is derived from the messages). 0 turns folding off. Threads not filed yet are never quiet.
 */
export function isQuiet(row: SubjectRow, quietDays: number, nowMs: number): boolean {
  return (
    quietDays > 0 &&
    row.id !== null &&
    row.waiting === 0 &&
    nowMs - row.activityAt >= quietDays * DAY_MS
  );
}

export interface AreaGroup {
  /** Lowercased key; '' for subjects without an area. */
  key: string;
  /** null: no area. */
  label: string | null;
  rows: SubjectRow[];
}

/**
 * The list as the Inbox shows it: active subjects grouped by area (areas A to Z, case-blind,
 * subjects without an area last), and the quiet ones apart. Row order is kept within a group.
 */
export function groupByArea(
  rows: readonly SubjectRow[],
  quietDays: number,
  nowMs: number,
): { groups: AreaGroup[]; quiet: SubjectRow[] } {
  const quiet: SubjectRow[] = [];
  const by = new Map<string, AreaGroup>();
  for (const r of rows) {
    if (isQuiet(r, quietDays, nowMs)) {
      quiet.push(r);
      continue;
    }
    const key = r.area ? r.area.toLowerCase() : '';
    let g = by.get(key);
    if (!g) by.set(key, (g = { key, label: r.area, rows: [] }));
    // Spellings that differ only in case share a group; its label does not depend on row order.
    if (r.area && g.label !== null && r.area < g.label) g.label = r.area;
    g.rows.push(r);
  }
  const groups = [...by.values()].sort(
    (a, b) => (a.key === '' ? 1 : 0) - (b.key === '' ? 1 : 0) || a.key.localeCompare(b.key),
  );
  return { groups, quiet };
}

/** The label filter's options: each label on a row (case-blind, first spelling wins) with its count. */
export function labelCounts(
  rows: readonly SubjectRow[],
): Array<{ key: string; label: string; count: number }> {
  const by = new Map<string, { key: string; label: string; count: number }>();
  for (const r of rows) {
    if (!r.label) continue;
    const key = r.label.toLowerCase();
    const e = by.get(key);
    if (e) e.count++;
    else by.set(key, { key, label: r.label, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Rows whose label is one of `keys` (lowercased labels); no keys: all rows. */
export function filterByLabels<T extends { label: string | null }>(
  rows: readonly T[],
  keys: ReadonlySet<string>,
): T[] {
  return keys.size === 0
    ? [...rows]
    : rows.filter((r) => r.label && keys.has(r.label.toLowerCase()));
}

/** The Inbox list's groups (item kt3E7u9EliL3q2veDDI0, design 2.4). */
export interface StateGroups {
  /** A thread in needsYou or yourCall, by that thread's rank (design 3.5). */
  needs: SubjectRow[];
  /** A thread an agent is investigating. */
  working: SubjectRow[];
  /** A thread waiting on others. */
  waiting: SubjectRow[];
  /** Everything else, by latest activity. */
  recent: SubjectRow[];
  /** Threads not filed under a subject yet (one row per organization). */
  unfiled: SubjectRow[];
  /** No message for `quietDays` days and nothing waiting for the member: folded. */
  quiet: SubjectRow[];
}

/** The state that puts a subject in its group: its most pressing thread. */
export function subjectState(row: SubjectRow): 'needs' | 'working' | 'waiting' | 'recent' {
  const states = row.threads.map((t) => t.data.state);
  if (states.some((s) => forMember(s))) return 'needs';
  if (states.includes('investigating')) return 'working';
  if (states.includes('waiting')) return 'waiting';
  return 'recent';
}

/**
 * Subjects grouped by their most pressing thread: Needs you (ranked), Agents working, Waiting on
 * others, Recent, then Not filed yet and Quiet. The area is a chip and a filter, not a group.
 */
export function groupByState(
  rows: readonly SubjectRow[],
  quietDays: number,
  nowMs: number,
): StateGroups {
  const g: StateGroups = {
    needs: [],
    working: [],
    waiting: [],
    recent: [],
    unfiled: [],
    quiet: [],
  };
  for (const r of rows) {
    if (r.id === null) g.unfiled.push(r);
    else if (isQuiet(r, quietDays, nowMs)) g.quiet.push(r);
    else g[subjectState(r)].push(r);
  }
  // Needs you: by the rank of each subject's most pressing thread.
  const best = new Map(
    g.needs.map((r) => {
      const top = rankThreads(
        r.threads.filter((t) => forMember(t.data.state)),
        nowMs,
      )[0]!;
      return [`${r.wid}/${r.id}`, top] as const;
    }),
  );
  const ranked = rankThreads(
    g.needs.map((r) => ({ id: `${r.wid}/${r.id}`, data: best.get(`${r.wid}/${r.id}`)!.data })),
    nowMs,
  ).map((x) => x.id);
  g.needs.sort((a, b) => ranked.indexOf(`${a.wid}/${a.id}`) - ranked.indexOf(`${b.wid}/${b.id}`));
  const latest = (a: SubjectRow, b: SubjectRow) =>
    b.lastAt - a.lastAt || a.name.localeCompare(b.name);
  g.working.sort(latest);
  g.waiting.sort(latest);
  g.recent.sort((a, b) => b.activityAt - a.activityAt || a.name.localeCompare(b.name));
  return g;
}

/** The areas on the listed subjects (case-blind), with how many subjects carry each. */
export function areaCounts(
  rows: readonly SubjectRow[],
): Array<{ key: string; label: string; count: number }> {
  const by = new Map<string, { key: string; label: string; count: number }>();
  for (const r of rows) {
    if (!r.area) continue;
    const key = r.area.toLowerCase();
    const cur = by.get(key);
    if (cur) {
      cur.count++;
      if (r.area < cur.label) cur.label = r.area;
    } else by.set(key, { key, label: r.area, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** Subjects in any of the chosen areas (lowercased keys); none chosen keeps all. */
export function filterByAreas(
  rows: readonly SubjectRow[],
  keys: ReadonlySet<string>,
): SubjectRow[] {
  if (keys.size === 0) return [...rows];
  return rows.filter((r) => r.area && keys.has(r.area.toLowerCase()));
}
