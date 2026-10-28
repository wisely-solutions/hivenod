/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo, design docs/INBOX.md): incoming requests that agents bring
 * in for a member (Teams, mail, Jira mentions, …), filed under lasting named subjects, drafted by
 * an agent and sent only after the member's Send.
 *
 * Records (separate from items and projects):
 *   workspaces/{wid}/inboxRequests/{rid}   one input waiting for an answer
 *   workspaces/{wid}/inboxSubjects/{sid}   a lasting topic that collects requests
 *   workspaces/{wid}/inboxEvents/{eid}     the tracking log (create-only), also the timeline
 *
 * Privacy (firestore.rules): a request, its subject and its events are readable only by the
 * member they belong to (`memberUid`) and by the organization's non-revoked agents; only that
 * member edits, sends or ignores. The workspace-wide `events` collection is never used for
 * inbox writes, so other members never see them.
 *
 * Flow: new (an agent brought it in) → drafting (filed under a subject) → yourCall (draft
 * written) → sending (the member pressed Send) → done (the fetching agent posted it), or
 * ignored. Nothing reaches `sending` without the member: agents can never write `approved`.
 *
 * Like ./actions, each action is ONE batch: the change plus exactly one inbox event.
 */
import { z } from 'zod';
import {
  ActionError,
  nid,
  requireAgent,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import { timestamp } from './schema';

// ---------- shapes ----------

export const INBOX_STATUSES = [
  'new',
  'drafting',
  'yourCall',
  'sending',
  'done',
  'ignored',
] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];
/** Statuses an agent may still work (file, draft). */
export const INBOX_OPEN: readonly InboxStatus[] = ['new', 'drafting', 'yourCall'];
/** Statuses that count as "waiting for the member". */
export const INBOX_WAITING: readonly InboxStatus[] = ['yourCall'];

export const INBOX_EVENT_TYPES = [
  'inbox.added',
  'inbox.filed',
  'inbox.drafted',
  'inbox.edited',
  'inbox.approved',
  'inbox.ignored',
  'inbox.restored',
  'inbox.sent',
  'subject.created',
  'subject.renamed',
  'subject.merged',
  'subject.split',
  'subject.itemMade',
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
  reply: 20_000,
  actions: 10,
  action: 500,
  subjectName: 120,
} as const;

const httpUrl = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^https?:\/\/\S+$/);

export const inboxSenderSchema = z.object({
  name: z.string().min(1).max(INBOX_LIMITS.senderName),
  handle: z.string().max(INBOX_LIMITS.senderHandle).nullable(),
});
export const inboxAttachmentSchema = z.object({
  name: z.string().min(1).max(INBOX_LIMITS.attachmentName),
  url: httpUrl(2048),
});
export const inboxDraftSchema = z.object({
  reply: z.string().min(1).max(INBOX_LIMITS.reply),
  actions: z.array(z.string().min(1).max(INBOX_LIMITS.action)).max(INBOX_LIMITS.actions),
  by: z.object({ type: z.enum(['human', 'agent']), id: z.string() }),
  at: timestamp,
});
export const inboxApprovedSchema = z.object({
  reply: z.string().min(1).max(INBOX_LIMITS.reply),
  actions: z.array(z.string()).max(INBOX_LIMITS.actions),
  byUid: z.string(),
  at: timestamp,
});
export const inboxSentSchema = z.object({
  permalink: z.string().max(INBOX_LIMITS.permalink).nullable(),
  by: z.string(),
  at: timestamp,
});

export const inboxRequestSchema = z.object({
  memberUid: z.string(),
  subjectId: z.string().nullable(),
  status: z.enum(INBOX_STATUSES),
  source: z.string().regex(SOURCE_RE),
  sender: inboxSenderSchema,
  text: z.string().min(1).max(INBOX_LIMITS.text),
  threadRef: z.string().min(1).max(INBOX_LIMITS.threadRef),
  messageId: z.string().min(1).max(INBOX_LIMITS.messageId),
  permalink: z.string().max(INBOX_LIMITS.permalink).nullable(),
  replyRef: z.string().max(INBOX_LIMITS.replyRef).nullable(),
  receivedAt: timestamp,
  attachments: z.array(inboxAttachmentSchema).max(INBOX_LIMITS.attachments),
  draft: inboxDraftSchema.nullable(),
  approved: inboxApprovedSchema.nullable(),
  sent: inboxSentSchema.nullable(),
  /** The agent that brought it in; it is the one that posts the reply. */
  fetchedBy: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxRequest = z.infer<typeof inboxRequestSchema>;

export const inboxSubjectSchema = z.object({
  memberUid: z.string(),
  name: z.string().min(1).max(INBOX_LIMITS.subjectName),
  createdBy: z.object({ type: z.enum(['human', 'agent']), id: z.string() }),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxSubject = z.infer<typeof inboxSubjectSchema>;

export const inboxEventSchema = z.object({
  actor: z.object({ type: z.enum(['human', 'agent']), id: z.string(), name: z.string() }),
  memberUid: z.string(),
  requestId: z.string().nullable(),
  subjectId: z.string().nullable(),
  type: z.enum(INBOX_EVENT_TYPES),
  data: z.record(z.string(), z.unknown()),
  at: timestamp,
});
export type InboxEvent = z.infer<typeof inboxEventSchema>;

export const inboxPaths = {
  request: (w: string, r: string) => `workspaces/${w}/inboxRequests/${r}`,
  requests: (w: string) => `workspaces/${w}/inboxRequests`,
  subject: (w: string, s: string) => `workspaces/${w}/inboxSubjects/${s}`,
  subjects: (w: string) => `workspaces/${w}/inboxSubjects`,
  event: (w: string, e: string) => `workspaces/${w}/inboxEvents/${e}`,
  events: (w: string) => `workspaces/${w}/inboxEvents`,
  /** Tombstone event id of a subject deleted by a merge. */
  deleteEventId: (subjectId: string) => `del-subject-${subjectId}`,
} as const;

/** What an action needs of a request (a listener's data). */
export type InboxRequestState = Pick<
  InboxRequest,
  'memberUid' | 'subjectId' | 'status' | 'fetchedBy' | 'draft'
>;

// ---------- dedup ----------

/**
 * The deduplication key of an input: source + thread + message. Inputs with the same key are the
 * same request (agents bringing it in twice, or two agents seeing the same message). The request
 * id is `inboxRequestId(key)`: "rq" + the first 24 hex digits of SHA-256(key, UTF-8), computed by
 * the agent clients (node:crypto, Go crypto/sha256) since this module stays sync and SDK-free.
 */
export function inboxRequestKey(source: string, threadRef: string, messageId: string): string {
  return `${source}\u0000${threadRef}\u0000${messageId}`;
}
/** The request id for a SHA-256 hex digest of the key. */
export function inboxRequestIdFromDigest(hex: string): string {
  return `rq${hex.slice(0, 24)}`;
}

// ---------- plan ----------

export function inboxPlan(
  ctx: ActionContext,
  type: InboxEventType,
  scope: { memberUid: string; requestId?: string | null; subjectId?: string | null },
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
      requestId: scope.requestId ?? null,
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
function len(s: string): number {
  return s.length;
}
function need(cond: boolean, msg: string) {
  if (!cond) throw new ActionError(msg);
}
function requireOwner(ctx: ActionContext, r: InboxRequestState) {
  requireHuman(ctx);
  need(r.memberUid === ctx.actor.id, 'Only the person this request is for can do this.');
}
function cleanSubjectName(name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  need(n.length > 0, 'A subject needs a name.');
  need(len(n) <= INBOX_LIMITS.subjectName, tooLong('A subject name', INBOX_LIMITS.subjectName));
  return n;
}
function cleanReply(reply: string): string {
  const r = reply.trim();
  need(r.length > 0, 'The reply is empty.');
  need(len(r) <= INBOX_LIMITS.reply, tooLong('A reply', INBOX_LIMITS.reply));
  return r;
}
function cleanActions(actions: readonly string[]): string[] {
  need(actions.length <= INBOX_LIMITS.actions, `At most ${INBOX_LIMITS.actions} actions.`);
  return actions.map((a) => {
    const t = a.trim();
    need(
      t.length > 0 && len(t) <= INBOX_LIMITS.action,
      `An action is 1 to ${INBOX_LIMITS.action} characters.`,
    );
    return t;
  });
}
const OPEN_MSG: Record<InboxStatus, string> = {
  new: '',
  drafting: '',
  yourCall: '',
  sending: 'This request is being sent already.',
  done: 'This request is done: it was sent.',
  ignored: 'This request was ignored.',
};

// ---------- agents ----------

export interface InboxAddInput {
  requestId: string;
  memberUid: string;
  source: string;
  sender: { name: string; handle?: string | null };
  text: string;
  threadRef: string;
  messageId: string;
  permalink?: string | null;
  replyRef?: string | null;
  receivedAt: Date;
  attachments?: readonly { name: string; url: string }[];
}

/** An agent brings in a request it saw (inbox_add). It starts `new`, in no subject yet. */
export function addInboxRequest(ctx: ActionContext, input: InboxAddInput): ActionPlan {
  requireAgent(ctx);
  const L = INBOX_LIMITS;
  need(SOURCE_RE.test(input.source), 'The source is one lowercase word, like teams, mail or jira.');
  const name = input.sender.name.trim();
  need(name.length > 0, 'Say who sent it (sender name).');
  need(len(name) <= L.senderName, tooLong('The sender name', L.senderName));
  const handle = input.sender.handle?.trim() || null;
  need(
    handle === null || len(handle) <= L.senderHandle,
    tooLong('The sender handle', L.senderHandle),
  );
  need(input.text.trim().length > 0, 'The request has no text.');
  need(len(input.text) <= L.text, tooLong('The text', L.text));
  need(
    input.threadRef.length > 0 && len(input.threadRef) <= L.threadRef,
    `The thread reference is 1 to ${L.threadRef} characters.`,
  );
  need(
    input.messageId.length > 0 && len(input.messageId) <= L.messageId,
    `The message id is 1 to ${L.messageId} characters.`,
  );
  const permalink = input.permalink?.trim() || null;
  need(
    permalink === null || (len(permalink) <= L.permalink && /^https?:\/\/\S+$/.test(permalink)),
    'The permalink is an http(s) link.',
  );
  const replyRef = input.replyRef?.trim() || null;
  need(
    replyRef === null || len(replyRef) <= L.replyRef,
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
        len(a.name) <= L.attachmentName &&
        len(a.url) <= 2048 &&
        /^https?:\/\/\S+$/.test(a.url),
      'Each attachment is a name and an http(s) link.',
    );
  const rid = input.requestId;
  return inboxPlan(
    ctx,
    'inbox.added',
    { memberUid: input.memberUid, requestId: rid },
    { source: input.source, sender: name },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.request(ctx.workspaceId, rid),
        data: {
          memberUid: input.memberUid,
          subjectId: null,
          status: 'new',
          source: input.source,
          sender: { name, handle },
          text: input.text,
          threadRef: input.threadRef,
          messageId: input.messageId,
          permalink,
          replyRef,
          receivedAt: input.receivedAt,
          attachments,
          draft: null,
          approved: null,
          sent: null,
          fetchedBy: ctx.actor.id,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/**
 * Files a request under a subject (subject_assign): an existing one of the same member, or a new
 * one named here. A new request moves on to `drafting`.
 */
export function assignSubject(
  ctx: ActionContext,
  input: {
    requestId: string;
    request: InboxRequestState;
    /** An existing subject of the request's member. */
    subjectId?: string;
    /** Or a new subject with this name. */
    newName?: string;
  },
): ActionPlan & { subjectId: string; created: boolean } {
  requireAgent(ctx);
  const r = input.request;
  need(INBOX_OPEN.includes(r.status), OPEN_MSG[r.status]);
  need(
    (input.subjectId === undefined) !== (input.newName === undefined),
    'Give either an existing subject id or a new subject name.',
  );
  const created = input.newName !== undefined;
  const name = created ? cleanSubjectName(input.newName!) : null;
  const subjectId = input.subjectId ?? nid(ctx);
  const status = r.status === 'new' ? 'drafting' : r.status;
  const p = inboxPlan(
    ctx,
    'inbox.filed',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId },
    created ? { name, created: true } : { created: false },
    (eventId) => [
      ...(created
        ? [
            {
              kind: 'set' as const,
              path: inboxPaths.subject(ctx.workspaceId, subjectId),
              data: {
                memberUid: r.memberUid,
                name,
                createdBy: { type: ctx.actor.type, id: ctx.actor.id },
                createdAt: SERVER_TIME,
                updatedAt: SERVER_TIME,
                lastEventId: eventId,
              },
            },
          ]
        : []),
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: { subjectId, status, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
  return { ...p, subjectId, created };
}

/** The agent's proposed answer in the member's voice (inbox_draft): the request waits for them. */
export function draftReply(
  ctx: ActionContext,
  input: {
    requestId: string;
    request: InboxRequestState;
    reply: string;
    actions?: readonly string[];
  },
): ActionPlan {
  requireAgent(ctx);
  const r = input.request;
  need(INBOX_OPEN.includes(r.status), OPEN_MSG[r.status]);
  need(r.subjectId !== null, 'File the request under a subject first (subject_assign).');
  const reply = cleanReply(input.reply);
  const actions = cleanActions(input.actions ?? []);
  return inboxPlan(
    ctx,
    'inbox.drafted',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { reply, actions },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: {
          status: 'yourCall',
          draft: { reply, actions, by: { type: 'agent', id: ctx.actor.id }, at: SERVER_TIME },
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/**
 * The fetching agent posted the approved reply in the source channel, as the member (inbox_sent).
 * Only after Send (`sending`), and only the agent that brought the request in.
 */
export function markSent(
  ctx: ActionContext,
  input: { requestId: string; request: InboxRequestState; permalink?: string | null },
): ActionPlan {
  requireAgent(ctx);
  const r = input.request;
  need(
    r.status === 'sending',
    r.status === 'done'
      ? OPEN_MSG.done
      : 'Not approved: only a request its person pressed Send on can be sent.',
  );
  need(
    r.fetchedBy === ctx.actor.id,
    'Only the agent that brought this request in sends its reply.',
  );
  const permalink = input.permalink?.trim() || null;
  need(
    permalink === null ||
      (len(permalink) <= INBOX_LIMITS.permalink && /^https?:\/\/\S+$/.test(permalink)),
    'The permalink is an http(s) link.',
  );
  return inboxPlan(
    ctx,
    'inbox.sent',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { permalink },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: {
          status: 'done',
          sent: { permalink, by: ctx.actor.id, at: SERVER_TIME },
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

// ---------- the member ----------

/** Edit: the member rewrites the draft; it stays waiting for their Send. */
export function editDraft(
  ctx: ActionContext,
  input: {
    requestId: string;
    request: InboxRequestState;
    reply: string;
    actions?: readonly string[];
  },
): ActionPlan {
  const r = input.request;
  requireOwner(ctx, r);
  need(r.status === 'yourCall' && r.draft !== null, 'There is no draft to edit.');
  const reply = cleanReply(input.reply);
  const actions = cleanActions(input.actions ?? r.draft!.actions);
  return inboxPlan(
    ctx,
    'inbox.edited',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { reply, actions },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: {
          draft: { reply, actions, by: { type: 'human', id: ctx.actor.id }, at: SERVER_TIME },
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/**
 * Send: the member approves the draft (as it stands, or with their last edit). The fetching agent
 * then posts exactly `approved.reply` and calls inbox_sent. The only way to `sending`.
 */
export function sendReply(
  ctx: ActionContext,
  input: { requestId: string; request: InboxRequestState },
): ActionPlan {
  const r = input.request;
  requireOwner(ctx, r);
  need(r.status === 'yourCall' && r.draft !== null, 'There is no draft to send yet.');
  const { reply, actions } = r.draft!;
  return inboxPlan(
    ctx,
    'inbox.approved',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { reply, actions },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: {
          status: 'sending',
          approved: { reply, actions: [...actions], byUid: ctx.actor.id, at: SERVER_TIME },
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/** Ignore: no answer goes out. Undo with restoreRequest. */
export function ignoreRequest(
  ctx: ActionContext,
  input: { requestId: string; request: InboxRequestState },
): ActionPlan {
  const r = input.request;
  requireOwner(ctx, r);
  need(INBOX_OPEN.includes(r.status), OPEN_MSG[r.status]);
  return inboxPlan(
    ctx,
    'inbox.ignored',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { from: r.status },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: { status: 'ignored', updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Brings an ignored request back: to Your call with its draft, else to where an agent picks it up. */
export function restoreRequest(
  ctx: ActionContext,
  input: { requestId: string; request: InboxRequestState },
): ActionPlan {
  const r = input.request;
  requireOwner(ctx, r);
  need(r.status === 'ignored', 'Only an ignored request can be brought back.');
  const status: InboxStatus = r.draft ? 'yourCall' : r.subjectId ? 'drafting' : 'new';
  return inboxPlan(
    ctx,
    'inbox.restored',
    { memberUid: r.memberUid, requestId: input.requestId, subjectId: r.subjectId },
    { to: status },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.request(ctx.workspaceId, input.requestId),
        data: { status, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Renames one of the member's subjects. */
export function renameSubject(
  ctx: ActionContext,
  input: { subjectId: string; subject: Pick<InboxSubject, 'memberUid' | 'name'>; name: string },
): ActionPlan {
  requireHuman(ctx);
  need(
    input.subject.memberUid === ctx.actor.id,
    'Only the person this subject is for can rename it.',
  );
  const name = cleanSubjectName(input.name);
  return inboxPlan(
    ctx,
    'subject.renamed',
    { memberUid: ctx.actor.id, subjectId: input.subjectId },
    { from: input.subject.name, name },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.subject(ctx.workspaceId, input.subjectId),
        data: { name, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** At most this many requests move in one merge or split (one batch). */
export const MAX_MOVE = 400;

/**
 * Merges subject `fromId` into `intoId`: every request of `from` moves to `into`, and `from` is
 * deleted (tombstone event `del-subject-<fromId>`). The caller passes all of from's request ids.
 */
export function mergeSubjects(
  ctx: ActionContext,
  input: {
    fromId: string;
    from: Pick<InboxSubject, 'memberUid' | 'name'>;
    intoId: string;
    into: Pick<InboxSubject, 'memberUid' | 'name'>;
    requestIds: readonly string[];
  },
): ActionPlan {
  requireHuman(ctx);
  need(
    input.from.memberUid === ctx.actor.id && input.into.memberUid === ctx.actor.id,
    'Only the person these subjects are for can merge them.',
  );
  need(input.fromId !== input.intoId, 'Pick two different subjects.');
  need(input.requestIds.length <= MAX_MOVE, `At most ${MAX_MOVE} requests move at once.`);
  return inboxPlan(
    ctx,
    'subject.merged',
    { memberUid: ctx.actor.id, subjectId: input.intoId },
    {
      fromId: input.fromId,
      fromName: input.from.name,
      intoName: input.into.name,
      requestIds: [...input.requestIds],
    },
    (eventId) => [
      ...input.requestIds.map((rid) => ({
        kind: 'update' as const,
        path: inboxPaths.request(ctx.workspaceId, rid),
        data: { subjectId: input.intoId, updatedAt: SERVER_TIME, lastEventId: eventId },
      })),
      { kind: 'delete', path: inboxPaths.subject(ctx.workspaceId, input.fromId) },
      {
        kind: 'update',
        path: inboxPaths.subject(ctx.workspaceId, input.intoId),
        data: { updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
    inboxPaths.deleteEventId(input.fromId),
  );
}

/** Splits some requests of a subject off into a new subject with its own name. */
export function splitSubject(
  ctx: ActionContext,
  input: {
    fromId: string;
    from: Pick<InboxSubject, 'memberUid' | 'name'>;
    name: string;
    requestIds: readonly string[];
    /** The new subject's id; defaults to a new one. */
    newId?: string;
  },
): ActionPlan & { subjectId: string } {
  requireHuman(ctx);
  need(input.from.memberUid === ctx.actor.id, 'Only the person this subject is for can split it.');
  need(input.requestIds.length > 0, 'Pick the requests that go to the new subject.');
  need(input.requestIds.length <= MAX_MOVE, `At most ${MAX_MOVE} requests move at once.`);
  const name = cleanSubjectName(input.name);
  const subjectId = input.newId ?? nid(ctx);
  const p = inboxPlan(
    ctx,
    'subject.split',
    { memberUid: ctx.actor.id, subjectId },
    { fromId: input.fromId, fromName: input.from.name, name, requestIds: [...input.requestIds] },
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
      ...input.requestIds.map((rid) => ({
        kind: 'update' as const,
        path: inboxPaths.request(ctx.workspaceId, rid),
        data: { subjectId, updatedAt: SERVER_TIME, lastEventId: eventId },
      })),
    ],
  );
  return { ...p, subjectId };
}

// ---------- reading ----------

/** Waiting requests per subject id (requests at Your call). */
export function waitingBySubject(
  requests: readonly Pick<InboxRequest, 'subjectId' | 'status'>[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of requests)
    if (r.subjectId && INBOX_WAITING.includes(r.status))
      m.set(r.subjectId, (m.get(r.subjectId) ?? 0) + 1);
  return m;
}
