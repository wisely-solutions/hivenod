/**
 * Connecting a terminal (card MkUwvyWs): `hivenod pair` shows a code; an admin confirms it
 * here. Hivenod creates the agent, then hands its token to the waiting terminal encrypted for the
 * terminal's key (packages/shared/src/pairing.ts). The token is never shown or stored here.
 */
import {
  CLI_INFO,
  createAgent,
  isRunCli,
  normalizePairingCode,
  pairingCompletion,
  pairingPath,
  pairingSchema,
  PAIRING_TTL_MS,
  revokeAgent,
  sealToken,
  tokenHint,
  type ActionContext,
  type ActionPlan,
  type Pairing,
} from '@hive/shared';
import { doc, getDocFromServer } from 'firebase/firestore';
import { db } from '../lib/db';
import { identityFor } from './flow';
import type { NewAgentInput } from './flow';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

export type Lookup = { ok: true; code: string; pairing: Pairing } | { ok: false; error: string };

/** Finds the terminal waiting with this code. */
export async function findPairing(text: string, nowMs = Date.now()): Promise<Lookup> {
  const code = normalizePairingCode(text);
  if (!code) return { ok: false, error: 'A code has 8 letters and digits, like K7QX-29PD.' };
  let snap;
  try {
    snap = await getDocFromServer(doc(db, pairingPath(code)));
  } catch {
    return { ok: false, error: 'Could not reach Hivenod. Check the connection and try again.' };
  }
  const parsed = snap.exists() ? pairingSchema.safeParse(snap.data()) : null;
  if (!parsed?.success)
    return {
      ok: false,
      error:
        'No terminal is waiting with this code. Check it, or run the command again for a new one.',
    };
  const p = parsed.data;
  if (p.status !== 'pending') return { ok: false, error: 'This code was already used.' };
  if (nowMs - p.createdAt.toMillis() > PAIRING_TTL_MS)
    return { ok: false, error: 'This code has expired. Run the command again for a new one.' };
  return { ok: true, code, pairing: p };
}

/** A name to start from: "Claude Code (laptop)". */
export function suggestedName(p: Pick<Pairing, 'cli' | 'host'>): string {
  const cli = isRunCli(p.cli) ? CLI_INFO[p.cli].name : p.cli;
  return `${cli}${p.host ? ` (${p.host})` : ''}`.slice(0, 80);
}

/**
 * Creates the agent and completes the pairing. If the pairing cannot be completed (expired,
 * already used), the new agent is revoked again so no unused token is left behind.
 */
export async function connectTerminalFlow(
  ctx: ActionContext,
  run: Run,
  input: NewAgentInput,
  found: { code: string; pairing: Pairing },
): Promise<{ agentUid: string }> {
  const { uid, token } = await identityFor(ctx.workspaceId);
  await run(createAgent(ctx, { agentUid: uid, ...input, tokenHint: tokenHint(token) }));
  try {
    const sealed = await sealToken(token, found.pairing.publicKey, found.code);
    await run({
      ops: [
        {
          kind: 'update',
          path: pairingPath(found.code),
          data: pairingCompletion({
            workspaceId: ctx.workspaceId,
            agentUid: uid,
            agentName: input.name,
            pairedBy: ctx.actor.id,
            sealed,
          }),
        },
      ],
    });
  } catch (e) {
    await run(revokeAgent(ctx, { agentUid: uid })).catch(() => undefined);
    throw e;
  }
  return { agentUid: uid };
}
