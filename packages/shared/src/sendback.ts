/**
 * Agent send-back (card KLCTVnX8): the agent holding an item at an agent step sends it back to an
 * earlier agent step on its path, with a reason (for example a test step that found a bug sends it
 * back to the build step). It never crosses a people gate, and after MAX_AGENT_SEND_BACKS rounds
 * without a person acting on the item the next one is refused: the agent then holds the item for
 * people instead (a question, released with a hold; see the agent client).
 *
 * firestore.rules `agentSendBackIt` enforces the same: change both together.
 */
import {
  ActionError,
  ownClaim,
  plan,
  requireAgent,
  runEnd,
  SERVER_TIME,
  stepIndexOf,
  streakOps,
  arrival,
  messageDoc,
  type ActionContext,
  type ActionPlan,
  type AgentGuardState,
  type ItemState,
  type ProjectState,
  type RunResult,
} from './actions';
import { skips } from './itempath';
import {
  MAX_AGENT_SEND_BACKS,
  MAX_SEND_BACK_REASON_CHARS,
  MAX_SEND_BACK_SPAN,
  paths,
  type Item,
  type Step,
} from './schema';

type PathState = Pick<ItemState, 'stepId'> & Partial<Pick<Item, 'pathSkips' | 'gateSkips'>>;

/** Agent send-backs so far on this item (since a person last acted on it). */
export function agentRounds(item: Partial<Pick<Item, 'agentSendBacks'>>): number {
  return item.agentSendBacks ?? 0;
}

/**
 * The steps an agent may send this item back to from its current step: earlier agent steps on
 * the item's path, nearest first, up to the closest people step on the path (never across it)
 * and at most MAX_SEND_BACK_SPAN steps in between.
 */
export function agentSendBackTargets(project: ProjectState, item: PathState): Step[] {
  const at = project.steps.findIndex((s) => s.id === item.stepId);
  const out: Step[] = [];
  for (let i = at - 1; i >= 0 && at - i - 1 <= MAX_SEND_BACK_SPAN; i--) {
    const s = project.steps[i]!;
    if (skips(item, s)) continue;
    if (s.kind === 'human') break;
    out.push(s);
  }
  return out;
}

/** Throws a clear message when `toStepId` is not a valid send-back target. */
export function checkSendBackTarget(project: ProjectState, item: PathState, toStepId: string) {
  const to = project.steps[stepIndexOf(project, toStepId)]!;
  if (to.id === item.stepId) throw new ActionError('That is the step the item is at now');
  const valid = agentSendBackTargets(project, item);
  if (valid.some((s) => s.id === to.id)) return to;
  const from = stepIndexOf(project, item.stepId);
  if (stepIndexOf(project, to.id) > from)
    throw new ActionError('You can only send an item back to an earlier step');
  if (skips(item, to))
    throw new ActionError(`${to.name} is not on this item's path (it is skipped)`);
  if (to.kind === 'human')
    throw new ActionError(`${to.name} is a people step: agents send back to agent steps only`);
  if (from - stepIndexOf(project, to.id) - 1 > MAX_SEND_BACK_SPAN)
    throw new ActionError(
      `${to.name} is too far back (more than ${MAX_SEND_BACK_SPAN} steps in between): send it to a nearer step, or ask people`,
    );
  throw new ActionError(
    `${to.name} is before a people step on this item's path: agents never send an item back across people`,
  );
}

export function requireSendBackReason(reason: string) {
  if (!reason.trim()) throw new ActionError('Say why you send it back (a reason is required)');
  if (reason.length > MAX_SEND_BACK_REASON_CHARS)
    throw new ActionError(`Keep the reason under ${MAX_SEND_BACK_REASON_CHARS} characters`);
}

/**
 * Agent: send the item it holds back to an earlier agent step (see the file comment). The run
 * ends as done (the agent did its step's work: it found what needs redoing), the reason is left
 * as a note for the next agent, and the round counter goes up by one.
 */
export function agentSendBack(
  ctx: ActionContext,
  input: {
    project: ProjectState;
    projectId: string;
    itemId: string;
    item: ItemState;
    toStepId: string;
    reason: string;
    result?: Omit<RunResult, 'status'>;
    agent?: AgentGuardState;
  },
): ActionPlan & { round: number } {
  requireAgent(ctx);
  const claim = ownClaim(ctx, input.item);
  const step = input.project.steps[stepIndexOf(input.project, input.item.stepId)];
  if (step?.kind !== 'agent') throw new ActionError('Agents only send back from agent steps');
  requireSendBackReason(input.reason);
  const to = checkSendBackTarget(input.project, input.item, input.toStepId);
  const round = agentRounds(input.item) + 1;
  if (round > MAX_AGENT_SEND_BACKS)
    throw new ActionError(
      `Agents already sent this item back ${MAX_AGENT_SEND_BACKS} times: it needs people now`,
    );
  const costEur = input.item.costEur + (input.result?.costEur ?? 0);
  const reason = input.reason.trim();
  return {
    round,
    ...plan(
      ctx,
      'item.sentBack',
      { projectId: input.projectId, itemId: input.itemId, runId: claim.runId },
      { fromStepId: input.item.stepId, toStepId: to.id, toStepName: to.name, reason, round },
      (eventId) => [
        {
          kind: 'update',
          path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
          data: {
            ...arrival(to),
            progress: null,
            costEur,
            agentSendBacks: round,
            updatedAt: SERVER_TIME,
            lastEventId: eventId,
          },
        },
        {
          kind: 'update',
          path: paths.run(ctx.workspaceId, claim.runId),
          data: runEnd({ ...input.result, status: 'done' }, eventId),
        },
        ...streakOps(ctx, input.agent, 'done', eventId),
        {
          kind: 'set',
          path: paths.message(ctx.workspaceId, input.projectId, input.itemId, `${eventId}-note`),
          data: messageDoc(ctx, input.projectId, input.itemId, 'note', reason, null, eventId),
        },
      ],
    ),
  };
}

/** Text of the question an agent asks when the round limit is reached (shown in Needs you). */
export const STUCK_QUESTION_PREFIX = `Agents sent this back ${MAX_AGENT_SEND_BACKS} times`;
export function stuckQuestion(reasons: readonly string[], next: string): string {
  const list = reasons.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const text = `${STUCK_QUESTION_PREFIX} and it still is not right. Please decide how to go on (answer to hand it back to the agents).\n\nReasons so far:\n${list}\n\nThis time: ${next}`;
  return text.length > 8000 ? `${text.slice(0, 7990)}…` : text;
}
