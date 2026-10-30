/**
 * Reach out (item KZ6O9): Hivenod asks the agent when an item or a thread step in its hands goes
 * quiet, instead of waiting for someone to notice.
 *
 *  - Quiet: no activity (a log line, a tool write, a status) for REACH_QUIET_MS (a parked item:
 *    REACH_PARKED_MS) → the notifier writes a status request (`statusAsk` by SYSTEM_UID). The
 *    agent's channel delivers it as a kind="status" event (or answers it itself when it saw the
 *    agent work on the item since its last status: no model turn).
 *  - No answer (no activity) REACH_ANSWER_MS after a request (the system's or a person's) → the
 *    silence flag ("Hive silent for 41 min") and ONE message to the people who decide next, with
 *    Ping again · Release to queue · Stop · Open. At most one reminder per REACH_REMIND_MS. Any
 *    activity clears the flag.
 *  - A stale claim (no heartbeat for STALE_CLAIM_MINUTES) whose agent has no live session goes back
 *    to the queue REACH_STALE_RELEASE_MS later, with a note.
 *
 * One request at a time per item: a new one only after activity answered the last.
 * Pure: the notifier keeps one timer per item to the time `reachNext` returns.
 */
import {
  parkOf,
  plan,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type ItemState,
} from './actions';
import { ActionError } from './actions';
import { paths, STALE_CLAIM_MINUTES, STATUS_ASK_EVERY_MS, type Item } from './schema';

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const REACH_QUIET_MS = 30 * 60_000;
export const REACH_PARKED_MS = 2 * 3_600_000;
export const REACH_ANSWER_MS = 10 * 60_000;
export const REACH_REMIND_MS = 2 * 3_600_000;
export const REACH_STALE_RELEASE_MS = 30 * 60_000;
const STALE_MS = STALE_CLAIM_MINUTES * 60_000;

/** Who a status request of Hivenod itself is from (statusAsk.byUid). */
export const SYSTEM_UID = 'hivenod';
export const SYSTEM_NAME = 'Hivenod';

/** In agent hands: held (live heartbeat), parked, or a stale claim. */
export type ReachKind = 'held' | 'parked' | 'stale';

export function reachKind(
  item: Pick<Item, 'status' | 'claim' | 'parked' | 'awaitingAnswer' | 'workStopped'>,
  nowMs: number,
): ReachKind | null {
  if (item.status !== 'working' || !item.claim || item.awaitingAnswer || item.workStopped)
    return null;
  if (nowMs - item.claim.heartbeatAt.toMillis() >= STALE_MS) return 'stale';
  return parkOf(item as ItemState) ? 'parked' : 'held';
}

/** The flag in force: its `since` is the last activity it saw. */
export interface ReachFlag {
  since: number;
  at: number;
  asked?: number | null;
  told?: number | null;
}

export interface ReachInput {
  kind: ReachKind;
  /** The newest activity known (ms): run start, status, park, tool write, log line. */
  activityMs: number;
  /** The newest status request on this claim (ms), anyone's; null: none. */
  askMs: number | null;
  /** The silence flag on this claim, or null. */
  flag: ReachFlag | null;
  /** The claim's last heartbeat (ms; items only): a stale claim goes back to the queue. */
  heartbeatMs?: number;
}

export type ReachStep =
  /** Activity came after the flag: clear it. */
  | { do: 'clear'; at: number }
  /** Quiet: send a status request. */
  | { do: 'ask'; at: number }
  /** A request went unanswered: flag it and tell the member. */
  | { do: 'silent'; at: number; askMs: number }
  /** Still silent: one more message. */
  | { do: 'remind'; at: number }
  /** A stale claim: back to the queue (unless its agent has a live session). */
  | { do: 'release'; at: number };

/** What happens next on an item (or step) in agent hands, and when. */
export function reachNext(i: ReachInput): ReachStep {
  const steps: ReachStep[] = [];
  if (i.flag && i.activityMs > i.flag.since) steps.push({ do: 'clear', at: i.activityMs });
  // told null: the message is still to go out (quiet hours); undefined: an older flag, told then.
  else if (i.flag)
    steps.push({
      do: 'remind',
      at: i.flag.told === null ? i.flag.at : (i.flag.told ?? i.flag.at) + REACH_REMIND_MS,
    });
  else if (i.askMs !== null && i.askMs >= i.activityMs)
    steps.push({ do: 'silent', at: i.askMs + REACH_ANSWER_MS, askMs: i.askMs });
  else
    steps.push({
      do: 'ask',
      at: i.activityMs + (i.kind === 'parked' ? REACH_PARKED_MS : REACH_QUIET_MS),
    });
  // A claim's heartbeat (items): it goes stale with no write, so its release is always timed.
  if (i.heartbeatMs !== undefined)
    steps.push({ do: 'release', at: i.heartbeatMs + STALE_MS + REACH_STALE_RELEASE_MS });
  return steps.reduce((a, b) => (b.at < a.at ? b : a));
}

/** "Hive silent for 41 min" (hours past two hours). */
export function silentText(agent: string | undefined, sinceMs: number, nowMs: number): string {
  const min = Math.max(1, Math.floor((nowMs - sinceMs) / 60_000));
  const span = min < 120 ? `${min} min` : `${Math.floor(min / 60)} h`;
  return `${agent ? clip(agent, 60) : 'Agent'} silent for ${span}`;
}

const ago = (ms: number) => {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 120 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
};

/**
 * The message about a silent item or step (design: "Hive is silent on …"). No clock times: the
 * notifier does not know the reader's zone, so it says how long ago.
 */
export function silentNotice(a: {
  agentName: string;
  title: string;
  /** "Build" for an item; the step's label for a thread step. */
  where: string;
  sinceMs: number;
  askMs: number | null;
  last: { text: string; atMs: number } | null;
  nowMs: number;
  url: string;
  reminder?: boolean;
}): { title: string; body: string; url: string } {
  const min = Math.max(1, Math.floor((a.nowMs - a.sinceMs) / 60_000));
  const span = min < 120 ? `${min} min` : `${Math.floor(min / 60)} h`;
  const who = a.agentName ? clip(a.agentName, 60) : 'The agent';
  const parts = [`No update for ${span}${a.where ? ` at ${clip(a.where, 60)}` : ''}`];
  if (a.askMs !== null) parts[0] += `; no answer to a status check ${ago(a.nowMs - a.askMs)}`;
  let body = `${parts[0]}.`;
  if (a.last) body += ` Last: "${clip(a.last.text, 120)}" (${ago(a.nowMs - a.last.atMs)}).`;
  return {
    title: `${a.reminder ? 'Still silent: ' : ''}${who} is silent on "${clip(a.title, 80)}"`,
    body,
    url: a.url,
  };
}

/**
 * Person: Ping again (the silent message's button, or the item's page). A status request on any
 * claimed item (held, parked or stale), at most once per STATUS_ASK_EVERY_MS. The notifier
 * applies it with the Admin SDK (no client rule).
 */
export function pingAgent(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState; nowMs: number },
): ActionPlan {
  requireHuman(ctx);
  const claim = input.item.claim;
  if (input.item.status !== 'working' || !claim)
    throw new ActionError('No agent holds this item any more.');
  const prev = input.item.statusAsk;
  if (prev && prev.runId === claim.runId && input.nowMs - prev.at.toMillis() < STATUS_ASK_EVERY_MS)
    throw new ActionError('A status was asked for less than 2 minutes ago.');
  const statusAsk = { runId: claim.runId, byUid: ctx.actor.id, at: SERVER_TIME };
  return plan(
    ctx,
    'item.updated',
    { projectId: input.projectId, itemId: input.itemId },
    { statusAsk: true },
    (eventId) => [
      {
        kind: 'update',
        path: paths.item(ctx.workspaceId, input.projectId, input.itemId),
        data: { statusAsk, lastEventId: eventId },
      },
    ],
  );
}

/**
 * The silent flag of a thread step in agent hands (an approved or running outcome), as the web
 * shows it ("Hive silent for 41 min"); null when it is not silent.
 */
export function stepSilentText(
  o: {
    state: string;
    silence?: { since: number; agent?: string } | null;
    progress?: { at: { toMillis(): number } };
  },
  nowMs: number,
): string | null {
  const f = o.silence;
  if (!f || (o.state !== 'approved' && o.state !== 'running')) return null;
  // A progress line after it ends it (the notifier clears the flag at its next check).
  if (o.progress && o.progress.at.toMillis() > f.since) return null;
  return silentText(f.agent, f.since, nowMs);
}
