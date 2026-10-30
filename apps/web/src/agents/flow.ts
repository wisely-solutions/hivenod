import {
  createAgent,
  revokeAgent,
  rotateAgent,
  tokenHint,
  type ActionContext,
  type ActionPlan,
  type Agent,
} from '@hive/shared';
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { app, AUTH_EMULATOR_PORT, USE_EMULATOR } from '../lib/app';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

export interface NewAgentInput {
  name: string;
  color: string;
  projectIds: string[] | '*';
  /** 'inbox': Inbox only (item fJnu6). */
  scope?: 'inbox';
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

/** Revokes the old identity and creates a new one with the same name, colour, scope and settings. */
export async function rotateAgentFlow(
  ctx: ActionContext,
  run: Run,
  previousAgentUid: string,
  agent: Pick<Agent, 'name' | 'color' | 'projectIds' | 'guardrails' | 'scope'>,
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
      ...(agent.scope ? { scope: agent.scope } : {}),
    }),
  );
  return token;
}

/** Revokes the agent. */
export function revokeAgentFlow(ctx: ActionContext, run: Run, agentUid: string): Promise<void> {
  return run(revokeAgent(ctx, { agentUid }));
}
