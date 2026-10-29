/**
 * "May be out of date" (item bmNoIvvqKCdAorLSShE9): computed in the browser, nothing stored. An
 * open proposal (or a live plan's step that has not run) may be stale when:
 *  - slot: its time slot (fields.start) has passed;
 *  - message: a message came in on the thread after it was written or last checked;
 *  - old: it was written or last checked more than 24 hours ago.
 * "Written" is the newest of: created, the last version (while proposed), the member's approval
 * (an approved plan step), the agent's last "still good" (checkedAt). The flag only offers a
 * Re-check; nothing runs by itself.
 */
import type { InboxOutcome, InboxThread } from './inbox';

export const STALE_AFTER_MS = 24 * 3_600_000;
export type StaleReason = 'slot' | 'message' | 'old';

type Ms = { toMillis(): number } | null | undefined;
const ms = (t: Ms) => (t ? t.toMillis() : 0);

export type StaleOutcomeOf = Pick<InboxOutcome, 'state' | 'fields'> & {
  createdAt?: Ms;
  updatedAt?: Ms;
  checkedAt?: Ms;
  versions?: readonly unknown[];
  decision?: { at?: Ms } | null;
};

/** When the proposal was last written or confirmed, in ms. */
export function freshAt(o: StaleOutcomeOf): number {
  return Math.max(
    ms(o.createdAt),
    ms(o.checkedAt),
    o.state === 'proposed' && (o.versions?.length ?? 0) > 1 ? ms(o.updatedAt) : 0,
    o.state === 'approved' ? ms(o.decision?.at) : 0,
  );
}

/** Why the proposal may be out of date, or null when it looks current. */
export function staleReason(
  o: StaleOutcomeOf,
  thread: Pick<InboxThread, 'lastMessageAt'> | { lastMessageAt?: Ms },
  nowMs: number,
): StaleReason | null {
  if (o.state !== 'proposed' && o.state !== 'approved') return null;
  const start = typeof o.fields.start === 'string' ? Date.parse(o.fields.start) : NaN;
  if (!Number.isNaN(start) && start <= nowMs) return 'slot';
  const at = freshAt(o);
  if (!at) return null;
  if (ms(thread.lastMessageAt as Ms) > at) return 'message';
  if (nowMs - at > STALE_AFTER_MS) return 'old';
  return null;
}

/** The reason as the chip's hover/tap text. */
export function staleText(reason: StaleReason, o: StaleOutcomeOf, nowMs: number): string {
  if (reason === 'slot') return 'Its time slot has passed';
  if (reason === 'message') return 'A newer message came in';
  const days = Math.max(1, Math.floor((nowMs - freshAt(o)) / 86_400_000));
  return `${days} ${days === 1 ? 'day' : 'days'} old`;
}
