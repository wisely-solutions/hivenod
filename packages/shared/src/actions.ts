/**
 * Domain actions (SPEC §5.2): each builds ONE batched write = the domain change(s) + exactly one
 * event doc, as a plain plan. No Firebase import here: `applyPlan` in ./firestore.ts commits a
 * plan with the JS SDK. The web app and the agent CLI both use these, and the rules tests prove
 * every plan built here is accepted by firestore.rules.
 *
 * Callers pass the current state they already hold (project, item, run). Rules re-check all of
 * it server-side, so stale state can only lead to a denied write, never to a wrong one.
 */
import { normalizeStepAgents, streakAfter } from './agents';
import { gateSatisfied, rejectionsSuffice } from './gates';
import { nextOnPath, skips } from './itempath';
import { diffProcess } from './process';
import {
  isReservedStepId,
  buildStepIndex,
  MAX_ATTACHMENT_BYTES,
  MAX_LOG_LINES,
  MAX_PARK_REASON_CHARS,
  MIN_REASON_CHARS,
  paths,
  type ActorType,
  type Agent,
  type AttachmentKind,
  type AgentScope,
  type Guardrails,
  type EventType,
  type Item,
  type ItemType,
  type Park,
  type LogLevel,
  type MemberProfile,
  type Project,
  type Role,
  type Step,
  type StopMode,
  MAX_STOP_REASON_CHARS,
  SILENCE_AFTER_CHOICES,
  STATUS_EVERY_CHOICES,
  type SilenceAfter,
  type StatusEvery,
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
  kind: 'set' | 'update' | 'delete';
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

/** Item state an action needs; matches what a listener on the item doc returns. */
export type ItemState = Pick<
  Item,
  'title' | 'type' | 'stepId' | 'status' | 'claim' | 'gate' | 'sendBackCount' | 'costEur' | 'triage'
> &
  Partial<
    Pick<
      Item,
      | 'awaitingAnswer'
      | 'agentSendBacks'
      | 'workStopped'
      | 'shape'
      | 'pathSkips'
      | 'gateSkips'
      | 'pathRequests'
      | 'pathRefused'
      | 'pathRev'
      | 'parked'
      | 'statusUpdate'
      | 'statusAsk'
    >
  >;
export type ProjectState = Pick<Project, 'steps'>;

// ---------- internals ----------

/** @internal shared with ./pathActions */
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

/** @internal shared with ./pathActions */
export function requireHuman(ctx: ActionContext) {
  if (ctx.actor.type !== 'human') throw new ActionError('Only people can do this');
}
/** @internal shared with ./pathActions */
export function requireAgent(ctx: ActionContext) {
  if (ctx.actor.type !== 'agent') throw new ActionError('Only agents can do this');
}
/** @internal shared with ./pathActions */
export function requireReason(text: string) {
  if (text.trim().length < MIN_REASON_CHARS)
    throw new ActionError(`Say why in at least ${MIN_REASON_CHARS} characters`);
}

/** @internal shared with ./pathActions */
export function stepIndexOf(project: ProjectState, stepId: string): number {
  const i = project.steps.findIndex((s) => s.id === stepId);
  if (i < 0) throw new ActionError(`Unknown step ${stepId}`);
  return i;
}

/**
 * The fields that put an item at step `step` (fresh gate for human steps). `stepAt` is when it got
 * there (item QjTTL): claimable work is handed out oldest first by it.
 */
export function arrival(step: Step): Record<string, unknown> {
  return step.kind === 'human'
    ? {
        stepId: step.id,
        status: 'waiting',
        claim: null,
        gate: { stepId: step.id, approvals: {}, rejections: {} },
        stepAt: SERVER_TIME,
      }
    : { stepId: step.id, status: 'queued', claim: null, gate: null, stepAt: SERVER_TIME };
}
/**
 * Forward one step: to the next library step the item does not skip (card st5INNZj; items from
 * before paths skip nothing). Finishes after the last one.
 */
export function forward(
  project: ProjectState,
  item: Pick<ItemState, 'stepId' | 'pathSkips' | 'gateSkips'>,
): Record<string, unknown> {
  const next = nextOnPath(project, item);
  return next ? arrival(next) : { stepId: item.stepId, status: 'done', claim: null, gate: null };
}

/** Where an item lands when it is moved or sent back to `toStepId`: never a step it skips. */
export function landAt(
  project: ProjectState,
  item: Pick<ItemState, 'pathSkips' | 'gateSkips'>,
  toStepId: string,
): Record<string, unknown> {
  const to = project.steps[stepIndexOf(project, toStepId)]!;
  if (skips(item, to)) throw new ActionError(`${to.name} is not on this item's path`);
  return arrival(to);
}

/** The fields of a new item that waits to be shaped (card st5INNZj): nobody works on it yet. */
export function unshapedArrival(project: ProjectState): Record<string, unknown> {
  const first = project.steps[0];
  if (!first) throw new ActionError('This project has no steps');
  return {
    stepId: first.id,
    status: 'queued',
    claim: null,
    gate: null,
    shape: null,
    stepAt: SERVER_TIME,
  };
}

/**
 * People acting on an item (an approval that moves it, a send-back, a move, an answer that ends a
 * hold) reset its agent send-back rounds (card KLCTVnX8). Fields for the item update.
 */
export function resetRounds(item: Partial<Pick<Item, 'agentSendBacks'>>): Record<string, unknown> {
  return (item.agentSendBacks ?? 0) > 0 ? { agentSendBacks: 0 } : {};
}

/** @internal shared with ./pathActions */
export function ownClaim(ctx: ActionContext, item: ItemState) {
  if (!item.claim || item.claim.agentUid !== ctx.actor.id)
    throw new ActionError('You do not hold this item');
  return item.claim;
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
  input: AgentInput & { previousAgentUid: string; openRuns?: readonly OpenRun[] },
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
      ...closeRunsOps(ctx, input.openRuns ?? [], eventId),
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

/** A run of the revoked agent that is still open, and whether its item's claim is still that run. */
export interface OpenRun {
  runId: string;
  projectId: string;
  itemId: string;
  /** True when the item's claim still points at this run: the item goes back to the queue too. */
  holdsItem: boolean;
}

/** At most this many open runs are closed in the revoke batch (the rules' read budget). */
export const MAX_RUNS_CLOSED_ON_REVOKE = 5;

export const REVOKED_RUN_SUMMARY = 'Stopped: the agent was revoked.';

/** Ends the open runs of a revoked agent and gives their items back (same batch as the revoke). */
function closeRunsOps(ctx: ActionContext, runs: readonly OpenRun[], eventId: string): WriteOp[] {
  return runs.slice(0, MAX_RUNS_CLOSED_ON_REVOKE).flatMap((r) => [
    {
      kind: 'update' as const,
      path: paths.run(ctx.workspaceId, r.runId),
      data: {
        status: 'failed',
        endedAt: SERVER_TIME,
        summary: REVOKED_RUN_SUMMARY,
        lastEventId: eventId,
      },
    },
    ...(r.holdsItem
      ? [
          {
            kind: 'update' as const,
            path: paths.item(ctx.workspaceId, r.projectId, r.itemId),
            data: { claim: null, status: 'queued', updatedAt: SERVER_TIME, lastEventId: eventId },
          },
        ]
      : []),
  ]);
}

export function revokeAgent(
  ctx: ActionContext,
  input: { agentUid: string; openRuns?: readonly OpenRun[] },
): ActionPlan {
  requireHuman(ctx);
  return plan(ctx, 'agent.revoked', {}, { agentUid: input.agentUid }, (eventId) => [
    {
      kind: 'update',
      path: paths.agent(ctx.workspaceId, input.agentUid),
      data: { revokedAt: SERVER_TIME, lastEventId: eventId },
    },
    ...closeRunsOps(ctx, input.openRuns ?? [], eventId),
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

// ---------- projects ----------

export function createProject(
  ctx: ActionContext,
  input: {
    projectId?: string;
    name: string;
    emoji: string;
    color: string;
    templateId: string;
    steps: Step[];
    /** Who may see it besides admins. Defaults to the creator. */
    memberUids?: string[];
    /** Card st5INNZj: new items wait to be shaped. Default on for new projects. */
    shapeNewItems?: boolean;
  },
): ActionPlan & { projectId: string } {
  requireHuman(ctx);
  const projectId = input.projectId ?? nid(ctx);
  return {
    projectId,
    ...plan(ctx, 'project.created', { projectId }, { name: input.name }, (eventId) => [
      {
        kind: 'set',
        path: paths.project(ctx.workspaceId, projectId),
        data: {
          name: input.name,
          emoji: input.emoji,
          color: input.color,
          templateId: input.templateId,
          steps: input.steps,
          stepIndex: buildStepIndex(input.steps),
          memberUids: input.memberUids ?? [ctx.actor.id],
          shapeNewItems: input.shapeNewItems ?? true,
          createdBy: ctx.actor.id,
          createdAt: SERVER_TIME,
          archivedAt: null,
          lastEventId: eventId,
        },
      },
    ]),
  };
}

/** People who decide on some step but are not on the project yet (they get added on save). */
export function missingDeciders(memberUids: readonly string[], steps: readonly Step[]): string[] {
  const have = new Set(memberUids);
  const out = new Set<string>();
  for (const s of steps) for (const u of s.gate?.deciderUids ?? []) if (!have.has(u)) out.add(u);
  return [...out];
}

/**
 * The write ops that put new deciders on the project: the project's people grow in the same update
 * as the process, plus an own `project.membersChanged` event so the activity feed says so.
 */
export function addDecidersOps(
  ctx: ActionContext,
  projectId: string,
  memberUids: readonly string[],
  steps: readonly Step[],
): { data: { memberUids: string[] } | Record<string, never>; ops: WriteOp[] } {
  const added = missingDeciders(memberUids, steps);
  if (!added.length) return { data: {}, ops: [] };
  const ev = plan(
    ctx,
    'project.membersChanged',
    { projectId },
    { added, reason: 'decider' },
    () => [],
  );
  return { data: { memberUids: [...memberUids, ...added] }, ops: ev.ops };
}

/** Items moved off removed steps in one save. Rules allow 20 document lookups per batch. */
export const MAX_MOVES_PER_SAVE = 10;

export interface ItemMove {
  itemId: string;
  toStepId: string;
}

/**
 * Saves a project's process. `before` (the steps as loaded) lets the event carry a diff. `moves`
 * relocate open items off steps this save removes: each is its own `item.moved` event, in the same
 * batch, so nothing is ever left on a step that no longer exists.
 */
export function saveProcess(
  ctx: ActionContext,
  input: {
    projectId: string;
    steps: Step[];
    before?: readonly Step[];
    moves?: ItemMove[];
    /** The project's people now: new deciders are added to them. */
    memberUids?: readonly string[];
    /**
     * Per-step allowed agents to store (card zSzW3LXy). Pass the project's current map when it is
     * unchanged: limits of removed steps are dropped. Left out, the stored map is not touched.
     */
    stepAgents?: Readonly<Record<string, readonly string[]>>;
  },
): ActionPlan {
  requireHuman(ctx);
  for (const s of input.steps)
    if (isReservedStepId(s.id)) throw new ActionError(`"${s.id}" is a reserved step id`);
  const moves = input.moves ?? [];
  if (moves.length > MAX_MOVES_PER_SAVE)
    throw new ActionError(`Move at most ${MAX_MOVES_PER_SAVE} items in one save`);
  const diff = input.before ? diffProcess(input.before, input.steps) : undefined;
  const added = addDecidersOps(ctx, input.projectId, input.memberUids ?? [], input.steps);
  const main = plan(
    ctx,
    'project.processChanged',
    { projectId: input.projectId },
    { stepIds: input.steps.map((s) => s.id), ...(diff ? { diff } : {}) },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: {
          steps: input.steps,
          stepIndex: buildStepIndex(input.steps),
          ...(input.stepAgents
            ? { stepAgents: normalizeStepAgents(input.steps, input.stepAgents) }
            : {}),
          ...(input.memberUids ? added.data : {}),
          lastEventId: eventId,
        },
      },
      ...(input.memberUids ? added.ops : []),
    ],
  );
  const moved = moves.map((m) => {
    const to = input.steps.find((s) => s.id === m.toStepId);
    if (!to) throw new ActionError(`Unknown step ${m.toStepId}`);
    return plan(
      ctx,
      'item.moved',
      { projectId: input.projectId, itemId: m.itemId },
      { toStepId: m.toStepId, reason: 'step removed' },
      (eventId) => [
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, m.itemId),
          data: {
            ...arrival(to),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
      ],
    );
  });
  return { eventId: main.eventId, ops: [...main.ops, ...moved.flatMap((m) => m.ops)] };
}

/**
 * Sets which agents may do a project's agent steps (admins and the project's creator), without
 * touching the steps. Used when an agent's token is rotated (the new identity takes its place).
 */
export function setStepAgents(
  ctx: ActionContext,
  input: {
    projectId: string;
    steps: readonly { id: string; kind: string }[];
    stepAgents: Readonly<Record<string, readonly string[]>>;
  },
): ActionPlan {
  requireHuman(ctx);
  const stepAgents = normalizeStepAgents(input.steps, input.stepAgents);
  return plan(ctx, 'project.updated', { projectId: input.projectId }, { stepAgents }, (eventId) => [
    {
      kind: 'update',
      path: paths.project(ctx.workspaceId, input.projectId),
      data: { stepAgents, lastEventId: eventId },
    },
  ]);
}

/** Admins choose who can see a project. Members only see projects they are listed on. */
export function setProjectMembers(
  ctx: ActionContext,
  input: { projectId: string; memberUids: string[]; name: string },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'project.membersChanged',
    { projectId: input.projectId },
    { name: input.name, memberUids: input.memberUids },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { memberUids: input.memberUids, lastEventId: eventId },
      },
    ],
  );
}

/** Admins and the project's creator: whether new items wait to be shaped (card st5INNZj). */
export function setShapeNewItems(
  ctx: ActionContext,
  input: { projectId: string; on: boolean },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { shapeNewItems: input.on },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { shapeNewItems: input.on, lastEventId: eventId },
      },
    ],
  );
}

/**
 * Admins and the project's creator: whether agents may create items in this project (item DhsO9).
 * Off by default; the rules enforce who may switch it and that agents create only while it is on.
 */
export function setAgentsMayCreateItems(
  ctx: ActionContext,
  input: { projectId: string; on: boolean },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { agentsMayCreateItems: input.on },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { agentsMayCreateItems: input.on, lastEventId: eventId },
      },
    ],
  );
}

/** Whether agents may create items in the project (absent = off). */
export function agentsMayCreateItems(project: { agentsMayCreateItems?: boolean }): boolean {
  return project.agentsMayCreateItems === true;
}

export const AGENT_CREATE_OFF_MESSAGE =
  'This project does not let agents create items. An admin or the project creator can switch on "Agents may create items" in Settings, Projects.';

/** Hides a project from lists and the board. Undo with `restoreProject`. */
export function archiveProject(ctx: ActionContext, input: { projectId: string; name: string }) {
  requireHuman(ctx);
  return plan(
    ctx,
    'project.archived',
    { projectId: input.projectId },
    { name: input.name },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { archivedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Edits a project's name, emoji and description (Settings > Projects). */
export function updateProject(
  ctx: ActionContext,
  input: {
    projectId: string;
    name: string;
    emoji: string;
    description: string;
    /** Item DhsO9: only when it changes (admins and the project's creator). */
    agentsMayCreateItems?: boolean;
    /** Item AzveC: only when it changes (admins and the project's creator). */
    statusEvery?: StatusEvery;
    /** Item AzveC: only when it changes (admins and the project's creator). */
    silenceAfter?: SilenceAfter;
  },
) {
  requireHuman(ctx);
  if (input.statusEvery !== undefined && !STATUS_EVERY_CHOICES.includes(input.statusEvery))
    throw new ActionError('Ask for a status every 15, 30 or 60 minutes, or never');
  if (input.silenceAfter !== undefined && !SILENCE_AFTER_CHOICES.includes(input.silenceAfter))
    throw new ActionError('Flag silence after 20, 40, 60 or 120 minutes, or never');
  const setting = {
    ...(input.agentsMayCreateItems === undefined
      ? {}
      : { agentsMayCreateItems: input.agentsMayCreateItems }),
    ...(input.statusEvery === undefined ? {} : { statusEvery: input.statusEvery }),
    ...(input.silenceAfter === undefined ? {} : { silenceAfter: input.silenceAfter }),
  };
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { name: input.name, ...setting },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: {
          name: input.name,
          emoji: input.emoji,
          description: input.description,
          ...setting,
          lastEventId: eventId,
        },
      },
    ],
  );
}

export function restoreProject(ctx: ActionContext, input: { projectId: string; name: string }) {
  requireHuman(ctx);
  return plan(
    ctx,
    'project.updated',
    { projectId: input.projectId },
    { name: input.name, restored: true },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: { archivedAt: null, lastEventId: eventId },
      },
    ],
  );
}

// ---------- items ----------

/**
 * A new item at the project's first step: a person's quick-add, or an agent's create_item (item
 * DhsO9), which the project must allow (agentsMayCreateItems). Either way it is ordinary work;
 * createdBy and the item.created event name the actor.
 */
export function createItem(
  ctx: ActionContext,
  input: {
    project: ProjectState & { agentsMayCreateItems?: boolean };
    projectId: string;
    itemId?: string;
    title: string;
    type: Exclude<ItemType, 'finding'>;
    summary?: string;
    source?: { kind: string; label: string };
    order?: number;
    parentItemId?: string | null;
    /** Card st5INNZj: the item waits to be shaped (an agent, or a person, sets its path). */
    unshaped?: boolean;
  },
): ActionPlan & { itemId: string } {
  const byAgent = ctx.actor.type === 'agent';
  if (byAgent && !agentsMayCreateItems(input.project))
    throw new ActionError(AGENT_CREATE_OFF_MESSAGE);
  const itemId = input.itemId ?? nid(ctx);
  const first = input.project.steps[0];
  if (!first) throw new ActionError('This project has no steps');
  return {
    itemId,
    ...plan(
      ctx,
      'item.created',
      { projectId: input.projectId, itemId },
      { title: input.title },
      (eventId) => [
        {
          kind: 'set',
          path: paths.item(ctx.workspaceId, input.projectId, itemId),
          data: {
            title: input.title,
            type: input.type,
            summary: input.summary ?? '',
            source: input.source ?? {
              kind: byAgent ? 'agent' : 'manual',
              label: ctx.actor.name.slice(0, 200),
            },
            createdBy: { type: ctx.actor.type, id: ctx.actor.id },
            parentItemId: input.parentItemId ?? null,
            sourceRunId: null,
            progress: null,
            triage: null,
            sendBackCount: 0,
            attachmentCount: 0,
            costEur: 0,
            order: input.order ?? Date.now(),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
            ...(input.unshaped ? unshapedArrival(input.project) : arrival(first)),
          },
        },
      ],
    ),
  };
}

/**
 * Undo of a just-made item (the toast's Undo after quick capture): deletes the item and the files
 * attached to it in the same batch. The rules allow it only for its creator, within two minutes,
 * while nobody has claimed or decided it.
 */
export function undoCreateItem(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; title: string; attachmentIds?: string[] },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'item.deleted',
    { projectId: input.projectId, itemId: input.itemId },
    { title: input.title },
    () => [
      ...(input.attachmentIds ?? []).map((a): WriteOp => ({
        kind: 'delete',
        path: paths.attachment(ctx.workspaceId, input.projectId, input.itemId, a),
      })),
      { kind: 'delete', path: paths.item(ctx.workspaceId, input.projectId, input.itemId) },
    ],
    paths.deleteEventId('items', input.itemId),
  );
}

/**
 * Human: delete an item and its history for good ("Delete…" in an item menu), in two plans around
 * a chunked erase the caller runs in between (a single batch cannot hold a long history: runs keep
 * up to 500 log lines each).
 *
 *  1. `beginItemErase` flags the item (`erasing`, stopped like an archive). From then on the rules
 *     let its creator or an admin delete its log lines, runs, messages and files in any number of
 *     batches. Interrupted, the flag stays and the same erase resumes ("Continue").
 *  2. `finishItemErase` deletes the item itself, with the tombstone event: the Activity keeps one
 *     line "deleted '<title>'" (`data.forever`).
 *
 * Only the item's creator or an organization admin (the rules enforce it), and not while an agent
 * holds it: Stop work first.
 */
export function beginItemErase(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState },
): ActionPlan {
  requireHuman(ctx);
  if (input.item.claim) throw new ActionError('An agent is working on this item. Stop work first.');
  return plan(
    ctx,
    'item.erasing',
    { projectId: input.projectId, itemId: input.itemId },
    { title: input.item.title },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          erasing: true,
          status: 'stopped',
          claim: null,
          gate: null,
          archivedAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/** Last step of the delete: the (by now empty) item goes, leaving the "deleted" line. */
export function finishItemErase(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; title: string },
): ActionPlan {
  requireHuman(ctx);
  const { projectId, itemId } = input;
  return plan(
    ctx,
    'item.deleted',
    { projectId, itemId },
    { title: input.title, forever: true },
    () => [{ kind: 'delete', path: paths.item(ctx.workspaceId, projectId, itemId) }],
    paths.deleteEventId('items', itemId),
  );
}

export function updateItem(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    changes: Partial<{ title: string; summary: string; type: ItemType; order: number }>;
    /** What the title and type were, so the history can say "from X to Y" (card mpWuccjl). */
    before?: Partial<{ title: string; type: ItemType }>;
  },
): ActionPlan {
  requireHuman(ctx);
  const c = input.changes;
  const b = input.before ?? {};
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId },
    {
      fields: Object.keys(c),
      ...(c.title !== undefined ? { title: { from: b.title ?? null, to: c.title } } : {}),
      ...(c.type !== undefined ? { type: { from: b.type ?? null, to: c.type } } : {}),
      // The text itself is on the item; the history only needs to know it changed.
      ...(c.summary !== undefined ? { summaryLength: c.summary.length } : {}),
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { ...input.changes, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/**
 * Human: move an open item to another step (card O2Ehb9CG, bulk "Move to step"). It arrives the
 * way a new item does (a fresh gate at a human step). Rules: anyone on the project may send an
 * item back to an earlier step; only an admin may jump forward over gates. Items an agent holds
 * cannot be moved.
 */
export function moveItem(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    toStepId: string;
  },
): ActionPlan {
  requireHuman(ctx);
  const from = input.item.stepId;
  if (input.item.claim) throw new ActionError('An agent is working on this item');
  if (input.item.status !== 'queued' && input.item.status !== 'waiting')
    throw new ActionError('Only open items can be moved');
  if (from === input.toStepId) throw new ActionError('The item is already at that step');
  const to = input.project.steps[stepIndexOf(input.project, input.toStepId)]!;
  const land = landAt(input.project, input.item, to.id);
  return plan(
    ctx,
    'item.moved',
    { projectId: input.projectId, itemId: input.itemId },
    { fromStepId: from, toStepId: to.id },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { ...land, ...resetRounds(input.item), updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/**
 * Human: archive an open item (card O2Ehb9CG): it stops without a decision and leaves the board.
 * Restore (the Undo) puts it back at the same step with a fresh gate.
 */
export function archiveItem(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState },
): ActionPlan {
  requireHuman(ctx);
  if (input.item.claim) throw new ActionError('An agent is working on this item');
  if (input.item.status !== 'queued' && input.item.status !== 'waiting')
    throw new ActionError('Only open items can be archived');
  return plan(
    ctx,
    'item.archived',
    { projectId: input.projectId, itemId: input.itemId },
    { stepId: input.item.stepId },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          status: 'stopped',
          claim: null,
          gate: null,
          archivedAt: SERVER_TIME,
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/** Human: undo Archive. The item is back at its step, as if it had just arrived. */
export function restoreItem(
  ctx: ActionContext,
  input: { project: ProjectState; projectId: string; itemId: string; stepId: string },
): ActionPlan {
  requireHuman(ctx);
  const step = input.project.steps[stepIndexOf(input.project, input.stepId)]!;
  return plan(
    ctx,
    'item.restored',
    { projectId: input.projectId, itemId: input.itemId },
    { stepId: step.id },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { ...arrival(step), archivedAt: null, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Agent: claim an item at an agent step (unclaimed, or stale > 10 min). Starts a run. */
export function claimItem(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: ItemState;
    runId?: string;
    /** The stale claim's run, still open: it ends as released in the same batch. */
    takeover?: { runId: string };
    /** 'shape': a shaping run on an unshaped item (card st5INNZj). */
    job?: 'shape';
  },
): ActionPlan & { runId: string } {
  requireAgent(ctx);
  const runId = input.runId ?? nid(ctx);
  const { workspaceId: w, actor } = ctx;
  return {
    runId,
    ...plan(
      ctx,
      'item.claimed',
      { projectId: input.projectId, itemId: input.itemId, runId },
      {
        stepId: input.item.stepId,
        takeover: input.item.claim?.agentUid ?? null,
        ...(input.job ? { job: input.job } : {}),
      },
      (eventId) => [
        {
          kind: 'set',
          path: paths.run(w, runId),
          data: {
            agentUid: actor.id,
            projectId: input.projectId,
            itemId: input.itemId,
            stepId: input.item.stepId,
            startedAt: SERVER_TIME,
            heartbeatAt: SERVER_TIME,
            heartbeatEventAt: SERVER_TIME,
            endedAt: null,
            status: 'running',
            costEur: 0,
            tokensIn: 0,
            tokensOut: 0,
            model: null,
            summary: null,
            ...(input.job ? { job: input.job } : {}),
            lastEventId: eventId,
          },
        },
        {
          kind: 'update',
          path: paths.item(w, input.projectId, input.itemId),
          data: {
            claim: { runId, agentUid: actor.id, heartbeatAt: SERVER_TIME },
            status: 'working',
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
        ...(input.takeover && input.takeover.runId !== runId
          ? [
              {
                kind: 'update' as const,
                path: paths.run(w, input.takeover.runId),
                data: {
                  status: 'released',
                  endedAt: SERVER_TIME,
                  summary: `Taken over by ${actor.name}: no heartbeat for 10 minutes.`.slice(
                    0,
                    4000,
                  ),
                  lastEventId: eventId,
                },
              },
            ]
          : []),
      ],
    ),
  };
}

/** How long after the last run.heartbeat event the client writes a new one (rules allow 5–6 min). */
export const HEARTBEAT_EVENT_AFTER_MS = 5.5 * 60 * 1000;

/**
 * Agent: heartbeat. Returns a plan with an event when one is due (coalesced, SPEC §5.3), or
 * `{eventId: null}` with plain updates otherwise.
 */
export function heartbeat(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    runId: string;
    lastHeartbeatEventAtMs: number;
    nowMs?: number;
    /** Running totals for this run so far (card zSzW3LXy); they only ever grow. */
    usage?: RunUsage;
  },
): { eventId: string | null; ops: WriteOp[] } {
  requireAgent(ctx);
  const { workspaceId: w } = ctx;
  const usage = input.usage ? usageFields(input.usage) : {};
  const itemOp: WriteOp = {
    kind: 'update',
    path: paths.item(w, input.projectId, input.itemId),
    data: { 'claim.heartbeatAt': SERVER_TIME },
  };
  const due =
    (input.nowMs ?? Date.now()) - input.lastHeartbeatEventAtMs >= HEARTBEAT_EVENT_AFTER_MS;
  if (!due) {
    return {
      eventId: null,
      ops: [
        {
          kind: 'update',
          path: paths.run(w, input.runId),
          data: { heartbeatAt: SERVER_TIME, ...usage },
        },
        itemOp,
      ],
    };
  }
  return plan(
    ctx,
    'run.heartbeat',
    { projectId: input.projectId, itemId: input.itemId, runId: input.runId },
    {},
    (eventId) => [
      {
        kind: 'update',
        path: paths.run(w, input.runId),
        data: {
          heartbeatAt: SERVER_TIME,
          heartbeatEventAt: SERVER_TIME,
          ...usage,
          lastEventId: eventId,
        },
      },
      itemOp,
    ],
  );
}

/** Agent: append one log line (no event; log lines are themselves the record). */
export function logLine(
  ctx: ActionContext,
  input: { runId: string; n: number; level: LogLevel; text: string },
): WriteOp {
  requireAgent(ctx);
  if (!Number.isInteger(input.n) || input.n < 0 || input.n >= MAX_LOG_LINES)
    throw new ActionError(`A run keeps at most ${MAX_LOG_LINES} log lines`);
  return {
    kind: 'set',
    path: paths.logLine(ctx.workspaceId, input.runId, input.n),
    data: { at: SERVER_TIME, level: input.level, text: input.text.slice(0, 4000) },
  };
}

export interface RunUsage {
  tokensIn: number;
  tokensOut: number;
  /** Part of tokensIn read from the prompt cache. */
  tokensCached?: number;
  model?: string | null;
  /** Cost so far in EUR (agent-reported, only grows), so a live run shows its cost. */
  costEur?: number;
}
function usageFields(u: RunUsage): Record<string, unknown> {
  const whole = (n: number | undefined) => Math.max(0, Math.round(n ?? 0));
  const tokensIn = whole(u.tokensIn);
  return {
    tokensIn,
    tokensOut: whole(u.tokensOut),
    ...(u.tokensCached !== undefined
      ? { tokensCached: Math.min(whole(u.tokensCached), tokensIn) }
      : {}),
    ...(u.model !== undefined ? { model: u.model ? u.model.slice(0, 80) : null } : {}),
    ...(u.costEur !== undefined && Number.isFinite(u.costEur)
      ? { costEur: Math.max(0, u.costEur) }
      : {}),
  };
}

export interface RunResult {
  status: 'done' | 'failed' | 'released';
  costEur?: number;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  model?: string | null;
  summary?: string | null;
}
/** @internal shared with ./pathActions */
export function runEnd(result: RunResult, eventId: string): Record<string, unknown> {
  const tokensIn = result.tokensIn ?? 0;
  return {
    status: result.status,
    endedAt: SERVER_TIME,
    heartbeatAt: SERVER_TIME,
    costEur: result.costEur ?? 0,
    tokensIn,
    tokensOut: result.tokensOut ?? 0,
    ...(result.tokensCached !== undefined
      ? { tokensCached: Math.min(result.tokensCached, tokensIn) }
      : {}),
    model: result.model ?? null,
    summary: result.summary ?? null,
    lastEventId: eventId,
  };
}

/** The agent state a run's end needs to keep the failure streak (card zSzW3LXy). */
export type AgentGuardState = Pick<Agent, 'guardrails' | 'failStreak' | 'pausedAt'>;

/**
 * The agent's own failure streak, written in the batch that ends its run (the rules check it
 * against that run). A failed run that reaches the limit pauses the agent.
 */
/** @internal shared with ./pathActions */
export function streakOps(
  ctx: ActionContext,
  agent: AgentGuardState | undefined,
  status: RunResult['status'],
  eventId: string,
): WriteOp[] {
  const next = agent ? streakAfter(agent, status) : null;
  if (!next) return [];
  return [
    {
      kind: 'update',
      path: paths.agent(ctx.workspaceId, ctx.actor.id),
      data: {
        failStreak: next.failStreak,
        ...(next.pause
          ? {
              pausedAt: SERVER_TIME,
              pausedReason: `${next.failStreak} failed runs in a row`,
            }
          : {}),
        lastEventId: eventId,
      },
    },
  ];
}
/** Event data that says the agent paused itself, when this end pauses it. */
function pauseData(agent: AgentGuardState | undefined, status: RunResult['status']) {
  const next = agent ? streakAfter(agent, status) : null;
  return next?.pause ? { agentPaused: true, failStreak: next.failStreak } : {};
}

/** Agent: give the item back (claim cleared, run ends as released). */
export function releaseClaim(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: ItemState;
    result?: Omit<RunResult, 'status'>;
    /** 'failed' when the CLI failed or was stopped (time limit). Default 'released'. */
    status?: 'released' | 'failed';
    agent?: AgentGuardState;
    /**
     * A question this agent just asked on the item (unanswered): the item is held until people
     * answer it, so no agent can claim it meanwhile (item.awaitingAnswer, checked by the rules).
     */
    holdFor?: string;
    /** The run already ended (run end without complete): only the item's claim is cleared. */
    runEnded?: boolean;
  },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const status = input.status ?? 'released';
  return plan(
    ctx,
    'item.released',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    {
      ...(status === 'failed' ? { runStatus: 'failed' } : {}),
      ...pauseData(input.agent, status),
      ...(input.holdFor ? { awaitingAnswer: input.holdFor } : {}),
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          claim: null,
          status: 'queued',
          ...(input.holdFor
            ? {
                awaitingAnswer: {
                  questionId: input.holdFor,
                  agentUid: ctx.actor.id,
                  at: SERVER_TIME,
                },
              }
            : {}),
          // The run's cost counts on the item even when it ended without completing the step
          // (a question, a failure), so the item list's Cost column is not short (card JJ6fYb3b).
          costEur: input.item.costEur + (input.runEnded ? 0 : (input.result?.costEur ?? 0)),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...(input.runEnded
        ? []
        : [
            {
              kind: 'update' as const,
              path: paths.run(ctx.workspaceId, claim.runId),
              data: runEnd({ ...input.result, status }, eventId),
            },
            ...streakOps(ctx, input.agent, status, eventId),
          ]),
    ],
  );
}

/**
 * Admin: release a stalled claim (no heartbeat for 10 minutes). The item goes back to the queue,
 * the run ends as released, and an `item.released` event records who did it and why.
 */
export function releaseStale(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    runId: string;
    agentUid: string;
    /** False when the item is no longer held by this run (only the orphaned run is ended). */
    clearItem?: boolean;
  },
): ActionPlan {
  requireHuman(ctx);
  return plan(
    ctx,
    'item.released',
    { projectId: input.projectId, itemId: input.itemId, runId: input.runId },
    { stalled: true, agentUid: input.agentUid },
    (eventId) => [
      ...(input.clearItem === false
        ? []
        : [
            {
              kind: 'update' as const,
              path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
              data: { claim: null, status: 'queued', updatedAt: SERVER_TIME, lastEventId: eventId },
            },
          ]),
      {
        kind: 'update',
        path: paths.run(ctx.workspaceId, input.runId),
        data: { status: 'released', endedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Agent: report progress and/or cost on the item it holds. */
export function reportProgress(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: ItemState;
    progress?: { done: number; total: number } | null;
    costEur?: number;
  },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const data: Record<string, unknown> = {};
  if (input.progress !== undefined) data.progress = input.progress;
  if (input.costEur !== undefined) data.costEur = input.costEur;
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    data,
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { ...data, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** The park in force on an item (item QjTTL): only while the claim it was made under holds. */
export function parkOf(item: Pick<ItemState, 'claim' | 'parked'>): Park | null {
  const p = item.parked;
  return p && item.claim && item.claim.runId === p.runId ? p : null;
}

/**
 * Agent: park the item it holds (item QjTTL), waiting on something outside it, with a reason. It
 * stays claimed but the session's max_items no longer counts it. Any tool call on it, or a
 * person's note, answer or Stop, wakes it (unparkItem).
 */
export function parkItem(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState; reason: string },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const reason = input.reason.trim();
  if (!reason) throw new ActionError('Say what the item waits for');
  if (reason.length > MAX_PARK_REASON_CHARS)
    throw new ActionError(`Keep the reason under ${MAX_PARK_REASON_CHARS} characters`);
  const parked = { runId: claim.runId, reason, at: SERVER_TIME };
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    { parked: { reason } },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { parked, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Agent: the parked item it holds is active again (item QjTTL). */
export function unparkItem(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    { parked: null },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { parked: null, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/** Agent: finish its step. The item moves exactly one step forward and the run ends as done. */
export function completeStep(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    result?: Omit<RunResult, 'status'>;
    agent?: AgentGuardState;
  },
): ActionPlan {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const step = input.project.steps[stepIndexOf(input.project, input.item.stepId)];
  if (step?.kind !== 'agent') throw new ActionError('Agents only complete agent steps');
  const to = forward(input.project, input.item);
  const costEur = input.item.costEur + (input.result?.costEur ?? 0);
  return plan(
    ctx,
    'item.completed',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    { fromStepId: input.item.stepId, toStepId: to.stepId, status: to.status },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { ...to, progress: null, costEur, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
      {
        kind: 'update',
        path: paths.run(ctx.workspaceId, claim.runId),
        data: runEnd({ ...input.result, status: 'done' }, eventId),
      },
      ...streakOps(ctx, input.agent, 'done', eventId),
    ],
  );
}

/** Agent: end a run without completing (e.g. failed). The claim stays until released or stale. */
export function endRun(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    runId: string;
    result: RunResult;
    agent?: AgentGuardState;
  },
): ActionPlan {
  requireAgent(ctx);
  return plan(
    ctx,
    'run.ended',
    { projectId: input.projectId, itemId: input.itemId, runId: input.runId },
    { status: input.result.status, ...pauseData(input.agent, input.result.status) },
    (eventId) => [
      {
        kind: 'update',
        path: paths.run(ctx.workspaceId, input.runId),
        data: runEnd(input.result, eventId),
      },
      ...streakOps(ctx, input.agent, input.result.status, eventId),
    ],
  );
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function attach(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    attachmentId?: string;
    kind: AttachmentKind;
    name: string;
    content?: string;
    url?: string;
    runId?: string | null;
  },
): ActionPlan & { attachmentId: string } {
  const attachmentId = input.attachmentId ?? nid(ctx);
  const isLink = input.kind === 'link';
  if (isLink && !input.url) throw new ActionError('A link needs a URL');
  if (!isLink && input.content === undefined) throw new ActionError('Attachment content missing');
  const bytes = isLink ? 0 : utf8Bytes(input.content ?? '');
  if (bytes > MAX_ATTACHMENT_BYTES)
    throw new ActionError('Attachments over 900 KB must be attached as a link');
  return {
    attachmentId,
    ...plan(
      ctx,
      'attachment.added',
      { projectId: input.projectId, itemId: input.itemId, runId: input.runId ?? null },
      { attachmentId, name: input.name, kind: input.kind },
      (eventId) => [
        {
          kind: 'set',
          path: paths.attachment(ctx.workspaceId, input.projectId, input.itemId, attachmentId),
          data: {
            kind: input.kind,
            name: input.name,
            content: isLink ? null : input.content,
            url: isLink ? input.url : null,
            bytes,
            runId: ctx.actor.type === 'agent' ? (input.runId ?? null) : null,
            by: { type: ctx.actor.type, id: ctx.actor.id },
            at: SERVER_TIME,
            lastEventId: eventId,
          },
        },
        // The board card shows how many attachments the item has (card 05PEkpwG).
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
          data: { attachmentCount: increment(1), lastEventId: eventId },
        },
      ],
    ),
  };
}

/** @internal shared with ./pathActions */
export function messageDoc(
  ctx: ActionContext,
  projectId: string,
  itemId: string,
  kind: 'question' | 'answer' | 'note',
  text: string,
  replyTo: string | null,
  eventId: string,
) {
  return {
    workspaceId: ctx.workspaceId,
    projectId,
    itemId,
    by: { type: ctx.actor.type, id: ctx.actor.id },
    kind,
    text,
    at: SERVER_TIME,
    answered: false,
    replyTo,
    lastEventId: eventId,
  };
}

/** A question (agents) or a note (anyone). Answers go through `answer`. */
export function postMessage(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    kind: 'question' | 'note';
    text: string;
    messageId?: string;
    runId?: string | null;
  },
): ActionPlan & { messageId: string } {
  if (input.kind === 'question') requireAgent(ctx);
  const messageId = input.messageId ?? nid(ctx);
  return {
    messageId,
    ...plan(
      ctx,
      'message.posted',
      { projectId: input.projectId, itemId: input.itemId, runId: input.runId ?? null },
      { messageId, kind: input.kind },
      (eventId) => [
        {
          kind: 'set',
          path: paths.message(ctx.workspaceId, input.projectId, input.itemId, messageId),
          data: messageDoc(
            ctx,
            input.projectId,
            input.itemId,
            input.kind,
            input.text,
            null,
            eventId,
          ),
        },
      ],
    ),
  };
}

/** Human answers an agent question: answer message + question marked answered + decision. */
export function answer(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: Pick<ItemState, 'title' | 'stepId' | 'awaitingAnswer' | 'agentSendBacks'>;
    questionId: string;
    text: string;
  },
): ActionPlan {
  requireHuman(ctx);
  const { workspaceId: w } = ctx;
  // Answering the question an item is held for lets agents take it again.
  const unhold = input.item.awaitingAnswer?.questionId === input.questionId;
  return plan(
    ctx,
    'decision.answered',
    { projectId: input.projectId, itemId: input.itemId },
    { questionId: input.questionId },
    (eventId) => [
      {
        kind: 'set',
        path: paths.message(w, input.projectId, input.itemId, eventId),
        data: messageDoc(
          ctx,
          input.projectId,
          input.itemId,
          'answer',
          input.text,
          input.questionId,
          eventId,
        ),
      },
      {
        kind: 'update',
        path: paths.message(w, input.projectId, input.itemId, input.questionId),
        data: { answered: true, lastEventId: eventId },
      },
      decisionOp(
        ctx,
        input.projectId,
        input.itemId,
        input.item,
        'answered',
        null,
        input.text.slice(0, 4000),
        [],
        eventId,
      ),
      ...(unhold
        ? [
            {
              kind: 'update' as const,
              path: paths.item(w, input.projectId, input.itemId),
              data: { awaitingAnswer: null, ...resetRounds(input.item), lastEventId: eventId },
            },
          ]
        : []),
    ],
  );
}

/**
 * Admin: let agents take an item that is held for an answer (item.awaitingAnswer) without
 * answering the question. The question stays open in "Needs you".
 */
export function clearHold(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: Pick<ItemState, 'awaitingAnswer'> },
): ActionPlan {
  requireHuman(ctx);
  const hold = input.item.awaitingAnswer;
  if (!hold) throw new ActionError('This item is not waiting for an answer');
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId },
    { holdCleared: hold.questionId },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { awaitingAnswer: null, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

/**
 * Human: stop the agent working on an item (card BrK0r2FE). The claim is cleared and the run ends
 * as `stopped` by this person (not a failure: the agent's failure streak is untouched), in one
 * batch, so it works while the agent's CLI is offline; a running `hivenod run` sees its run end and
 * stops the coding CLI within seconds.
 * - `back`: the item stays at its step on hold (`workStopped`) until someone presses Resume; the
 *   reason is also left as a note so the next agent reads it.
 * - `cancel`: the item is stopped for good, like a stop at a gate.
 * Only admins and the deciders of a gate of the project (`stopGateFor`, mirrored by the rules).
 */
export function stopWork(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    mode: StopMode;
    reason?: string;
    /** The gate that lets a non-admin stop work (`stopGateFor`); '' or omitted for admins. */
    gateStepId?: string | null;
    /** The claimed run as last read: its cost counts on the item; an ended run is left alone. */
    run?: { costEur: number; endedAt: unknown } | null;
  },
): ActionPlan {
  requireHuman(ctx);
  const claim = input.item.claim;
  const step = input.project.steps[stepIndexOf(input.project, input.item.stepId)];
  // A shaping run (card st5INNZj) may sit at a first step that is a people step.
  if (!claim || (step?.kind !== 'agent' && input.item.shape !== null))
    throw new ActionError('No agent is working on this item right now');
  const reason = (input.reason ?? '').trim();
  if (reason.length > MAX_STOP_REASON_CHARS)
    throw new ActionError(`Keep the reason under ${MAX_STOP_REASON_CHARS} characters`);
  const runOpen = !input.run?.endedAt;
  const who = ctx.actor.name || 'someone';
  const summary =
    (input.mode === 'back'
      ? `Stopped by ${who} in Hivenod: the item went back on hold.`
      : `Stopped by ${who} in Hivenod: the item was cancelled.`) +
    (reason ? ` Reason: ${reason}` : '');
  return plan(
    ctx,
    'item.workStopped',
    { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
    {
      mode: input.mode,
      reason,
      agentUid: claim.agentUid,
      stepId: input.item.stepId,
      ...(input.gateStepId ? { gateStepId: input.gateStepId } : {}),
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          claim: null,
          status: input.mode === 'back' ? 'queued' : 'stopped',
          workStopped: {
            mode: input.mode,
            byUid: ctx.actor.id,
            at: SERVER_TIME,
            reason,
            runId: claim.runId,
          },
          costEur: input.item.costEur + (runOpen ? (input.run?.costEur ?? 0) : 0),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...(runOpen
        ? [
            {
              kind: 'update' as const,
              path: paths.run(ctx.workspaceId, claim.runId),
              data: {
                status: 'stopped',
                endedAt: SERVER_TIME,
                stoppedBy: { uid: ctx.actor.id, name: ctx.actor.name.slice(0, 200) },
                summary: summary.slice(0, 4000),
                lastEventId: eventId,
              },
            },
          ]
        : []),
      ...(input.mode === 'back' && reason
        ? [
            {
              kind: 'set' as const,
              path: paths.message(
                ctx.workspaceId,
                input.projectId,
                input.itemId,
                `${eventId}-note`,
              ),
              data: messageDoc(
                ctx,
                input.projectId,
                input.itemId,
                'note',
                `Work stopped: ${reason}`,
                null,
                eventId,
              ),
            },
          ]
        : []),
    ],
  );
}

/** Human: let agents take an item that was put on hold by Stop work, Go back (card BrK0r2FE). */
export function resumeWork(
  ctx: ActionContext,
  input: {
    projectId: string;
    itemId: string;
    item: Pick<ItemState, 'workStopped' | 'status'>;
    /** As for `stopWork`: the gate that lets a non-admin do it. */
    gateStepId?: string | null;
  },
): ActionPlan {
  requireHuman(ctx);
  if (input.item.workStopped?.mode !== 'back' || input.item.status === 'stopped')
    throw new ActionError('This item is not on hold');
  return plan(
    ctx,
    'item.resumed',
    { projectId: input.projectId, itemId: input.itemId },
    { ...(input.gateStepId ? { gateStepId: input.gateStepId } : {}) },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { workStopped: null, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
}

function decisionOp(
  ctx: ActionContext,
  projectId: string,
  itemId: string,
  item: Pick<ItemState, 'title' | 'stepId'>,
  outcome: 'approved' | 'sentBack' | 'stopped' | 'answered',
  toStepId: string | null,
  rationale: string,
  tags: string[],
  eventId: string,
  waitedMs?: number,
): WriteOp {
  return {
    kind: 'set',
    path: paths.decision(ctx.workspaceId, projectId, eventId),
    data: {
      workspaceId: ctx.workspaceId,
      projectId,
      itemId,
      itemTitle: item.title.slice(0, 300),
      stepId: item.stepId,
      outcome,
      toStepId,
      byUid: ctx.actor.id,
      rationale,
      tags,
      ...(waitedMs !== undefined ? { waitMs: Math.max(0, Math.round(waitedMs)) } : {}),
      ...(ctx.via ? { via: ctx.via } : {}),
      at: SERVER_TIME,
      lastEventId: eventId,
    },
  };
}

function gateFor(project: ProjectState, item: ItemState) {
  const step = project.steps[stepIndexOf(project, item.stepId)];
  if (step?.kind !== 'human' || !step.gate || !item.gate || item.status !== 'waiting')
    throw new ActionError('This item is not waiting for a decision');
  return { step, gate: step.gate, votes: item.gate };
}

/**
 * Human: approve at the current gate. If the approvals (with this one) satisfy the step's rule,
 * the item moves to the next step in the same write; otherwise the approval is recorded.
 */
export function approve(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    rationale?: string;
    tags?: string[];
    /** How long the item waited for this decision (stored for the insights screen). */
    waitedMs?: number;
  },
): ActionPlan & { advanced: boolean } {
  requireHuman(ctx);
  const { gate, votes } = gateFor(input.project, input.item);
  const me = ctx.actor.id;
  const approvals = [...Object.keys(votes.approvals), me];
  const advanced = gateSatisfied(gate, approvals);
  const to = advanced ? forward(input.project, input.item) : null;
  const rationale = input.rationale ?? '';
  return {
    advanced,
    ...plan(
      ctx,
      'decision.approved',
      { projectId: input.projectId, itemId: input.itemId },
      { stepId: input.item.stepId, advanced, toStepId: to?.stepId ?? null },
      (eventId) => [
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
          data: {
            ...(to
              ? { ...to, ...resetRounds(input.item) }
              : { [`gate.approvals.${me}`]: { at: SERVER_TIME, rationale } }),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
        decisionOp(
          ctx,
          input.projectId,
          input.itemId,
          input.item,
          'approved',
          (to?.stepId as string | undefined) ?? null,
          rationale,
          input.tags ?? [],
          eventId,
          input.waitedMs,
        ),
      ],
    ),
  };
}

/**
 * Human: reject at the current gate, sending the item back to `toStepId` (an earlier step) or
 * stopping it (`toStepId: 'stop'`). With rejectPolicy 'majority' the rejection is only recorded
 * until more than half of the deciders reject. Always adds a note with the reason for the agent.
 */
export function sendBack(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    toStepId: string | 'stop';
    rationale: string;
    tags?: string[];
    /** How long the item waited for this decision (stored for the insights screen). */
    waitedMs?: number;
  },
): ActionPlan & { moved: boolean } {
  requireHuman(ctx);
  requireReason(input.rationale);
  const { gate, votes } = gateFor(input.project, input.item);
  const stop = input.toStepId === 'stop';
  if (
    !stop &&
    stepIndexOf(input.project, input.toStepId) >= stepIndexOf(input.project, input.item.stepId)
  )
    throw new ActionError('You can only send an item back to an earlier step');
  const me = ctx.actor.id;
  const moved = rejectionsSuffice(gate, [...Object.keys(votes.rejections), me]);
  const outcome = stop ? 'stopped' : 'sentBack';
  const target = stop ? null : input.project.steps[stepIndexOf(input.project, input.toStepId)];
  let change: Record<string, unknown>;
  if (!moved)
    change = { [`gate.rejections.${me}`]: { at: SERVER_TIME, rationale: input.rationale } };
  else if (stop) change = { status: 'stopped', gate: null, claim: null };
  else
    change = {
      ...landAt(input.project, input.item, (target as Step).id),
      sendBackCount: input.item.sendBackCount + 1,
      ...resetRounds(input.item),
    };
  return {
    moved,
    ...plan(
      ctx,
      stop ? 'decision.stopped' : 'decision.sentBack',
      { projectId: input.projectId, itemId: input.itemId },
      { stepId: input.item.stepId, toStepId: target?.id ?? null, moved, tags: input.tags ?? [] },
      (eventId) => [
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
          data: { ...change, updatedAt: SERVER_TIME, lastEventId: eventId },
        },
        decisionOp(
          ctx,
          input.projectId,
          input.itemId,
          input.item,
          outcome,
          target?.id ?? null,
          input.rationale,
          input.tags ?? [],
          eventId,
          input.waitedMs,
        ),
        {
          kind: 'set',
          path: paths.message(ctx.workspaceId, input.projectId, input.itemId, `${eventId}-note`),
          data: messageDoc(
            ctx,
            input.projectId,
            input.itemId,
            'note',
            input.rationale,
            null,
            eventId,
          ),
        },
      ],
    ),
  };
}

/** Human: stop an item at a gate (archive, don't retry). Same reject policy as send back. */
export function stop(
  ctx: ActionContext,
  input: Omit<Parameters<typeof sendBack>[1], 'toStepId'>,
): ActionPlan & { moved: boolean } {
  return sendBack(ctx, { ...input, toStepId: 'stop' });
}

/**
 * Agent: raise a finding (something outside the item's scope) as a suggestion for people (card
 * TU5pDmzE). It is stored at the first step with status `suggested`: not work, never listed by
 * `work list`, not claimable. The agent does not have to hold the item it was found on; when it
 * does, the finding records the run (`sourceRunId`).
 */
export function raiseFinding(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    parentItemId: string;
    parent: Pick<ItemState, 'title' | 'claim'>;
    title: string;
    details: string;
    itemId?: string;
  },
): ActionPlan & { itemId: string } {
  requireAgent(ctx);
  const title = input.title.trim();
  if (!title) throw new ActionError('A finding needs a title');
  const first = input.project.steps[0];
  if (!first) throw new ActionError('This project has no steps');
  const runId = input.parent.claim?.agentUid === ctx.actor.id ? input.parent.claim.runId : null;
  const itemId = input.itemId ?? nid(ctx);
  return {
    itemId,
    ...plan(
      ctx,
      'finding.raised',
      { projectId: input.projectId, itemId, runId },
      { parentItemId: input.parentItemId, title: title.slice(0, 300) },
      (eventId) => [
        {
          kind: 'set',
          path: paths.item(ctx.workspaceId, input.projectId, itemId),
          data: {
            title: title.slice(0, 300),
            type: 'finding',
            stepId: first.id,
            status: 'suggested',
            summary: input.details.slice(0, 20000),
            source: {
              kind: 'finding',
              label: `${ctx.actor.name} on ${input.parent.title}`.slice(0, 200),
            },
            createdBy: { type: 'agent', id: ctx.actor.id },
            parentItemId: input.parentItemId,
            sourceRunId: runId,
            claim: null,
            progress: null,
            gate: null,
            triage: null,
            sendBackCount: 0,
            attachmentCount: 0,
            costEur: 0,
            order: Date.now(),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
      ],
    ),
  };
}

/**
 * Human: triage a suggestion (an untriaged finding). Who may: see `canTriage` in ./suggestions.
 *  - intake: "Add to <first step>": it becomes a normal item of `newType` at the project's first
 *    step (agents can pick it up from then on)
 *  - addedToItem: its text is appended to the parent item's summary; the finding closes
 *  - dismissed: closed with a reason (≥ 10 chars), so agents learn what is not wanted
 */
export function triageFinding(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    finding: Pick<Item, 'title' | 'summary' | 'parentItemId'>;
    outcome: 'intake' | 'addedToItem' | 'dismissed';
    reason?: string;
    newType?: Exclude<ItemType, 'finding'>;
    parentSummary?: string;
    /** Card st5INNZj: an accepted suggestion waits to be shaped like any new item. */
    unshaped?: boolean;
  },
): ActionPlan {
  requireHuman(ctx);
  const reason = (input.reason ?? '').trim();
  if (input.outcome === 'dismissed') requireReason(reason);
  const first = input.project.steps[0];
  if (!first) throw new ActionError('This project has no steps');
  const item = paths.item(ctx.workspaceId, input.projectId, input.itemId);
  const triage = { outcome: input.outcome, reason, byUid: ctx.actor.id, at: SERVER_TIME };
  const parentItemId = input.finding.parentItemId;
  if (input.outcome === 'addedToItem' && (!parentItemId || input.parentSummary === undefined))
    throw new ActionError('Adding to an item needs the parent item');
  return plan(
    ctx,
    'finding.triaged',
    { projectId: input.projectId, itemId: input.itemId },
    {
      outcome: input.outcome,
      parentItemId,
      title: input.finding.title,
      ...(input.outcome === 'intake' ? { stepName: first.name } : {}),
      ...(input.outcome === 'dismissed' ? { reason } : {}),
    },
    (eventId) => {
      const ops: WriteOp[] = [
        {
          kind: 'update',
          path: item,
          data: {
            triage,
            ...(input.outcome === 'intake'
              ? {
                  type: input.newType ?? 'task',
                  ...(input.unshaped ? unshapedArrival(input.project) : arrival(first)),
                }
              : { status: 'stopped' }),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
      ];
      if (input.outcome === 'addedToItem') {
        ops.push({
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, parentItemId as string),
          data: {
            summary: [
              (input.parentSummary ?? '').trim(),
              `Added from finding: ${input.finding.title}${input.finding.summary.trim() ? `\n${input.finding.summary.trim()}` : ''}`,
            ]
              .filter(Boolean)
              .join('\n\n')
              .slice(0, 20000),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        });
      }
      return ops;
    },
  );
}
