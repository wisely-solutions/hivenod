/**
 * Per-item paths (card st5INNZj): the actions that shape an item, change its path, settle a
 * people-step change, and grow the library from an agent's proposal. Each builds one batched
 * write with its event, like ./actions (and the rules re-check all of it).
 *
 * The rule for every change: agent steps may be added or dropped by the agent working the item
 * (or a person) at once; a people step changes only with any one of its deciders. A decider's own
 * change applies at once; anyone else's becomes a pending request in Needs you.
 */
import {
  ActionError,
  addDecidersOps,
  randomId,
  arrival,
  forward,
  DELETE_FIELD,
  nid,
  ownClaim,
  plan,
  requireAgent,
  requireHuman,
  requireReason,
  runEnd,
  SERVER_TIME,
  stepIndexOf,
  streakOps,
  type ActionContext,
  type ActionPlan,
  type AgentGuardState,
  type ItemState,
  type ProjectState,
  type RunResult,
} from './actions';

import { firstOnPath, hasOwnKey, ownGet, skips } from './itempath';
import {
  buildStepIndex,
  MAX_PATH_NOTE_CHARS,
  MAX_PATH_REASON_CHARS,
  MIN_REASON_CHARS,
  paths,
  type PathOp,
  type Step,
  type StepKind,
  type StepProposal,
} from './schema';

type Where = { project: ProjectState; projectId: string; itemId: string; item: ItemState };

function stepOf(project: ProjectState, stepId: string): Step {
  return project.steps[stepIndexOf(project, stepId)]!;
}
function isDecider(project: ProjectState, stepId: string, uid: string): boolean {
  const s = stepOf(project, stepId);
  return s.kind === 'human' && !!s.gate?.deciderUids.includes(uid);
}
function rev(item: ItemState): number {
  return (item.pathRev ?? 0) + 1;
}
function requireOpen(item: ItemState) {
  if (!['queued', 'working', 'waiting'].includes(item.status))
    throw new ActionError('Only open items can change their path');
}
function requireAhead(project: ProjectState, item: ItemState, stepId: string) {
  if (stepIndexOf(project, stepId) <= stepIndexOf(project, item.stepId))
    throw new ActionError(`${stepOf(project, stepId).name} is not ahead of this item`);
}
const note = (s: string | undefined) => (s ?? '').trim().slice(0, MAX_PATH_NOTE_CHARS);
/** Items from before paths get an (empty) agent-skips map with their first path change. */
const withSkips = (item: ItemState) => (item.pathSkips ? {} : { pathSkips: {} });
const mapFor = (step: Step) => (step.kind === 'agent' ? 'pathSkips' : 'gateSkips');

/**
 * Shapes an unshaped item (an agent's shaping run, or a person's "Set path"): it skips the
 * agent steps in `skips` at once. People steps in `skips` stay on the path and become pending
 * skip requests for their deciders (a decider may approve their own right after). The item
 * arrives at the first step of its path.
 *
 * Commit `asks` first, in order (one request per people step), then the returned plan.
 */
export function shapeItem(
  ctx: ActionContext,
  input: Where & {
    /** The steps to skip, with why. */
    skips: Readonly<Record<string, string>>;
    /** One line on the whole path ("copy change: no research, spec or release"). */
    note: string;
    /** Agents: the shaping run's result (the run ends as done in the same batch). */
    result?: Omit<RunResult, 'status'>;
    agent?: AgentGuardState;
  },
): ActionPlan & { pending: string[]; skipped: string[]; asks: ActionPlan[] } {
  const { project, item } = input;
  if (item.shape !== null) throw new ActionError('This item is already shaped');
  const claim = ctx.actor.type === 'agent' ? ownClaim(ctx, item) : null;
  if (ctx.actor.type === 'human' && item.claim)
    throw new ActionError('An agent is shaping this item right now');
  const skips: Record<string, string> = {};
  const pending: string[] = [];
  for (const s of project.steps) {
    if (!hasOwnKey(input.skips, s.id)) continue;
    if (s.kind === 'agent') skips[s.id] = note(input.skips[s.id]);
    else pending.push(s.id);
  }
  const first = firstOnPath(project, { pathSkips: skips });
  if (!first) throw new ActionError('A path needs at least one step');
  const by = { type: ctx.actor.type, id: ctx.actor.id };
  // One ask per people step, each on the state the previous one leaves.
  const asks: ActionPlan[] = [];
  let state: ItemState = item;
  for (const id of pending) {
    const given = input.skips[id]?.trim() ?? '';
    const reason = given.length >= MIN_REASON_CHARS ? given : 'Not needed for this item';
    asks.push(askPathChange(ctx, { ...input, item: state, stepId: id, reason }));
    state = {
      ...state,
      pathRev: rev(state),
      pathRequests: {
        ...(state.pathRequests ?? {}),
        [id]: { op: 'drop', by, reason, at: null as never },
      },
    };
  }
  const skipped = Object.keys(skips);
  const result = plan(
    ctx,
    'item.shaped',
    { projectId: input.projectId, itemId: input.itemId, runId: claim?.runId ?? null },
    { skipped, pending, note: note(input.note), firstStepId: first.id },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          ...arrival(first),
          ...(claim
            ? { progress: null, costEur: item.costEur + (input.result?.costEur ?? 0) }
            : {}),
          shape: { by, at: SERVER_TIME, note: note(input.note) },
          pathSkips: skips,
          pathRev: rev(state),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
      ...(claim
        ? [
            {
              kind: 'update' as const,
              path: paths.run(ctx.workspaceId, claim.runId),
              data: runEnd({ ...input.result, status: 'done' }, eventId),
            },
            ...streakOps(ctx, input.agent, 'done', eventId),
          ]
        : []),
    ],
  );
  return { ...result, pending, skipped, asks };
}

/** A person's fallback when no agent shapes the item: it goes through every step. */
export function fullProcessPlan(ctx: ActionContext, input: Where): ActionPlan {
  requireHuman(ctx);
  return shapeItem(ctx, { ...input, skips: {}, note: 'Full process' });
}

/**
 * Skips one step ahead, or puts a skipped one back. Agent steps: the agent holding the item, or
 * any person, at once (logged; undo is the opposite change). A people step: only one of its
 * deciders (everyone else uses `askPathChange`).
 */
export function skipStep(
  ctx: ActionContext,
  input: Where & { stepId: string; skip: boolean; reason?: string },
): ActionPlan {
  const { project, item, stepId } = input;
  requireOpen(item);
  if (item.shape === null) throw new ActionError('Shape the item first');
  const claim = ctx.actor.type === 'agent' ? ownClaim(ctx, item) : null;
  const step = stepOf(project, stepId);
  requireAhead(project, item, stepId);
  if (
    step.kind === 'human' &&
    (ctx.actor.type === 'agent' || !isDecider(project, stepId, ctx.actor.id))
  )
    throw new ActionError(`${step.name} is a people step: ask one of its deciders to change it`);
  const skipped = skips(item, step);
  if (skipped === input.skip)
    throw new ActionError(`${step.name} is already ${input.skip ? 'skipped' : 'on the path'}`);
  const reason = note(input.reason);
  return plan(
    ctx,
    'item.pathChanged',
    { projectId: input.projectId, itemId: input.itemId, runId: claim?.runId ?? null },
    {
      change: input.skip ? 'skip' : 'unskip',
      stepId,
      stepName: step.name,
      kind: step.kind,
      reason,
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          ...withSkips(item),
          [`${mapFor(step)}.${stepId}`]: input.skip ? reason : DELETE_FIELD,
          pathRev: rev(item),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

/**
 * Splits a wanted path into what this actor may apply at once (`skip`/`unskip`, one write each)
 * and what needs a decider (`ask`). Only steps ahead of the current one change.
 */
export function planPathChange(
  project: ProjectState,
  item: ItemState,
  actor: { type: 'human' | 'agent'; id: string },
  wanted: readonly string[],
): { skip: string[]; unskip: string[]; ask: string[] } {
  const want = new Set(wanted);
  const cur = stepIndexOf(project, item.stepId);
  const out = { skip: [] as string[], unskip: [] as string[], ask: [] as string[] };
  project.steps.forEach((s, i) => {
    if (i <= cur) return;
    const skipped = skips(item, s);
    if (want.has(s.id) === !skipped) return;
    const direct =
      s.kind === 'agent' || (actor.type === 'human' && isDecider(project, s.id, actor.id));
    if (!direct) out.ask.push(s.id);
    else (skipped ? out.unskip : out.skip).push(s.id);
  });
  return out;
}

/**
 * Asks the deciders of a people step ahead to put it on the path or skip it. The item keeps
 * going meanwhile; if it reaches a step whose skip is pending, it waits there as usual.
 */
export function askPathChange(
  ctx: ActionContext,
  input: Where & { stepId: string; reason: string },
): ActionPlan & { op: PathOp } {
  const { project, item, stepId } = input;
  requireOpen(item);
  requireReason(input.reason);
  const claim = ctx.actor.type === 'agent' ? ownClaim(ctx, item) : null;
  const step = stepOf(project, stepId);
  if (step.kind !== 'human')
    throw new ActionError(`${step.name} is an agent step: change it directly`);
  requireAhead(project, item, stepId);
  if (ownGet(item.pathRequests, stepId))
    throw new ActionError(`A change of ${step.name} is pending`);
  if (ctx.actor.type === 'agent' && item.pathRefused?.includes(stepId))
    throw new ActionError(`A decider already kept ${step.name} as it is on this item`);
  const op: PathOp = skips(item, step) ? 'add' : 'drop';
  const reason = input.reason.trim().slice(0, MAX_PATH_REASON_CHARS);
  return {
    op,
    ...plan(
      ctx,
      'item.pathChanged',
      { projectId: input.projectId, itemId: input.itemId, runId: claim?.runId ?? null },
      { change: 'ask', stepId, stepName: step.name, op, pending: true, reason },
      (eventId) => [
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
          data: {
            [`pathRequests.${stepId}`]: {
              op,
              by: { type: ctx.actor.type, id: ctx.actor.id },
              reason,
              at: SERVER_TIME,
            },
            pathRev: rev(item),
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
      ],
    ),
  };
}

/**
 * A decider settles a pending change of their step, either way (the first one to answer). An
 * approved skip of the gate the item waits at moves it on along its path. After a refusal agents
 * cannot ask again for that step on this item.
 */
export function decidePathChange(
  ctx: ActionContext,
  input: Where & { stepId: string; approve: boolean },
): ActionPlan {
  requireHuman(ctx);
  const { project, item, stepId } = input;
  const req = ownGet(item.pathRequests, stepId);
  if (!req) throw new ActionError('Nothing is pending for this step');
  if (!isDecider(project, stepId, ctx.actor.id))
    throw new ActionError(`Only a decider of ${stepOf(project, stepId).name} can settle this`);
  let data: Record<string, unknown>;
  if (!input.approve) {
    const refused = item.pathRefused ?? [];
    data = { pathRefused: refused.includes(stepId) ? refused : [...refused, stepId] };
  } else {
    requireOpen(item);
    const here = stepId === item.stepId;
    if (!here) requireAhead(project, item, stepId);
    if (req.op === 'add') data = { ...withSkips(item), [`gateSkips.${stepId}`]: DELETE_FIELD };
    else {
      data = { ...withSkips(item), [`gateSkips.${stepId}`]: note(req.reason) };
      if (here) {
        if (item.status !== 'waiting') throw new ActionError('This item is not waiting here');
        // Skipping the gate the item waits at: on to the next step on its path.
        const gateSkips = { ...(item.gateSkips ?? {}), [stepId]: '' };
        data = { ...data, ...forward(project, { stepId, pathSkips: item.pathSkips, gateSkips }) };
      }
    }
  }
  return plan(
    ctx,
    'item.pathChangeDecided',
    { projectId: input.projectId, itemId: input.itemId },
    {
      stepId,
      stepName: stepOf(project, stepId).name,
      op: req.op,
      outcome: input.approve ? 'approved' : 'refused',
      askedBy: req.by,
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: {
          ...data,
          [`pathRequests.${stepId}`]: DELETE_FIELD,
          pathRev: rev(item),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      },
    ],
  );
}

export interface ProposalInput {
  name: string;
  kind: StepKind;
  description: string;
  instructions?: string;
  outputs?: string[];
  /** The library step it goes after; '' = first. */
  afterStepId: string;
  deciderUids?: string[];
  /** Why the library needs it (agents and approvers read it). */
  reason: string;
}

/** Agent (holding the item): proposes a new library step for an approver. */
export function proposeStep(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    proposal: ProposalInput;
    proposalId?: string;
  },
): ActionPlan & { proposalId: string } {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const p = input.proposal;
  const name = p.name.trim();
  if (!name) throw new ActionError('A step needs a name');
  requireReason(p.reason);
  if (p.afterStepId) stepIndexOf(input.project, p.afterStepId);
  const proposalId = input.proposalId ?? nid(ctx);
  return {
    proposalId,
    ...plan(
      ctx,
      'step.proposed',
      { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
      { proposalId, name: name.slice(0, 60), kind: p.kind, afterStepId: p.afterStepId },
      (eventId) => [
        {
          kind: 'set',
          path: paths.stepProposal(ctx.workspaceId, input.projectId, proposalId),
          data: {
            name: name.slice(0, 60),
            kind: p.kind,
            description: p.description.slice(0, 2000),
            instructions: (p.instructions ?? '').slice(0, 20000),
            outputs: (p.outputs ?? []).slice(0, 20).map((o) => o.slice(0, 200)),
            afterStepId: p.afterStepId,
            deciderUids: p.kind === 'human' ? (p.deciderUids ?? []).slice(0, 100) : [],
            reason: p.reason.trim().slice(0, MAX_PATH_REASON_CHARS),
            itemId: input.itemId,
            by: { type: 'agent', id: ctx.actor.id },
            at: SERVER_TIME,
            status: 'open',
            decision: null,
            lastEventId: eventId,
          },
        },
      ],
    ),
  };
}

/**
 * A new library step id, random like the process editor's (`s-xxxxxxxx`), so an id is never
 * reused: an item that still skips a removed step must not skip a new one by accident.
 */
export function newStepId(): string {
  return `s-${randomId(8)}`;
}

/**
 * Approver (admins and the project's creator): adds a proposed step to the library, after the
 * step it names. It is on the path of every item that has not passed that position, the
 * proposing one included; the approver's client then skips it on the other open items
 * (`skipStep`, one write each) so it does not appear on them silently.
 */
export function acceptProposal(
  ctx: ActionContext,
  input: {
    project: ProjectState & { memberUids?: readonly string[] };
    projectId: string;
    proposalId: string;
    proposal: Pick<StepProposal, 'afterStepId' | 'itemId' | 'name'>;
    /** The step as the approver finalised it (deciders editable for a people step). */
    step: Step;
  },
): ActionPlan & { stepId: string } {
  requireHuman(ctx);
  const { project, step } = input;
  if (project.steps.some((s) => s.id === step.id))
    throw new ActionError('That step id is already in the library');
  const after = input.proposal.afterStepId;
  const pos = after ? stepIndexOf(project, after) + 1 : 0;
  const steps = [...project.steps.slice(0, pos), step, ...project.steps.slice(pos)];
  const added = addDecidersOps(ctx, input.projectId, project.memberUids ?? [], steps);
  const result = plan(
    ctx,
    'step.accepted',
    { projectId: input.projectId, itemId: input.proposal.itemId },
    {
      proposalId: input.proposalId,
      stepId: step.id,
      name: step.name,
      kind: step.kind,
      itemId: input.proposal.itemId,
    },
    (eventId) => [
      {
        kind: 'update',
        path: paths.project(ctx.workspaceId, input.projectId),
        data: {
          steps,
          stepIndex: buildStepIndex(steps),
          ...(project.memberUids ? added.data : {}),
          lastEventId: eventId,
        },
      },
      ...(project.memberUids ? added.ops : []),
      {
        kind: 'update',
        path: paths.stepProposal(ctx.workspaceId, input.projectId, input.proposalId),
        data: {
          status: 'accepted',
          decision: { byUid: ctx.actor.id, at: SERVER_TIME, reason: '', stepId: step.id },
          lastEventId: eventId,
        },
      },
    ],
  );
  return { ...result, stepId: step.id };
}

/** Approver: rejects a proposal with a reason (≥ 10 characters) that agents can read. */
export function rejectProposal(
  ctx: ActionContext,
  input: { projectId: string; proposalId: string; itemId: string; reason: string },
): ActionPlan {
  requireHuman(ctx);
  requireReason(input.reason);
  const reason = input.reason.trim().slice(0, 2000);
  return plan(
    ctx,
    'step.rejected',
    { projectId: input.projectId, itemId: input.itemId },
    { proposalId: input.proposalId, reason },
    (eventId) => [
      {
        kind: 'update',
        path: paths.stepProposal(ctx.workspaceId, input.projectId, input.proposalId),
        data: {
          status: 'rejected',
          decision: { byUid: ctx.actor.id, at: SERVER_TIME, reason, stepId: null },
          lastEventId: eventId,
        },
      },
    ],
  );
}
