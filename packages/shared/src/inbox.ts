/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo, docs/INBOX.md): what people send a member (Teams, mail, Jira
 * mentions, …), brought in by the organization's agents, in three levels:
 *
 *   workspaces/{wid}/inboxSubjects/{sid}   a lasting, well-named topic (owned by the member)
 *   workspaces/{wid}/inboxThreads/{tid}    one conversation in a subject: its state and outcomes
 *   workspaces/{wid}/inboxMessages/{mid}   each input (or the member's own reply), immutable
 *   workspaces/{wid}/inboxOutcomes/{oid}   what comes of a thread (./outcomes.ts), proposed by an
 *                                          agent, approved or rejected by the member, then done
 *   workspaces/{wid}/inboxEvents/{eid}     the tracking log (create-only) and the timeline
 *
 * Thread states: investigating (an agent digs in) · needsYou (it asked the member) · yourCall
 * (outcomes proposed) · waiting (on them, a third party, an item or a date) · done · ignored. A
 * new message from them reopens a waiting, done or ignored thread.
 *
 * Privacy (firestore.rules): all of it is readable only by the member it belongs to
 * (`memberUid`) and by the organization's non-revoked agents; only that member decides.
 * Nothing is carried out without the member's approval: agents never write an approval.
 *
 * Like ./actions, each action is ONE batch: the change plus exactly one inbox event.
 */
import { z } from 'zod';
import {
  ActionError,
  arrayUnion,
  nid,
  requireAgent,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import {
  cleanOutcomeFields,
  OUTCOME_TYPES,
  OutcomeFieldError,
  outcomeType,
  type WaitingOn,
} from './outcomes';
import { calendarEventId, calendarUpsert } from './calendar';
import { timestamp } from './schema';

// ---------- shapes ----------

export const THREAD_STATES = [
  'investigating',
  'needsYou',
  'yourCall',
  'waiting',
  'done',
  'ignored',
] as const;
export type ThreadState = (typeof THREAD_STATES)[number];
/** States that wait for the member. */
export const THREAD_FOR_MEMBER: readonly ThreadState[] = ['needsYou', 'yourCall'];
/** Open threads (counted in a subject). */
export const THREAD_OPEN: readonly ThreadState[] = [
  'investigating',
  'needsYou',
  'yourCall',
  'waiting',
];
/** A new message from them reopens these. */
const REOPENS: readonly ThreadState[] = ['waiting', 'done', 'ignored'];

/**
 * `revising`: the member asked the proposing agent for changes (Ask for changes, item
 * L7OzWKMYZ1O2dX33Xkrj); the thread stays in Your call and nothing is rejected.
 */
export const OUTCOME_STATES = [
  'proposed',
  'revising',
  'approved',
  'rejected',
  'done',
  'failed',
] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

export const INBOX_EVENT_TYPES = [
  // agents
  'inbox.added',
  'thread.filed',
  'thread.note',
  'thread.asked',
  'thread.woke',
  'outcome.proposed',
  'outcome.revised',
  'outcome.done',
  'outcome.failed',
  // agents and the member
  'thread.titled',
  'thread.flagged',
  'thread.due',
  // the member
  'thread.answered',
  'thread.ignored',
  'thread.closed',
  'thread.restored',
  'thread.moved',
  'thread.itemMade',
  'outcome.approved',
  'outcome.rejected',
  'outcome.revise_requested',
  'subject.created',
  'subject.renamed',
  'subject.merged',
  'subject.split',
  'subject.area',
  'subject.label',
  // related subjects: an agent proposes, the member decides
  'relation.proposed',
  'relation.created',
  'relation.accepted',
  'relation.rejected',
  'relation.removed',
] as const;
export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

/** Known sources; any lowercase word of the same form is accepted. */
export const INBOX_SOURCES = ['teams', 'mail', 'gitlab', 'jira', 'github', 'telegram', 'slack'];
export const SOURCE_RE = /^[a-z][a-z0-9_-]{0,39}$/;

export const INBOX_LIMITS = {
  text: 50_000,
  senderName: 200,
  senderHandle: 320,
  threadRef: 1000,
  messageId: 500,
  permalink: 2048,
  replyRef: 2000,
  attachments: 20,
  attachmentName: 200,
  subjectName: 120,
  area: 60,
  /** A subject label (Sales, Support, ...): characters each, and how many a workspace lists. */
  label: 30,
  labels: 12,
  title: 200,
  note: 8000,
  question: 4000,
  answer: 4000,
  outcomeNote: 2000,
  reason: 1000,
  resultText: 20_000,
  refs: 50,
  relationNote: 500,
  /** Outcome checks (what the agent verified): count, then characters each. */
  checks: 6,
  check: 200,
  /** Answer chips on a question: count, then characters each. */
  options: 4,
  option: 80,
  /** Ask for changes: the instruction's characters, and the versions an outcome keeps. */
  reviseInstruction: 500,
  versions: 10,
} as const;

/** The quick chips of Ask for changes, in the order the card shows them. */
export const REVISE_CHIPS = ['shorter', 'formal', 'warmer', 'availability'] as const;
export type ReviseChip = (typeof REVISE_CHIPS)[number];
export const REVISE_CHIP_LABELS: Record<ReviseChip, string> = {
  shorter: 'Shorter',
  formal: 'More formal',
  warmer: 'Warmer',
  availability: 'Add my availability',
};
/** The outcome types with text worth revising (the others are a one-tap decision). */
export const REVISABLE_TYPES: readonly string[] = [
  'reply',
  'reply_book',
  'nudge',
  'handover',
  'make_it_work',
];

/** How sure the agent is of a proposed outcome (item kt3E7u9EliL3q2veDDI0). */
export const OUTCOME_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type OutcomeConfidence = (typeof OUTCOME_CONFIDENCE)[number];

const by = z.object({ type: z.enum(['human', 'agent']), id: z.string() });

export const inboxSubjectSchema = z.object({
  memberUid: z.string(),
  name: z.string().min(1).max(INBOX_LIMITS.subjectName),
  /** Optional area or tag (a client, a product, "admin"): the Inbox groups subjects by it. */
  area: z.string().min(1).max(INBOX_LIMITS.area).nullable().optional(),
  /** Optional label (the kind of request) from the workspace's list; null: none (item YaOErIjeIFG8Y3EvZuIp). */
  label: z.string().min(1).max(INBOX_LIMITS.label).nullable().optional(),
  /** true: the agent's guess, not confirmed by the member yet. */
  labelSuggested: z.boolean().optional(),
  labelBy: z.enum(['agent', 'member']).optional(),
  createdBy: by,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxSubject = z.infer<typeof inboxSubjectSchema>;

/** The labels a workspace offers until an admin edits the list (mirrored in Go and the rules). */
export const DEFAULT_INBOX_LABELS: readonly string[] = [
  'Sales',
  'Support',
  'Billing',
  'Partnership',
  'Internal',
  'Other',
];

/** workspaces/{wid}/inboxConfig/labels: absent means the defaults. Written by admins only. */
export const inboxLabelsSchema = z.object({
  labels: z.array(z.string().min(1).max(INBOX_LIMITS.label)).min(1).max(INBOX_LIMITS.labels),
  updatedBy: z.string(),
  updatedAt: timestamp,
});
export type InboxLabels = z.infer<typeof inboxLabelsSchema>;

export const inboxThreadSchema = z.object({
  memberUid: z.string(),
  subjectId: z.string().nullable(),
  state: z.enum(THREAD_STATES),
  waiting: z
    .object({ on: z.enum(['them', 'thirdParty', 'date', 'item']), until: timestamp.nullable() })
    .nullable(),
  question: z
    .object({
      text: z.string(),
      by: z.string(),
      at: timestamp,
      answer: z.string().nullable(),
      answeredAt: timestamp.nullable(),
      /** Answer chips: tapping one answers with its text. Absent on older questions. */
      options: z.array(z.string()).max(INBOX_LIMITS.options).optional(),
    })
    .nullable(),
  title: z.string().max(INBOX_LIMITS.title),
  /** Hashes of member + source + threadRef of the source threads it gathers. */
  refs: z.array(z.string()).max(INBOX_LIMITS.refs),
  lastMessageAt: timestamp,
  /** The agent that brought it in: it posts replies (it has the channel access). */
  fetchedBy: z.string(),
  /** Urgent (thread_flag): the member is pinged at once. Absent means false. */
  urgent: z.boolean().optional(),
  /** A deadline stated in the thread (thread_due), or null when cleared. Absent at first. */
  due: timestamp.nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxThread = z.infer<typeof inboxThreadSchema>;

export const inboxMessageSchema = z.object({
  memberUid: z.string(),
  threadId: z.string(),
  /** in: from them; out: the member's own reply, seen by the agent (answered outside Hivenod). */
  direction: z.enum(['in', 'out']),
  source: z.string().regex(SOURCE_RE),
  sender: z.object({ name: z.string(), handle: z.string().nullable() }),
  text: z.string(),
  threadRef: z.string(),
  messageId: z.string(),
  permalink: z.string().nullable(),
  replyRef: z.string().nullable(),
  receivedAt: timestamp,
  attachments: z.array(z.object({ name: z.string(), url: z.string() })),
  fetchedBy: z.string(),
  createdAt: timestamp,
  lastEventId: z.string(),
});
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

const reviseAskSchema = z.object({
  instruction: z.string().max(INBOX_LIMITS.reviseInstruction).nullable(),
  chips: z.array(z.enum(REVISE_CHIPS)).max(REVISE_CHIPS.length),
});
const reviseSchema = reviseAskSchema.extend({ byUid: z.string(), at: timestamp });
export const outcomeVersionSchema = z.object({
  /** 1, 2, … in order. */
  n: z.number().int().min(1),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])),
  note: z.string().max(INBOX_LIMITS.outcomeNote),
  confidence: z.enum(OUTCOME_CONFIDENCE).nullable(),
  checks: z.array(z.string()),
  /** The agent that wrote it. */
  by: z.string(),
  /** The outcome.revised event that wrote it (null for v1: the proposal). */
  eventId: z.string().nullable(),
  /** What the member asked for to get it (null for v1). */
  asked: reviseAskSchema.nullable(),
});
export type OutcomeVersion = z.infer<typeof outcomeVersionSchema>;

export const inboxOutcomeSchema = z.object({
  memberUid: z.string(),
  threadId: z.string(),
  type: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])),
  state: z.enum(OUTCOME_STATES),
  /** The agent's why, for the member. */
  note: z.string().max(INBOX_LIMITS.outcomeNote),
  /** How sure the agent is; absent (or null after a revision without one): no meter. */
  confidence: z.enum(OUTCOME_CONFIDENCE).nullable().optional(),
  /** What the agent verified, one line each; absent on older outcomes. */
  checks: z.array(z.string().max(INBOX_LIMITS.check)).max(INBOX_LIMITS.checks).optional(),
  proposedBy: z.string(),
  /** The agent that carries it out; null when it takes effect on approval. */
  executor: z.string().nullable(),
  decision: z
    .object({
      byUid: z.string(),
      at: timestamp,
      edited: z.boolean(),
      reason: z.string().nullable(),
      /** The version approved (absent or null: the outcome was never revised). */
      version: z.number().int().nullable().optional(),
    })
    .nullable(),
  /**
   * Every version once the member asked for changes (append-only, at most 10; absent before).
   * The top-level fields, note, confidence and checks always hold the latest one.
   */
  versions: z.array(outcomeVersionSchema).max(INBOX_LIMITS.versions).optional(),
  /** What the member asked while `revising`; null (or absent) otherwise. */
  revise: reviseSchema.nullable().optional(),
  result: z
    .object({
      text: z.string().nullable(),
      permalink: z.string().nullable(),
      itemId: z.string().nullable(),
      error: z.string().nullable(),
      by: z.string(),
      at: timestamp,
    })
    .nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxOutcome = z.infer<typeof inboxOutcomeSchema>;

export const inboxEventSchema = z.object({
  actor: z.object({ type: z.enum(['human', 'agent']), id: z.string(), name: z.string() }),
  memberUid: z.string(),
  threadId: z.string().nullable(),
  subjectId: z.string().nullable(),
  type: z.enum(INBOX_EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
  at: timestamp,
});
export type InboxEvent = z.infer<typeof inboxEventSchema>;

export const inboxPaths = {
  subject: (w: string, s: string) => `workspaces/${w}/inboxSubjects/${s}`,
  thread: (w: string, t: string) => `workspaces/${w}/inboxThreads/${t}`,
  message: (w: string, m: string) => `workspaces/${w}/inboxMessages/${m}`,
  outcome: (w: string, o: string) => `workspaces/${w}/inboxOutcomes/${o}`,
  event: (w: string, e: string) => `workspaces/${w}/inboxEvents/${e}`,
  relation: (w: string, r: string) => `workspaces/${w}/inboxRelations/${r}`,
  /** The workspace's label list (absent: the defaults). */
  labels: (w: string) => `workspaces/${w}/inboxConfig/labels`,
  /** Tombstone event id of a subject deleted by a merge. */
  deleteEventId: (subjectId: string) => `del-subject-${subjectId}`,
} as const;

/** What an action needs of a thread (a listener's data). */
export type ThreadStateOf = Pick<
  InboxThread,
  'memberUid' | 'subjectId' | 'state' | 'fetchedBy' | 'refs'
> & {
  waiting?: { on: string; until: { toMillis(): number } | null } | null;
  question?: InboxThread['question'];
};
export type OutcomeStateOf = Pick<
  InboxOutcome,
  'memberUid' | 'threadId' | 'type' | 'fields' | 'state' | 'executor'
> &
  Partial<
    Pick<InboxOutcome, 'proposedBy' | 'note' | 'confidence' | 'checks' | 'versions' | 'revise'>
  >;

// ---------- ids ----------

/**
 * Deduplication: a message is the same message when member + source + threadRef + messageId
 * match; a source thread is the same when member + source + threadRef match. Ids are prefix +
 * the first 24 hex digits of SHA-256 of the key (UTF-8), computed by the agent clients
 * (node:crypto, Go crypto/sha256) since this module stays sync and SDK-free:
 *   message id `im<h>`, thread ref `<h>`, the thread first made for a ref `it<h>`.
 */
export function inboxMessageKey(
  member: string,
  source: string,
  threadRef: string,
  messageId: string,
) {
  return [member, source, threadRef, messageId].join('\u0000');
}
export function inboxThreadKey(member: string, source: string, threadRef: string) {
  return [member, source, threadRef].join('\u0000');
}
export const digest24 = (hex: string) => hex.slice(0, 24);

// ---------- plan ----------

export function inboxPlan(
  ctx: ActionContext,
  type: InboxEventType,
  scope: { memberUid: string; threadId?: string | null; subjectId?: string | null },
  data: Record<string, unknown>,
  build: (eventId: string) => WriteOp[],
  eventId: string = nid(ctx),
): ActionPlan {
  const event: WriteOp = {
    kind: 'set',
    path: inboxPaths.event(ctx.workspaceId, eventId),
    data: {
      actor: { type: ctx.actor.type, id: ctx.actor.id, name: ctx.actor.name },
      memberUid: scope.memberUid,
      threadId: scope.threadId ?? null,
      subjectId: scope.subjectId ?? null,
      type,
      data,
      at: SERVER_TIME,
    },
  };
  return { eventId, ops: [...build(eventId), event] };
}

// ---------- checks ----------

const tooLong = (what: string, max: number) => `${what} is at most ${max} characters.`;
const LINK = /^https?:\/\/\S+$/;
function need(cond: boolean, msg: string) {
  if (!cond) throw new ActionError(msg);
}
function owner(ctx: ActionContext, member: string) {
  requireHuman(ctx);
  need(member === ctx.actor.id, 'Only the person this is for can do this.');
}
function cleanText(what: string, v: string, max: number): string {
  const t = v.trim();
  need(t.length > 0, `${what} is empty.`);
  need(t.length <= max, tooLong(what, max));
  return t;
}
export function cleanSubjectName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  need(n.length > 0, 'A subject needs a name.');
  need(n.length <= INBOX_LIMITS.subjectName, tooLong('A subject name', INBOX_LIMITS.subjectName));
  return n;
}
/** An area from input: collapsed spaces; empty means "no area" (null). */
export function cleanArea(area: string): string | null {
  const n = area.trim().replace(/\s+/g, ' ');
  need(n.length <= INBOX_LIMITS.area, tooLong('An area', INBOX_LIMITS.area));
  return n === '' ? null : n;
}
/** A label from input: collapsed spaces, 1 to 30 characters. */
export function cleanLabel(label: string): string {
  const n = label.trim().replace(/\s+/g, ' ');
  need(n.length > 0, 'A label needs a name.');
  need(n.length <= INBOX_LIMITS.label, tooLong('A label', INBOX_LIMITS.label));
  return n;
}
/** The label list from input: 1 to 12 labels, unique ignoring case. */
export function cleanLabelList(labels: readonly string[]): string[] {
  need(Array.isArray(labels), 'The labels are a list of texts.');
  need(
    labels.length >= 1 && labels.length <= INBOX_LIMITS.labels,
    `Give 1 to ${INBOX_LIMITS.labels} labels.`,
  );
  const out = labels.map((l) => cleanLabel(String(l)));
  need(new Set(out.map((l) => l.toLowerCase())).size === out.length, 'Each label is listed once.');
  return out;
}
/** The listed spelling of a label (matched ignoring case), or null when it is not listed. */
export function matchLabel(label: string, list: readonly string[]): string | null {
  const w = label.trim().replace(/\s+/g, ' ').toLowerCase();
  return list.find((l) => l.toLowerCase() === w) ?? null;
}
/** A thread's title from its first message: the first non-empty line, at most 120 characters. */
export function titleFrom(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.trim().replace(/\s+/g, ' ').slice(0, 120);
}
/** A list of short lines (checks, options): trimmed, each 1..each characters, at most max. */
function cleanLines(
  what: string,
  v: readonly unknown[] | null | undefined,
  max: number,
  each: number,
): string[] {
  if (v === null || v === undefined) return [];
  need(Array.isArray(v), `${what} is a list of texts.`);
  need(v.length <= max, `At most ${max} ${what}.`);
  return v.map((e) => {
    const t = typeof e === 'string' ? e.trim() : '';
    need(t.length > 0 && t.length <= each, `Each of the ${what} is 1-${each} characters.`);
    return t;
  });
}
const ISO_OFFSET = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;
function liveThread(t: ThreadStateOf) {
  need(t.state !== 'ignored', 'This thread was ignored: bring it back first.');
}
const upd = (path: string, data: Record<string, unknown>, eventId: string): WriteOp => ({
  kind: 'update',
  path,
  data: { ...data, updatedAt: SERVER_TIME, lastEventId: eventId },
});

// ---------- agents ----------

export interface InboxAddInput {
  /** `im<h>` of the message key. */
  messageDocId: string;
  /** `<h>` of the thread key. */
  ref: string;
  memberUid: string;
  direction?: 'in' | 'out';
  source: string;
  sender: { name: string; handle?: string | null };
  text: string;
  threadRef: string;
  messageId: string;
  permalink?: string | null;
  replyRef?: string | null;
  receivedAt: Date;
  attachments?: readonly { name: string; url: string }[];
  /** The thread it joins (found by ref, or named by the agent); absent = a new thread. */
  thread?: { threadId: string; state: ThreadStateOf } | null;
  /** The new thread's id (default `it<ref>`) and title (default from the text). */
  newThreadId?: string;
  title?: string;
}

/**
 * An agent brings a message in (inbox_add): into the thread it belongs to (which a message from
 * them reopens), or into a new thread that starts `investigating`, in no subject yet.
 */
export function addInboxMessage(
  ctx: ActionContext,
  input: InboxAddInput,
): ActionPlan & { threadId: string; newThread: boolean; state: ThreadState } {
  requireAgent(ctx);
  const L = INBOX_LIMITS;
  const direction = input.direction ?? 'in';
  need(SOURCE_RE.test(input.source), 'The source is one lowercase word, like teams, mail or jira.');
  const name = input.sender.name.trim();
  need(name.length > 0, 'Say who sent it (sender name).');
  need(name.length <= L.senderName, tooLong('The sender name', L.senderName));
  const handle = input.sender.handle?.trim() || null;
  need(
    handle === null || handle.length <= L.senderHandle,
    tooLong('The sender handle', L.senderHandle),
  );
  need(input.text.trim().length > 0, 'The message has no text.');
  need(input.text.length <= L.text, tooLong('The text', L.text));
  need(
    input.threadRef.length > 0 && input.threadRef.length <= L.threadRef,
    `The thread reference is 1 to ${L.threadRef} characters.`,
  );
  need(
    input.messageId.length > 0 && input.messageId.length <= L.messageId,
    `The message id is 1 to ${L.messageId} characters.`,
  );
  const permalink = input.permalink?.trim() || null;
  need(
    permalink === null || (permalink.length <= L.permalink && LINK.test(permalink)),
    'The permalink is an http(s) link.',
  );
  const replyRef = input.replyRef?.trim() || null;
  need(
    replyRef === null || replyRef.length <= L.replyRef,
    tooLong('The reply reference', L.replyRef),
  );
  need(!Number.isNaN(input.receivedAt.getTime()), 'receivedAt is not a valid time.');
  const attachments = (input.attachments ?? []).map((a) => ({
    name: a.name.trim(),
    url: a.url.trim(),
  }));
  need(attachments.length <= L.attachments, `At most ${L.attachments} attachments.`);
  for (const a of attachments)
    need(
      a.name.length > 0 &&
        a.name.length <= L.attachmentName &&
        a.url.length <= 2048 &&
        LINK.test(a.url),
      'Each attachment is a name and an http(s) link.',
    );
  const existing = input.thread ?? null;
  if (existing && !existing.state.refs.includes(input.ref))
    need(existing.state.refs.length < L.refs, `A thread gathers at most ${L.refs} source threads.`);
  const memberUid = existing?.state.memberUid ?? input.memberUid;
  need(memberUid === input.memberUid, 'That thread is for someone else.');
  const threadId = existing?.threadId ?? input.newThreadId ?? `it${input.ref}`;
  const title = existing
    ? null
    : (input.title?.trim().replace(/\s+/g, ' ') || titleFrom(input.text)).slice(0, L.title);
  const before = existing?.state.state ?? null;
  const state: ThreadState =
    before === null
      ? 'investigating'
      : direction === 'in' && REOPENS.includes(before)
        ? 'investigating'
        : before;
  const p = inboxPlan(
    ctx,
    'inbox.added',
    { memberUid, threadId, subjectId: existing?.state.subjectId ?? null },
    {
      messageDocId: input.messageDocId,
      source: input.source,
      sender: name,
      direction,
      newThread: !existing,
      ...(existing && state !== before ? { reopened: true } : {}),
    },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.message(ctx.workspaceId, input.messageDocId),
        data: {
          memberUid,
          threadId,
          direction,
          source: input.source,
          sender: { name, handle },
          text: input.text,
          threadRef: input.threadRef,
          messageId: input.messageId,
          permalink,
          replyRef,
          receivedAt: input.receivedAt,
          attachments,
          fetchedBy: ctx.actor.id,
          createdAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      existing
        ? upd(
            inboxPaths.thread(ctx.workspaceId, threadId),
            {
              ...(existing.state.refs.includes(input.ref) ? {} : { refs: arrayUnion(input.ref) }),
              lastMessageAt: SERVER_TIME,
              ...(state !== before ? { state, waiting: null } : {}),
            },
            eventId,
          )
        : {
            kind: 'set',
            path: inboxPaths.thread(ctx.workspaceId, threadId),
            data: {
              memberUid,
              subjectId: null,
              state,
              waiting: null,
              question: null,
              title,
              refs: [input.ref],
              lastMessageAt: SERVER_TIME,
              fetchedBy: ctx.actor.id,
              createdAt: SERVER_TIME,
              updatedAt: SERVER_TIME,
              lastEventId: eventId,
            },
          },
    ],
  );
  return { ...p, threadId, newThread: !existing, state };
}

/** Files a thread under a subject of its member: an existing one, or a new one named here. */
export function assignSubject(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    subjectId?: string;
    newName?: string;
    /** Sets the subject's area (new or existing); empty clears it. Left out: unchanged. */
    area?: string;
    /**
     * The agent's suggested label, from `labels` (the workspace's list). Applied to a new subject,
     * or to one that has none yet; a label the member confirmed is never touched.
     */
    label?: string;
    labels?: readonly string[];
    existing?: Pick<InboxSubject, 'label' | 'labelBy'> | null;
  },
): ActionPlan & { subjectId: string; created: boolean; labelApplied: boolean } {
  requireAgent(ctx);
  const t = input.thread;
  need(
    (input.subjectId === undefined) !== (input.newName === undefined),
    'Give either an existing subject id or a new subject name.',
  );
  const created = input.newName !== undefined;
  const name = created ? cleanSubjectName(input.newName!) : null;
  const area = input.area === undefined ? undefined : cleanArea(input.area);
  const subjectId = input.subjectId ?? nid(ctx);
  let label: string | null = null;
  if (input.label !== undefined) {
    const list = input.labels ?? DEFAULT_INBOX_LABELS;
    label = matchLabel(input.label, list);
    need(label !== null, `Unknown label. Use one of: ${list.join(', ')}.`);
    if (!created && input.existing?.label) label = null;
  }
  const labelFields = label ? { label, labelSuggested: true, labelBy: 'agent' as const } : null;
  const p = inboxPlan(
    ctx,
    'thread.filed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId },
    {
      ...(created ? { name, created: true } : { created: false }),
      from: t.subjectId,
      ...(area !== undefined ? { area } : {}),
      ...(label ? { label } : {}),
    },
    (eventId) => [
      ...(created
        ? [
            {
              kind: 'set' as const,
              path: inboxPaths.subject(ctx.workspaceId, subjectId),
              data: {
                memberUid: t.memberUid,
                name,
                ...(area ? { area } : {}),
                ...(labelFields ?? {}),
                createdBy: { type: ctx.actor.type, id: ctx.actor.id },
                createdAt: SERVER_TIME,
                updatedAt: SERVER_TIME,
                lastEventId: eventId,
              },
            },
          ]
        : area !== undefined || labelFields
          ? [
              upd(
                inboxPaths.subject(ctx.workspaceId, subjectId),
                { ...(area !== undefined ? { area } : {}), ...(labelFields ?? {}) },
                eventId,
              ),
            ]
          : []),
      upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { subjectId }, eventId),
    ],
  );
  return { ...p, subjectId, created, labelApplied: label !== null };
}

/** An investigation note on the thread's timeline (inbox_note). Changes nothing else. */
export function addThreadNote(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; text: string },
): ActionPlan {
  requireAgent(ctx);
  const text = cleanText('The note', input.text, INBOX_LIMITS.note);
  return inboxPlan(
    ctx,
    'thread.note',
    {
      memberUid: input.thread.memberUid,
      threadId: input.threadId,
      subjectId: input.thread.subjectId,
    },
    { text },
    () => [],
  );
}

/** The agent asks the member (inbox_ask): the thread goes to Needs you until they answer. */
export function askMember(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    question: string;
    /** Up to 4 answer chips (item kt3E7u9EliL3q2veDDI0). */
    options?: readonly string[] | null;
  },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  liveThread(t);
  const text = cleanText('The question', input.question, INBOX_LIMITS.question);
  const options = cleanLines('options', input.options, INBOX_LIMITS.options, INBOX_LIMITS.option);
  const opt = options.length > 0 ? { options } : {};
  return inboxPlan(
    ctx,
    'thread.asked',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { text, ...opt },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          state: 'needsYou',
          question: {
            text,
            by: ctx.actor.id,
            at: SERVER_TIME,
            answer: null,
            answeredAt: null,
            ...opt,
          },
        },
        eventId,
      ),
    ],
  );
}

/** The agent proposes an outcome (outcome_propose): the thread goes to Your call. */
export function proposeOutcome(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    type: string;
    fields: Readonly<Record<string, unknown>>;
    note?: string;
    outcomeId?: string;
    /** How sure the agent is (item kt3E7u9EliL3q2veDDI0); absent: no meter. */
    confidence?: string | null;
    /** What the agent verified, at most 6 lines of 1-200 characters. */
    checks?: readonly string[] | null;
  },
): ActionPlan & { outcomeId: string } {
  requireAgent(ctx);
  const t = input.thread;
  liveThread(t);
  const type = outcomeType(input.type);
  need(type !== null, `Unknown outcome type ${input.type}. Types: ${OUTCOME_TYPES.join(', ')}.`);
  let fields: Record<string, string | boolean>;
  try {
    fields = cleanOutcomeFields(input.type, input.fields);
  } catch (e) {
    if (e instanceof OutcomeFieldError) throw new ActionError(e.message);
    throw e;
  }
  const note = (input.note ?? '').trim();
  need(note.length <= INBOX_LIMITS.outcomeNote, tooLong('The note', INBOX_LIMITS.outcomeNote));
  const conf = input.confidence ?? null;
  need(
    conf === null || (OUTCOME_CONFIDENCE as readonly string[]).includes(conf),
    'The confidence is high, medium or low.',
  );
  const checks = cleanLines('checks', input.checks, INBOX_LIMITS.checks, INBOX_LIMITS.check);
  const outcomeId = input.outcomeId ?? nid(ctx);
  const p = inboxPlan(
    ctx,
    'outcome.proposed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { outcomeId, type: input.type, fields },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.outcome(ctx.workspaceId, outcomeId),
        data: {
          memberUid: t.memberUid,
          threadId: input.threadId,
          type: input.type,
          fields,
          state: 'proposed',
          note,
          ...(conf !== null ? { confidence: conf } : {}),
          ...(checks.length > 0 ? { checks } : {}),
          proposedBy: ctx.actor.id,
          executor: type!.executor === 'agent' ? t.fetchedBy : null,
          decision: null,
          result: null,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        { state: 'yourCall', waiting: null },
        eventId,
      ),
    ],
  );
  return { ...p, outcomeId };
}

/** The thread's state once an outcome of `type` is done. */
export function threadAfter(
  type: string,
  fields: Readonly<Record<string, string | boolean>>,
): { state: ThreadState; waiting: { on: WaitingOn; until: Date | null } | null } {
  const t = outcomeType(type);
  if (!t) throw new ActionError(`Unknown outcome type ${type}.`);
  if (t.after.state !== 'waiting') return { state: t.after.state, waiting: null };
  const f = t.untilField;
  const until = f && typeof fields[f] === 'string' ? new Date(fields[f]) : null;
  return { state: 'waiting', waiting: { on: t.after.waitingOn!, until } };
}

/**
 * The executing agent reports an approved outcome (outcome_done): done (the thread moves to the
 * type's after-state) or failed (the thread goes back to investigating).
 */
export function finishOutcome(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    status: 'done' | 'failed';
    result?: {
      text?: string | null;
      permalink?: string | null;
      itemId?: string | null;
      error?: string | null;
    };
  },
): ActionPlan {
  requireAgent(ctx);
  const o = input.outcome;
  need(
    o.state === 'approved',
    o.state === 'proposed'
      ? 'Not approved: nothing is carried out before the person approves it.'
      : `This outcome is ${o.state} already.`,
  );
  need(o.executor === ctx.actor.id, 'Only the agent that carries this outcome out reports it.');
  const r = input.result ?? {};
  const text = r.text?.trim() || null;
  need(
    text === null || text.length <= INBOX_LIMITS.resultText,
    tooLong('The result', INBOX_LIMITS.resultText),
  );
  const permalink = r.permalink?.trim() || null;
  need(
    permalink === null || (permalink.length <= INBOX_LIMITS.permalink && LINK.test(permalink)),
    'The permalink is an http(s) link.',
  );
  const itemId = r.itemId?.trim() || null;
  need(itemId === null || itemId.length <= 128, 'The item id is at most 128 characters.');
  const error = r.error?.trim() || null;
  need(
    error === null || error.length <= INBOX_LIMITS.reason,
    tooLong('The error', INBOX_LIMITS.reason),
  );
  if (input.status === 'failed') need(error !== null, 'Say what went wrong (result.error).');
  const after =
    input.status === 'done'
      ? threadAfter(o.type, o.fields)
      : { state: 'investigating' as const, waiting: null };
  return inboxPlan(
    ctx,
    input.status === 'done' ? 'outcome.done' : 'outcome.failed',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, permalink, itemId, ...(error ? { error } : {}) },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: input.status,
          result: { text, permalink, itemId, error, by: ctx.actor.id, at: SERVER_TIME },
        },
        eventId,
      ),
      upd(inboxPaths.thread(ctx.workspaceId, o.threadId), after, eventId),
    ],
  );
}

/** A snoozed thread whose date has come wakes up (thread_wake). */
export function wakeThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; nowMs: number },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  const until = t.state === 'waiting' ? (t.waiting?.until ?? null) : null;
  need(until !== null, 'This thread is not waiting for a date.');
  need(until!.toMillis() <= input.nowMs, 'Not yet: it waits until its date.');
  return inboxPlan(
    ctx,
    'thread.woke',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    {},
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        { state: 'investigating', waiting: null },
        eventId,
      ),
    ],
  );
}

/**
 * Marks a thread urgent, or not (thread_flag; its agent or its member). An urgent thread pings
 * the member at once, whatever their quiet hours (the notifier). Stored as `urgent: boolean`
 * on the thread; absent means false.
 */
export function flagThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; urgent: boolean; reason?: string | null },
): ActionPlan {
  if (ctx.actor.type === 'human') owner(ctx, input.thread.memberUid);
  const reason = input.reason?.trim() || null;
  need(
    reason === null || reason.length <= INBOX_LIMITS.reason,
    tooLong('The reason', INBOX_LIMITS.reason),
  );
  return inboxPlan(
    ctx,
    'thread.flagged',
    {
      memberUid: input.thread.memberUid,
      threadId: input.threadId,
      subjectId: input.thread.subjectId,
    },
    { urgent: input.urgent, reason },
    (eventId) => [
      upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { urgent: input.urgent }, eventId),
    ],
  );
}

/**
 * Sets or clears a thread's deadline (thread_due; its agent or its member, item
 * kt3E7u9EliL3q2veDDI0): an ISO 8601 time with its offset, or null. The Today page ranks by it.
 */
export function dueThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; due: string | null; reason?: string | null },
): ActionPlan {
  if (ctx.actor.type === 'human') owner(ctx, input.thread.memberUid);
  let due: Date | null = null;
  if (input.due !== null) {
    const s = typeof input.due === 'string' ? input.due.trim() : '';
    const ms = Date.parse(s);
    need(
      ISO_OFFSET.test(s) && !Number.isNaN(ms),
      'The due date is an ISO 8601 time with its offset, e.g. 2026-11-03T12:00:00Z.',
    );
    due = new Date(ms);
  }
  const reason = input.reason?.trim() || null;
  need(
    reason === null || reason.length <= INBOX_LIMITS.reason,
    tooLong('The reason', INBOX_LIMITS.reason),
  );
  return inboxPlan(
    ctx,
    'thread.due',
    {
      memberUid: input.thread.memberUid,
      threadId: input.threadId,
      subjectId: input.thread.subjectId,
    },
    { due: due ? due.toISOString() : null, reason },
    (eventId) => [upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { due }, eventId)],
  );
}

/** Retitles a thread (its agent or its member). */
export function retitleThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; title: string },
): ActionPlan {
  if (ctx.actor.type === 'human') owner(ctx, input.thread.memberUid);
  const title = cleanText('The title', input.title.replace(/\s+/g, ' '), INBOX_LIMITS.title);
  return inboxPlan(
    ctx,
    'thread.titled',
    {
      memberUid: input.thread.memberUid,
      threadId: input.threadId,
      subjectId: input.thread.subjectId,
    },
    { title },
    (eventId) => [upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { title }, eventId)],
  );
}

// ---------- the member ----------

/** The member answers the agent's question: the agent goes on investigating. */
export function answerQuestion(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; answer: string },
): ActionPlan {
  const t = input.thread;
  owner(ctx, t.memberUid);
  need(t.state === 'needsYou' && !!t.question, 'There is no question to answer.');
  const answer = cleanText('The answer', input.answer, INBOX_LIMITS.answer);
  return inboxPlan(
    ctx,
    'thread.answered',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { question: t.question!.text, answer },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        { state: 'investigating', 'question.answer': answer, 'question.answeredAt': SERVER_TIME },
        eventId,
      ),
    ],
  );
}

function sorted(f: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * The member approves a proposed outcome, as proposed or with edited fields. An outcome that
 * takes effect on approval (no_reply, snooze, ignore) is done at once and moves the thread.
 */
export function approveOutcome(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    fields?: Readonly<Record<string, unknown>>;
    /**
     * The version on show (Ask for changes): its fields are the ones approved, unless edited.
     * Approving while the agent revises ends the request; its late revision is then refused.
     */
    version?: number;
  },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(
    o.state === 'proposed' || o.state === 'revising',
    'Only a proposed outcome can be approved.',
  );
  const versions = o.versions ?? [];
  let base = o.fields;
  if (input.version !== undefined) {
    const v = versions[input.version - 1];
    need(
      Number.isInteger(input.version) && v !== undefined && v.n === input.version,
      `There is no version ${input.version} of this proposal.`,
    );
    base = v!.fields;
  }
  const version = versions.length ? (input.version ?? versions.length) : null;
  let fields = base;
  if (input.fields) {
    try {
      fields = cleanOutcomeFields(o.type, input.fields);
    } catch (e) {
      if (e instanceof OutcomeFieldError) throw new ActionError(e.message);
      throw e;
    }
  }
  const edited = JSON.stringify(sorted(fields)) !== JSON.stringify(sorted(base));
  const immediate = outcomeType(o.type)?.executor === 'none';
  const approval = inboxPlan(
    ctx,
    'outcome.approved',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    {
      outcomeId: input.outcomeId,
      type: o.type,
      edited,
      ...(edited ? { fields } : {}),
      ...(version !== null ? { version } : {}),
    },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: immediate ? 'done' : 'approved',
          fields,
          decision: {
            byUid: ctx.actor.id,
            at: SERVER_TIME,
            edited,
            reason: null,
            ...(version !== null ? { version } : {}),
          },
          ...(o.state === 'revising' ? { revise: null } : {}),
        },
        eventId,
      ),
      ...(immediate
        ? [
            upd(
              inboxPaths.thread(ctx.workspaceId, o.threadId),
              threadAfter(o.type, fields),
              eventId,
            ),
          ]
        : []),
    ],
  );
  if (o.type !== 'reply_book') return approval;
  // The booking goes into the member's calendar in the same batch (Inbox item w9SAf).
  const booking = bookingPlan(ctx, input.outcomeId, o.memberUid, fields);
  return { eventId: approval.eventId, ops: [...approval.ops, ...booking.ops] };
}

/** The calendar event of an approved reply_book outcome: source hivenod, id from the outcome. */
export function bookingEventId(memberUid: string, outcomeId: string): string {
  return calendarEventId(memberUid, BOOKING_SOURCE, outcomeId);
}
export const BOOKING_SOURCE = 'hivenod';

function bookingPlan(
  ctx: ActionContext,
  outcomeId: string,
  memberUid: string,
  fields: Readonly<Record<string, string | boolean>>,
): ActionPlan {
  const str = (k: string) => (typeof fields[k] === 'string' ? (fields[k] as string) : '');
  const start = new Date(str('start'));
  const end = new Date(str('end'));
  need(
    !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start,
    'The meeting must end after it starts.',
  );
  const who = str('with');
  const attendees = who
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter((a) => a !== '');
  try {
    return calendarUpsert(ctx, {
      memberUid,
      events: [
        {
          source: BOOKING_SOURCE,
          sourceEventId: outcomeId,
          title: str('title') || `Meeting with ${who}`,
          start,
          end,
          attendees,
        },
      ],
    });
  } catch (e) {
    if (e instanceof ActionError) throw new ActionError(`The booking: ${e.message}`);
    throw e;
  }
}

/** The member turns a proposal down; with none left, the agent investigates again. */
export function rejectOutcome(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    reason?: string;
    /** Other proposals of the thread still wait for the member. */
    othersPending: boolean;
  },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(o.state === 'proposed', 'Only a proposed outcome can be rejected.');
  const reason = input.reason?.trim() || null;
  need(
    reason === null || reason.length <= INBOX_LIMITS.reason,
    tooLong('The reason', INBOX_LIMITS.reason),
  );
  const back = !input.othersPending && input.thread.state === 'yourCall';
  return inboxPlan(
    ctx,
    'outcome.rejected',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, reason },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: 'rejected',
          decision: { byUid: ctx.actor.id, at: SERVER_TIME, edited: false, reason },
        },
        eventId,
      ),
      ...(back
        ? [
            upd(
              inboxPaths.thread(ctx.workspaceId, o.threadId),
              { state: 'investigating', waiting: null },
              eventId,
            ),
          ]
        : []),
    ],
  );
}

// ---------- Ask for changes (item L7OzWKMYZ1O2dX33Xkrj) ----------

/** How many versions an outcome has (1 before any revision). */
export function versionCount(o: Pick<OutcomeStateOf, 'versions'>): number {
  return Math.max(o.versions?.length ?? 0, 1);
}

/**
 * The member asks the proposing agent for changes: quick chips and/or an instruction (1-500
 * characters). The outcome goes to `revising` in place; the thread stays in Your call and no
 * rejection is written. The agent gets a `revise` inbox event.
 */
export function requestRevision(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    instruction?: string | null;
    chips?: readonly string[] | null;
  },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(
    o.state === 'proposed',
    o.state === 'revising'
      ? 'The agent is already revising it.'
      : 'Only a proposed outcome can be revised.',
  );
  need(REVISABLE_TYPES.includes(o.type), `A ${o.type} proposal has nothing to revise.`);
  need(
    versionCount(o) < INBOX_LIMITS.versions,
    `This proposal has ${INBOX_LIMITS.versions} versions: edit it yourself or pick another outcome.`,
  );
  const instruction = input.instruction?.trim() || null;
  need(
    instruction === null || instruction.length <= INBOX_LIMITS.reviseInstruction,
    tooLong('The instruction', INBOX_LIMITS.reviseInstruction),
  );
  const raw = input.chips ?? [];
  need(
    raw.every((c) => (REVISE_CHIPS as readonly string[]).includes(c)),
    `The chips are ${REVISE_CHIPS.join(', ')}.`,
  );
  const chips = REVISE_CHIPS.filter((c) => raw.includes(c));
  need(instruction !== null || chips.length > 0, 'Say what should change.');
  return inboxPlan(
    ctx,
    'outcome.revise_requested',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, instruction, chips },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: 'revising',
          revise: { instruction, chips, byUid: ctx.actor.id, at: SERVER_TIME },
        },
        eventId,
      ),
    ],
  );
}

/** The member takes the request back ("Revising… · Cancel"): the outcome is proposed again. */
export function cancelRevision(
  ctx: ActionContext,
  input: { outcomeId: string; outcome: OutcomeStateOf; thread: ThreadStateOf },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(o.state === 'revising', 'Nothing to cancel: the agent is not revising it.');
  return inboxPlan(
    ctx,
    'outcome.revise_requested',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, instruction: null, chips: [] },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        { state: 'proposed', revise: null },
        eventId,
      ),
    ],
  );
}

/**
 * The proposing agent writes the next version (outcome_propose with `revises`): same type, the
 * fields cleaned as a proposal's. The first revision keeps the original as v1. The outcome is
 * proposed again in the same slot; a decided outcome refuses it.
 */
export function reviseOutcome(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    type?: string;
    threadId?: string;
    fields: Readonly<Record<string, unknown>>;
    note?: string;
    confidence?: string | null;
    checks?: readonly string[] | null;
  },
): ActionPlan & { version: number } {
  requireAgent(ctx);
  const o = input.outcome;
  need(
    input.threadId === undefined || input.threadId === o.threadId,
    `Outcome ${input.outcomeId} is on thread ${o.threadId}, not ${input.threadId}: propose a new outcome instead.`,
  );
  need(
    input.type === undefined || input.type === o.type,
    `Outcome ${input.outcomeId} is a ${o.type}; a revision keeps the type: propose a new outcome instead.`,
  );
  need(
    o.state === 'revising',
    o.state === 'proposed'
      ? 'Nobody asked for changes on this outcome (or the person cancelled the request).'
      : `This outcome was already decided (${o.state}): your revision is not needed.`,
  );
  need(o.proposedBy === ctx.actor.id, 'Only the agent that proposed this outcome revises it.');
  let fields: Record<string, string | boolean>;
  try {
    fields = cleanOutcomeFields(o.type, input.fields);
  } catch (e) {
    if (e instanceof OutcomeFieldError) throw new ActionError(e.message);
    throw e;
  }
  const note = (input.note ?? '').trim();
  need(note.length <= INBOX_LIMITS.outcomeNote, tooLong('The note', INBOX_LIMITS.outcomeNote));
  const conf = input.confidence ?? null;
  need(
    conf === null || (OUTCOME_CONFIDENCE as readonly string[]).includes(conf),
    'The confidence is high, medium or low.',
  );
  const checks = cleanLines('checks', input.checks, INBOX_LIMITS.checks, INBOX_LIMITS.check);
  const prior: OutcomeVersion[] = o.versions?.length
    ? [...o.versions]
    : [
        {
          n: 1,
          fields: o.fields,
          note: o.note ?? '',
          confidence: o.confidence ?? null,
          checks: o.checks ?? [],
          by: o.proposedBy ?? ctx.actor.id,
          eventId: null,
          asked: null,
        },
      ];
  need(
    prior.length < INBOX_LIMITS.versions,
    `This proposal has ${INBOX_LIMITS.versions} versions already.`,
  );
  const version = prior.length + 1;
  const asked = o.revise ? { instruction: o.revise.instruction, chips: o.revise.chips } : null;
  const p = inboxPlan(
    ctx,
    'outcome.revised',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, version, fields },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: 'proposed',
          fields,
          note,
          confidence: conf,
          checks,
          versions: [
            ...prior,
            { n: version, fields, note, confidence: conf, checks, by: ctx.actor.id, eventId, asked },
          ],
          revise: null,
        },
        eventId,
      ),
    ],
  );
  return { ...p, version };
}

function setThreadState(
  ctx: ActionContext,
  type: 'thread.ignored' | 'thread.closed' | 'thread.restored',
  input: { threadId: string; thread: ThreadStateOf },
  state: ThreadState,
) {
  const t = input.thread;
  owner(ctx, t.memberUid);
  return inboxPlan(
    ctx,
    type,
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { from: t.state },
    (eventId) => [
      upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { state, waiting: null }, eventId),
    ],
  );
}
/** The member ignores a thread themselves. */
export function ignoreThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf },
) {
  need(input.thread.state !== 'ignored', 'This thread is ignored already.');
  return setThreadState(ctx, 'thread.ignored', input, 'ignored');
}
/** The member marks a thread done themselves (handled elsewhere). */
export function closeThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf },
) {
  need(!['done', 'ignored'].includes(input.thread.state), 'This thread is closed already.');
  return setThreadState(ctx, 'thread.closed', input, 'done');
}
/** Brings an ignored or done thread back to the agents. */
export function restoreThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf },
) {
  need(
    ['done', 'ignored'].includes(input.thread.state),
    'Only a done or ignored thread can be brought back.',
  );
  return setThreadState(ctx, 'thread.restored', input, 'investigating');
}

/** Moves one thread to another of the member's subjects. */
export function moveThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; subjectId: string },
): ActionPlan {
  owner(ctx, input.thread.memberUid);
  need(input.thread.subjectId !== input.subjectId, 'It is in that subject already.');
  return inboxPlan(
    ctx,
    'thread.moved',
    { memberUid: ctx.actor.id, threadId: input.threadId, subjectId: input.subjectId },
    { from: input.thread.subjectId },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        { subjectId: input.subjectId },
        eventId,
      ),
    ],
  );
}

/** Renames one of the member's subjects. */
export function renameSubject(
  ctx: ActionContext,
  input: { subjectId: string; subject: Pick<InboxSubject, 'memberUid' | 'name'>; name: string },
): ActionPlan {
  owner(ctx, input.subject.memberUid);
  const name = cleanSubjectName(input.name);
  return inboxPlan(
    ctx,
    'subject.renamed',
    { memberUid: ctx.actor.id, subjectId: input.subjectId },
    { from: input.subject.name, name },
    (eventId) => [upd(inboxPaths.subject(ctx.workspaceId, input.subjectId), { name }, eventId)],
  );
}

/** Sets (or clears, with an empty area) the area of one of the member's subjects. */
export function setSubjectArea(
  ctx: ActionContext,
  input: { subjectId: string; subject: Pick<InboxSubject, 'memberUid' | 'name'>; area: string },
): ActionPlan {
  owner(ctx, input.subject.memberUid);
  const area = cleanArea(input.area);
  return inboxPlan(
    ctx,
    'subject.area',
    { memberUid: ctx.actor.id, subjectId: input.subjectId },
    { area },
    (eventId) => [upd(inboxPaths.subject(ctx.workspaceId, input.subjectId), { area }, eventId)],
  );
}

/**
 * Confirms or changes the label of one of the member's subjects (empty: no label). The label
 * must be in the workspace's list, unless it is the one the subject already has.
 */
export function setSubjectLabel(
  ctx: ActionContext,
  input: {
    subjectId: string;
    subject: Pick<InboxSubject, 'memberUid' | 'name' | 'label'>;
    label: string;
    labels?: readonly string[];
  },
): ActionPlan {
  owner(ctx, input.subject.memberUid);
  const list = input.labels ?? DEFAULT_INBOX_LABELS;
  let label: string | null = null;
  if (input.label.trim() !== '') {
    label = input.subject.label === input.label ? input.label : matchLabel(input.label, list);
    need(label !== null, `Unknown label. Use one of: ${list.join(', ')}.`);
  }
  return inboxPlan(
    ctx,
    'subject.label',
    { memberUid: ctx.actor.id, subjectId: input.subjectId },
    { label, from: input.subject.label ?? null },
    (eventId) => [
      upd(
        inboxPaths.subject(ctx.workspaceId, input.subjectId),
        { label, labelSuggested: false, labelBy: 'member' },
        eventId,
      ),
    ],
  );
}

/** Sets the workspace's label list (admins only: the rules check the role). */
export function setInboxLabels(
  ctx: ActionContext,
  input: { labels: readonly string[] },
): ActionPlan {
  requireHuman(ctx);
  const labels = cleanLabelList(input.labels);
  return {
    eventId: '',
    ops: [
      {
        kind: 'set',
        path: inboxPaths.labels(ctx.workspaceId),
        data: { labels, updatedBy: ctx.actor.id, updatedAt: SERVER_TIME },
      },
    ],
  };
}

/** At most this many threads move in one merge or split (one batch). */
export const MAX_MOVE = 400;

/**
 * Merges subject `fromId` into `intoId`: every thread of `from` moves to `into`, and `from` is
 * deleted (tombstone event `del-subject-<fromId>`). The caller passes all of from's thread ids.
 */
export function mergeSubjects(
  ctx: ActionContext,
  input: {
    fromId: string;
    from: Pick<InboxSubject, 'memberUid' | 'name'>;
    intoId: string;
    into: Pick<InboxSubject, 'memberUid' | 'name'>;
    threadIds: readonly string[];
  },
): ActionPlan {
  owner(ctx, input.from.memberUid);
  need(
    input.into.memberUid === ctx.actor.id,
    'Only the person these subjects are for can merge them.',
  );
  need(input.fromId !== input.intoId, 'Pick two different subjects.');
  need(input.threadIds.length <= MAX_MOVE, `At most ${MAX_MOVE} threads move at once.`);
  return inboxPlan(
    ctx,
    'subject.merged',
    { memberUid: ctx.actor.id, subjectId: input.intoId },
    {
      fromId: input.fromId,
      fromName: input.from.name,
      intoName: input.into.name,
      threadIds: [...input.threadIds],
    },
    (eventId) => [
      ...input.threadIds.map((tid) =>
        upd(inboxPaths.thread(ctx.workspaceId, tid), { subjectId: input.intoId }, eventId),
      ),
      { kind: 'delete', path: inboxPaths.subject(ctx.workspaceId, input.fromId) },
      upd(inboxPaths.subject(ctx.workspaceId, input.intoId), {}, eventId),
    ],
    inboxPaths.deleteEventId(input.fromId),
  );
}

/** Splits some threads of a subject off into a new subject with its own name. */
export function splitSubject(
  ctx: ActionContext,
  input: {
    fromId: string;
    from: Pick<InboxSubject, 'memberUid' | 'name'>;
    name: string;
    threadIds: readonly string[];
    newId?: string;
  },
): ActionPlan & { subjectId: string } {
  owner(ctx, input.from.memberUid);
  need(input.threadIds.length > 0, 'Pick the threads that go to the new subject.');
  need(input.threadIds.length <= MAX_MOVE, `At most ${MAX_MOVE} threads move at once.`);
  const name = cleanSubjectName(input.name);
  const subjectId = input.newId ?? nid(ctx);
  const p = inboxPlan(
    ctx,
    'subject.split',
    { memberUid: ctx.actor.id, subjectId },
    { fromId: input.fromId, fromName: input.from.name, name, threadIds: [...input.threadIds] },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.subject(ctx.workspaceId, subjectId),
        data: {
          memberUid: ctx.actor.id,
          name,
          createdBy: { type: 'human', id: ctx.actor.id },
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...input.threadIds.map((tid) =>
        upd(inboxPaths.thread(ctx.workspaceId, tid), { subjectId }, eventId),
      ),
    ],
  );
  return { ...p, subjectId };
}

/**
 * The member's own "Make it work": a Hivenod item they create from a thread (createItem, with
 * them as its creator), linked on the thread's timeline by a `thread.itemMade` event in the same
 * batch. The thread itself does not change: proposals and agents carry on.
 */
export function makeItemFromThread(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: Pick<ThreadStateOf, 'memberUid' | 'subjectId'>;
    /** The createItem plan for the new item, built by the caller in the same context. */
    item: ActionPlan & { itemId: string };
    projectId: string;
    title: string;
  },
): ActionPlan & { itemId: string } {
  owner(ctx, input.thread.memberUid);
  const p = inboxPlan(
    ctx,
    'thread.itemMade',
    { memberUid: ctx.actor.id, threadId: input.threadId, subjectId: input.thread.subjectId },
    { projectId: input.projectId, itemId: input.item.itemId, title: input.title.slice(0, 300) },
    () => input.item.ops,
  );
  return { ...p, itemId: input.item.itemId };
}

// ---------- related subjects (docs/INBOX.md, "Related subjects") ----------

export const RELATION_STATES = ['proposed', 'related', 'rejected'] as const;
export type RelationState = (typeof RELATION_STATES)[number];

/**
 * workspaces/{wid}/inboxRelations/{rid}: two subjects of one member linked as related. It is
 * symmetric: `a` < `b` and the id is `rel-<a>-<b>` (relationId), so a pair has one document. An
 * agent proposes it (state proposed); the member accepts it (related) or turns it down
 * (rejected). The member can also relate two subjects directly, and remove a link (it goes back
 * to rejected, so agents do not propose it again). Never deleted. A link to a subject that a
 * merge removed is ignored.
 */
export const inboxRelationSchema = z.object({
  memberUid: z.string(),
  a: z.string(),
  b: z.string(),
  note: z.string().max(INBOX_LIMITS.relationNote),
  state: z.enum(RELATION_STATES),
  proposedBy: by,
  decision: z.object({ byUid: z.string(), at: timestamp }).nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxRelation = z.infer<typeof inboxRelationSchema>;
export type RelationStateOf = Pick<InboxRelation, 'memberUid' | 'a' | 'b' | 'note' | 'state'>;
type SubjectOf = Pick<InboxSubject, 'memberUid'>;

/** The one document id of a pair of subjects, either way round. */
export function relationId(a: string, b: string): string {
  const [x, y] = a < b ? [a, b] : [b, a];
  return `rel-${x}-${y}`;
}

function relationPair(input: { a: string; b: string; subjectA: SubjectOf; subjectB: SubjectOf }) {
  need(input.a !== input.b, 'Pick two different subjects.');
  need(
    input.subjectA.memberUid === input.subjectB.memberUid,
    'Both subjects must be for the same person.',
  );
  const [a, b] = input.a < input.b ? [input.a, input.b] : [input.b, input.a];
  return { a, b, relationId: `rel-${a}-${b}`, memberUid: input.subjectA.memberUid };
}

function relationNote(note: string | null | undefined): string {
  const n = (note ?? '').trim().replace(/\s+/g, ' ');
  need(n.length <= INBOX_LIMITS.relationNote, tooLong('The note', INBOX_LIMITS.relationNote));
  return n;
}

/**
 * An agent proposes that two subjects are related (subject_relate). It waits for the member's
 * OK; a pair already related, already proposed, or turned down is refused.
 */
export function proposeRelation(
  ctx: ActionContext,
  input: {
    a: string;
    b: string;
    subjectA: SubjectOf;
    subjectB: SubjectOf;
    existing: RelationStateOf | null;
    note?: string | null;
  },
): ActionPlan & { relationId: string; a: string; b: string } {
  requireAgent(ctx);
  const p = relationPair(input);
  const ex = input.existing;
  if (ex) {
    need(ex.state !== 'related', 'These subjects are related already.');
    need(ex.state !== 'proposed', 'This link is proposed already: it waits for the person.');
    need(false, 'The person turned this link down (or removed it): do not propose it again.');
  }
  const note = relationNote(input.note);
  const plan = inboxPlan(
    ctx,
    'relation.proposed',
    { memberUid: p.memberUid, subjectId: p.a },
    { relationId: p.relationId, a: p.a, b: p.b, note },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.relation(ctx.workspaceId, p.relationId),
        data: {
          memberUid: p.memberUid,
          a: p.a,
          b: p.b,
          note,
          state: 'proposed',
          proposedBy: { type: 'agent', id: ctx.actor.id },
          decision: null,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
  return { ...plan, relationId: p.relationId, a: p.a, b: p.b };
}

/**
 * The member relates two of their subjects: accepts an agent's proposal (relation.accepted,
 * maybe with a new note), relinks a pair turned down before, or links a new pair
 * (relation.created).
 */
export function relateSubjects(
  ctx: ActionContext,
  input: {
    a: string;
    b: string;
    subjectA: SubjectOf;
    subjectB: SubjectOf;
    existing: RelationStateOf | null;
    note?: string | null;
  },
): ActionPlan & { relationId: string } {
  owner(ctx, input.subjectA.memberUid);
  const p = relationPair(input);
  const ex = input.existing;
  need(ex?.state !== 'related', 'These subjects are related already.');
  const note =
    input.note === undefined || input.note === null ? (ex?.note ?? '') : relationNote(input.note);
  const type = ex?.state === 'proposed' ? 'relation.accepted' : 'relation.created';
  const path = inboxPaths.relation(ctx.workspaceId, p.relationId);
  const decision = { byUid: ctx.actor.id, at: SERVER_TIME };
  const plan = inboxPlan(
    ctx,
    type,
    { memberUid: p.memberUid, subjectId: p.a },
    { relationId: p.relationId, a: p.a, b: p.b, note },
    (eventId) => [
      ex
        ? upd(path, { state: 'related', note, decision }, eventId)
        : {
            kind: 'set',
            path,
            data: {
              memberUid: p.memberUid,
              a: p.a,
              b: p.b,
              note,
              state: 'related',
              proposedBy: { type: 'human', id: ctx.actor.id },
              decision,
              createdAt: SERVER_TIME,
              updatedAt: SERVER_TIME,
              lastEventId: eventId,
            },
          },
    ],
  );
  return { ...plan, relationId: p.relationId };
}

function decideRelation(
  ctx: ActionContext,
  input: { relationId: string; relation: RelationStateOf },
  from: RelationState,
  type: 'relation.rejected' | 'relation.removed',
  msg: string,
): ActionPlan {
  const r = input.relation;
  owner(ctx, r.memberUid);
  need(r.state === from, msg);
  return inboxPlan(
    ctx,
    type,
    { memberUid: r.memberUid, subjectId: r.a },
    { relationId: input.relationId, a: r.a, b: r.b },
    (eventId) => [
      upd(
        inboxPaths.relation(ctx.workspaceId, input.relationId),
        { state: 'rejected', decision: { byUid: ctx.actor.id, at: SERVER_TIME } },
        eventId,
      ),
    ],
  );
}
/** The member turns an agent's proposed link down. */
export function rejectRelation(
  ctx: ActionContext,
  input: { relationId: string; relation: RelationStateOf },
) {
  return decideRelation(
    ctx,
    input,
    'proposed',
    'relation.rejected',
    'Only a proposed link can be turned down.',
  );
}
/** The member removes a link (it stays turned down, so agents do not propose it again). */
export function unrelateSubjects(
  ctx: ActionContext,
  input: { relationId: string; relation: RelationStateOf },
) {
  return decideRelation(
    ctx,
    input,
    'related',
    'relation.removed',
    'These subjects are not related.',
  );
}

// ---------- subject search (docs/INBOX.md, "Finding subjects") ----------

export interface SubjectSearchFilters {
  /** Only subjects with threads waiting for the member (Needs you, Your call). */
  waitingForMe?: boolean;
  /** Only subjects with a message in the last N days. */
  activeDays?: number;
  /** Only subjects with open threads. */
  hasOpen?: boolean;
  /** At most this many (default 20, 1..100). */
  limit?: number;
}

export interface SubjectSearchInput {
  query: string;
  filters: SubjectSearchFilters;
  nowMs: number;
  subjects: { id: string; name: string }[];
  threads: {
    id: string;
    subjectId: string | null;
    state: string;
    title: string;
    lastMessageAtMs: number;
  }[];
  messages: {
    threadId: string;
    direction: string;
    source: string;
    senderName: string;
    senderHandle: string | null;
    text: string;
  }[];
  relations: { a: string; b: string; state: string; note: string }[];
}

export type SubjectMatch = 'name' | 'people' | 'channel' | 'thread' | 'text';
const MATCH_WEIGHT: [SubjectMatch, number][] = [
  ['name', 5],
  ['people', 3],
  ['channel', 3],
  ['thread', 2],
  ['text', 1],
];

export interface SubjectLink {
  subjectId: string;
  name: string;
  note: string;
}
export interface SubjectHit {
  subjectId: string;
  name: string;
  score: number;
  matched: SubjectMatch[];
  forYou: number;
  open: number;
  threads: number;
  lastActivityAt: string | null;
  people: string[];
  channels: string[];
  related: SubjectLink[];
  proposed: SubjectLink[];
}

export const SEARCH_LIMIT = { default: 20, max: 100, tokens: 10, people: 10 } as const;
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Finds a member's subjects (subject_search; the web app's Find): every word of the query
 * (lowercased) must appear in the subject's name, its people (sender names and handles), its
 * channels (sources), its thread titles or its message texts. Best first: name hits weigh 5,
 * people and channel 3, thread titles 2, texts 1; then waiting for the member, then the latest
 * activity. An empty query lists every subject that passes the filters. Pure, so the Go CLI and
 * the web app give the same answer.
 */
export function searchSubjects(input: SubjectSearchInput): {
  subjects: SubjectHit[];
  total: number;
} {
  const f = input.filters;
  const limit = Math.max(
    1,
    Math.min(SEARCH_LIMIT.max, Math.floor(f.limit ?? SEARCH_LIMIT.default) || SEARCH_LIMIT.default),
  );
  const tokens = input.query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '')
    .slice(0, SEARCH_LIMIT.tokens);
  const names = new Map(input.subjects.map((s) => [s.id, s.name]));
  const bySubject = new Map<string, SubjectSearchInput['threads']>();
  const subjectOf = new Map<string, string>();
  for (const t of input.threads) {
    if (t.subjectId === null || !names.has(t.subjectId)) continue;
    subjectOf.set(t.id, t.subjectId);
    const l = bySubject.get(t.subjectId) ?? [];
    l.push(t);
    bySubject.set(t.subjectId, l);
  }
  const msgs = new Map<string, SubjectSearchInput['messages']>();
  for (const m of input.messages) {
    const sid = subjectOf.get(m.threadId);
    if (!sid) continue;
    const l = msgs.get(sid) ?? [];
    l.push(m);
    msgs.set(sid, l);
  }
  const links = (sid: string, state: string): SubjectLink[] =>
    input.relations
      .filter((r) => r.state === state && (r.a === sid || r.b === sid))
      .map((r) => (r.a === sid ? r.b : r.a))
      .filter((o) => names.has(o))
      .map((o) => {
        const r = input.relations.find(
          (x) => x.state === state && ((x.a === sid && x.b === o) || (x.b === sid && x.a === o)),
        )!;
        return { subjectId: o, name: names.get(o)!, note: r.note };
      })
      .sort((x, y) => cmpStr(x.name, y.name) || cmpStr(x.subjectId, y.subjectId));
  const hits: (SubjectHit & { lastMs: number | null })[] = [];
  for (const s of input.subjects) {
    const threads = bySubject.get(s.id) ?? [];
    const ms = msgs.get(s.id) ?? [];
    const forYou = threads.filter((t) => THREAD_FOR_MEMBER.includes(t.state as ThreadState)).length;
    const open = threads.filter((t) => THREAD_OPEN.includes(t.state as ThreadState)).length;
    const lastMs = threads.length ? Math.max(...threads.map((t) => t.lastMessageAtMs)) : null;
    if (f.waitingForMe && forYou === 0) continue;
    if (f.hasOpen && open === 0) continue;
    if (f.activeDays !== undefined && f.activeDays !== null) {
      if (lastMs === null || lastMs < input.nowMs - f.activeDays * 86_400_000) continue;
    }
    const people = [
      ...new Set(ms.filter((m) => m.direction === 'in').map((m) => m.senderName)),
    ].sort(cmpStr);
    const channels = [...new Set(ms.map((m) => m.source))].sort(cmpStr);
    const fields: Record<SubjectMatch, string[]> = {
      name: [s.name.toLowerCase()],
      people: ms.flatMap((m) =>
        [m.senderName, m.senderHandle ?? ''].filter((x) => x !== '').map((x) => x.toLowerCase()),
      ),
      channel: channels,
      thread: threads.map((t) => t.title.toLowerCase()),
      text: ms.map((m) => m.text.toLowerCase()),
    };
    let score = 0;
    const matched = new Set<SubjectMatch>();
    let all = true;
    for (const tok of tokens) {
      let best = 0;
      for (const [k, w] of MATCH_WEIGHT)
        if (fields[k].some((v) => v.includes(tok))) {
          matched.add(k);
          best = Math.max(best, w);
        }
      if (best === 0) {
        all = false;
        break;
      }
      score += best;
    }
    if (!all) continue;
    hits.push({
      subjectId: s.id,
      name: s.name,
      score,
      matched: MATCH_WEIGHT.map(([k]) => k).filter((k) => matched.has(k)),
      forYou,
      open,
      threads: threads.length,
      lastActivityAt: lastMs === null ? null : new Date(lastMs).toISOString(),
      people: people.slice(0, SEARCH_LIMIT.people),
      channels,
      related: links(s.id, 'related'),
      proposed: links(s.id, 'proposed'),
      lastMs,
    });
  }
  hits.sort(
    (x, y) =>
      y.score - x.score ||
      y.forYou - x.forYou ||
      (x.lastMs === null ? 1 : 0) - (y.lastMs === null ? 1 : 0) ||
      (y.lastMs ?? 0) - (x.lastMs ?? 0) ||
      cmpStr(x.name, y.name) ||
      cmpStr(x.subjectId, y.subjectId),
  );
  return {
    subjects: hits.slice(0, limit).map((h) => {
      const { lastMs, ...rest } = h;
      void lastMs;
      return rest;
    }),
    total: hits.length,
  };
}
