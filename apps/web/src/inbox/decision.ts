import {
  ActionError,
  answer,
  approve,
  evaluateGate,
  nextOnPath,
  stop,
  shapesNewItems,
  triageFinding,
  MIN_REASON_CHARS,
  type ActionContext,
  type ActionPlan,
} from '@hive/shared';
import type { InboxEntry } from './logic';
import { waitedMs } from '../insights/logic';

/**
 * The one-tap outcomes: Approve moves on; Iterate sends it back to a chosen step with a comment (the send-back
 * dialog, build 12); Reject drops it. Reject needs a reason (10+ characters) until João says
 * otherwise (card YHCZnF1M: "mandatory vs optional to be confirmed"; reason required is safest).
 */
export type Decision =
  | { kind: 'approve'; rationale: string }
  | { kind: 'reject'; rationale: string }
  | { kind: 'answer'; text: string }
  | { kind: 'intake' }
  | { kind: 'dismiss'; reason: string };

/** Shown during the Undo window of a final approval, before it is written. */
export function releasingMessage(title: string): string {
  return `Releasing \u201c${title}\u201d\u2026`;
}

/** The name of the step suggestions are added to (the project's first step). */
export function firstStepName(project: { steps: readonly { name: string }[] }): string {
  return project.steps[0]?.name ?? 'the first step';
}

export interface Prepared {
  plan: Pick<ActionPlan, 'ops'>;
  /** What the toast says once it is queued. */
  message: string;
  /** A final approval: what the toast says during the Undo window ("Releasing…"); `message` is shown when it commits. */
  pending?: string;
}

/** Plain-words problem with the input, or null when it can be sent. */
export function decisionProblem(d: Decision): string | null {
  const need = (t: string, what: string) =>
    t.trim().length < MIN_REASON_CHARS
      ? `${what} (at least ${MIN_REASON_CHARS} characters).`
      : null;
  switch (d.kind) {
    case 'reject':
      return need(d.rationale, 'Say why you are dropping it');
    case 'dismiss':
      return need(d.reason, 'Say why you are dismissing it');
    case 'answer':
      return d.text.trim() ? null : 'Write an answer.';
    default:
      return null;
  }
}

export function prepareDecision(ctx: ActionContext, entry: InboxEntry, d: Decision): Prepared {
  const problem = decisionProblem(d);
  if (problem) throw new ActionError(problem);
  const { project, item, pid, itemId } = entry;
  const base = { project, projectId: pid, itemId, item, waitedMs: waitedMs(item) };
  switch (d.kind) {
    case 'approve': {
      const p = approve(ctx, { ...base, rationale: d.rationale.trim() });
      const step = project.steps.find((s) => s.id === item.stepId);
      // The next step on the item's real path: skipped steps are passed over (same rule as approve()).
      const to = nextOnPath(project, item);
      let message: string;
      let pending: string | undefined;
      if (p.advanced && !to) pending = releasingMessage(item.title);
      if (p.advanced)
        message = to
          ? `Approved. Moved to ${to.name}.`
          : `Released. \u201c${item.title}\u201d is done.`;
      else {
        const left = step
          ? evaluateGate(
              step,
              [...Object.keys(item.gate?.approvals ?? {}), ctx.actor.id],
              item.gate?.rejections ?? {},
            ).remaining
          : 1;
        message = `Approved by you. Waiting for ${left} more.`;
      }
      return { plan: p, message, pending };
    }
    case 'reject': {
      const p = stop(ctx, { ...base, rationale: d.rationale.trim() });
      return {
        plan: p,
        message: p.moved
          ? 'Rejected. The item is dropped.'
          : 'Reject recorded. Waiting for the others.',
      };
    }
    case 'answer': {
      if (!entry.question) throw new ActionError('There is no question to answer');
      return {
        plan: answer(ctx, {
          projectId: pid,
          itemId,
          item,
          questionId: entry.question.id,
          text: d.text.trim(),
        }),
        message: 'Answer sent.',
      };
    }
    case 'intake':
    case 'dismiss':
      return {
        plan: triageFinding(ctx, {
          project,
          projectId: pid,
          itemId,
          finding: item,
          outcome: d.kind === 'intake' ? 'intake' : 'dismissed',
          reason: d.kind === 'dismiss' ? d.reason.trim() : undefined,
          newType: 'task',
          unshaped: shapesNewItems(project),
        }),
        message:
          d.kind === 'intake'
            ? `Added to ${firstStepName(project)} as a task. Agents can pick it up now.`
            : 'Suggestion dismissed.',
      };
  }
}
