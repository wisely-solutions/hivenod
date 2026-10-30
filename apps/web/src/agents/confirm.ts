/**
 * `hivenod connect` (item EJ2Cxq4k), the browser side: like a device login. The terminal shows a
 * link to /connect?code=…; a signed-in member opens it, sees which machine is asking, and confirms
 * with one click. Hivenod creates the agent and hands the token to the terminal sealed for its
 * key (connect.ts). The token is never shown or stored.
 */
import {
  normalizePairingCode,
  pairingPath,
  pairingSchema,
  pairingTtlMs,
  type ActionContext,
  type ActionPlan,
  type Pairing,
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

/** One click: creates the agent and completes the request (the terminal gets the token). */
export async function confirmConnectFlow(
  ctx: ActionContext,
  run: Run,
  input: NewAgentInput,
  found: { code: string; pairing: Pairing },
): Promise<{ agentUid: string }> {
  return connectTerminalFlow(ctx, run, input, found);
}

/** Clocks of the browser and the server differ a little: an agent made just before counts too. */
const SKEW_MS = 60_000;

/**
 * The agent this person connected since `sinceMs` (the Connect Claude Code page opened), newest
 * first, or null. The page flips live to "Connected" when it appears (item EJ2Cxq4k).
 */
export function newlyConnected<
  A extends {
    id: string;
    data: { createdBy: string; createdAt: { toMillis(): number } | null; revokedAt: unknown };
  },
>(agents: readonly A[], uid: string, sinceMs: number): A | null {
  let best: A | null = null;
  for (const a of agents) {
    const at = a.data.createdAt?.toMillis() ?? 0;
    if (a.data.createdBy !== uid || a.data.revokedAt || at < sinceMs - SKEW_MS) continue;
    if (!best || at > (best.data.createdAt?.toMillis() ?? 0)) best = a;
  }
  return best;
}
