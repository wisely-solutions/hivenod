/**
 * Domain actions (SPEC §5.2): each builds ONE batched write = the domain change(s) + exactly one
 * event doc, as a plain plan. No Firebase import here: `applyPlan` in ./firestore.ts commits a
 * plan with the JS SDK. The web app and the agent CLI both use these, and the rules tests prove
 * every plan built here is accepted by firestore.rules.
 *
 * Callers pass the current state they already hold (project, item, run). Rules re-check all of
 * it server-side, so stale state can only lead to a denied write, never to a wrong one.
 */
import {
  MIN_REASON_CHARS,
  paths,
  type ActorType,
  type AgentScope,
  type EventType,
  type Guardrails,
  type MemberProfile,
  type Role,
} from './schema';

/** Placeholder for `serverTimestamp()`; rules require `at == request.time`. */
export const SERVER_TIME = Object.freeze({ __hive: 'serverTime' as const });
export type ServerTime = typeof SERVER_TIME;
/** Placeholder for `deleteField()` in update ops. */
export const DELETE_FIELD = Object.freeze({ __hive: 'deleteField' as const });

/** Placeholder for `arrayUnion(...values)` in update ops. */
export function arrayUnion(...values: string[]) {
  return { __hive: 'arrayUnion' as const, values };
}
export type ArrayUnion = ReturnType<typeof arrayUnion>;

/** Placeholder for `increment(n)` in update ops (a counter bumped without reading it). */
export function increment(by: number) {
  return { __hive: 'increment' as const, by };
}
export type Increment = ReturnType<typeof increment>;

export interface WriteOp {
  /**
   * `create`: a set that fails when the document exists (Admin SDK `create()`, the scheduler's
   * idempotent fire). The web SDK has no batch create: it writes it as a set, which the rules
   * judge as a create anyway when the document is new.
   */
  kind: 'set' | 'create' | 'update' | 'delete';
  path: string;
  /** For `update`, keys may be dotted field paths (e.g. `gate.approvals.<uid>`). */
  data?: Record<string, unknown>;
}
export interface ActionPlan {
  eventId: string;
  ops: WriteOp[];
}

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}
export interface ActionContext {
  workspaceId: string;
  actor: Actor;
  /** Set when the action did not come from the app UI (the Telegram bot). */
  via?: 'telegram';
  /** Id generator; defaults to 20 random base62 chars. */
  newId?: () => string;
}

export class ActionError extends Error {}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomId(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// ---------- internals ----------

export function nid(ctx: ActionContext): string {
  return (ctx.newId ?? randomId)();
}

export function plan(
  ctx: ActionContext,
  type: EventType,
  scope: { projectId?: string | null; itemId?: string | null; runId?: string | null },
  data: Record<string, unknown>,
  build: (eventId: string) => WriteOp[],
  eventId: string = nid(ctx),
): ActionPlan {
  const event: WriteOp = {
    kind: 'set',
    path: paths.event(ctx.workspaceId, eventId),
    data: {
      actor: { type: ctx.actor.type, id: ctx.actor.id, name: ctx.actor.name },
      projectId: scope.projectId ?? null,
      itemId: scope.itemId ?? null,
      runId: scope.runId ?? null,
      type,
      data: ctx.via && type.startsWith('decision.') ? { ...data, via: ctx.via } : data,
      at: SERVER_TIME,
    },
  };
  return { eventId, ops: [...build(eventId), event] };
}

export function requireHuman(ctx: ActionContext) {
  if (ctx.actor.type !== 'human') throw new ActionError('Only people can do this');
}
export function requireAgent(ctx: ActionContext) {
  if (ctx.actor.type !== 'agent') throw new ActionError('Only agents can do this');
}
export function requireReason(text: string) {
  if (text.trim().length < MIN_REASON_CHARS)
    throw new ActionError(`Say why in at least ${MIN_REASON_CHARS} characters`);
}

// ---------- workspace, members, groups ----------

/** What other members of an organization may see of a person (`workspaces/{wid}/members/{uid}`). */
export type ProfileInput = Pick<MemberProfile, 'name' | 'email' | 'photoURL' | 'color'>;

/** Writes or refreshes a person's own profile card inside an organization. No event (SPEC §5.3). */
export function memberProfileOp(workspaceId: string, uid: string, profile: ProfileInput): WriteOp {
  return {
    kind: 'set',
    path: paths.member(workspaceId, uid),
    data: {
      name: profile.name,
      email: profile.email,
      photoURL: profile.photoURL,
      color: profile.color,
    },
  };
}

/** Creates an organization with the actor as its first admin. */
export function createWorkspace(
  ctx: ActionContext,
  input: { name: string; profile?: ProfileInput },
): ActionPlan & { workspaceId: string } {
  requireHuman(ctx);
  const workspaceId = ctx.workspaceId;
  const plan_ = plan(ctx, 'workspace.created', {}, { name: input.name }, (eventId) => [
    {
      kind: 'set',
      path: paths.workspace(workspaceId),
      data: {
        name: input.name,
        ownerUid: ctx.actor.id,
        memberRoles: { [ctx.actor.id]: 'admin' },
        adminUids: [ctx.actor.id],
        createdAt: SERVER_TIME,
        lastEventId: eventId,
      },
    },
    ...(input.profile ? [memberProfileOp(workspaceId, ctx.actor.id, input.profile)] : []),
  ]);
  return { workspaceId, ...plan_ };
}

export function renameWorkspace(ctx: ActionContext, input: { name: string }): ActionPlan {
  requireHuman(ctx);
  return plan(ctx, 'workspace.updated', {}, { name: input.name }, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: { name: input.name, lastEventId: eventId },
    },
  ]);
}

/**
 * First step of deleting an organization (card 9jpb1Q4a): flags it. From then on the rules let the
 * admins delete everything under it and refuse every other write. See apps/web/src/orgs/deleteOrg.
 */
export function beginOrgDelete(ctx: ActionContext): ActionPlan {
  requireHuman(ctx);
  return plan(ctx, 'workspace.deleting', {}, {}, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: { deletingAt: SERVER_TIME, deletingBy: ctx.actor.id, lastEventId: eventId },
    },
  ]);
}

export function createInvite(
  ctx: ActionContext,
  input: { email: string; role: Role; expiresAt: Date; code?: string },
): ActionPlan & { code: string } {
  requireHuman(ctx);
  const code = input.code ?? randomId(24);
  const email = input.email.trim().toLowerCase();
  return {
    code,
    ...plan(ctx, 'member.invited', {}, { email, role: input.role, inviteCode: code }, (eventId) => [
      {
        kind: 'set',
        path: paths.invite(ctx.workspaceId, code),
        data: {
          email,
          role: input.role,
          createdBy: ctx.actor.id,
          expiresAt: input.expiresAt,
          usedBy: null,
          lastEventId: eventId,
        },
      },
    ]),
  };
}

export function acceptInvite(
  ctx: ActionContext,
  input: { code: string; role: Role; profile?: ProfileInput },
): ActionPlan {
  requireHuman(ctx);
  return plan(ctx, 'member.joined', {}, { inviteCode: input.code, role: input.role }, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: {
        [`memberRoles.${ctx.actor.id}`]: input.role,
        ...(input.role === 'admin' ? { adminUids: arrayUnion(ctx.actor.id) } : {}),
        lastEventId: eventId,
      },
    },
    {
      kind: 'update',
      path: paths.invite(ctx.workspaceId, input.code),
      data: { usedBy: ctx.actor.id, lastEventId: eventId },
    },
    ...(input.profile ? [memberProfileOp(ctx.workspaceId, ctx.actor.id, input.profile)] : []),
  ]);
}

export function revokeInvite(ctx: ActionContext, input: { code: string }): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'member.inviteRevoked',
    {},
    { inviteCode: input.code },
    () => [{ kind: 'delete', path: paths.invite(ctx.workspaceId, input.code) }],
    paths.deleteEventId('invites', input.code),
  );
}

/** Admins of the organization after `uid` becomes (or stops being) one. Never empties the list. */
function adminsAfter(admins: readonly string[], uid: string, admin: boolean): string[] {
  const rest = admins.filter((a) => a !== uid);
  const next = admin ? [...rest, uid] : rest;
  if (next.length === 0) throw new ActionError('An organization needs at least one admin');
  return next;
}

/** Promote or demote. `adminUids` is the organization's current list. One person per write. */
export function setMemberRole(
  ctx: ActionContext,
  input: { uid: string; role: Role; adminUids: readonly string[] },
): ActionPlan {
  requireHuman(ctx);
  const admins = adminsAfter(input.adminUids, input.uid, input.role === 'admin');
  return plan(ctx, 'member.roleChanged', {}, { uid: input.uid, role: input.role }, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: { [`memberRoles.${input.uid}`]: input.role, adminUids: admins, lastEventId: eventId },
    },
  ]);
}

export function removeMember(
  ctx: ActionContext,
  input: { uid: string; adminUids: readonly string[] },
): ActionPlan {
  requireHuman(ctx);
  const admins = adminsAfter(input.adminUids, input.uid, false);
  return plan(ctx, 'member.removed', {}, { uid: input.uid }, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: { [`memberRoles.${input.uid}`]: DELETE_FIELD, adminUids: admins, lastEventId: eventId },
    },
    { kind: 'delete', path: paths.member(ctx.workspaceId, input.uid) },
  ]);
}

/** A member leaves the organization themselves. The last admin cannot leave. */
export function leaveOrganization(
  ctx: ActionContext,
  input: { adminUids: readonly string[] },
): ActionPlan {
  requireHuman(ctx);
  const uid = ctx.actor.id;
  const admins = adminsAfter(input.adminUids, uid, false);
  return plan(ctx, 'member.left', {}, { uid }, (eventId) => [
    {
      kind: 'update',
      path: paths.workspace(ctx.workspaceId),
      data: { [`memberRoles.${uid}`]: DELETE_FIELD, adminUids: admins, lastEventId: eventId },
    },
    { kind: 'delete', path: paths.member(ctx.workspaceId, uid) },
  ]);
}

export function saveGroup(
  ctx: ActionContext,
  input: { groupId?: string; name: string; memberUids: string[]; isNew: boolean },
): ActionPlan & { groupId: string } {
  requireHuman(ctx);
  const groupId = input.groupId ?? nid(ctx);
  return {
    groupId,
    ...plan(
      ctx,
      input.isNew ? 'group.created' : 'group.updated',
      {},
      { groupId, name: input.name },
      (eventId) => [
        {
          kind: 'set',
          path: paths.group(ctx.workspaceId, groupId),
          data: { name: input.name, memberUids: input.memberUids, lastEventId: eventId },
        },
      ],
    ),
  };
}

export function deleteGroup(ctx: ActionContext, input: { groupId: string }): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'group.deleted',
    {},
    { groupId: input.groupId },
    () => [{ kind: 'delete', path: paths.group(ctx.workspaceId, input.groupId) }],
    paths.deleteEventId('groups', input.groupId),
  );
}

// ---------- agents (identity docs; the Auth user and token come from agentAuth.ts) ----------

interface AgentInput {
  agentUid: string;
  name: string;
  color: string;
  projectIds: string[] | '*';
  /** `…a7f3`, never the token itself. */
  tokenHint: string;
  /** Optional settings (card zSzW3LXy); left out, the defaults apply. */
  guardrails?: Guardrails;
  /** 'inbox': Inbox only (item fJnu6); then `projectIds` must be `[]`. */
  scope?: AgentScope;
}

function agentDocOp(
  ctx: ActionContext,
  input: AgentInput,
  previous: string | null,
  eventId: string,
) {
  if (input.scope === 'inbox' && (input.projectIds === '*' || input.projectIds.length > 0))
    throw new ActionError('An Inbox agent has no projects');
  return {
    kind: 'set' as const,
    path: paths.agent(ctx.workspaceId, input.agentUid),
    data: {
      name: input.name,
      color: input.color,
      projectIds: input.projectIds,
      ...(input.scope ? { scope: input.scope } : {}),
      createdBy: ctx.actor.id,
      createdAt: SERVER_TIME,
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: input.tokenHint,
      previousAgentUid: previous,
      ...(input.guardrails ? { guardrails: input.guardrails } : {}),
      lastEventId: eventId,
    },
  };
}

export function createAgent(
  ctx: ActionContext,
  input: AgentInput & { previousAgentUid?: string | null },
): ActionPlan {
  requireHuman(ctx);
  const previous = input.previousAgentUid ?? null;
  const type = previous ? 'agent.rotated' : 'agent.created';
  return plan(ctx, type, {}, { agentUid: input.agentUid, name: input.name }, (eventId) => [
    agentDocOp(ctx, input, previous, eventId),
  ]);
}

/** Rotate: one batch creates the new identity (same name, colour, scope) and revokes the old. */
export function rotateAgent(
  ctx: ActionContext,
  input: AgentInput & { previousAgentUid: string },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'agent.rotated',
    {},
    { agentUid: input.agentUid, previousAgentUid: input.previousAgentUid, name: input.name },
    (eventId) => [
      agentDocOp(ctx, input, input.previousAgentUid, eventId),
      {
        kind: 'update',
        path: paths.agent(ctx.workspaceId, input.previousAgentUid),
        data: { revokedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Admin: change an agent's projects or guardrails. */
export function updateAgentSettings(
  ctx: ActionContext,
  input: {
    agentUid: string;
    name: string;
    projectIds?: string[] | '*';
    guardrails?: Guardrails;
    /** The agent's scope (item fJnu6): an Inbox agent never gets projects. */
    scope?: AgentScope;
  },
): ActionPlan {
  requireHuman(ctx);
  if (
    input.scope === 'inbox' &&
    input.projectIds !== undefined &&
    (input.projectIds === '*' || input.projectIds.length > 0)
  )
    throw new ActionError('An Inbox agent has no projects');
  const data: Record<string, unknown> = {};
  if (input.projectIds !== undefined) data.projectIds = input.projectIds;
  if (input.guardrails !== undefined) data.guardrails = input.guardrails;
  if (!Object.keys(data).length) throw new ActionError('Nothing to change');
  return plan(
    ctx,
    'agent.updated',
    {},
    { agentUid: input.agentUid, name: input.name, changed: Object.keys(data) },
    (eventId) => [
      {
        kind: 'update',
        path: paths.agent(ctx.workspaceId, input.agentUid),
        data: { ...data, lastEventId: eventId },
      },
    ],
  );
}

/** Admin: resume an agent that paused itself (its failure streak starts again from 0). */
export function resumeAgent(
  ctx: ActionContext,
  input: { agentUid: string; name: string },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'agent.updated',
    {},
    { agentUid: input.agentUid, name: input.name, resumed: true },
    (eventId) => [
      {
        kind: 'update',
        path: paths.agent(ctx.workspaceId, input.agentUid),
        data: { pausedAt: null, pausedReason: null, failStreak: 0, lastEventId: eventId },
      },
    ],
  );
}

export function revokeAgent(ctx: ActionContext, input: { agentUid: string }): ActionPlan {
  requireHuman(ctx);
  return plan(ctx, 'agent.revoked', {}, { agentUid: input.agentUid }, (eventId) => [
    {
      kind: 'update',
      path: paths.agent(ctx.workspaceId, input.agentUid),
      data: { revokedAt: SERVER_TIME, lastEventId: eventId },
    },
  ]);
}

/** Admin: renames an agent. Old events keep the name they were written with. */
export function renameAgent(
  ctx: ActionContext,
  input: { agentUid: string; oldName: string; newName: string },
): ActionPlan {
  requireHuman(ctx);
  const newName = input.newName.trim();
  if (!newName) throw new ActionError('Give the agent a name');
  if (newName.length > 80) throw new ActionError('Keep the name to 80 characters');
  if (newName === input.oldName) throw new ActionError('That is already its name');
  return plan(
    ctx,
    'agent.renamed',
    {},
    { agentUid: input.agentUid, name: newName, oldName: input.oldName, newName },
    (eventId) => [
      {
        kind: 'update',
        path: paths.agent(ctx.workspaceId, input.agentUid),
        data: { name: newName, lastEventId: eventId },
      },
    ],
  );
}

/** Removes a revoked agent for good (admins only; the rules refuse a live agent). */
export function removeAgent(
  ctx: ActionContext,
  input: { agentUid: string; name: string },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'agent.removed',
    {},
    { agentUid: input.agentUid, name: input.name },
    () => [{ kind: 'delete', path: paths.agent(ctx.workspaceId, input.agentUid) }],
    paths.deleteEventId('agents', input.agentUid),
  );
}
