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
  for (const s of subjects)
    by.set(key(s.wid, s.id), {
      wid: s.wid,
      id: s.id,
      name: s.data.name,
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
  'thread.flagged',
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
    case 'thread.flagged':
      return d.urgent ? `${who} marked it urgent${q(d.reason)}` : `${who} marked it not urgent`;
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
