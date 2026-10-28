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

export const OUTCOME_STATES = ['proposed', 'approved', 'rejected', 'done', 'failed'] as const;
export type OutcomeState = (typeof OUTCOME_STATES)[number];

export const INBOX_EVENT_TYPES = [
  // agents
  'inbox.added',
  'thread.filed',
  'thread.note',
  'thread.asked',
  'thread.woke',
  'outcome.proposed',
  'outcome.done',
  'outcome.failed',
  // agents and the member
  'thread.titled',
  'thread.flagged',
  // the member
  'thread.answered',
  'thread.ignored',
  'thread.closed',
  'thread.restored',
  'thread.moved',
  'outcome.approved',
  'outcome.rejected',
  'subject.created',
  'subject.renamed',
  'subject.merged',
  'subject.split',
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
  title: 200,
  note: 8000,
  question: 4000,
  answer: 4000,
  outcomeNote: 2000,
  reason: 1000,
  resultText: 20_000,
  refs: 50,
  relationNote: 500,
} as const;

const by = z.object({ type: z.enum(['human', 'agent']), id: z.string() });

export const inboxSubjectSchema = z.object({
  memberUid: z.string(),
  name: z.string().min(1).max(INBOX_LIMITS.subjectName),
  createdBy: by,
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxSubject = z.infer<typeof inboxSubjectSchema>;

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

export const inboxOutcomeSchema = z.object({
  memberUid: z.string(),
  threadId: z.string(),
  type: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.boolean()])),
  state: z.enum(OUTCOME_STATES),
  /** The agent's why, for the member. */
  note: z.string().max(INBOX_LIMITS.outcomeNote),
  proposedBy: z.string(),
  /** The agent that carries it out; null when it takes effect on approval. */
  executor: z.string().nullable(),
  decision: z
    .object({
      byUid: z.string(),
      at: timestamp,
      edited: z.boolean(),
      reason: z.string().nullable(),
    })
    .nullable(),
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
/** A thread's title from its first message: the first non-empty line, at most 120 characters. */
export function titleFrom(text: string): string {
  const first = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return first.trim().replace(/\s+/g, ' ').slice(0, 120);
}
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
  input: { threadId: string; thread: ThreadStateOf; subjectId?: string; newName?: string },
): ActionPlan & { subjectId: string; created: boolean } {
  requireAgent(ctx);
  const t = input.thread;
  need(
    (input.subjectId === undefined) !== (input.newName === undefined),
    'Give either an existing subject id or a new subject name.',
  );
  const created = input.newName !== undefined;
  const name = created ? cleanSubjectName(input.newName!) : null;
  const subjectId = input.subjectId ?? nid(ctx);
  const p = inboxPlan(
    ctx,
    'thread.filed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId },
    created ? { name, created: true, from: t.subjectId } : { created: false, from: t.subjectId },
    (eventId) => [
      ...(created
        ? [
            {
              kind: 'set' as const,
              path: inboxPaths.subject(ctx.workspaceId, subjectId),
              data: {
                memberUid: t.memberUid,
                name,
                createdBy: { type: ctx.actor.type, id: ctx.actor.id },
                createdAt: SERVER_TIME,
                updatedAt: SERVER_TIME,
                lastEventId: eventId,
              },
            },
          ]
        : []),
      upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { subjectId }, eventId),
    ],
  );
  return { ...p, subjectId, created };
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
  input: { threadId: string; thread: ThreadStateOf; question: string },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  liveThread(t);
  const text = cleanText('The question', input.question, INBOX_LIMITS.question);
  return inboxPlan(
    ctx,
    'thread.asked',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { text },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          state: 'needsYou',
          question: { text, by: ctx.actor.id, at: SERVER_TIME, answer: null, answeredAt: null },
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
  },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(o.state === 'proposed', 'Only a proposed outcome can be approved.');
  let fields = o.fields;
  if (input.fields) {
    try {
      fields = cleanOutcomeFields(o.type, input.fields);
    } catch (e) {
      if (e instanceof OutcomeFieldError) throw new ActionError(e.message);
      throw e;
    }
  }
  const edited = JSON.stringify(sorted(fields)) !== JSON.stringify(sorted(o.fields));
  const immediate = outcomeType(o.type)?.executor === 'none';
  const approval = inboxPlan(
    ctx,
    'outcome.approved',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, type: o.type, edited, ...(edited ? { fields } : {}) },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        {
          state: immediate ? 'done' : 'approved',
          fields,
          decision: { byUid: ctx.actor.id, at: SERVER_TIME, edited, reason: null },
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
