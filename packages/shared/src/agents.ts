/**
 * Agent settings and guardrails (card zSzW3LXy): which steps an agent may take, when it pauses,
 * and who may change these settings. Token usage is tracked, never limited. Pure; shared by the web
 * app, the agent client and the rules tests. The rules mirror every check here (firestore.rules,
 * "agent settings"); change both together.
 */
import { ownGet } from './itempath';
import {
  DEFAULT_MAX_FAILED_RUNS,
  type Agent,
  type Guardrails,
  type Project,
  type Run,
} from './schema';

/** The agent's guardrails, with the defaults for agents created before they existed. */
export function guardrailsOf(agent: Pick<Agent, 'guardrails'>): Guardrails {
  return {
    maxFailedRuns: agent.guardrails?.maxFailedRuns ?? DEFAULT_MAX_FAILED_RUNS,
  };
}

/**
 * True for an agent limited to Inbox (item fJnu6): it never touches development
 * items. The rules enforce it (firestore.rules `agentCanProject`); change both together.
 */
export function inboxOnly(agent: Pick<Agent, 'scope'>): boolean {
  return agent.scope === 'inbox';
}

/**
 * Tool name prefixes an Inbox-only agent may use: the Inbox tools
 * (requests, threads, subjects, outcomes). Every other tool works on development items and is
 * refused up front, with a clear message (the rules refuse the writes anyway). Mirrored in Go by
 * cli/internal/hive/scope.go.
 */
export const INBOX_SCOPE_TOOL_PREFIXES = [
  'inbox_',
  'thread_',
  'subject_',
  'outcome_',
] as const;

/** Whether an agent of this scope may call this tool. */
export function toolInScope(agent: Pick<Agent, 'scope'>, tool: string): boolean {
  if (!inboxOnly(agent)) return true;
  return INBOX_SCOPE_TOOL_PREFIXES.some((p) => tool.startsWith(p));
}

export const INBOX_SCOPE_REFUSAL =
  'This agent is limited to Inbox (scope "inbox"): it cannot work on development items. Use the inbox tools.';

export function isPaused(agent: Pick<Agent, 'pausedAt'>): boolean {
  return !!agent.pausedAt;
}

/**
 * Who may change agent settings. THE ONE PLACE for this rule, mirrored in firestore.rules:
 * - an agent's own settings (projects, guardrails, resume): organization admins;
 * - which agents may do a project's steps: admins and the project's creator.
 * Pass `project` for the second.
 */
export function canEditAgentSettings(
  who: { uid: string; isAdmin: boolean },
  project?: Pick<Project, 'createdBy'>,
): boolean {
  if (who.isAdmin) return true;
  return !!project && project.createdBy === who.uid;
}

/** The agents a step is limited to; empty means any agent allowed on the project. */
export function allowedAgentsFor(project: Pick<Project, 'stepAgents'>, stepId: string): string[] {
  return ownGet(project.stepAgents, stepId) ?? [];
}

/** True when this agent may take work at this step (the step is not limited to other agents). */
export function agentMayTakeStep(
  project: Pick<Project, 'stepAgents'>,
  stepId: string,
  agentUid: string,
): boolean {
  const only = allowedAgentsFor(project, stepId);
  return only.length === 0 || only.includes(agentUid);
}

/**
 * The stored form of the per-step limits for a process: only steps that exist, only non-empty
 * lists, no duplicates. Saving a process always writes this, so removing a step drops its limit
 * (the rules let anyone who edits the process drop the limits of removed steps). A limit on a
 * step that became a gate is kept (it is unused there), so such a save never needs an admin.
 */
export function normalizeStepAgents(
  steps: readonly { id: string; kind: string }[],
  stepAgents: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const s of steps) {
    const uids = [...new Set(ownGet(stepAgents, s.id) ?? [])];
    if (uids.length) out[s.id] = uids;
  }
  return out;
}

/** True when two stepAgents maps hold the same limits (order of agents does not matter). */
export function sameStepAgents(
  a: Readonly<Record<string, readonly string[]>>,
  b: Readonly<Record<string, readonly string[]>>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const x = [...(a[k] ?? [])].sort();
    const y = [...(b[k] ?? [])].sort();
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return true;
}

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
  tokensCached?: number;
}

/** New tokens: input without cache reads, plus output (cache reads are shown apart). Display only. */
export function newTokens(u: TokenUsage): number {
  return Math.max(0, u.tokensIn - (u.tokensCached ?? 0)) + u.tokensOut;
}

/** Token totals and models over a set of runs (agent page). */
export function tokenTotals(
  runs: readonly Pick<Run, 'tokensIn' | 'tokensOut' | 'tokensCached' | 'model'>[],
) {
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  const models = new Map<string, number>();
  for (const r of runs) {
    tokensIn += r.tokensIn;
    tokensOut += r.tokensOut;
    tokensCached += r.tokensCached ?? 0;
    if (r.model) models.set(r.model, (models.get(r.model) ?? 0) + 1);
  }
  return {
    tokensIn,
    tokensOut,
    tokensCached,
    newTokens: newTokens({ tokensIn, tokensOut, tokensCached }),
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
  };
}

/** Compact token count: 950, 41k, 1.2M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000)
    return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/**
 * What a run's end does to the agent's failure streak (null: nothing to write). A done run resets
 * it; a failed one adds one and pauses the agent when the streak reaches its limit; a released
 * run (given back, e.g. to ask a question) leaves it alone.
 */
export function streakAfter(
  agent: Pick<Agent, 'guardrails' | 'failStreak' | 'pausedAt'>,
  status: 'done' | 'failed' | 'released',
): { failStreak: number; pause: boolean } | null {
  const streak = agent.failStreak ?? 0;
  if (status === 'released') return null;
  // A paused agent that finishes a live run stays paused with its streak: only a person resumes it.
  if (status === 'done')
    return streak === 0 || agent.pausedAt ? null : { failStreak: 0, pause: false };
  const next = streak + 1;
  return { failStreak: next, pause: !agent.pausedAt && next >= guardrailsOf(agent).maxFailedRuns };
}

/** An agent counts as online (and its terminal as alive) for this long after it was last seen. */
export const AGENT_ONLINE_MS = 2 * 60_000;

/**
 * One terminal per agent (card wvLiSoy8): the live terminal's presence, or null when none is alive.
 * Alive = seen within the online window and not signed out since (a crashed terminal stops
 * counting once the window passes; a stopped one at once).
 */
export function liveTerminal(
  agent: Pick<Agent, 'lastSeenAt' | 'signedOutAt' | 'seenHost'>,
  now: number,
): { host: string | null; since: Date } | null {
  const seen = agent.lastSeenAt?.toMillis() ?? 0;
  const out = agent.signedOutAt?.toMillis() ?? 0;
  if (!seen || seen <= out || now - seen >= AGENT_ONLINE_MS) return null;
  return { host: agent.seenHost ?? null, since: new Date(seen) };
}
