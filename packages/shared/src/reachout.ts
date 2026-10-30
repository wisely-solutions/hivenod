/**
 * Reach out (item KZ6O9): Hivenod asks the agent when a thread step in its hands goes quiet,
 * instead of waiting for someone to notice. (Projects and their items were removed in slice 11:
 * only thread steps are watched.)
 *
 *  - Quiet: no activity (a progress line, a note on the thread) for REACH_QUIET_MS → the notifier
 *    writes a status request (`statusAsk` by SYSTEM_UID) on the outcome.
 *  - No answer (no activity) REACH_ANSWER_MS after a request (the system's or a person's) → the
 *    silence flag ("Scout silent for 41 min") and ONE message to the thread's member, with
 *    Ping again · Open. At most one reminder per REACH_REMIND_MS. Any activity clears the flag.
 *
 * One request at a time per step: a new one only after activity answered the last.
 * Pure: the notifier keeps one timer per step to the time `reachNext` returns.
 */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const REACH_QUIET_MS = 30 * 60_000;
export const REACH_ANSWER_MS = 10 * 60_000;
export const REACH_REMIND_MS = 2 * 3_600_000;
/** A person may ask for a status on one step at most this often (Ping again). */
export const STATUS_ASK_EVERY_MS = 2 * 60_000;
/** Who a status request of Hivenod itself is from (statusAsk.byUid). */
export const SYSTEM_UID = 'hivenod';
export const SYSTEM_NAME = 'Hivenod';

/** The flag in force: its `since` is the last activity it saw. */
export interface ReachFlag {
  since: number;
  at: number;
  asked?: number | null;
  told?: number | null;
}

export interface ReachInput {
  /** The newest activity known (ms): the step's start, progress, a note on the thread. */
  activityMs: number;
  /** The newest status request on this claim (ms), anyone's; null: none. */
  askMs: number | null;
  /** The silence flag on this claim, or null. */
  flag: ReachFlag | null;
}

export type ReachStep =
  /** Activity came after the flag: clear it. */
  | { do: 'clear'; at: number }
  /** Quiet: send a status request. */
  | { do: 'ask'; at: number }
  /** A request went unanswered: flag it and tell the member. */
  | { do: 'silent'; at: number; askMs: number }
  /** Still silent: one more message. */
  | { do: 'remind'; at: number };

/** What happens next on a step in agent hands, and when. */
export function reachNext(i: ReachInput): ReachStep {
  if (i.flag && i.activityMs > i.flag.since) return { do: 'clear', at: i.activityMs };
  // told null: the message is still to go out (quiet hours); undefined: an older flag, told then.
  if (i.flag)
    return {
      do: 'remind',
      at: i.flag.told === null ? i.flag.at : (i.flag.told ?? i.flag.at) + REACH_REMIND_MS,
    };
  if (i.askMs !== null && i.askMs >= i.activityMs)
    return { do: 'silent', at: i.askMs + REACH_ANSWER_MS, askMs: i.askMs };
  return { do: 'ask', at: i.activityMs + REACH_QUIET_MS };
}

/** "Scout silent for 41 min" (hours past two hours). */
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
 * The message about a silent step (design: "Scout is silent on …"). No clock times: the
 * notifier does not know the reader's zone, so it says how long ago.
 */
export function silentNotice(a: {
  agentName: string;
  title: string;
  /** The step's label ("Reply, step 2 of 3"). */
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
 * The silent flag of a thread step in agent hands (an approved or running outcome), as the web
 * shows it ("Scout silent for 41 min"); null when it is not silent.
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
