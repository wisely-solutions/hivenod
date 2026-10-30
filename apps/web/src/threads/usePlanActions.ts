/**
 * The member's decisions on a plan (item qwFAWxZM5xkcE7PPjAzi), shared by the thread page's plan
 * checklist and the Today card: each counts down with Undo (one countdown per plan), then
 * writes. `onDone` follows a write that went through (Today's one-line done row).
 */
import {
  approveOutcome,
  approveStepAsk,
  markStepDone,
  approvePlan,
  editPlan,
  rejectOutcome,
  rejectPlan,
  retryPlanStep,
  sendBackPlan,
  skipPlanStep,
  stopPlan,
  type ActionPlan,
  type InboxThread,
  type PlanEdit,
  type PlanInput,
  type PlanStepView,
  type SendBackOf,
} from '@hive/shared';
import { useState } from 'react';
import { useReady } from '../auth/context';
import type { Row } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import { useCountdown, useToast } from '../ui/overlay';
import { errorText } from './parts';

export function usePlanActions(
  wid: string,
  thread: Row<InboxThread>,
  pl: PlanInput & { plan: SendBackOf },
  onDone?: (label: string) => void,
) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const key = `ip:${wid}:${pl.planId}`;
  const counting = useCountdown(key);
  const [error, setError] = useState<string | null>(null);

  function commit(make: () => Pick<ActionPlan, 'ops'>, message: string, done: string) {
    const ctx = actionContext(wid);
    if (!ctx || counting) return;
    setError(null);
    let p: Pick<ActionPlan, 'ops'>;
    try {
      p = make();
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const forget = stash(session.me.uid, wid, [p.ops], `Saved: ${done}`);
    toast.push({
      message,
      undoLabel: 'Undo',
      duration: 5000,
      countdown: { key, tag: message, announce: `${message}. Undo available for 5 seconds` },
      onUndo: forget,
      onCommit: () => {
        run(p).then(
          () => {
            forget();
            onDone?.(done);
          },
          (e: unknown) => {
            forget();
            setError(errorText(e));
          },
        );
      },
    });
  }
  const ctx = () => {
    const c = actionContext(wid);
    if (!c) throw new Error('Not signed in.');
    return c;
  };
  const th = () => ({ ...thread.data });
  return {
    counting,
    error,
    edit: (e: PlanEdit, message: string) =>
      commit(() => editPlan(ctx(), { ...pl, thread: th(), edit: e }), message, `Plan · ${message}`),
    approveAll: () =>
      commit(() => approvePlan(ctx(), { ...pl, thread: th() }), 'Plan approved', 'Plan approved'),
    rejectAll: () =>
      commit(() => rejectPlan(ctx(), { ...pl, thread: th() }), 'Plan rejected', 'Plan rejected'),
    /** A gate: Approve (pinning the summary version on screen, slice 6) or Not approved. */
    gate: (s: Pick<PlanStepView, 'outcomeId' | 'number'>, yes: boolean, summaryVersion?: number) =>
      commit(
        () =>
          yes
            ? approveOutcome(ctx(), {
                outcomeId: s.outcomeId,
                outcome: pl.outcomes[s.outcomeId]!,
                thread: th(),
                plan: pl,
                ...(summaryVersion ? { summaryVersion } : {}),
              })
            : rejectOutcome(ctx(), {
                outcomeId: s.outcomeId,
                outcome: pl.outcomes[s.outcomeId]!,
                thread: th(),
                othersPending: false,
                plan: pl,
              }),
        yes ? `Step ${s.number} approved` : `Step ${s.number} not approved: the plan stops`,
        yes ? `Approved step ${s.number}` : `Not approved: step ${s.number}`,
      ),
    /** Ask for changes on a gate (slice 6): the plan goes back to an earlier step, with the text. */
    sendBack: (reason: string, toStep: number) =>
      commit(
        () => sendBackPlan(ctx(), { ...pl, thread: th(), reason, toStep }),
        `Sent back to step ${toStep + 1}`,
        `Sent back to step ${toStep + 1}`,
      ),
    /** Their reply: approve the drafted message (maybe edited), or count the step as done. */
    approveAsk: (s: Pick<PlanStepView, 'outcomeId' | 'number'>, label: string, text?: string) =>
      commit(
        () =>
          approveStepAsk(ctx(), {
            outcomeId: s.outcomeId,
            outcome: pl.outcomes[s.outcomeId]!,
            thread: th(),
            plan: pl,
            text: text ?? null,
          }),
        `${label} approved`,
        `${label} approved`,
      ),
    markDone: (s: Pick<PlanStepView, 'outcomeId' | 'number'>) =>
      commit(
        () =>
          markStepDone(ctx(), {
            outcomeId: s.outcomeId,
            outcome: pl.outcomes[s.outcomeId]!,
            thread: th(),
            plan: pl,
          }),
        `Step ${s.number} marked done`,
        `Marked step ${s.number} done`,
      ),
    retry: () => commit(() => retryPlanStep(ctx(), { ...pl, thread: th() }), 'Retrying', 'Retry'),
    skip: () =>
      commit(() => skipPlanStep(ctx(), { ...pl, thread: th() }), 'Step skipped', 'Skipped a step'),
    stop: () =>
      commit(() => stopPlan(ctx(), { ...pl, thread: th() }), 'Plan stopped', 'Plan stopped'),
  };
}
