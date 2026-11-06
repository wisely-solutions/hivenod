/**
 * The Re-check write behind WaitingView's bulk buttons and the "Re-check N" bar: one
 * requestRecheck per thread (one write, one agent turn each), after one 5 s Undo; a thread that
 * moved on since is skipped, a refused write does not hold up the others. Nothing polls.
 */
import { requestRecheck, type ActionPlan } from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { stash } from '../lib/pendingDecisions';
import { useCountdown, useToast } from '../ui/overlay';
import type { ThreadRow } from './logic';
import { errorText } from './parts';

export function useBulkRecheck(key: string, onCommit?: () => void) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const counting = useCountdown(key);
  const [error, setError] = useState<string | null>(null);

  function start(targets: readonly ThreadRow[], tag: string, now: number) {
    if (!targets.length || counting) return;
    setError(null);
    const plans: Array<{ wid: string; plan: ActionPlan }> = [];
    for (const t of targets) {
      const ctx = actionContext(t.wid);
      if (!ctx) continue;
      try {
        plans.push({
          wid: t.wid,
          plan: requestRecheck(ctx, { threadId: t.id, thread: { ...t.data }, nowMs: now }),
        });
      } catch {
        /* moved on since (no longer open, or already asked): skipped */
      }
    }
    if (!plans.length) return;
    // Kept across a reload until written, one entry per organization.
    const forgets = [...new Set(plans.map((p) => p.wid))].map((wid) =>
      stash(
        session.me.uid,
        wid,
        plans.filter((p) => p.wid === wid).map((p) => p.plan.ops),
        'Saved: Re-check asked',
      ),
    );
    const forget = () => forgets.forEach((f) => f());
    const n = plans.length;
    toast.push({
      message: `Re-check asked for ${n} thread${n === 1 ? '' : 's'}`,
      duration: 5000,
      countdown: {
        key,
        tag,
        announce: `Re-check asked for ${n} thread${n === 1 ? '' : 's'}. Undo available for 5 seconds`,
      },
      onUndo: forget,
      onCommit: () => {
        onCommit?.();
        void Promise.allSettled(plans.map((p) => run(p.plan))).then((res) => {
          forget();
          const failed = res.filter((r) => r.status === 'rejected');
          if (failed.length)
            setError(
              `${failed.length} of ${n} could not be asked: ${errorText((failed[0] as PromiseRejectedResult).reason)}`,
            );
        });
      },
    });
  }

  return { counting, error, start };
}
