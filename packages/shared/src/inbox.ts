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
  DELETE_FIELD,
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
  OUTCOME_CONFIDENCE,
  threadAfter,
  outcomeKind,
  PLAN_TYPES,
  SINGLE_TYPES,
  OutcomeFieldError,
  outcomeType,
  isRetiredOutcome,
} from './outcomes';
import {
  PLAN_LIMITS,
  planThreadState,
  type PlanOutcomeOf,
  type PlanState,
  type PlanStateOf,
} from './plans';
import { planTemplate, sendBackTarget, templateSendBack, templateSteps } from './planTemplates';
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
  /** A plan's Build it step: the item is made, the step waits for it to be Done (qwFAW). */
  'running',
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
  // plans (item qwFAWxZM5xkcE7PPjAzi): the agent proposes, starts a Build it step
  'plan.proposed',
  'outcome.started',
  // Re-check (item bmNoIvvqKCdAorLSShE9): the home agent reports what it found
  'thread.rechecked',
  // Ask the agent (item w6O2KOw4ys70TQv9I1xD): the home agent answers, suggests chips
  'thread.instruction_answered',
  'thread.chips_suggested',
  // Summaries (item OE8FmrTaIxFVGcaeGG3N, ./summary.ts): the home agent wrote a new version
  'summary.written',
  // Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4, ./threadattach.ts)
  'thread.attached',
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
  'thread.recheck_requested',
  'thread.instructed',
  // Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3): out of Today until 09:00 the next day
  'thread.not_now',
  'plan.approved',
  'plan.rejected',
  'plan.edited',
  'plan.retried',
  'plan.skipped',
  'plan.stopped',
  // Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): New thread, and a send back by the
  // member (Ask for changes on a gate) or by the agent (plan_send_back)
  'thread.created',
  'plan.sent_back',
  // Long steps (slice 6b): the executing agent's progress line and heartbeat on a running step
  'step.progress',
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
  /** Re-check: the agent's note on what it found, in characters. */
  recheckNote: 500,
  /** Ask the agent: an instruction's characters, the instructions a thread keeps, the chips an agent suggests, its answer's note. */
  instruction: 500,
  instructions: 20,
  suggestedChips: 5,
  instructNote: 500,
  /** A long step's progress line (step_progress, slice 6b), in characters. */
  progressLine: 140,
} as const;

/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): the quick chips. `recheck` asks for a Re-check
 * (requestRecheck); the others are sent as an instruction with that chip.
 */
export const INSTRUCT_CHIPS = [
  'prepare_meeting',
  'recheck',
  'follow_up',
  'summarize',
  'draft_reply',
] as const;
export type InstructChip = (typeof INSTRUCT_CHIPS)[number];
/** The chips an instruction may carry (Re-check has its own request). */
export const INSTRUCTION_CHIPS = INSTRUCT_CHIPS.filter((c) => c !== 'recheck') as Exclude<
  InstructChip,
  'recheck'
>[];
export const INSTRUCT_CHIP_LABELS: Record<InstructChip, string> = {
  prepare_meeting: 'Prepare for the meeting',
  recheck: 'Re-check',
  follow_up: 'Follow up',
  summarize: 'Summarize',
  draft_reply: 'Draft a reply',
};
/** What each chip asks the agent (its inbox event says this). */
export const INSTRUCT_CHIP_TEXT: Record<InstructChip, string> = {
  prepare_meeting:
    'Prepare me for the meeting on this thread: who, what it is about, what to bring or decide.',
  recheck: 'Check this thread again.',
  follow_up: 'They have not answered: propose a follow-up (a nudge) if one makes sense.',
  summarize: 'Summarize this thread: where it stands, what was agreed, what is open.',
  draft_reply: 'Draft a reply to their last message.',
};
/** How the home agent answered an instruction. */
export const INSTRUCT_ANSWERS = ['note', 'ask', 'outcome', 'plan'] as const;
export type InstructAnswer = (typeof INSTRUCT_ANSWERS)[number];
/** An instruction the agent has not answered after this long: the member may ask again. */
export const INSTRUCT_RETRY_MS = 30 * 60_000;

/**
 * Re-check (item bmNoIvvqKCdAorLSShE9): what the home agent found when the member asked it to
 * check a thread again. still_good: the open proposals stand (stamped `checkedAt`); revised: it
 * wrote new versions (outcome_propose revises); asked: it asked the member (inbox_ask).
 */
export const RECHECK_RESULTS = ['still_good', 'revised', 'asked'] as const;
export type RecheckResult = (typeof RECHECK_RESULTS)[number];
/** A request the agent has not answered after this long may be made again. */
export const RECHECK_RETRY_MS = 30 * 60_000;

/** The quick chips of Ask for changes, in the order the card shows them. */
export const REVISE_CHIPS = ['shorter', 'formal', 'warmer', 'availability'] as const;
export type ReviseChip = (typeof REVISE_CHIPS)[number];
export const REVISE_CHIP_LABELS: Record<ReviseChip, string> = {
  shorter: 'Shorter',
  formal: 'More formal',
  warmer: 'Warmer',
  availability: 'Add my availability',
};
/** The refusal for a retired outcome type (bookings went with Calendar, slice 5). */
export const RETIRED_MESSAGE = (type: string) =>
  `${type} was retired with Calendar: bookings are no longer made through Hivenod. Reject it, or propose a reply that suggests times.`;

/** The outcome types with text worth revising (the others are a one-tap decision). */
export const REVISABLE_TYPES: readonly string[] = ['reply', 'nudge', 'handover', 'make_it_work'];

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
    .object({
      on: z.enum(['them', 'thirdParty', 'date', 'item', 'agent']),
      until: timestamp.nullable(),
    })
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
  /**
   * Re-check (item bmNoIvvqKCdAorLSShE9): the member's last request that the home agent check the
   * thread again, and what it found. Absent until the first request.
   */
  recheck: z
    .object({
      state: z.enum(['pending', 'done']),
      by: z.string(),
      requestedAt: timestamp,
      result: z.enum(RECHECK_RESULTS).nullable(),
      note: z.string().max(INBOX_LIMITS.recheckNote).nullable(),
      at: timestamp.nullable(),
    })
    .nullable()
    .optional(),
  /**
   * Ask the agent (item w6O2KOw4ys70TQv9I1xD): the member's instructions by id (the event that
   * made each), at most 20 kept; append-only, each answered once by the home agent.
   */
  instructions: z
    .record(
      z.string(),
      z.object({
        text: z.string().max(INBOX_LIMITS.instruction).nullable(),
        chip: z.enum(INSTRUCT_CHIPS).nullable(),
        by: z.string(),
        at: timestamp,
        state: z.enum(['pending', 'answered']),
        answer: z
          .object({
            kind: z.enum(INSTRUCT_ANSWERS),
            refId: z.string().nullable(),
            note: z.string().max(INBOX_LIMITS.instructNote).nullable(),
            at: timestamp,
          })
          .nullable(),
      }),
    )
    .optional(),
  /** The latest instruction and whether it waits for the agent (its listener queries this). */
  instruct: z
    .object({ state: z.enum(['pending', 'done']), id: z.string(), at: timestamp })
    .nullable()
    .optional(),
  /** Chips the home agent suggests for this thread (thread_suggest_chips), at most 5. */
  suggestedChips: z.array(z.enum(INSTRUCT_CHIPS)).max(INBOX_LIMITS.suggestedChips).optional(),
  /**
   * The top line of the thread's summary (item OE8FmrTaIxFVGcaeGG3N, ./summary.ts), mirrored
   * from inboxSummaries/{tid} by the same batch; absent until the home agent writes one.
   */
  summary: z
    .object({
      version: z.number().int().min(1),
      at: timestamp,
      headline: z.string(),
      ask: z.string().nullable(),
      answer: z.string().nullable(),
      recAction: z.string().nullable(),
      confidence: z.enum(OUTCOME_CONFIDENCE).nullable(),
    })
    .optional(),
  /**
   * Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3, ./threadask.ts): the member put the decision
   * `key` (threadAsk) out of Today until `until`; absent until the first one.
   */
  notNow: z.object({ until: timestamp, key: z.string(), at: timestamp }).nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxThread = z.infer<typeof inboxThreadSchema>;
export type InboxInstruction = NonNullable<InboxThread['instructions']>[string];

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
      /** A gate's approval: the summary version on screen (slice 6). */
      summaryVersion: z.number().int().optional(),
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
  /** The plan it is a step of (item qwFAWxZM5xkcE7PPjAzi); absent: a single outcome. */
  planId: z.string().optional(),
  /**
   * A running long step's last progress (slice 6b, step_progress): its line, a percentage, and
   * when (the heartbeat). Absent until the first one.
   */
  progress: z
    .object({ line: z.string(), percent: z.number().int().nullable(), at: timestamp })
    .optional(),
  /** When the home agent last re-checked it and found it still good (absent: never). */
  checkedAt: timestamp.optional(),
  /**
   * Reach out (item KZ6O9), written by the notifier only: a status request to the executing agent
   * on a step in its hands that went quiet (byUid 'hivenod', or the person who pressed Ping
   * again), and the silence flag when it did not answer.
   */
  statusAsk: z.object({ byUid: z.string(), at: timestamp }).nullable().optional(),
  silence: z
    .object({
      since: z.number(),
      at: z.number(),
      asked: z.number().nullable().optional(),
      agent: z.string().max(200).optional(),
      told: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
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
  plan: (w: string, p: string) => `workspaces/${w}/inboxPlans/${p}`,
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
  /** Re-check: only `state` and `requestedAt` matter to the actions. */
  recheck?: {
    state: 'pending' | 'done';
    requestedAt?: { toMillis(): number } | null;
  } | null;
  /** Ask the agent: the instructions (only `state` and `at` matter here) and the latest one. */
  instructions?: Readonly<
    Record<string, { state: 'pending' | 'answered'; at?: { toMillis(): number } | null }>
  >;
  instruct?: { state: 'pending' | 'done'; id: string; at?: { toMillis(): number } | null } | null;
  /** The summary mirror (slice 9): its version and recommended action go on decision events. */
  summary?: { version: number; recAction: string | null } | null;
};
export type OutcomeStateOf = Pick<
  InboxOutcome,
  'memberUid' | 'threadId' | 'type' | 'fields' | 'state' | 'executor'
> &
  Partial<
    Pick<
      InboxOutcome,
      'proposedBy' | 'note' | 'confidence' | 'checks' | 'versions' | 'revise' | 'planId'
    >
  > & {
    /** When it was last written (its latest version): a proposal's wait starts there (slice 9). */
    updatedAt?: { toMillis(): number } | null;
    createdAt?: { toMillis(): number } | null;
  };
/** What the plan actions need of a plan (a listener's data). */
export type PlanOf = PlanStateOf & {
  memberUid: string;
  threadId: string;
  /** When the cursor last moved (slice 9; absent on older plans: createdAt). */
  cursorAt?: { toMillis(): number } | null;
  createdAt?: { toMillis(): number } | null;
  templateId?: string | null;
};
/** A plan with its steps' outcomes (by id), as the plan actions take it. */
export interface PlanInput {
  planId: string;
  plan: PlanOf;
  outcomes: Readonly<Record<string, OutcomeStateOf>>;
}

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

// ---------- plans (item qwFAWxZM5xkcE7PPjAzi) ----------

/** The plan of a plan step, checked against the step. */
function planFor(pl: PlanInput | undefined, o: OutcomeStateOf, oid: string): PlanInput {
  need(pl !== undefined, 'This outcome is a step of a plan: give its plan.');
  need(pl!.planId === o.planId, `Outcome ${oid} is a step of plan ${o.planId}, not ${pl!.planId}.`);
  need(
    pl!.plan.threadId === o.threadId && pl!.plan.steps.includes(oid),
    `Outcome ${oid} is not a step of plan ${pl!.planId}.`,
  );
  return pl!;
}
interface PlanNext {
  plan: PlanOf;
  outcomes: Record<string, PlanOutcomeOf>;
}
/** The plan after a change: step states, cursor, state, steps. */
function nextPlan(
  pl: PlanInput,
  change: {
    outcomes?: Readonly<Record<string, Partial<PlanOutcomeOf>>>;
    cursor?: number;
    state?: PlanState;
    steps?: string[];
  },
): PlanNext {
  const outcomes: Record<string, PlanOutcomeOf> = { ...pl.outcomes };
  for (const [id, c] of Object.entries(change.outcomes ?? {}))
    outcomes[id] = { ...(outcomes[id] as PlanOutcomeOf), ...c };
  const steps = change.steps ?? [...pl.plan.steps];
  const cursor = change.cursor ?? pl.plan.cursor;
  const state: PlanState =
    change.state ??
    (cursor >= steps.length
      ? 'done'
      : cursor !== pl.plan.cursor && pl.plan.state === 'proposed'
        ? 'active'
        : pl.plan.state);
  return { plan: { ...pl.plan, steps, cursor, state }, outcomes };
}
/** Step `oid` takes `state`; `through`: its turn is over and the cursor moves on. */
function advance(pl: PlanInput, oid: string, state: PlanOutcomeOf['state'], through: boolean) {
  return nextPlan(pl, {
    outcomes: { [oid]: { state } },
    ...(through ? { cursor: pl.plan.cursor + 1 } : {}),
  });
}
/** The writes of a plan change: the plan (when it changed) and the thread's state. */
function planWrites(
  ctx: ActionContext,
  pl: PlanInput,
  next: PlanNext,
  forceState: PlanState | null,
  eventId: string,
): WriteOp[] {
  const plan = forceState ? { ...next.plan, state: forceState } : next.plan;
  const d: Record<string, unknown> = {};
  if (plan.cursor !== pl.plan.cursor) {
    d.cursor = plan.cursor;
    d.cursorAt = SERVER_TIME;
  }
  if (plan.state !== pl.plan.state) d.state = plan.state;
  if (JSON.stringify(plan.steps) !== JSON.stringify(pl.plan.steps)) d.steps = plan.steps;
  return [
    ...(Object.keys(d).length
      ? [upd(inboxPaths.plan(ctx.workspaceId, pl.planId), d, eventId)]
      : []),
    upd(
      inboxPaths.thread(ctx.workspaceId, pl.plan.threadId),
      { ...planThreadState(plan, next.outcomes) },
      eventId,
    ),
  ];
}
const PLAN_LIVE: readonly PlanState[] = ['proposed', 'active', 'blocked'];
function livePlan(pl: PlanInput) {
  need(
    PLAN_LIVE.includes(pl.plan.state),
    `This plan is ${pl.plan.state === 'done' ? 'done' : 'stopped'}.`,
  );
}
/** Whether the step at the cursor has started (being carried out, running or failed). */
function cursorStarted(pl: PlanInput): boolean {
  const id = pl.plan.steps[pl.plan.cursor];
  const st = id !== undefined ? pl.outcomes[id]?.state : undefined;
  return st === 'approved' || st === 'running' || st === 'failed';
}

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
  need(type !== null, `Unknown outcome type ${input.type}. Types: ${SINGLE_TYPES.join(', ')}.`);
  need(type!.retired !== true, RETIRED_MESSAGE(input.type));
  need(
    type!.planOnly !== true,
    `${input.type} is only a step of a plan (plan_propose). Types alone: ${SINGLE_TYPES.join(', ')}.`,
  );
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

/** A template's steps with the caller's steps (fields, note, …) over them, in order. */
function fromTemplate(id: string, over: readonly PlanStepInput[]): PlanStepInput[] {
  const base = templateSteps(
    id,
    over.map((o) => o.fields ?? {}),
  );
  return base.map((b, i) => {
    const o = over[i];
    need(
      !o || !o.type || o.type === b.type,
      `Step ${i + 1} of the ${planTemplate(id)!.name} template is ${b.type}, not ${o?.type}.`,
    );
    return { ...(o ?? {}), type: b.type, fields: b.fields };
  });
}

/** Plan steps checked and cleaned: plan types, fields, note, confidence, checks. */
function cleanPlanSteps(input: readonly PlanStepInput[]) {
  need(
    input.length >= 1 && input.length <= PLAN_LIMITS.steps,
    `A plan has 1 to ${PLAN_LIMITS.steps} steps.`,
  );
  return input.map((st, i) => {
    const n = `Step ${i + 1}`;
    need(
      (PLAN_TYPES as readonly string[]).includes(st.type),
      `${n}: ${st.type} is not a plan step. Plan steps: ${PLAN_TYPES.join(', ')}.`,
    );
    let fields: Record<string, string | boolean>;
    try {
      fields = cleanOutcomeFields(st.type, st.fields ?? {});
    } catch (e) {
      if (e instanceof OutcomeFieldError) throw new ActionError(`${n}: ${e.message}`);
      throw e;
    }
    const sn = (st.note ?? '').trim();
    need(
      sn.length <= INBOX_LIMITS.outcomeNote,
      `${n}: ${tooLong('the note', INBOX_LIMITS.outcomeNote)}`,
    );
    const sc = st.confidence ?? null;
    need(
      sc === null || (OUTCOME_CONFIDENCE as readonly string[]).includes(sc),
      `${n}: the confidence is high, medium or low.`,
    );
    const checks = cleanLines('checks', st.checks, INBOX_LIMITS.checks, INBOX_LIMITS.check);
    return { type: st.type, fields, note: sn, conf: sc, checks };
  });
}

/** One step of a proposed plan: an outcome of a plan type. */
export interface PlanStepInput {
  type: string;
  fields: Readonly<Record<string, unknown>>;
  note?: string;
  confidence?: string | null;
  checks?: readonly string[] | null;
}

/**
 * An agent proposes a plan (plan_propose, item qwFAWxZM5xkcE7PPjAzi): 1-8 ordered steps, each an
 * outcome of a plan type, all in one batch with the plan and one plan.proposed event, so the
 * member never sees half a plan. The steps run in order once approved; an `approval` step is a
 * gate the member decides at its turn. Like a single proposal, the thread goes to Your call.
 */
export function proposePlan(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    note?: string;
    confidence?: string | null;
    steps: readonly PlanStepInput[];
    planId?: string;
    stepIds?: readonly string[];
    /**
     * A plan template (./planTemplates.ts, slice 6): the plan is the template's steps; `steps`
     * then gives each step's fields (and note, confidence, checks) over the defaults, in order.
     */
    template?: string | null;
  },
): ActionPlan & { planId: string; stepIds: string[] } {
  requireAgent(ctx);
  const t = input.thread;
  liveThread(t);
  need(
    Array.isArray(input.steps) &&
      (input.template ? input.steps.length >= 0 : input.steps.length >= 1) &&
      input.steps.length <= PLAN_LIMITS.steps,
    `A plan has 1 to ${PLAN_LIMITS.steps} steps.`,
  );
  const note = (input.note ?? '').trim();
  need(note.length <= PLAN_LIMITS.note, tooLong('The note', PLAN_LIMITS.note));
  const conf = input.confidence ?? null;
  need(
    conf === null || (OUTCOME_CONFIDENCE as readonly string[]).includes(conf),
    'The confidence is high, medium or low.',
  );
  const tpl = input.template ?? null;
  const steps = cleanPlanSteps(tpl ? fromTemplate(tpl, input.steps) : input.steps);
  const planId = input.planId ?? nid(ctx);
  const stepIds = input.stepIds ? [...input.stepIds] : steps.map(() => nid(ctx));
  need(
    stepIds.length === steps.length && new Set(stepIds).size === stepIds.length,
    'One distinct id per step.',
  );
  const p = inboxPlan(
    ctx,
    'plan.proposed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    {
      planId,
      steps: stepIds,
      types: steps.map((st) => st.type),
      ...(tpl ? { templateId: tpl } : {}),
    },
    (eventId) => [
      ...steps.map((st, i): WriteOp => ({
        kind: 'set',
        path: inboxPaths.outcome(ctx.workspaceId, stepIds[i]!),
        data: {
          memberUid: t.memberUid,
          threadId: input.threadId,
          type: st.type,
          fields: st.fields,
          state: 'proposed',
          note: st.note,
          ...(st.conf !== null ? { confidence: st.conf } : {}),
          ...(st.checks.length > 0 ? { checks: st.checks } : {}),
          proposedBy: ctx.actor.id,
          executor: outcomeType(st.type)!.executor === 'agent' ? t.fetchedBy : null,
          decision: null,
          result: null,
          planId,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      })),
      {
        kind: 'set',
        path: inboxPaths.plan(ctx.workspaceId, planId),
        data: {
          memberUid: t.memberUid,
          threadId: input.threadId,
          proposedBy: ctx.actor.id,
          steps: stepIds,
          cursor: 0,
          state: 'proposed',
          note,
          ...(conf !== null ? { confidence: conf } : {}),
          ...(tpl ? { templateId: tpl, sendBackTo: templateSendBack(tpl, stepIds) } : {}),
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
  return { ...p, planId, stepIds };
}

/**
 * The executing agent reports an approved outcome (outcome_done): done (the thread moves to the
 * type's after-state) or failed (the thread goes back to investigating). A plan step
 * (item qwFAWxZM5xkcE7PPjAzi) is reported only at its turn: done moves the plan to the next
 * step, failed blocks the plan (the member retries, skips or stops), and `started` (Build it:
 * the item is made, with its id) leaves the step running until the item is Done.
 */
export function finishOutcome(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    status: 'done' | 'failed' | 'started';
    result?: {
      text?: string | null;
      permalink?: string | null;
      itemId?: string | null;
      error?: string | null;
    };
    /** The plan, when the outcome is a plan step. */
    plan?: PlanInput;
    /** What carrying it out cost (slice 6b), recorded on the event. */
    usage?: { tokens?: number | null; costEur?: number | null } | null;
  },
): ActionPlan {
  requireAgent(ctx);
  const o = input.outcome;
  const planned = o.planId !== undefined && o.planId !== null;
  const usage = cleanUsage(input.usage);
  need(
    o.state === 'approved' || (planned && o.state === 'running' && input.status !== 'started'),
    o.state === 'proposed' || o.state === 'revising'
      ? 'Not approved: nothing is carried out before the person approves it.'
      : `This outcome is ${o.state} already.`,
  );
  need(o.executor === ctx.actor.id, 'Only the agent that carries this outcome out reports it.');
  need(
    input.status !== 'started' || planned,
    'Only a plan step can be started (status started is for Build it).',
  );
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
  const result = { text, permalink, itemId, error, by: ctx.actor.id, at: SERVER_TIME };
  if (planned) {
    const pl = planFor(input.plan, o, input.outcomeId);
    need(
      pl.plan.state === 'proposed' || pl.plan.state === 'active',
      `This plan is ${pl.plan.state}: its steps are not carried out.`,
    );
    need(
      pl.plan.steps[pl.plan.cursor] === input.outcomeId,
      'Not its turn: a plan step is carried out only once the steps before it are done.',
    );
    // A long step (Build, Release: slice 6b) starts with no item; Build it with the item it made.
    if (input.status === 'started' && outcomeType(o.type)?.long !== true) {
      need(
        outcomeType(o.type)?.after.waitingOn === 'item',
        `A ${o.type} step is reported done or failed, not started.`,
      );
      need(itemId !== null, 'Give the item you made (result.itemId).');
    }
    const state =
      input.status === 'started' ? 'running' : input.status === 'done' ? 'done' : 'failed';
    const next = advance(pl, input.outcomeId, state, input.status === 'done');
    return inboxPlan(
      ctx,
      input.status === 'started'
        ? 'outcome.started'
        : input.status === 'done'
          ? 'outcome.done'
          : 'outcome.failed',
      { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
      {
        outcomeId: input.outcomeId,
        type: o.type,
        planId: pl.planId,
        permalink,
        itemId,
        ...(error ? { error } : {}),
        ...(usage ? { usage } : {}),
      },
      (eventId) => [
        upd(inboxPaths.outcome(ctx.workspaceId, input.outcomeId), { state, result }, eventId),
        ...planWrites(ctx, pl, next, input.status === 'failed' ? 'blocked' : null, eventId),
      ],
    );
  }
  const after =
    input.status === 'done'
      ? threadAfter(o.type, o.fields)
      : { state: 'investigating' as const, waiting: null };
  return inboxPlan(
    ctx,
    input.status === 'done' ? 'outcome.done' : 'outcome.failed',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    {
      outcomeId: input.outcomeId,
      type: o.type,
      permalink,
      itemId,
      ...(error ? { error } : {}),
      ...(usage ? { usage } : {}),
    },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        { state: input.status, result },
        eventId,
      ),
      upd(inboxPaths.thread(ctx.workspaceId, o.threadId), after, eventId),
    ],
  );
}

/** A run's usage (outcome_done usage, slice 6b): whole tokens and euros, both optional. */
function cleanUsage(
  u: { tokens?: number | null; costEur?: number | null } | null | undefined,
): { tokens?: number; costEur?: number } | null {
  if (!u) return null;
  const out: { tokens?: number; costEur?: number } = {};
  if (u.tokens !== undefined && u.tokens !== null) {
    need(
      Number.isInteger(u.tokens) && u.tokens >= 0 && u.tokens <= 1e10,
      'usage.tokens is a whole number from 0.',
    );
    out.tokens = u.tokens;
  }
  if (u.costEur !== undefined && u.costEur !== null) {
    need(
      Number.isFinite(u.costEur) && u.costEur >= 0 && u.costEur <= 1e6,
      'usage.costEur is a number of euros from 0.',
    );
    out.costEur = Math.round(u.costEur * 10000) / 10000;
  }
  return Object.keys(out).length ? out : null;
}

/** How often the CLI stamps a running long step it holds, and when the web calls it quiet. */
export const STEP_HEARTBEAT_MS = 5 * 60_000;
export const STEP_QUIET_MS = 60 * 60_000;

/**
 * step_progress (slice 6b, design 6.6): the agent carrying out a running long step (Build,
 * Release) says where it stands: a line (1-140 characters) and maybe a percentage. It is also the
 * heartbeat (the CLI sends one every 5 minutes while its session holds the step); without one
 * for an hour the page says the agent is quiet. Only the step changes, with one step.progress
 * event: the thread and its summary are not touched.
 */
export function stepProgress(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    line: string;
    percent?: number | null;
    plan: PlanInput;
  },
): ActionPlan {
  requireAgent(ctx);
  const o = input.outcome;
  need(
    o.executor === ctx.actor.id,
    'Only the agent that carries this step out reports its progress.',
  );
  need(
    o.state === 'running' && outcomeType(o.type)?.long === true,
    'Progress is for a long step you started (outcome_done status started first).',
  );
  const pl = planFor(input.plan, o, input.outcomeId);
  need(
    (pl.plan.state === 'active' || pl.plan.state === 'proposed') &&
      pl.plan.steps[pl.plan.cursor] === input.outcomeId,
    'Not its turn: this step is not the one the plan runs now.',
  );
  const line = (input.line ?? '').trim().replace(/\s+/g, ' ');
  need(line.length > 0, 'Say where it stands (line).');
  need(line.length <= INBOX_LIMITS.progressLine, tooLong('The line', INBOX_LIMITS.progressLine));
  const percent = input.percent ?? null;
  need(
    percent === null || (Number.isInteger(percent) && percent >= 0 && percent <= 100),
    'The percent is a whole number from 0 to 100.',
  );
  return inboxPlan(
    ctx,
    'step.progress',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { planId: pl.planId, outcomeId: input.outcomeId, line, percent },
    (eventId) => [
      upd(
        inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
        { progress: { line, percent, at: SERVER_TIME } },
        eventId,
      ),
    ],
  );
}

/**
 * A snoozed thread whose date has come wakes up (thread_wake). When its plan waits at a
 * wait-until step (an approved snooze at the cursor), that step is done and the plan moves on.
 */
export function wakeThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; nowMs: number; plan?: PlanInput },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  const until = t.state === 'waiting' ? (t.waiting?.until ?? null) : null;
  need(until !== null, 'This thread is not waiting for a date.');
  need(until!.toMillis() <= input.nowMs, 'Not yet: it waits until its date.');
  const pl = input.plan;
  const sid = pl ? pl.plan.steps[pl.plan.cursor] : undefined;
  const step = sid !== undefined ? pl!.outcomes[sid] : undefined;
  if (pl && sid !== undefined && step) {
    need(pl.plan.threadId === input.threadId, `Plan ${pl.planId} is not on this thread.`);
    need(
      (pl.plan.state === 'proposed' || pl.plan.state === 'active') &&
        step.state === 'approved' &&
        step.type === 'snooze',
      'This plan is not waiting until a date.',
    );
    const next = advance(pl, sid, 'done', true);
    return inboxPlan(
      ctx,
      'thread.woke',
      { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
      { planId: pl.planId, outcomeId: sid },
      (eventId) => [
        upd(
          inboxPaths.outcome(ctx.workspaceId, sid),
          {
            state: 'done',
            result: {
              text: null,
              permalink: null,
              itemId: null,
              error: null,
              by: ctx.actor.id,
              at: SERVER_TIME,
            },
          },
          eventId,
        ),
        ...planWrites(ctx, pl, next, null, eventId),
      ],
    );
  }
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

// ---------- decision facts (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7) ----------

/** What every decision event records for Decision insights. */
export interface DecisionFacts {
  /** The step decided ("Ship it?", "Build", "Approve plan"), or null. */
  stepLabel: string | null;
  templateId: string | null;
  /** How long it waited for the member, in ms (null: unknown). */
  waitedMs: number | null;
  /** The summary's recommended action at that moment (null: none). */
  recommended: string | null;
  /** The summary version on show (null: none). */
  summaryVersion: number | null;
}

/** A step's label: an approval's own words, else the outcome type's name. */
export function stepLabelOf(o: Pick<OutcomeStateOf, 'type' | 'fields'> | undefined): string | null {
  if (!o) return null;
  const what =
    o.type === 'approval' && typeof o.fields?.what === 'string' ? o.fields.what.trim() : '';
  return (what || outcomeType(o.type)?.label || o.type).slice(0, 80);
}

const ms = (t: { toMillis(): number } | null | undefined) =>
  t && typeof t.toMillis === 'function' ? t.toMillis() : null;

/**
 * The facts of a decision: on a plan step (`plan` given) the wait runs from when the cursor
 * reached it (`cursorAt`, older plans: `createdAt`); on a single proposal from its latest version
 * (`updatedAt`); on the whole plan (`step` null) from the plan's creation.
 */
export function decisionFacts(input: {
  thread: ThreadStateOf;
  plan?: PlanOf | null;
  outcome?: OutcomeStateOf | null;
  stepLabel?: string | null;
  summaryVersion?: number | null;
  nowMs?: number;
}): DecisionFacts {
  const now = input.nowMs ?? Date.now();
  const p = input.plan ?? null;
  const o = input.outcome ?? null;
  const from = o
    ? p
      ? (ms(p.cursorAt) ?? ms(p.createdAt))
      : (ms(o.updatedAt) ?? ms(o.createdAt))
    : p
      ? ms(p.createdAt)
      : null;
  const s = input.thread.summary ?? null;
  return {
    stepLabel: input.stepLabel !== undefined ? input.stepLabel : stepLabelOf(o ?? undefined),
    templateId: p?.templateId ?? null,
    waitedMs: from === null ? null : Math.max(0, Math.round(now - from)),
    recommended: s?.recAction ?? null,
    summaryVersion: input.summaryVersion ?? s?.version ?? null,
  };
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
    /** The plan, when the outcome is a plan step (item qwFAWxZM5xkcE7PPjAzi). */
    plan?: PlanInput;
    /**
     * The summary version on screen (slice 6, design 6.4): a gate's approval records it, and the
     * next steps follow that version.
     */
    summaryVersion?: number | null;
    /**
     * A single outcome: whether other proposals of the thread still wait for the member. False:
     * an outcome the agent carries out moves the thread to waiting on the agent (nothing is the
     * member's call any more); absent: the thread's state is left as it is.
     */
    othersPending?: boolean;
  },
): ActionPlan {
  const o = input.outcome;
  owner(ctx, o.memberUid);
  need(
    o.state === 'proposed' || o.state === 'revising',
    'Only a proposed outcome can be approved.',
  );
  const sv = input.summaryVersion ?? null;
  need(
    sv === null || (Number.isInteger(sv) && sv >= 1),
    'The summary version is a whole number from 1.',
  );
  need(!isRetiredOutcome(o.type), RETIRED_MESSAGE(o.type));
  // A plan step: an agent step may be approved any time before it runs (it still runs only at
  // its turn); a person step (approval) only at its turn, and passing it moves the plan on.
  const pl = o.planId ? planFor(input.plan, o, input.outcomeId) : null;
  const gate = pl !== null && outcomeKind(o.type) === 'human';
  if (pl) {
    livePlan(pl);
    if (gate)
      need(
        pl.plan.steps[pl.plan.cursor] === input.outcomeId,
        'Not its turn yet: you decide this approval once the steps before it are done.',
      );
  }
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
  // In a plan only the gate takes effect on approval; a wait-until step waits for its turn.
  const immediate = pl ? gate : outcomeType(o.type)?.executor === 'none';
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
      ...(pl ? { planId: pl.planId } : {}),
      ...decisionFacts({
        thread: input.thread,
        plan: pl?.plan,
        outcome: o,
        ...(sv !== null ? { summaryVersion: sv } : {}),
      }),
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
            ...(gate && sv !== null ? { summaryVersion: sv } : {}),
          },
          ...(o.state === 'revising' ? { revise: null } : {}),
        },
        eventId,
      ),
      ...(pl
        ? planWrites(
            ctx,
            pl,
            advance(pl, input.outcomeId, immediate ? 'done' : 'approved', gate),
            null,
            eventId,
          )
        : []),
      ...(immediate && !pl
        ? [
            upd(
              inboxPaths.thread(ctx.workspaceId, o.threadId),
              threadAfter(o.type, fields),
              eventId,
            ),
          ]
        : !pl && input.othersPending === false && input.thread.state === 'yourCall'
          ? [
              upd(
                inboxPaths.thread(ctx.workspaceId, o.threadId),
                { state: 'waiting', waiting: { on: 'agent', until: null } },
                eventId,
              ),
            ]
          : []),
    ],
  );
  return approval;
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
    /** The plan, when the outcome is a plan step (item qwFAWxZM5xkcE7PPjAzi). */
    plan?: PlanInput;
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
  if (o.planId) {
    // Not approved, on a gate at its turn: the plan stops and the agent re-plans. An agent step
    // is removed from the plan instead (editPlan), or the whole plan rejected (rejectPlan).
    const pl = planFor(input.plan, o, input.outcomeId);
    livePlan(pl);
    need(
      outcomeKind(o.type) === 'human',
      'Remove this step from the plan instead, or reject the whole plan.',
    );
    need(
      pl.plan.steps[pl.plan.cursor] === input.outcomeId,
      'Not its turn yet: you decide this approval once the steps before it are done.',
    );
    const next = advance(pl, input.outcomeId, 'rejected', false);
    return inboxPlan(
      ctx,
      'outcome.rejected',
      { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
      {
        outcomeId: input.outcomeId,
        type: o.type,
        reason,
        planId: pl.planId,
        ...decisionFacts({ thread: input.thread, plan: pl.plan, outcome: o }),
      },
      (eventId) => [
        upd(
          inboxPaths.outcome(ctx.workspaceId, input.outcomeId),
          {
            state: 'rejected',
            decision: { byUid: ctx.actor.id, at: SERVER_TIME, edited: false, reason },
          },
          eventId,
        ),
        ...planWrites(ctx, pl, next, 'stopped', eventId),
      ],
    );
  }
  const back = !input.othersPending && input.thread.state === 'yourCall';
  return inboxPlan(
    ctx,
    'outcome.rejected',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    {
      outcomeId: input.outcomeId,
      type: o.type,
      reason,
      ...decisionFacts({ thread: input.thread, outcome: o }),
    },
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

// ---------- plans: the member's decisions (item qwFAWxZM5xkcE7PPjAzi) ----------

function planScope(pl: PlanInput, thread: ThreadStateOf) {
  return { memberUid: pl.plan.memberUid, threadId: pl.plan.threadId, subjectId: thread.subjectId };
}
const decisionBy = (ctx: ActionContext, reason: string | null) => ({
  byUid: ctx.actor.id,
  at: SERVER_TIME,
  edited: false,
  reason,
});

/**
 * Approve plan: every proposed agent step is approved at the version on show, unedited. Person
 * steps stay gates; steps being revised keep waiting for their new version. Nothing runs early:
 * each step is still carried out only at its turn.
 */
export function approvePlan(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf },
): ActionPlan {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  livePlan(pl);
  const ids = pl.plan.steps.filter((id) => {
    const o = pl.outcomes[id];
    need(o !== undefined, `Step ${id} of the plan is not loaded.`);
    return o!.state === 'proposed' && outcomeKind(o!.type) === 'agent';
  });
  need(ids.length > 0, 'No step waits for your approval.');
  const changes = Object.fromEntries(ids.map((id) => [id, { state: 'approved' as const }]));
  const next = nextPlan(pl, {
    outcomes: changes,
    ...(pl.plan.state === 'proposed' ? { state: 'active' as const } : {}),
  });
  for (const id of ids)
    need(!isRetiredOutcome(pl.outcomes[id]!.type), RETIRED_MESSAGE(pl.outcomes[id]!.type));
  const p = inboxPlan(
    ctx,
    'plan.approved',
    planScope(pl, input.thread),
    {
      planId: pl.planId,
      approved: ids,
      ...decisionFacts({ thread: input.thread, plan: pl.plan, stepLabel: 'Approve plan' }),
    },
    (eventId) => [
      ...ids.map((id) => {
        const n = pl.outcomes[id]!.versions?.length ?? 0;
        return upd(
          inboxPaths.outcome(ctx.workspaceId, id),
          {
            state: 'approved',
            decision: { ...decisionBy(ctx, null), ...(n > 0 ? { version: n } : {}) },
          },
          eventId,
        );
      }),
      ...planWrites(ctx, pl, next, null, eventId),
    ],
  );
  return p;
}

/** Reject plan: every step not started is rejected, the plan stops and the agent re-plans. */
export function rejectPlan(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf; reason?: string | null },
): ActionPlan {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  livePlan(pl);
  const reason = input.reason?.trim() || null;
  need(
    reason === null || reason.length <= INBOX_LIMITS.reason,
    tooLong('The reason', INBOX_LIMITS.reason),
  );
  const ids = pl.plan.steps.filter((id, i) => {
    const st = pl.outcomes[id]?.state;
    const started = i === pl.plan.cursor && cursorStarted(pl);
    return !started && (st === 'proposed' || st === 'revising' || st === 'approved');
  });
  const next = nextPlan(pl, {
    outcomes: Object.fromEntries(ids.map((id) => [id, { state: 'rejected' as const }])),
  });
  return inboxPlan(
    ctx,
    'plan.rejected',
    planScope(pl, input.thread),
    {
      planId: pl.planId,
      rejected: ids,
      reason,
      ...decisionFacts({ thread: input.thread, plan: pl.plan, stepLabel: 'Approve plan' }),
    },
    (eventId) => [
      ...ids.map((id) =>
        upd(
          inboxPaths.outcome(ctx.workspaceId, id),
          {
            state: 'rejected',
            decision: decisionBy(ctx, reason),
            ...(pl.outcomes[id]!.state === 'revising' ? { revise: null } : {}),
          },
          eventId,
        ),
      ),
      ...planWrites(ctx, pl, next, 'stopped', eventId),
    ],
  );
}

export type PlanEdit =
  /** Move the step at `from` to `to` (both not started). */
  | { op: 'move'; from: number; to: number }
  /** Remove the step at `index` (not started): it is rejected ("removed"). */
  | { op: 'remove'; index: number }
  /** Add a person-approval step at `index` (from the first step not started on). */
  | {
      op: 'add';
      index: number;
      fields: Readonly<Record<string, unknown>>;
      outcomeId?: string;
    };

/**
 * Edit plan (plan.edited): reorder or remove steps that have not started, or add an approval
 * step. The steps already through (and the one being carried out) never move.
 */
export function editPlan(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf; edit: PlanEdit },
): ActionPlan & { outcomeId?: string } {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  livePlan(pl);
  const steps = [...pl.plan.steps];
  const first = pl.plan.cursor + (cursorStarted(pl) ? 1 : 0);
  const free = (i: number, end = steps.length) => Number.isInteger(i) && i >= first && i < end;
  const e = input.edit;
  const scope = planScope(pl, input.thread);
  if (e.op === 'move') {
    need(free(e.from) && free(e.to), 'Only steps that have not started move.');
    need(e.from !== e.to, 'The step is already there.');
    const [id] = steps.splice(e.from, 1);
    steps.splice(e.to, 0, id!);
    const next = nextPlan(pl, { steps });
    return inboxPlan(
      ctx,
      'plan.edited',
      scope,
      { planId: pl.planId, op: 'move', from: e.from, to: e.to },
      (eventId) => planWrites(ctx, pl, next, null, eventId),
    );
  }
  if (e.op === 'remove') {
    need(free(e.index), 'Only a step that has not started can be removed.');
    need(steps.length > 1, 'This is the only step: reject the plan instead.');
    const [id] = steps.splice(e.index, 1);
    const o = pl.outcomes[id!];
    need(o !== undefined, `Step ${id} of the plan is not loaded.`);
    const next = nextPlan(pl, { steps, outcomes: { [id!]: { state: 'rejected' } } });
    return inboxPlan(
      ctx,
      'plan.edited',
      scope,
      { planId: pl.planId, op: 'remove', index: e.index, outcomeId: id },
      (eventId) => [
        upd(
          inboxPaths.outcome(ctx.workspaceId, id!),
          {
            state: 'rejected',
            decision: decisionBy(ctx, 'removed'),
            ...(o!.state === 'revising' ? { revise: null } : {}),
          },
          eventId,
        ),
        ...planWrites(ctx, pl, next, null, eventId),
      ],
    );
  }
  need(e.op === 'add', 'An edit moves, removes or adds a step.');
  need(steps.length < PLAN_LIMITS.steps, `A plan has at most ${PLAN_LIMITS.steps} steps.`);
  need(free(e.index, steps.length + 1), 'Add it after the steps that have started.');
  let fields: Record<string, string | boolean>;
  try {
    fields = cleanOutcomeFields('approval', e.fields);
  } catch (err) {
    if (err instanceof OutcomeFieldError) throw new ActionError(err.message);
    throw err;
  }
  const oid = e.outcomeId ?? nid(ctx);
  steps.splice(e.index, 0, oid);
  const outcome: PlanOutcomeOf = { type: 'approval', fields, state: 'proposed' };
  const next = nextPlan(
    {
      ...pl,
      outcomes: {
        ...pl.outcomes,
        [oid]: {
          ...outcome,
          memberUid: pl.plan.memberUid,
          threadId: pl.plan.threadId,
          executor: null,
        },
      },
    },
    { steps },
  );
  const p = inboxPlan(
    ctx,
    'plan.edited',
    scope,
    { planId: pl.planId, op: 'add', index: e.index, outcomeId: oid },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.outcome(ctx.workspaceId, oid),
        data: {
          memberUid: pl.plan.memberUid,
          threadId: pl.plan.threadId,
          type: 'approval',
          fields,
          state: 'proposed',
          note: '',
          proposedBy: ctx.actor.id,
          executor: null,
          decision: null,
          result: null,
          planId: pl.planId,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...planWrites(ctx, pl, next, null, eventId),
    ],
  );
  return { ...p, outcomeId: oid };
}

/** The failed step at the cursor, for Retry and Skip. */
function failedStep(pl: PlanInput): string {
  need(pl.plan.state === 'blocked', 'This plan is not blocked.');
  const id = pl.plan.steps[pl.plan.cursor];
  need(id !== undefined && pl.outcomes[id]?.state === 'failed', 'No step of this plan failed.');
  return id!;
}

/**
 * Retry a failed step: it is approved again and carried out again; the plan goes on. A plan
 * blocked by its third send back (slice 6) goes on too: its step at the cursor is approved
 * already and is carried out again.
 */
export function retryPlanStep(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf },
): ActionPlan {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  const at = pl.plan.steps[pl.plan.cursor];
  const sent =
    pl.plan.state === 'blocked' && at !== undefined && pl.outcomes[at]?.state === 'approved';
  const id = sent ? at! : failedStep(pl);
  const next = nextPlan(pl, { outcomes: { [id]: { state: 'approved' } }, state: 'active' });
  return inboxPlan(
    ctx,
    'plan.retried',
    planScope(pl, input.thread),
    { planId: pl.planId, outcomeId: id },
    (eventId) => [
      ...(sent
        ? []
        : [
            upd(
              inboxPaths.outcome(ctx.workspaceId, id),
              { state: 'approved', result: null },
              eventId,
            ),
          ]),
      ...planWrites(ctx, pl, next, null, eventId),
    ],
  );
}

/** Skip a failed step: it is set aside (rejected) and the plan moves to the next step. */
export function skipPlanStep(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf },
): ActionPlan {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  const id = failedStep(pl);
  const cursor = pl.plan.cursor + 1;
  const next = nextPlan(pl, {
    outcomes: { [id]: { state: 'rejected' } },
    cursor,
    state: cursor >= pl.plan.steps.length ? 'done' : 'active',
  });
  return inboxPlan(
    ctx,
    'plan.skipped',
    planScope(pl, input.thread),
    { planId: pl.planId, outcomeId: id },
    (eventId) => [
      upd(inboxPaths.outcome(ctx.workspaceId, id), { state: 'rejected' }, eventId),
      ...planWrites(ctx, pl, next, null, eventId),
    ],
  );
}

/** Stop plan: nothing more of it runs; the thread goes back to the agent. */
export function stopPlan(
  ctx: ActionContext,
  input: PlanInput & { thread: ThreadStateOf },
): ActionPlan {
  const pl = input;
  owner(ctx, pl.plan.memberUid);
  livePlan(pl);
  return inboxPlan(
    ctx,
    'plan.stopped',
    planScope(pl, input.thread),
    {
      planId: pl.planId,
      ...decisionFacts({
        thread: input.thread,
        plan: pl.plan,
        outcome: pl.outcomes[pl.plan.steps[pl.plan.cursor] ?? ''] ?? null,
      }),
    },
    (eventId) => planWrites(ctx, pl, nextPlan(pl, {}), 'stopped', eventId),
  );
}

// ---------- Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6) ----------

/** Send backs a plan takes before it stops at the member (design 6.5). */
export const MAX_PLAN_SEND_BACKS = 3;
export const NEW_THREAD_SOURCE = 'hivenod';

/**
 * New thread (design 6.2): the member writes to one of the organization's agents (its home
 * agent from then on): the thread, its first message (source hivenod, from the member) and, with
 * a template, the plan, in one batch with one thread.created event. A plan the member makes from
 * a template is theirs: its agent steps start approved (the creation is the approval), its person
 * steps stay gates. Without a plan the thread starts investigating, as one an agent brings in.
 */
export function createMemberThread(
  ctx: ActionContext,
  input: {
    title: string;
    text: string;
    /** The home agent (an active agent of the organization; the rules check it). */
    agentUid: string;
    template?: string | null;
    threadId?: string;
    planId?: string;
    stepIds?: readonly string[];
  },
): ActionPlan & { threadId: string; planId: string | null } {
  requireHuman(ctx);
  const me = ctx.actor.id;
  const text = cleanText('The message', input.text, INBOX_LIMITS.text);
  const title = cleanText('The title', input.title.replace(/\s+/g, ' '), INBOX_LIMITS.title);
  const agentUid = input.agentUid?.trim() ?? '';
  need(agentUid.length > 0 && agentUid.length <= 128, 'Pick the agent it is for.');
  const tpl = input.template || null;
  const steps = tpl
    ? cleanPlanSteps(
        fromTemplate(tpl, [
          { type: '', fields: tpl === 'dev' ? { idea: text.slice(0, 20_000) } : {} },
        ]),
      )
    : null;
  const threadId = input.threadId ?? nid(ctx);
  const planId = steps ? (input.planId ?? nid(ctx)) : null;
  const stepIds = steps ? (input.stepIds ? [...input.stepIds] : steps.map(() => nid(ctx))) : [];
  need(
    !steps || (stepIds.length === steps.length && new Set(stepIds).size === stepIds.length),
    'One distinct id per step.',
  );
  const messageDocId = nid(ctx);
  const w = ctx.workspaceId;
  const outs: Record<string, OutcomeStateOf> = {};
  steps?.forEach((st, i) => {
    outs[stepIds[i]!] = {
      memberUid: me,
      threadId,
      type: st.type,
      fields: st.fields,
      state: outcomeKind(st.type) === 'human' ? 'proposed' : 'approved',
      executor: outcomeType(st.type)!.executor === 'agent' ? agentUid : null,
    };
  });
  const state = planId
    ? planThreadState({ steps: stepIds, cursor: 0, state: 'active' }, outs)
    : { state: 'investigating' as const, waiting: null };
  const p = inboxPlan(
    ctx,
    'thread.created',
    { memberUid: me, threadId, subjectId: null },
    {
      messageDocId,
      agentUid,
      ...(planId ? { planId, steps: stepIds, templateId: tpl } : {}),
    },
    (eventId) => [
      {
        kind: 'set',
        path: inboxPaths.message(w, messageDocId),
        data: {
          memberUid: me,
          threadId,
          direction: 'in',
          source: NEW_THREAD_SOURCE,
          sender: {
            name: ctx.actor.name.trim().slice(0, INBOX_LIMITS.senderName) || 'Me',
            handle: null,
          },
          text,
          threadRef: threadId,
          messageId: messageDocId,
          permalink: null,
          replyRef: null,
          receivedAt: SERVER_TIME,
          attachments: [],
          fetchedBy: me,
          createdAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      {
        kind: 'set',
        path: inboxPaths.thread(w, threadId),
        data: {
          memberUid: me,
          subjectId: null,
          ...state,
          question: null,
          title,
          refs: [threadId],
          lastMessageAt: SERVER_TIME,
          fetchedBy: agentUid,
          createdAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...(planId && steps
        ? [
            ...steps.map((st, i): WriteOp => ({
              kind: 'set',
              path: inboxPaths.outcome(w, stepIds[i]!),
              data: {
                ...outs[stepIds[i]!],
                note: st.note,
                proposedBy: me,
                decision: null,
                result: null,
                planId,
                createdAt: SERVER_TIME,
                updatedAt: SERVER_TIME,
                lastEventId: eventId,
              },
            })),
            {
              kind: 'set',
              path: inboxPaths.plan(w, planId),
              data: {
                memberUid: me,
                threadId,
                proposedBy: me,
                steps: stepIds,
                cursor: 0,
                state: 'active',
                note: '',
                templateId: tpl,
                sendBackTo: templateSendBack(tpl!, stepIds),
                createdAt: SERVER_TIME,
                updatedAt: SERVER_TIME,
                lastEventId: eventId,
              },
            } satisfies WriteOp,
          ]
        : []),
    ],
  );
  return { ...p, threadId, planId };
}

/** What a send back needs of the plan doc beyond its state (listener data). */
export interface SendBackOf {
  sendBackTo?: Readonly<Record<string, string>> | null;
  sentBack?: { n: number } | null;
}

/**
 * Send back (design 6.5): Ask for changes on the person step at the cursor (the member), or
 * plan_send_back from the agent step at the cursor (its executor), moves the cursor back to an
 * earlier agent step that is done (default: the plan's `sendBackTo` for that gate, else the
 * nearest earlier agent step). The steps from there to the cursor that were through start again:
 * agent steps approved (they were), person steps proposed (decided again). The plan counts it in
 * `sentBack` (n, the target, the reason); the third send back, and each after it, leaves the plan
 * blocked for the member (Retry goes on, Stop plan ends it). The agent gets carry_out again
 * (why sent_back, with the reason).
 */
export function sendBackPlan(
  ctx: ActionContext,
  input: PlanInput & {
    thread: ThreadStateOf;
    reason: string;
    /** The target step's index; absent: the default. */
    toStep?: number | null;
    plan: PlanOf & SendBackOf;
  },
): ActionPlan & { toStep: number; blocked: boolean } {
  const pl = input;
  const p = pl.plan;
  const agent = ctx.actor.type === 'agent';
  if (agent) requireAgent(ctx);
  else owner(ctx, p.memberUid);
  need(
    p.state === 'active' || p.state === 'proposed',
    p.state === 'blocked'
      ? 'This plan is blocked: retry or stop it first.'
      : `This plan is ${p.state}.`,
  );
  const reason = (input.reason ?? '').trim();
  need(reason.length > 0, 'Say what should change.');
  need(reason.length <= INBOX_LIMITS.reason, tooLong('The reason', INBOX_LIMITS.reason));
  const cur = p.steps[p.cursor];
  const o = cur !== undefined ? pl.outcomes[cur] : undefined;
  need(o !== undefined, 'No step is at its turn.');
  const human = outcomeKind(o!.type) === 'human';
  if (agent) {
    need(
      !human && o!.executor === ctx.actor.id,
      'Only the agent carrying out the step at its turn sends the plan back.',
    );
    need(
      o!.state === 'approved' || o!.state === 'running',
      `This step is ${o!.state}: nothing to send back.`,
    );
  } else {
    need(human && o!.state === 'proposed', 'Only an approval at its turn sends the plan back.');
  }
  const types = Object.fromEntries(p.steps.map((id) => [id, pl.outcomes[id]?.type]));
  const to =
    input.toStep ?? sendBackTarget(p.steps, types, p.cursor, input.plan.sendBackTo ?? null);
  need(to !== null, 'No earlier agent step to send it back to.');
  const target = pl.outcomes[p.steps[to!]!];
  need(
    Number.isInteger(to) &&
      to! >= 0 &&
      to! < p.cursor &&
      target !== undefined &&
      outcomeKind(target.type) === 'agent' &&
      target.state === 'done',
    'Send it back to an earlier agent step that is done.',
  );
  const reset = p.steps
    .slice(to!, p.cursor + 1)
    .filter((id) => ['done', 'running'].includes(pl.outcomes[id]?.state ?? ''));
  const n = (input.plan.sentBack?.n ?? 0) + 1;
  const blocked = n >= MAX_PLAN_SEND_BACKS;
  const back = (id: string) =>
    outcomeKind(pl.outcomes[id]!.type) === 'human' ? 'proposed' : 'approved';
  const next = nextPlan(pl, {
    outcomes: Object.fromEntries(reset.map((id) => [id, { state: back(id) }])),
    cursor: to!,
    state: blocked ? 'blocked' : 'active',
  });
  const tid = p.steps[to!]!;
  const plan = inboxPlan(
    ctx,
    'plan.sent_back',
    planScope(pl, input.thread),
    {
      planId: pl.planId,
      outcomeId: tid,
      from: p.cursor,
      to,
      reset,
      reason,
      n,
      // A person's decision (slice 9): what it was, and the step it went back to.
      ...(agent
        ? {}
        : {
            ...decisionFacts({ thread: input.thread, plan: p, outcome: o }),
            toLabel: stepLabelOf(target),
          }),
    },
    (eventId) => [
      ...reset.map((id) =>
        upd(
          inboxPaths.outcome(ctx.workspaceId, id),
          back(id) === 'proposed' ? { state: 'proposed', decision: null } : { state: 'approved' },
          eventId,
        ),
      ),
      upd(
        inboxPaths.plan(ctx.workspaceId, pl.planId),
        {
          cursor: to,
          cursorAt: SERVER_TIME,
          state: next.plan.state,
          sentBack: { n, to: tid, reason, by: ctx.actor.id, at: SERVER_TIME },
        },
        eventId,
      ),
      upd(
        inboxPaths.thread(ctx.workspaceId, p.threadId),
        { ...planThreadState(next.plan, next.outcomes) },
        eventId,
      ),
    ],
  );
  return { ...plan, toStep: to!, blocked };
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
    {
      outcomeId: input.outcomeId,
      type: o.type,
      instruction,
      chips,
      ...decisionFacts({ thread: input.thread, outcome: o }),
    },
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
    /** A plan step's plan: during a re-check, an approved step that has not run may be revised. */
    plan?: PlanInput;
  },
): ActionPlan & { version: number } {
  requireAgent(ctx);
  const o = input.outcome;
  // Re-check (item bmNoIvvqKCdAorLSShE9): the home agent may revise an open proposal unasked.
  const rechecking =
    input.thread.recheck?.state === 'pending' && input.thread.fetchedBy === ctx.actor.id;
  const unasked =
    rechecking &&
    (o.state === 'proposed' ||
      (o.state === 'approved' &&
        !!o.planId &&
        recheckable(input.outcomeId, o, planFor(input.plan, o, input.outcomeId))));
  need(
    input.threadId === undefined || input.threadId === o.threadId,
    `Outcome ${input.outcomeId} is on thread ${o.threadId}, not ${input.threadId}: propose a new outcome instead.`,
  );
  need(
    input.type === undefined || input.type === o.type,
    `Outcome ${input.outcomeId} is a ${o.type}; a revision keeps the type: propose a new outcome instead.`,
  );
  need(
    o.state === 'revising' || unasked,
    o.state === 'proposed'
      ? 'Nobody asked for changes on this outcome (or the person cancelled the request).'
      : o.state === 'approved' && o.planId && rechecking
        ? 'This step has started (it is its turn): it cannot be revised now.'
        : `This outcome was already decided (${o.state}): your revision is not needed.`,
  );
  need(o.proposedBy === ctx.actor.id, 'Only the agent that proposed this outcome revises it.');
  need(!isRetiredOutcome(o.type), RETIRED_MESSAGE(o.type));
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
  const asked =
    o.state === 'revising' && o.revise
      ? { instruction: o.revise.instruction, chips: o.revise.chips }
      : null;
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
            {
              n: version,
              fields,
              note,
              confidence: conf,
              checks,
              by: ctx.actor.id,
              eventId,
              asked,
            },
          ],
          revise: null,
          // An approved plan step revised on a re-check needs the member's approval again.
          ...(o.state === 'approved' ? { decision: null } : {}),
        },
        eventId,
      ),
    ],
  );
  return { ...p, version };
}

// ---------- Re-check (item bmNoIvvqKCdAorLSShE9) ----------

/**
 * Whether a re-check looks at this outcome: an open proposal (proposed), or a step of a live
 * plan that has not run (approved, and not at the cursor, where it is being carried out).
 */
export function recheckable(
  oid: string,
  o: Pick<OutcomeStateOf, 'state' | 'planId'>,
  plan?: Pick<PlanInput, 'plan'>,
): boolean {
  if (o.state === 'proposed') return true;
  if (o.state !== 'approved' || !o.planId || !plan) return false;
  const p = plan.plan;
  return PLAN_LIVE.includes(p.state) && p.steps.includes(oid) && p.steps[p.cursor] !== oid;
}

/** Whether a re-check request of the thread is still waiting for its agent. */
export function recheckPending(t: Pick<ThreadStateOf, 'recheck'>, nowMs: number): boolean {
  const r = t.recheck;
  if (!r || r.state !== 'pending') return false;
  const at = r.requestedAt?.toMillis();
  return at === undefined || nowMs - at < RECHECK_RETRY_MS;
}

/**
 * The member asks the thread's home agent to check it again (Re-check): re-read the thread, the
 * new messages and the context, then confirm or revise the open proposals (and
 * the steps of a live plan that have not run). Only on a thread with something open (Your call
 * or waiting); a request the agent has not answered may be made again after 30 minutes. The
 * agent gets a `recheck` inbox event. Nothing runs by itself.
 */
export function requestRecheck(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; nowMs?: number },
): ActionPlan {
  const t = input.thread;
  owner(ctx, t.memberUid);
  need(
    t.state === 'yourCall' || t.state === 'waiting',
    'Only a thread with a proposal or a plan can be re-checked.',
  );
  need(!recheckPending(t, input.nowMs ?? Date.now()), 'The agent is already checking it again.');
  return inboxPlan(
    ctx,
    'thread.recheck_requested',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { from: t.state },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          recheck: {
            state: 'pending',
            by: ctx.actor.id,
            requestedAt: SERVER_TIME,
            result: null,
            note: null,
            at: null,
          },
        },
        eventId,
      ),
    ],
  );
}

/**
 * The home agent reports its re-check (thread_recheck_done): still_good stamps `checkedAt` on
 * every open proposal and unrun live-plan step of the thread; revised (after outcome_propose
 * revises) and asked (after inbox_ask) only close the request.
 */
export function recheckDone(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf & { recheck?: (ThreadStateOf['recheck'] & { by?: string }) | null };
    result: string;
    note?: string | null;
    /** The thread's outcomes, by id. */
    outcomes: Readonly<Record<string, OutcomeStateOf>>;
    /** The thread's plans, by id. */
    plans?: Readonly<Record<string, PlanOf>>;
  },
): ActionPlan & { checked: string[] } {
  requireAgent(ctx);
  const t = input.thread;
  need(
    t.fetchedBy === ctx.actor.id,
    "Only the thread's home agent (the one that brought it in) answers a re-check.",
  );
  need(t.recheck?.state === 'pending', 'Nobody asked to re-check this thread.');
  need(
    (RECHECK_RESULTS as readonly string[]).includes(input.result),
    `The result is ${RECHECK_RESULTS.join(', ')}.`,
  );
  const result = input.result as RecheckResult;
  const note = input.note?.trim() || null;
  need(
    note === null || note.length <= INBOX_LIMITS.recheckNote,
    tooLong('The note', INBOX_LIMITS.recheckNote),
  );
  const checked =
    result === 'still_good'
      ? Object.keys(input.outcomes)
          .sort()
          .filter((oid) => {
            const o = input.outcomes[oid]!;
            if (o.threadId !== input.threadId) return false;
            const pl = o.planId ? input.plans?.[o.planId] : undefined;
            return recheckable(oid, o, pl ? { plan: pl } : undefined);
          })
      : [];
  const p = inboxPlan(
    ctx,
    'thread.rechecked',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { result, note, checked },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          'recheck.state': 'done',
          'recheck.result': result,
          'recheck.note': note,
          'recheck.at': SERVER_TIME,
        },
        eventId,
      ),
      ...checked.map((oid) =>
        upd(inboxPaths.outcome(ctx.workspaceId, oid), { checkedAt: SERVER_TIME }, eventId),
      ),
    ],
  );
  return { ...p, checked };
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
/** Not now lasts at most this long (09:00 the next day, in any time zone). */
export const NOT_NOW_MAX_MS = 48 * 3_600_000;

/**
 * Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3): the member puts what waits (`key`, from
 * threadAsk) out of Today until `until` (09:00 the next day, notNowUntil). Nothing else changes:
 * the thread keeps its state, and its summary stays fresh (`updatedAt` is not touched). A new
 * arrival has a new key, so it shows again.
 */
export function notNowThread(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; key: string; until: Date; nowMs?: number },
): ActionPlan {
  const t = input.thread;
  owner(ctx, t.memberUid);
  need(t.state === 'needsYou' || t.state === 'yourCall', 'Nothing on this thread waits for you.');
  const key = input.key.trim();
  need(key.length > 0 && key.length <= 200, 'Not now needs the decision it is about.');
  const until = input.until.getTime();
  const now = input.nowMs ?? Date.now();
  need(until > now && until <= now + NOT_NOW_MAX_MS, 'Not now lasts until tomorrow morning.');
  return inboxPlan(
    ctx,
    'thread.not_now',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { key, until: input.until, ...decisionFacts({ thread: t, stepLabel: null }) },
    (eventId) => [
      {
        kind: 'update',
        path: inboxPaths.thread(ctx.workspaceId, input.threadId),
        data: { notNow: { until: input.until, key, at: SERVER_TIME }, lastEventId: eventId },
      },
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

// ---------- Ask the agent (item w6O2KOw4ys70TQv9I1xD) ----------

/** Whether the thread's latest instruction still waits for its agent (under 30 minutes old). */
export function instructPending(t: Pick<ThreadStateOf, 'instruct'>, nowMs: number): boolean {
  const r = t.instruct;
  if (!r || r.state !== 'pending') return false;
  const at = r.at?.toMillis();
  return at === undefined || nowMs - at < INSTRUCT_RETRY_MS;
}

/**
 * The member asks the thread's home agent something (free text, at most 500 characters, or a
 * chip), on a thread in any state. It is kept on the thread (at most 20: the oldest answered one
 * goes) and the agent gets an `instruct` inbox event; it answers with a note, a question, a
 * proposal or a plan. Nothing outward happens without an approved outcome. One at a time: a new
 * one waits until the agent answered, or 30 minutes passed.
 */
export function instructThread(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    text?: string | null;
    chip?: string | null;
    nowMs?: number;
  },
): ActionPlan & { instructionId: string } {
  const t = input.thread;
  owner(ctx, t.memberUid);
  const raw = input.text?.trim() ?? '';
  const chip = input.chip ?? null;
  need((raw === '') !== (chip === null), 'Ask with a text or a chip (one of them).');
  need(
    chip === null || (INSTRUCTION_CHIPS as readonly string[]).includes(chip),
    `The chip is ${INSTRUCTION_CHIPS.join(', ')}.`,
  );
  const text = chip === null ? cleanText('The request', raw, INBOX_LIMITS.instruction) : null;
  need(!instructPending(t, input.nowMs ?? Date.now()), 'The agent is still on your last request.');
  const list = t.instructions ?? {};
  const ids = Object.keys(list);
  // At most 20 kept: the oldest answered one goes (else the oldest).
  let dropped: string | null = null;
  if (ids.length >= INBOX_LIMITS.instructions) {
    const order = [...ids].sort(
      (a, b) => (list[a]!.at?.toMillis() ?? 0) - (list[b]!.at?.toMillis() ?? 0) || (a < b ? -1 : 1),
    );
    dropped = order.find((id) => list[id]!.state === 'answered') ?? order[0]!;
  }
  const p = inboxPlan(
    ctx,
    'thread.instructed',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { text, chip },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          [`instructions.${eventId}`]: {
            text,
            chip,
            by: ctx.actor.id,
            at: SERVER_TIME,
            state: 'pending',
            answer: null,
          },
          ...(dropped ? { [`instructions.${dropped}`]: DELETE_FIELD } : {}),
          instruct: { state: 'pending', id: eventId, at: SERVER_TIME },
        },
        eventId,
      ),
    ],
  );
  return { ...p, instructionId: p.eventId };
}

/**
 * The home agent answers an instruction (thread_answer_instruction): with a note (its text), a
 * question it asked (inbox_ask), or the outcome or plan it proposed (refId). Once per instruction.
 */
export function answerInstruction(
  ctx: ActionContext,
  input: {
    threadId: string;
    thread: ThreadStateOf;
    instructionId: string;
    kind: string;
    refId?: string | null;
    note?: string | null;
  },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  need(
    t.fetchedBy === ctx.actor.id,
    "Only the thread's home agent (the one that brought it in) answers the person's request.",
  );
  const ins = t.instructions?.[input.instructionId];
  need(!!ins, `There is no request ${input.instructionId} on this thread.`);
  need(ins!.state === 'pending', 'This request was answered already.');
  need(
    (INSTRUCT_ANSWERS as readonly string[]).includes(input.kind),
    `The kind is ${INSTRUCT_ANSWERS.join(', ')}.`,
  );
  const kind = input.kind as InstructAnswer;
  const refId = input.refId?.trim() || null;
  const note = input.note?.trim() || null;
  need(
    note === null || note.length <= INBOX_LIMITS.instructNote,
    tooLong('The note', INBOX_LIMITS.instructNote),
  );
  need(kind !== 'note' || note !== null, 'Answer with a note: give its text.');
  need(
    (kind === 'outcome' || kind === 'plan') === (refId !== null),
    kind === 'outcome' || kind === 'plan'
      ? `Give the ${kind === 'outcome' ? 'outcome' : 'plan'} id you proposed (refId).`
      : 'Only an outcome or plan answer has a refId.',
  );
  const latest = t.instruct?.id === input.instructionId;
  return inboxPlan(
    ctx,
    'thread.instruction_answered',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { instructionId: input.instructionId, kind, refId, note },
    (eventId) => [
      upd(
        inboxPaths.thread(ctx.workspaceId, input.threadId),
        {
          [`instructions.${input.instructionId}.state`]: 'answered',
          [`instructions.${input.instructionId}.answer`]: { kind, refId, note, at: SERVER_TIME },
          ...(latest ? { 'instruct.state': 'done' } : {}),
        },
        eventId,
      ),
    ],
  );
}

/** The home agent sets the chips it suggests for the thread (thread_suggest_chips): 0-5, once each. */
export function suggestChips(
  ctx: ActionContext,
  input: { threadId: string; thread: ThreadStateOf; chips: readonly string[] },
): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  need(
    t.fetchedBy === ctx.actor.id,
    "Only the thread's home agent (the one that brought it in) suggests its chips.",
  );
  need(Array.isArray(input.chips), 'The chips are a list.');
  need(
    input.chips.length <= INBOX_LIMITS.suggestedChips,
    `At most ${INBOX_LIMITS.suggestedChips} chips.`,
  );
  for (const c of input.chips)
    need(
      (INSTRUCT_CHIPS as readonly string[]).includes(c),
      `A chip is one of ${INSTRUCT_CHIPS.join(', ')}.`,
    );
  need(new Set(input.chips).size === input.chips.length, 'Each chip is listed once.');
  const chips = [...input.chips];
  return inboxPlan(
    ctx,
    'thread.chips_suggested',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { chips },
    (eventId) => [
      upd(inboxPaths.thread(ctx.workspaceId, input.threadId), { suggestedChips: chips }, eventId),
    ],
  );
}
