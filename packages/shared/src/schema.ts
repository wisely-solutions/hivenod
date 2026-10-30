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

export const themeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;

/** Organization roles (SPEC §5.1): admins manage everything, members see their own Inbox. */
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

export const attachmentKind = z.enum(['html', 'markdown', 'text', 'image', 'pdf', 'link']);
export type AttachmentKind = z.infer<typeof attachmentKind>;

/** Inline attachments are capped at 900 KB (SPEC §3). */
export const MAX_ATTACHMENT_BYTES = 900 * 1024;
/** Minimum length of a reason (send back, stop). */
export const MIN_REASON_CHARS = 10;
/** Workspace events (the organization's audit log); project, item and run events went with Projects. */
export const EVENT_TYPES = [
  'agent.created',
  'agent.revoked',
  'agent.removed',
  'agent.renamed',
  'agent.rotated',
  'agent.updated',
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
] as const;
export const eventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventType>;

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
  event: (w: string, e: string) => `workspaces/${w}/events/${e}`,
  /** Deterministic tombstone event id required for hard deletes. */
  deleteEventId: (kind: 'groups' | 'invites' | 'agents', docId: string) => `del-${kind}-${docId}`,
} as const;
