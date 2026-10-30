/**
 * Bulk Re-check (item "Inbox: Waiting view with bulk Re-check"): the member's waiting threads
 * (on them, a third party, an item, a date or the agent), which of them a bulk Re-check asks, and
 * what each row says about it. Each thread gets the existing Re-check (requestRecheck), one write
 * per thread; nothing polls: the rows follow the Inbox list's own thread listener.
 */
import { recheckPending, type InboxThread, type RecheckResult } from '@hive/shared';
import type { ThreadRow } from './logic';

/** After the agent answers, how long a row waits for the new summary before it says "checked". */
export const SUMMARY_GRACE_MS = 2 * 60_000;

export const rowKey = (t: Pick<ThreadRow, 'wid' | 'id'>) => `${t.wid}/${t.id}`;

const ms = (v: { toMillis(): number } | null | undefined) => (v ? v.toMillis() : 0);

/** The member's waiting threads, the latest change first. */
export function waitingThreads(threads: readonly ThreadRow[]): ThreadRow[] {
  return threads
    .filter((t) => t.data.state === 'waiting')
    .sort((a, b) => ms(b.data.updatedAt) - ms(a.data.updatedAt));
}

/**
 * The threads a bulk Re-check asks: every waiting thread ('all') or the selected ones, never one
 * whose re-check still waits for its agent (it is not sent twice).
 */
export function recheckTargets(
  threads: readonly ThreadRow[],
  selection: ReadonlySet<string> | 'all',
  nowMs: number,
): ThreadRow[] {
  return threads.filter(
    (t) =>
      t.data.state === 'waiting' &&
      (selection === 'all' || selection.has(rowKey(t))) &&
      !recheckPending(t.data, nowMs),
  );
}

export type RowStatus =
  | { kind: 'rechecking' }
  | { kind: 'updated'; version: number; at: number }
  | { kind: 'checked'; result: RecheckResult | null; at: number }
  | { kind: 'idle'; version: number | null; at: number | null };

/**
 * A row's re-check line: re-checking while the request waits for the agent and until the summary
 * moves to a new version (a short grace after the answer), then "updated · vN"; "checked" when
 * the agent answered without a new summary; else the last summary.
 */
export function rowStatus(t: Pick<InboxThread, 'recheck' | 'summary'>, nowMs: number): RowStatus {
  if (recheckPending(t, nowMs)) return { kind: 'rechecking' };
  const r = t.recheck;
  const s = t.summary;
  if (r?.state === 'done' && r.requestedAt) {
    const asked = r.requestedAt.toMillis();
    if (s && s.at.toMillis() >= asked)
      return { kind: 'updated', version: s.version, at: s.at.toMillis() };
    const answered = r.at ? r.at.toMillis() : asked;
    if (nowMs - answered < SUMMARY_GRACE_MS) return { kind: 'rechecking' };
    return { kind: 'checked', result: r.result, at: answered };
  }
  return s
    ? { kind: 'idle', version: s.version, at: s.at.toMillis() }
    : { kind: 'idle', version: null, at: null };
}
