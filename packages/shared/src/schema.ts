/**
 * Firestore data model (SPEC §5). Every collection has a Zod schema and an inferred type.
 * Rules-relevant invariants (who may write what) live in firestore.rules; these schemas
 * describe shape only. Fields marked "rules:" are required by the security rules.
 */
import { z } from 'zod';

// ---------- primitives ----------

/** Firestore Timestamp, duck-typed so this module never imports the Firebase SDK. */
export interface TimestampLike {
  seconds: number;
  nanoseconds: number;
  toMillis(): number;
}
export const timestamp = z.custom<TimestampLike>(
  (v) =>
    typeof v === 'object' &&
    v !== null &&
    typeof (v as TimestampLike).seconds === 'number' &&
    typeof (v as TimestampLike).toMillis === 'function',
  { message: 'Expected a Firestore Timestamp' },
);

export const id = z.string().min(1).max(128);
export const uid = id;

export const stepKind = z.enum(['agent', 'human']);
export type StepKind = z.infer<typeof stepKind>;

export const gateRule = z.enum(['any', 'atLeast', 'all', 'specific']);
export type GateRule = z.infer<typeof gateRule>;

export const rejectPolicy = z.enum(['one', 'majority']);
export type RejectPolicy = z.infer<typeof rejectPolicy>;

export const themeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

/** Organization roles (SPEC §5.1): admins manage everything, members only see projects they are added to. */
export const role = z.enum(['admin', 'member']);
/** Reads `owner` (the name before organizations) as `admin`, until the migration has rewritten it. */
const storedRole = z
  .enum(['admin', 'member', 'owner'])
  .transform((r): Role => (r === 'owner' ? 'admin' : r));
export type Role = z.infer<typeof role>;

export const actorType = z.enum(['human', 'agent']);
export type ActorType = z.infer<typeof actorType>;

/** `{type, id}` reference to whoever wrote something. */
export const actorRef = z.object({ type: actorType, id: uid });
export type ActorRef = z.infer<typeof actorRef>;

export const itemType = z.enum(['idea', 'request', 'bug', 'finding', 'task']);
export type ItemType = z.infer<typeof itemType>;

/**
 * `suggested`: an agent's finding nobody has triaged yet (card TU5pDmzE). It sits at the first
 * step with no claim and no gate, is never listed as work and cannot be claimed; "Add to <first
 * step>" turns it into a normal item there, "Dismiss" stops it with a reason.
 */
export const itemStatus = z.enum(['queued', 'working', 'waiting', 'done', 'stopped', 'suggested']);
export type ItemStatus = z.infer<typeof itemStatus>;

export const decisionOutcome = z.enum(['approved', 'sentBack', 'stopped', 'answered']);
export type DecisionOutcome = z.infer<typeof decisionOutcome>;

/**
 * `stopped`: a person pressed Stop work while the agent ran (card BrK0r2FE). Not a failure: it
 * never counts toward the agent's failure pause.
 */
export const runStatus = z.enum(['running', 'done', 'failed', 'released', 'stopped']);
export type RunStatus = z.infer<typeof runStatus>;

export const attachmentKind = z.enum(['html', 'markdown', 'text', 'image', 'pdf', 'link']);
export type AttachmentKind = z.infer<typeof attachmentKind>;

export const messageKind = z.enum(['question', 'answer', 'note']);
export type MessageKind = z.infer<typeof messageKind>;

export const logLevel = z.enum(['info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevel>;

/** Inline attachments are capped at 900 KB (SPEC §3). */
export const MAX_ATTACHMENT_BYTES = 900 * 1024;
/** Agent log lines per run (SPEC §5). */
export const MAX_LOG_LINES = 500;
/** A claim is stale (and can be taken over) after this many minutes without a heartbeat. */
export const STALE_CLAIM_MINUTES = 10;
/** run.heartbeat events are coalesced: at most one per this many minutes. */
export const HEARTBEAT_EVENT_MINUTES = 5;
/** Minimum length of a send-back / stop / dismiss reason. */
export const MIN_REASON_CHARS = 10;
/** Agent send-backs (card KLCTVnX8): rounds before the item is held for people, longest reason. */
export const MAX_AGENT_SEND_BACKS = 3;
export const MAX_SEND_BACK_REASON_CHARS = 2000;
/** At most this many library steps may lie between the target and the sender (rules budget). */
export const MAX_SEND_BACK_SPAN = 12;

export const EVENT_TYPES = [
  'item.created',
  'item.moved',
  'item.claimed',
  'item.released',
  'item.completed',
  'item.updated',
  'item.deleted',
  'item.workStopped',
  'item.resumed',
  'item.archived',
  'item.restored',
  'item.erasing',
  'attachment.added',
  'message.posted',
  'decision.approved',
  'decision.sentBack',
  'decision.stopped',
  'decision.answered',
  'finding.raised',
  'finding.triaged',
  'run.started',
  'run.heartbeat',
  'run.ended',
  'agent.created',
  'agent.revoked',
  'agent.removed',
  'agent.renamed',
  'agent.rotated',
  'agent.updated',
  'project.created',
  'project.updated',
  'project.processChanged',
  'project.archived',
  'project.deleted',
  'project.membersChanged',
  'workspace.created',
  'workspace.updated',
  'workspace.deleting',
  'member.invited',
  'member.joined',
  'member.roleChanged',
  'member.removed',
  'member.left',
  'member.inviteRevoked',
  'group.created',
  'group.updated',
  'group.deleted',
  // Per-item paths (card st5INNZj)
  'item.shaped',
  'item.pathChanged',
  'item.pathChangeDecided',
  'step.proposed',
  'step.accepted',
  'step.rejected',
  // Agent send-back (card KLCTVnX8)
  'item.sentBack',
  // Calendar (Inbox item w9SAf), removed in slice 5 of OE8Fm: old events only, never written now
  'calendar.changed',
] as const;
export const eventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventType>;

/** Event types an agent is allowed to emit (enforced in rules too). */
export const AGENT_EVENT_TYPES = [
  'item.claimed',
  'item.released',
  'item.completed',
  'item.updated',
  'attachment.added',
  'message.posted',
  'finding.raised',
  'run.started',
  'run.heartbeat',
  'run.ended',
  'item.shaped',
  'item.pathChanged',
  'step.proposed',
  'item.sentBack',
] as const satisfies readonly EventType[];

// ---------- users & workspaces ----------

export const userSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  photoURL: z.string().max(2048).nullable(),
  color: z.string().max(32),
  /** The organization shown right now (the switcher changes it). */
  workspaceId: id.nullable(),
  /** Every organization this person has joined (the switcher lists them). Missing on old profiles. */
  workspaceIds: z.array(id).max(50).default([]),
  theme: themeSchema.nullable(),
});
export type User = z.infer<typeof userSchema>;

/**
 * An organization. It lives at `workspaces/{wid}`: the storage path keeps its original name so
 * nothing had to move when workspaces became organizations (SPEC §5).
 */
export const workspaceSchema = z.object({
  name: z.string().min(1).max(120),
  /** Who created it. Informational only: any admin has the same powers. */
  ownerUid: uid,
  memberRoles: z.record(uid, storedRole),
  /** Denormalised list of the admins in memberRoles, so rules can tell the last admin. */
  adminUids: z.array(uid).max(200).default([]),
  createdAt: timestamp,
  lastEventId: id,
  /** Set by an admin when the organization is being deleted (card 9jpb1Q4a); see orgs/deleteOrg. */
  deletingAt: timestamp.nullable().optional(),
  deletingBy: uid.nullable().optional(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** A member's public profile inside one organization, so people in several orgs stay readable. */
export const memberProfileSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(320),
  photoURL: z.string().max(2048).nullable(),
  color: z.string().max(32),
});
export type MemberProfile = z.infer<typeof memberProfileSchema>;

export const inviteSchema = z.object({
  email: z.string().min(3).max(320),
  role,
  createdBy: uid,
  expiresAt: timestamp,
  usedBy: uid.nullable(),
  lastEventId: id,
});
export type Invite = z.infer<typeof inviteSchema>;

export const groupSchema = z.object({
  name: z.string().min(1).max(80),
  memberUids: z.array(uid).max(200),
  lastEventId: id,
});
export type Group = z.infer<typeof groupSchema>;

/**
 * Guardrails for an agent (card zSzW3LXy). Absent on agents created before them: read with
 * `guardrailsOf()` (packages/shared/src/agents.ts), which fills the defaults.
 */
export const DEFAULT_MAX_FAILED_RUNS = 3;
export const MAX_FAILED_RUNS_LIMIT = 20;
export const guardrailsSchema = z.object({
  /** Pause the agent after this many failed runs in a row. */
  maxFailedRuns: z.number().int().min(1).max(MAX_FAILED_RUNS_LIMIT),
  // Older agents also store `maxTokensPerItem`: ignored (token usage is tracked, never limited).
});
export type Guardrails = z.infer<typeof guardrailsSchema>;

/**
 * Not set in Hivenod any more (card rifzGl8M): what Claude Code may do is the person's own Claude
 * Code config. Kept for the stored `permissions` field of older agents (ignored) and as the fixed
 * defaults of the experimental Codex and Copilot adapters, which do not read that config.
 */
export const AGENT_PERMISSIONS = [
  'editFiles',
  'runTests',
  'gitCommit',
  'gitPush',
  'installPackages',
  'runCommands',
  'webAccess',
] as const;
export const agentPermission = z.enum(AGENT_PERMISSIONS);
export type AgentPermission = z.infer<typeof agentPermission>;
export const DEFAULT_AGENT_PERMISSIONS: readonly AgentPermission[] = [
  'editFiles',
  'runTests',
  'gitCommit',
];

/**
 * What an agent may work on (Inbox item fJnu6). Absent: projects (its `projectIds`), plus Inbox. `'inbox'`: Inbox only, never development items (a personal assistant,
 * e.g. the personal agent in a "Personal" organization). Set when the agent is created, kept on
 * rotation, never changed afterwards; its `projectIds` stays `[]`. Enforced by firestore.rules
 * (`agentCanProject`), mirrored by `inboxOnly()` in packages/shared/src/agents.ts.
 */
export const AGENT_SCOPES = ['inbox'] as const;
export const agentScope = z.enum(AGENT_SCOPES);
export type AgentScope = z.infer<typeof agentScope>;

export const agentSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(32),
  /** Allowed project ids, or '*' for every project. */
  projectIds: z.union([z.array(id).max(100), z.literal('*')]),
  /** Optional (item fJnu6): 'inbox' = Inbox only. Absent = projects too. */
  scope: agentScope.optional(),
  createdBy: uid,
  createdAt: timestamp,
  revokedAt: timestamp.nullable(),
  lastSeenAt: timestamp.nullable(),
  /** Set by the agent when its `hivenod run` session stops; it shows offline until it is seen again. */
  signedOutAt: timestamp.nullable().optional(),
  /** Host name of the terminal that last stamped presence (shown when a second terminal is refused). */
  seenHost: z.string().max(80).optional(),
  /** `hivenod --version` of the CLI that last stamped presence (item N9EEn); absent on older CLIs. */
  cliVersion: z.string().max(40).optional(),
  /** The channel session that last stamped presence, and a stable id of its machine (item N0biX). */
  seenSession: z.string().max(64).optional(),
  seenHostId: z.string().max(64).optional(),
  tokenHint: z.string().max(8),
  previousAgentUid: uid.nullable(),
  /** Optional (card zSzW3LXy); absent means the defaults. */
  guardrails: guardrailsSchema.optional(),
  /** Legacy, ignored: older agents may still store an allow-list. Never written any more. */
  permissions: z.array(agentPermission).max(AGENT_PERMISSIONS.length).optional(),
  /** Failed runs in a row; reset by a done run or when an admin resumes. */
  failStreak: z.number().int().min(0).optional(),
  /** Set when the agent paused itself after too many failed runs; only an admin clears it. */
  pausedAt: timestamp.nullable().optional(),
  pausedReason: z.string().max(200).nullable().optional(),
  lastEventId: id,
});
export type Agent = z.infer<typeof agentSchema>;

// ---------- projects & process ----------

export const gateSchema = z.object({
  /** Resolved union of people + group members, recomputed on save. */
  deciderUids: z.array(uid).max(100),
  groupIds: z.array(id).max(50),
  rule: gateRule,
  /** Used by `atLeast`; kept present (default 1) so rules can read it. */
  n: z.number().int().min(1),
  mustInclude: z.array(uid).max(100),
  rejectPolicy,
  remindAfterHours: z
    .number()
    .min(0)
    .max(24 * 30),
});
export type Gate = z.infer<typeof gateSchema>;

/**
 * Ids that name something on Object.prototype (`constructor`, `toString`, `__proto__`, ...) and `prototype`. They
 * would clash with plain-object maps keyed by step id, so no step may use one.
 */
export function isReservedStepId(id: string): boolean {
  return id === 'prototype' || id in Object.prototype;
}

export const stepSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .refine((v) => !isReservedStepId(v), 'This step id is reserved'),
    name: z.string().min(1).max(60),
    kind: stepKind,
    description: z.string().max(2000),
    instructions: z.string().max(20000).optional(),
    outputs: z.array(z.string().max(200)).max(20).optional(),
    gate: gateSchema.optional(),
  })
  .refine((s) => (s.kind === 'human') === (s.gate !== undefined), {
    message: 'Human steps need a gate; agent steps must not have one',
  });
export type Step = z.infer<typeof stepSchema>;

export const MAX_STEPS = 30;

export const projectSchema = z
  .object({
    name: z.string().min(1).max(120),
    emoji: z.string().max(16),
    color: z.string().max(32),
    /** Optional one-line purpose, edited under Settings > Projects. Absent on older projects. */
    description: z.string().max(500).optional(),
    // Older projects also store `budgetEur`: ignored (Hivenod shows spend, it has no budgets).
    templateId: z.string().max(40),
    steps: z.array(stepSchema).min(1).max(MAX_STEPS),
    /** Denormalised {stepId: index} so rules can find a step's position (rules have no indexOf). */
    stepIndex: z.record(z.string(), z.number().int().min(0)),
    /** Who may see this project. Admins always can; members only when listed here. */
    memberUids: z.array(uid).max(200).default([]),
    /**
     * Per-step allowed agents (card zSzW3LXy): {agentStepId: [agentUid]}. A step that is not
     * listed (or lists nobody) may be done by any agent allowed on the project. Kept beside the
     * steps so the rules can check it cheaply; only admins and the project's creator change it.
     */
    stepAgents: z.record(z.string(), z.array(uid).max(50)).default({}),
    /**
     * Card st5INNZj: new items wait to be shaped (an agent picks their path). Absent on projects
     * from before paths: read with shapesNewItems().
     */
    shapeNewItems: z.boolean().optional(),
    /**
     * Item DhsO9: agents of this workspace allowed on the project may create items in it
     * (create_item). Off when absent. Admins and the project's creator switch it.
     */
    agentsMayCreateItems: z.boolean().optional(),
    /**
     * Item AzveC: ask the holder of an actively worked item for a status every N minutes (15, 30
     * or 60; 0 = off). Absent = DEFAULT_STATUS_EVERY (off). Admins and the project's creator change it.
     */
    statusEvery: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(60)]).optional(),
    /**
     * Item AzveC: an actively worked item with no activity from its agent for N minutes (20, 40,
     * 60 or 120; 0 = never) is flagged and its deciders are told once. Absent = DEFAULT_SILENCE_AFTER.
     */
    silenceAfter: z
      .union([z.literal(0), z.literal(20), z.literal(40), z.literal(60), z.literal(120)])
      .optional(),
    createdBy: uid,
    createdAt: timestamp,
    archivedAt: timestamp.nullable(),
    lastEventId: id,
  })
  .refine(
    (p) =>
      Object.keys(p.stepIndex).length === p.steps.length &&
      p.steps.every((s, i) => p.stepIndex[s.id] === i),
    { message: 'stepIndex must match steps' },
  );
export type Project = z.infer<typeof projectSchema>;

/** Builds the stepIndex map for a list of steps. */
export function buildStepIndex(steps: readonly Pick<Step, 'id'>[]): Record<string, number> {
  return Object.fromEntries(steps.map((s, i) => [s.id, i]));
}

// ---------- items and their children ----------

export const decisionMark = z.object({ at: timestamp, rationale: z.string().max(4000) });
export type DecisionMark = z.infer<typeof decisionMark>;

export const itemGateSchema = z.object({
  stepId: z.string(),
  approvals: z.record(uid, decisionMark),
  rejections: z.record(uid, decisionMark),
});
export type ItemGate = z.infer<typeof itemGateSchema>;

export const claimSchema = z.object({ runId: id, agentUid: uid, heartbeatAt: timestamp });
export type Claim = z.infer<typeof claimSchema>;

/** An item held for people's answer: the question, the agent that asked it, and when. */
/**
 * Legacy: older holds say 'tokenLimit' (the guardrail that asked is gone). They are read as
 * ordinary questions; nothing writes a reason any more.
 */
export const holdReason = z.enum(['tokenLimit']);
export type HoldReason = z.infer<typeof holdReason>;
export const holdSchema = z.object({
  questionId: id,
  agentUid: uid,
  at: timestamp,
  reason: holdReason.optional(),
});
export type Hold = z.infer<typeof holdSchema>;

/** Stop work (card BrK0r2FE): go back (held until Resume) or cancel completely (item stopped). */
export const stopMode = z.enum(['back', 'cancel']);
export type StopMode = z.infer<typeof stopMode>;
/** Longest optional reason for stopping work. */
export const MAX_STOP_REASON_CHARS = 500;
export const workStopSchema = z.object({
  mode: stopMode,
  byUid: uid,
  at: timestamp,
  reason: z.string().max(MAX_STOP_REASON_CHARS),
  /** The run that was stopped. */
  runId: id,
});
export type WorkStop = z.infer<typeof workStopSchema>;

/**
 * A held item its agent parked (item QjTTL): waiting on something outside the agent (a release
 * batch, a review). It stays claimed by that agent but does not count toward the session's
 * max_items. Only the claim of `runId` parks it: once the claim moves on, the park is void.
 */
export const MAX_PARK_REASON_CHARS = 200;
export const parkSchema = z.object({
  runId: id,
  reason: z.string().min(1).max(MAX_PARK_REASON_CHARS),
  at: timestamp,
});
export type Park = z.infer<typeof parkSchema>;
/** A parked item goes back to the queue after this long without activity (item QjTTL). */
export const PARK_RETURN_MS = 24 * 60 * 60_000;

/**
 * Status checks (item AzveC). A project may ask the agent holding an item for a one-line status
 * every `statusEvery` minutes while the item is actively worked (off by default). The holder
 * answers with the `status` tool (statusUpdate); a person may ask at once (statusAsk). Silence is
 * counted from the item's last activity (any agent log line, tool write or status): with none for
 * `silenceAfter` minutes (or SILENCE_GRACE_MS after a person asked), the notifier flags the item
 * (silence) and tells its deciders once.
 */
export const STATUS_EVERY_CHOICES = [0, 15, 30, 60] as const;
export type StatusEvery = (typeof STATUS_EVERY_CHOICES)[number];
export const DEFAULT_STATUS_EVERY: StatusEvery = 0;
export const SILENCE_AFTER_CHOICES = [0, 20, 40, 60, 120] as const;
export type SilenceAfter = (typeof SILENCE_AFTER_CHOICES)[number];
export const DEFAULT_SILENCE_AFTER: SilenceAfter = 40;
export const MAX_STATUS_TEXT_CHARS = 200;
/** How long after a person asked for a status, without any activity, the item counts as silent. */
export const SILENCE_GRACE_MS = 10 * 60_000;
/** A person may ask for a status on one item at most this often. */
export const STATUS_ASK_EVERY_MS = 2 * 60_000;
export const statusUpdateSchema = z.object({
  /** The claim it was written under: void once the claim moves on. */
  runId: id,
  text: z.string().min(1).max(MAX_STATUS_TEXT_CHARS),
  /** Optional percentage done. */
  pct: z.number().int().min(0).max(100).nullable(),
  at: timestamp,
  /** The agent that wrote it. */
  by: uid,
});
export type StatusUpdate = z.infer<typeof statusUpdateSchema>;
export const statusAskSchema = z.object({ runId: id, byUid: uid, at: timestamp });
export type StatusAsk = z.infer<typeof statusAskSchema>;
/** Written by the notifier only (admin SDK): no activity since `since` (ms) on this run. */
export const silenceSchema = z.object({ runId: id, since: z.number(), at: z.number() });
export type Silence = z.infer<typeof silenceSchema>;

export const triageSchema = z.object({
  outcome: z.enum(['intake', 'addedToItem', 'dismissed']),
  reason: z.string().max(2000),
  byUid: uid,
  at: timestamp,
});
export type Triage = z.infer<typeof triageSchema>;

/**
 * Per-item paths (card st5INNZj). The project's steps are its library; an item's path is the
 * library minus the steps it skips, so it always keeps library order. Agent steps it skips are in
 * `pathSkips` (agents and people change them at once); people steps it skips are in `gateSkips`
 * (only a decider of that step changes it; a people step listed in pathSkips is NOT skipped).
 * Absent skips = the full library (items from before paths: nothing to migrate).
 */
export const MAX_PATH_NOTE_CHARS = 300;
export const MAX_PATH_REASON_CHARS = 1000;
/** Who shaped the item, when, and their one-line summary of the path. */
export const itemShapeSchema = z.object({
  by: actorRef,
  at: timestamp,
  note: z.string().max(MAX_PATH_NOTE_CHARS),
});
export type ItemShape = z.infer<typeof itemShapeSchema>;
export const pathOp = z.enum(['add', 'drop']);
export type PathOp = z.infer<typeof pathOp>;
/** A pending change of a people step on a path, waiting for any one of that step's deciders. */
export const pathRequestSchema = z.object({
  op: pathOp,
  by: actorRef,
  reason: z.string().max(MAX_PATH_REASON_CHARS),
  at: timestamp,
});
export type PathRequest = z.infer<typeof pathRequestSchema>;

export const itemSchema = z.object({
  title: z.string().min(1).max(300),
  type: itemType,
  stepId: z.string(),
  status: itemStatus,
  summary: z.string().max(20000),
  source: z.object({ kind: z.string().max(40), label: z.string().max(200) }),
  createdBy: actorRef,
  parentItemId: id.nullable(),
  /** For findings: the run that raised it. */
  sourceRunId: id.nullable(),
  claim: claimSchema.nullable(),
  progress: z.object({ done: z.number().int().min(0), total: z.number().int().min(0) }).nullable(),
  gate: itemGateSchema.nullable(),
  triage: triageSchema.nullable(),
  sendBackCount: z.number().int().min(0),
  /**
   * Agent send-backs since a person last acted on the item (card KLCTVnX8): an agent may send an
   * item back to an earlier agent step at most MAX_AGENT_SEND_BACKS times; a person's approval,
   * send-back, move or answer resets it. Absent = 0.
   */
  agentSendBacks: z.number().int().min(0).optional(),
  /** Attachments on the item, kept in step by `attach`. Absent on items older than card 05PEkpwG (read as 0 until migrated). */
  attachmentCount: z.number().int().min(0).optional(),
  costEur: z.number().min(0),
  order: z.number(),
  /**
   * Set when a guardrail stopped an agent's run and asked people (card zSzW3LXy, e.g. the token
   * limit): no agent may claim the item until that question is answered (or an admin clears
   * it). Absent on older items, read as null.
   */
  awaitingAnswer: holdSchema.nullable().optional(),
  /**
   * Set when a person stopped an agent's work on this item (card BrK0r2FE). `back`: the item is
   * on hold at its step (no agent may claim it) until someone presses Resume, which clears it.
   * `cancel`: the item is stopped for good; kept to show who stopped it and why. Absent on older
   * items, read as null.
   */
  workStopped: workStopSchema.nullable().optional(),
  /** Set by Archive (card O2Ehb9CG): the item is stopped without a decision; Restore clears it. Absent = never archived. */
  archivedAt: timestamp.nullable().optional(),
  /** Set when a delete for good has begun; the rules then let the item's history be erased in chunks. */
  erasing: z.boolean().optional(),
  /** Absent: an item from before paths (full library). null: not shaped yet. */
  shape: itemShapeSchema.nullable().optional(),
  /** The agent steps this item skips, with why: {stepId: reason}. */
  pathSkips: z.record(z.string(), z.string().max(MAX_PATH_NOTE_CHARS)).optional(),
  /** The people steps this item skips (a decider approved), with why. */
  gateSkips: z.record(z.string(), z.string().max(MAX_PATH_NOTE_CHARS)).optional(),
  /** Pending people-step changes, each waiting for any one decider of that step. */
  pathRequests: z.record(z.string(), pathRequestSchema).optional(),
  /** People steps a decider refused to change on this item: agents may not ask again. */
  pathRefused: z.array(z.string()).max(MAX_STEPS).optional(),
  /** Bumped by every write that touches the path fields (the rules route on it). */
  pathRev: z.number().int().min(0).optional(),
  /**
   * When the item reached its current step (item QjTTL): agents are handed work oldest first by
   * it. Absent on items that have not moved since; they count as older than any that has.
   */
  stepAt: timestamp.optional(),
  /** Parked by the agent holding it (item QjTTL); valid only while claim.runId is its runId. */
  parked: parkSchema.nullable().optional(),
  /** The holder's last status line (item AzveC); valid only while claim.runId is its runId. */
  statusUpdate: statusUpdateSchema.nullable().optional(),
  /** A person's "Ask for status" (item AzveC); valid only while claim.runId is its runId. */
  statusAsk: statusAskSchema.nullable().optional(),
  /** The notifier's silence flag (item AzveC); valid only while claim.runId is its runId. */
  silence: silenceSchema.nullable().optional(),
  updatedAt: timestamp,
  lastEventId: id,
});
export type Item = z.infer<typeof itemSchema>;

export const attachmentSchema = z.object({
  kind: attachmentKind,
  name: z.string().min(1).max(200),
  content: z.string().max(MAX_ATTACHMENT_BYTES).nullable(),
  url: z.string().url().max(2048).nullable(),
  bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES),
  runId: id.nullable(),
  by: actorRef,
  at: timestamp,
  lastEventId: id,
});
export type Attachment = z.infer<typeof attachmentSchema>;

export const messageSchema = z.object({
  /** Denormalised for the cross-project "Needs you" collection-group query. */
  workspaceId: id,
  projectId: id,
  itemId: id,
  by: actorRef,
  kind: messageKind,
  text: z.string().min(1).max(8000),
  at: timestamp,
  answered: z.boolean(),
  /** For answers: the question being answered. */
  replyTo: id.nullable(),
  lastEventId: id,
});
export type Message = z.infer<typeof messageSchema>;

export const decisionSchema = z.object({
  /** Denormalised for cross-project insights (collection-group query). */
  workspaceId: id,
  projectId: id,
  itemId: id,
  itemTitle: z.string().max(300),
  stepId: z.string(),
  outcome: decisionOutcome,
  toStepId: z.string().nullable(),
  byUid: uid,
  rationale: z.string().max(4000),
  tags: z.array(z.string().max(60)).max(20),
  /** How long the item waited at this gate before the decision (absent on older decisions). */
  waitMs: z.number().int().min(0).optional(),
  /** Where the decision was made when not in the app (written by the notifier only). */
  via: z.enum(['telegram']).optional(),
  at: timestamp,
  /** Decision id == event id; kept as a field so rules can check it uniformly. */
  lastEventId: id,
});
export type Decision = z.infer<typeof decisionSchema>;

/** A new library step an agent proposes (card st5INNZj); an approver adds it or rejects it. */
export const stepProposalStatus = z.enum(['open', 'accepted', 'rejected']);
export const stepProposalSchema = z.object({
  name: z.string().min(1).max(60),
  kind: stepKind,
  description: z.string().max(2000),
  instructions: z.string().max(20000),
  outputs: z.array(z.string().max(200)).max(20),
  /** The library step it goes after; '' = first. */
  afterStepId: z.string().max(40),
  /** Suggested deciders for a people step. */
  deciderUids: z.array(uid).max(100),
  reason: z.string().max(MAX_PATH_REASON_CHARS),
  /** The item it was proposed for (it joins that item's path when accepted). */
  itemId: id,
  by: actorRef,
  at: timestamp,
  status: stepProposalStatus,
  decision: z
    .object({
      byUid: uid,
      at: timestamp,
      reason: z.string().max(2000),
      /** The id of the library step it became (accepted). */
      stepId: z.string().nullable(),
    })
    .nullable(),
  lastEventId: id,
});
export type StepProposal = z.infer<typeof stepProposalSchema>;

// ---------- runs, logs, events ----------

/** A Remote Control session link (the only kind of link a run may carry). */
export const REMOTE_URL = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{8,64}$/;

export const runSchema = z.object({
  agentUid: uid,
  projectId: id,
  itemId: id,
  stepId: z.string(),
  startedAt: timestamp,
  heartbeatAt: timestamp,
  /** When the last run.heartbeat event was written (coalescing, SPEC §5.3). */
  heartbeatEventAt: timestamp,
  endedAt: timestamp.nullable(),
  status: runStatus,
  costEur: z.number().min(0),
  /** 'shape': the run shapes an unshaped item (card st5INNZj) instead of doing its step. */
  job: z.enum(['shape']).optional(),
  /** All input tokens, cache reads included (agent-reported, display only). */
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  /** The part of tokensIn read from the prompt cache. Absent on older runs (= 0). */
  tokensCached: z.number().int().min(0).optional(),
  model: z.string().max(80).nullable(),
  summary: z.string().max(4000).nullable(),
  lastEventId: id,
  /** Who pressed Stop work (status `stopped`, card BrK0r2FE); the name is for the CLI's message. */
  stoppedBy: z.object({ uid, name: z.string().max(200) }).optional(),
  /**
   * The Remote Control session of the interactive Claude Code session working on this run (card
   * OPpbi0MS): open it on claude.ai/code or in the Claude app. Absent for headless runs.
   */
  remote: z
    .object({
      url: z.string().regex(REMOTE_URL),
      /** Claude Code's local session id (for `claude --resume`). */
      sessionId: z.string().min(1).max(80),
    })
    .optional(),
});
export type Run = z.infer<typeof runSchema>;

export const logLineSchema = z.object({
  at: timestamp,
  level: logLevel,
  text: z.string().max(4000),
});
export type LogLine = z.infer<typeof logLineSchema>;

export const eventSchema = z.object({
  actor: z.object({ type: actorType, id: uid, name: z.string().max(200) }),
  projectId: id.nullable(),
  itemId: id.nullable(),
  runId: id.nullable(),
  type: eventType,
  data: z.record(z.string(), z.unknown()),
  at: timestamp,
});
export type HiveEvent = z.infer<typeof eventSchema>;

/** Collection path builders, so app, CLI and tests agree on layout. */
export const paths = {
  user: (u: string) => `users/${u}`,
  workspace: (w: string) => `workspaces/${w}`,
  member: (w: string, u: string) => `workspaces/${w}/members/${u}`,
  invite: (w: string, code: string) => `workspaces/${w}/invites/${code}`,
  group: (w: string, g: string) => `workspaces/${w}/groups/${g}`,
  agent: (w: string, a: string) => `workspaces/${w}/agents/${a}`,
  project: (w: string, p: string) => `workspaces/${w}/projects/${p}`,
  item: (w: string, p: string, i: string) => `workspaces/${w}/projects/${p}/items/${i}`,
  attachment: (w: string, p: string, i: string, a: string) =>
    `workspaces/${w}/projects/${p}/items/${i}/attachments/${a}`,
  message: (w: string, p: string, i: string, m: string) =>
    `workspaces/${w}/projects/${p}/items/${i}/messages/${m}`,
  stepProposal: (w: string, p: string, s: string) =>
    `workspaces/${w}/projects/${p}/stepProposals/${s}`,
  decision: (w: string, p: string, d: string) => `workspaces/${w}/projects/${p}/decisions/${d}`,
  run: (w: string, r: string) => `workspaces/${w}/runs/${r}`,
  logLine: (w: string, r: string, n: number) => `workspaces/${w}/runs/${r}/log/${n}`,
  event: (w: string, e: string) => `workspaces/${w}/events/${e}`,
  /** Deterministic tombstone event id required for hard deletes. */
  deleteEventId: (kind: 'groups' | 'invites' | 'projects' | 'items' | 'agents', docId: string) =>
    `del-${kind}-${docId}`,
} as const;
