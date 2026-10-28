import {
  createAgent,
  revokeAgent,
  rotateAgent,
  setStepAgents,
  tokenHint,
  type ActionContext,
  type ActionPlan,
  type Agent,
  type OpenRun,
  type Project,
} from '@hive/shared';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { app, AUTH_EMULATOR_PORT, USE_EMULATOR } from '../lib/app';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

export interface NewAgentInput {
  name: string;
  color: string;
  projectIds: string[] | '*';
}

/** The Auth user lives on a throw-away second app, so the owner stays signed in. */
export function identityFor(workspaceId: string) {
  return createAgentIdentity(
    app.options,
    workspaceId,
    USE_EMULATOR
      ? { authEmulatorUrl: `http://${window.location.hostname}:${AUTH_EMULATOR_PORT}` }
      : {},
  );
}

/**
 * Creates the agent and returns its token. The token goes straight back to the caller to show
 * once. The only thing written is the hint (`…a7f3`); the plan is built from fields that cannot
 * contain the credential.
 */
export async function createAgentFlow(
  ctx: ActionContext,
  run: Run,
  input: NewAgentInput,
): Promise<string> {
  const { uid, token } = await identityFor(ctx.workspaceId);
  await run(createAgent(ctx, { agentUid: uid, ...input, tokenHint: tokenHint(token) }));
  return token;
}

/**
 * Revokes the old identity and creates a new one with the same name, colour, scope and settings.
 * Steps limited to the old identity are then limited to the new one (one save per project).
 */
export async function rotateAgentFlow(
  ctx: ActionContext,
  run: Run,
  previousAgentUid: string,
  agent: Pick<Agent, 'name' | 'color' | 'projectIds' | 'guardrails'>,
  projects: readonly { id: string; data: Pick<Project, 'steps' | 'stepAgents'> }[] = [],
  openRuns: readonly OpenRun[] = [],
): Promise<string> {
  const { uid, token } = await identityFor(ctx.workspaceId);
  await run(
    rotateAgent(ctx, {
      previousAgentUid,
      agentUid: uid,
      name: agent.name,
      color: agent.color,
      projectIds: agent.projectIds,
      tokenHint: tokenHint(token),
      ...(agent.guardrails ? { guardrails: agent.guardrails } : {}),
      openRuns,
    }),
  );
  for (const p of projectsToRelink(projects, previousAgentUid)) {
    const stepAgents = Object.fromEntries(
      Object.entries(p.data.stepAgents ?? {}).map(([k, v]) => [
        k,
        v.map((u) => (u === previousAgentUid ? uid : u)),
      ]),
    );
    await run(setStepAgents(ctx, { projectId: p.id, steps: p.data.steps, stepAgents }));
  }
  return token;
}

/** Projects with a step limited to this agent. */
export function projectsToRelink<P extends { data: Pick<Project, 'stepAgents'> }>(
  projects: readonly P[],
  agentUid: string,
): P[] {
  return projects.filter((p) =>
    Object.values(p.data.stepAgents ?? {}).some((uids) => uids.includes(agentUid)),
  );
}

/** Revokes the agent and, in the same batch, ends its open runs and gives their items back. */
export function revokeAgentFlow(
  ctx: ActionContext,
  run: Run,
  agentUid: string,
  openRuns: readonly OpenRun[] = [],
): Promise<void> {
  return run(revokeAgent(ctx, { agentUid, openRuns }));
}
