/**
 * `hivenod connect` (item EJ2Cxq4k), the browser side: like a device login. The terminal shows a
 * link to /connect?code=…; a signed-in member opens it, sees which machine is asking, and confirms
 * with one click for projects they are in. Hivenod creates the agent, adds it to the agent steps of
 * those projects that are limited to some agents (where this person may change that), and hands
 * the token to the terminal sealed for its key (connect.ts). The token is never shown or stored.
 */
import {
  canEditAgentSettings,
  MEMBER_CONNECT_MAX_PROJECTS,
  normalizePairingCode,
  pairingPath,
  pairingSchema,
  pairingTtlMs,
  setStepAgents,
  type ActionContext,
  type ActionPlan,
  type Pairing,
  type Project,
} from '@hive/shared';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../lib/db';
import { connectTerminalFlow } from './connect';
import type { NewAgentInput } from './flow';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

export type ConnectLookup =
  | { ok: true; code: string; pairing: Pairing }
  /** `pair`: the code is a `hivenod pair` code, confirmed on the admins' Connect page instead. */
  | { ok: false; error: string; pair?: string };

export const CONNECT_ERRORS = {
  format: 'A code has 8 letters and digits, like K7QX-29PD.',
  offline: 'Could not reach Hivenod. Check the connection and try again.',
  missing:
    'No terminal is waiting with this code. Check it, or run hivenod connect again for a new one.',
  used: 'This request was already used. Run hivenod connect again for a new one.',
  expired: 'This request has expired. Run hivenod connect again in your terminal.',
} as const;

/** Reads the request and says whether it can still be confirmed. */
export function checkConnect(code: string, data: unknown, nowMs = Date.now()): ConnectLookup {
  const parsed = data ? pairingSchema.safeParse(data) : null;
  if (!parsed?.success) return { ok: false, error: CONNECT_ERRORS.missing };
  const p = parsed.data;
  if (p.status !== 'pending') return { ok: false, error: CONNECT_ERRORS.used };
  if (nowMs - p.createdAt.toMillis() > pairingTtlMs(p))
    return { ok: false, error: CONNECT_ERRORS.expired };
  if (p.kind !== 'connect') return { ok: false, error: '', pair: code };
  return { ok: true, code, pairing: p };
}

export async function findConnect(text: string, nowMs = Date.now()): Promise<ConnectLookup> {
  const code = normalizePairingCode(text);
  if (!code) return { ok: false, error: CONNECT_ERRORS.format };
  let snap;
  try {
    snap = await getDocFromServer(doc(db, pairingPath(code)));
  } catch {
    return { ok: false, error: CONNECT_ERRORS.offline };
  }
  return checkConnect(code, snap.exists() ? snap.data() : null, nowMs);
}

/** How many projects this person may connect an agent to at once (firestore.rules). */
export function maxConnectProjects(isAdmin: boolean): number {
  return isAdmin ? 100 : MEMBER_CONNECT_MAX_PROJECTS;
}

/** Ticked to start with: all of their projects when they fit, else none (they pick). */
export function initialChoice(projectIds: readonly string[], isAdmin: boolean): string[] {
  return projectIds.length <= maxConnectProjects(isAdmin) ? [...projectIds] : [];
}

/**
 * The stepAgents map with the new agent added to every agent step limited to some agents, or null
 * when nothing changes. Steps with no limit already let any agent of the project work there.
 */
export function withAgentOnSteps(
  project: Pick<Project, 'steps' | 'stepAgents'>,
  agentUid: string,
): Record<string, string[]> | null {
  const next: Record<string, string[]> = {};
  let changed = false;
  for (const [k, v] of Object.entries(project.stepAgents ?? {})) next[k] = [...v];
  for (const s of project.steps) {
    const only = next[s.id];
    if (s.kind !== 'agent' || !only || only.length === 0 || only.includes(agentUid)) continue;
    next[s.id] = [...only, agentUid];
    changed = true;
  }
  return changed ? next : null;
}

/** Limited agent steps the agent could not be added to (this person may not change them). */
export function stepsLeftOut(
  who: { uid: string; isAdmin: boolean },
  projects: readonly { id: string; data: Pick<Project, 'steps' | 'stepAgents' | 'createdBy'> }[],
): number {
  let n = 0;
  for (const p of projects) {
    if (canEditAgentSettings(who, p.data)) continue;
    for (const s of p.data.steps)
      if (s.kind === 'agent' && (p.data.stepAgents?.[s.id]?.length ?? 0) > 0) n++;
  }
  return n;
}

/**
 * One click: creates the agent for the chosen projects, completes the request (the terminal gets
 * the token), then adds the agent to limited agent steps where this person may. A failed step
 * update leaves the connection in place (the steps can be set in the process editor).
 */
export async function confirmConnectFlow(
  ctx: ActionContext,
  run: Run,
  who: { uid: string; isAdmin: boolean },
  input: NewAgentInput & { projectIds: string[] },
  found: { code: string; pairing: Pairing },
  projects: readonly { id: string; data: Pick<Project, 'steps' | 'stepAgents' | 'createdBy'> }[],
): Promise<{ agentUid: string }> {
  const { agentUid } = await connectTerminalFlow(ctx, run, input, found);
  for (const p of projects) {
    if (!input.projectIds.includes(p.id) || !canEditAgentSettings(who, p.data)) continue;
    const stepAgents = withAgentOnSteps(p.data, agentUid);
    if (!stepAgents) continue;
    await run(setStepAgents(ctx, { projectId: p.id, steps: p.data.steps, stepAgents })).catch(
      () => undefined,
    );
  }
  return { agentUid };
}
