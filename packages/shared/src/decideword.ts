/**
 * May act on my word (thread it18ecc2f3446f3b4e29e8f24c): a member who drives an agent from his
 * own terminal says "approved" there, and the agent records that decision in Hivenod, attributed
 * to him, instead of him tapping the gate again.
 *
 *   workspaces/{wid}/agentTrust/{uid}   the member's own list of agents that may act on his word
 *                                       (off by default; only he writes it, never an agent)
 *
 * The agent decides only a person step of a plan on a thread it is the home agent of, only while
 * the member trusts it, and only with his quoted words: approve or accept (the gate passes),
 * reject (the gate, or a whole proposed plan), changes (the gate sends the plan back), or close
 * (the thread is done). The writes are the member's own decisions (approveOutcome, rejectOutcome,
 * rejectPlan, sendBackPlan, closeThread), with the agent as the actor and the event saying on
 * whose word: data.onBehalfOf (the member), memberName, via 'terminal' and words. The rules
 * (firestore.rules `inboxOnWord`, `inboxDecider`) enforce all of it; change both together.
 */
import { requireAgent, requireHuman, SERVER_TIME, ActionError } from './actions';
import type { ActionContext, ActionPlan, WriteOp } from './actions';
import {
  approveOutcome,
  closeThread,
  inboxPaths,
  inboxPlan,
  rejectOutcome,
  rejectPlan,
  sendBackPlan,
  type PlanInput,
  type PlanOf,
  type SendBackOf,
  type ThreadStateOf,
} from './inbox';
import { outcomeKind } from './outcomes';
import { timestamp } from './schema';
import { z } from 'zod';

export const STEP_DECISIONS = ['approve', 'accept', 'reject', 'changes', 'close'] as const;
export type StepDecision = (typeof STEP_DECISIONS)[number];

export const ON_WORD_LIMITS = { words: 500, agents: 20 } as const;

export const decidePaths = {
  trust: (w: string, uid: string) => `workspaces/${w}/agentTrust/${uid}`,
} as const;

/** The member's trust doc as listeners read it (absent: nobody may act on his word). */
export interface AgentTrustOf {
  agents: readonly string[];
}

export const agentTrustSchema = z.object({
  agents: z.array(z.string()).max(ON_WORD_LIMITS.agents),
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type AgentTrust = z.infer<typeof agentTrustSchema>;

/** Whether `agentUid` may act on the member's word. */
export function trusts(t: AgentTrustOf | null | undefined, agentUid: string): boolean {
  return !!t && Array.isArray(t.agents) && t.agents.includes(agentUid);
}

/**
 * The member turns "May act on my word" on or off for one agent (the Agents page). Only he
 * writes his list; an agent never can (the rules refuse it).
 */
export function setAgentTrust(
  ctx: ActionContext,
  input: { agentUid: string; on: boolean; current?: AgentTrustOf | null },
): ActionPlan & { agents: string[] } {
  requireHuman(ctx);
  const a = input.agentUid.trim();
  if (!a || a.length > 128) throw new ActionError('Pick an agent by its id.');
  const before = [...new Set(input.current?.agents ?? [])];
  const agents = input.on ? [...before.filter((x) => x !== a), a] : before.filter((x) => x !== a);
  if (agents.length > ON_WORD_LIMITS.agents)
    throw new ActionError(`At most ${ON_WORD_LIMITS.agents} agents may act on your word.`);
  const me = ctx.actor.id;
  const p = inboxPlan(
    ctx,
    'agents.trusted',
    { memberUid: me },
    { agentUid: a, on: input.on },
    (eventId) => [
      {
        kind: 'set',
        path: decidePaths.trust(ctx.workspaceId, me),
        data: { agents, updatedAt: SERVER_TIME, lastEventId: eventId },
      },
    ],
  );
  return { ...p, agents };
}

export interface DecideOnWordInput {
  decision: StepDecision;
  /** The member's own words, as he typed them in this session (quoted on the timeline). */
  words: string;
  threadId: string;
  thread: ThreadStateOf;
  /** The member's name (the timeline says "Approved by <name> via <agent>'s terminal"). */
  memberName: string;
  /** The person step decided (approve, accept, reject, changes); absent for close. */
  outcomeId?: string | null;
  /** Its plan (for every decision but close). */
  plan?: PlanInput & { plan: PlanOf & SendBackOf };
  /** changes: the step to send the plan back to (0-based); default the template's. */
  toStep?: number | null;
}

/** The trimmed words, 1-500 characters. */
export function cleanWords(words: string): string {
  const w = (words ?? '').trim();
  if (!w)
    throw new ActionError('Quote the person’s words (words): what they typed in this session.');
  if (w.length > ON_WORD_LIMITS.words)
    throw new ActionError(`The words are at most ${ON_WORD_LIMITS.words} characters.`);
  return w;
}

/**
 * The home agent records the member's decision on his word (step_decide). The member's trust is
 * checked by the rules (the agent's client reads it first, to say so plainly).
 */
export function decideOnWord(ctx: ActionContext, input: DecideOnWordInput): ActionPlan {
  requireAgent(ctx);
  const t = input.thread;
  if (t.fetchedBy !== ctx.actor.id)
    throw new ActionError('Only the thread’s home agent decides on the person’s word.');
  const words = cleanWords(input.words);
  const memberName = (input.memberName ?? '').trim().slice(0, 200);
  const as: ActionContext = {
    ...ctx,
    actor: { type: 'human', id: t.memberUid, name: memberName },
  };
  let p: ActionPlan;
  if (input.decision === 'close') {
    p = closeThread(as, { threadId: input.threadId, thread: t });
  } else {
    const pl = input.plan;
    const oid = input.outcomeId ?? '';
    const o = pl?.outcomes[oid];
    if (!pl || !o || !pl.plan.steps.includes(oid))
      throw new ActionError('Name a person step of the thread’s plan (outcomeId).');
    if (pl.plan.threadId !== input.threadId)
      throw new ActionError('That plan is on another thread.');
    // A whole proposed plan (e.g. one a newer plan replaced): Reject plan.
    if (input.decision === 'reject' && pl.plan.state === 'proposed') {
      p = rejectPlan(as, { ...pl, thread: t, reason: words });
    } else {
      if (outcomeKind(o.type) !== 'human')
        throw new ActionError(
          'Only a person step (Approve idea, Ship it?, Accept on live, …) is decided on the person’s word.',
        );
      if (input.decision === 'approve' || input.decision === 'accept')
        p = approveOutcome(as, { outcomeId: oid, outcome: o, thread: t, plan: pl });
      else if (input.decision === 'reject')
        p = rejectOutcome(as, {
          outcomeId: oid,
          outcome: o,
          thread: t,
          plan: pl,
          reason: words,
          othersPending: false,
        });
      else {
        if (pl.plan.steps[pl.plan.cursor] !== oid)
          throw new ActionError(
            'Not its turn yet: the person decides this step once the steps before it are done.',
          );
        p = sendBackPlan(as, { ...pl, thread: t, reason: words, toStep: input.toStep ?? null });
      }
    }
  }
  return onWord(ctx, p, { onBehalfOf: t.memberUid, memberName, words });
}

/** The member's decision, written by the agent: its event names on whose word. */
function onWord(
  ctx: ActionContext,
  p: ActionPlan,
  w: { onBehalfOf: string; memberName: string; words: string },
): ActionPlan {
  const ev = inboxPaths.event(ctx.workspaceId, p.eventId);
  const me = ctx.actor.id;
  const ops = p.ops.map((op): WriteOp => {
    if (op.kind === 'delete') return op;
    const d = { ...op.data } as Record<string, unknown>;
    if (op.path === ev) {
      d.actor = { type: ctx.actor.type, id: me, name: ctx.actor.name };
      d.data = { ...(d.data as object), ...w, via: 'terminal' };
    }
    const dec = d.decision as Record<string, unknown> | null | undefined;
    if (dec && dec.byUid === w.onBehalfOf) d.decision = { ...dec, byUid: me };
    const sb = d.sentBack as Record<string, unknown> | undefined;
    if (sb && sb.by === w.onBehalfOf) d.sentBack = { ...sb, by: me };
    return { ...op, data: d } as WriteOp;
  });
  return { eventId: p.eventId, ops };
}

/** The data of an event recorded on the member's word, or null. */
export function onWordOf(
  data: Readonly<Record<string, unknown>> | null | undefined,
): { onBehalfOf: string; memberName: string; words: string } | null {
  if (!data || typeof data.onBehalfOf !== 'string' || data.via !== 'terminal') return null;
  return {
    onBehalfOf: data.onBehalfOf,
    memberName: typeof data.memberName === 'string' ? data.memberName : '',
    words: typeof data.words === 'string' ? data.words : '',
  };
}

const VERB: Record<string, string> = {
  'outcome.approved': 'Approved',
  'outcome.rejected': 'Turned down',
  'plan.rejected': 'Plan rejected',
  'plan.sent_back': 'Changes asked',
  'thread.closed': 'Closed',
};

/**
 * The line of a decision taken on the member's word: "Approved by João via Bee’s terminal:
 * “approved”" (timeline, Activity, notifier). Null for any other event.
 */
export function onWordLine(e: {
  type: string;
  data: Readonly<Record<string, unknown>>;
  actor: { name: string };
}): string | null {
  const w = onWordOf(e.data);
  if (!w) return null;
  const verb = VERB[e.type] ?? 'Decided';
  const who = w.memberName || 'the person';
  const agent = e.actor.name || 'the agent';
  return `${verb} by ${who} via ${agent}’s terminal: “${w.words}”`;
}
