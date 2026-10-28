import type { WriteOp } from '@hive/shared';
import { eventPath, forget, keepPlans, setBusy, type Stashed } from './pendingDecisions';

/** Firestore codes that will never succeed on a retry: the item moved on or the rules refuse it. */
const PERMANENT = new Set([
  'permission-denied',
  'failed-precondition',
  'not-found',
  'already-exists',
  'invalid-argument',
  'out-of-range',
]);
export const isRefused = (e: unknown): boolean =>
  PERMANENT.has((e as { code?: string } | null)?.code ?? '');

export interface ReplayIo {
  /** Writes one plan; rejects with the Firestore error when it fails. */
  apply: (ops: WriteOp[]) => Promise<void>;
  /** True when the plan's event document exists (the plan already landed). */
  exists: (path: string) => Promise<boolean>;
}

/**
 * Replays one stashed decision. The entry is removed only once every plan is confirmed by the
 * server (written, or proven already landed) or refused for good. A failure that may pass
 * (network, a killed page, a chunk hiccup) keeps the entry, so the next load tries again.
 * Returns what to tell the person: 'saved', 'refused' (the item had already changed), or
 * 'kept' (nothing to say yet; will retry).
 */
export async function replayStashed(
  uid: string,
  ws: string,
  s: Stashed,
  io: ReplayIo,
): Promise<{ saved: number; refused: number; kept: number }> {
  setBusy(s.id, true);
  try {
    const landed = async (ops: WriteOp[]) => {
      const path = eventPath(ops);
      if (!path) return false;
      try {
        return await io.exists(path);
      } catch {
        return false;
      }
    };
    const outcomes = await Promise.all(
      s.plans.map(async (ops): Promise<'saved' | 'refused' | 'kept'> => {
        if (await landed(ops)) return 'saved';
        try {
          await io.apply(ops);
          return 'saved';
        } catch (e) {
          if (!isRefused(e)) return 'kept';
          // A refusal can also mean it landed in the meantime (events are create-only).
          return (await landed(ops)) ? 'saved' : 'refused';
        }
      }),
    );
    const keptPlans = s.plans.filter((_, i) => outcomes[i] === 'kept');
    if (keptPlans.length === 0) forget(uid, ws, s.id);
    else if (keptPlans.length < s.plans.length) keepPlans(uid, ws, s.id, keptPlans);
    const count = (k: string) => outcomes.filter((o) => o === k).length;
    return { saved: count('saved'), refused: count('refused'), kept: keptPlans.length };
  } finally {
    setBusy(s.id, false);
  }
}
