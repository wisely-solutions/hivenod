/**
 * Plans on the thread page (item qwFAWxZM5xkcE7PPjAzi, slice 4): what the plan checklist needs
 * beside planView (packages/shared/src/plans.ts): the action input of a plan, the steps that may
 * still move, a step's one-line title, and the plan's main action (the phone sheet's button).
 */
import {
  outcomeKind,
  outcomeType,
  planView,
  type InboxOutcome,
  type InboxPlan,
  type PlanInput,
  type PlanStepView,
  type PlanView,
} from '@hive/shared';
import type { Row } from '../lib/live';
import type { Tone } from '../ui/badge';
import { dayLabel, hhmm } from '../today/logic';

/** A plan with its steps' outcomes, as the plan actions take it. */
export function planInputOf(
  plan: Row<InboxPlan>,
  outcomes: readonly Row<InboxOutcome>[],
): PlanInput {
  const by: Record<string, PlanInput['outcomes'][string]> = {};
  for (const o of outcomes) if (plan.data.steps.includes(o.id)) by[o.id] = o.data;
  return {
    planId: plan.id,
    plan: {
      memberUid: plan.data.memberUid,
      threadId: plan.data.threadId,
      steps: [...plan.data.steps],
      cursor: plan.data.cursor,
      state: plan.data.state,
    },
    outcomes: by,
  };
}

export const planLive = (state: InboxPlan['state']) =>
  state === 'proposed' || state === 'active' || state === 'blocked';

/** The first step that may still move or be removed (the one being carried out never moves). */
export function firstFree(pl: PlanInput): number {
  const id = pl.plan.steps[pl.plan.cursor];
  const st = id !== undefined ? pl.outcomes[id]?.state : undefined;
  const started = st === 'approved' || st === 'running' || st === 'failed';
  return pl.plan.cursor + (started ? 1 : 0);
}

const clip = (s: string, n = 60) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
function when(iso: unknown): string {
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${dayLabel(d)}, ${hhmm(d)}`;
}

/** A step's one-line title: what it does, from its fields. */
export function stepTitle(type: string | null, fields: Readonly<Record<string, unknown>>): string {
  switch (type) {
    case 'reply':
      return str(fields.text) ? `Reply: “${clip(str(fields.text), 50)}”` : 'Reply';
    case 'reply_book':
      return `Reply and book ${when(fields.start)}`.trim();
    case 'book':
      return `Book ${when(fields.start)}`.trim();
    case 'approval':
      return `You approve: ${clip(str(fields.what))}`;
    case 'make_it_work':
      return str(fields.title) ? `Build it: ${clip(str(fields.title))}` : 'Build it';
    case 'handover':
      return `Hand over to ${clip(str(fields.to), 40)}`;
    case 'snooze':
      return `Wait until ${when(fields.until)}`.trim();
    case 'nudge':
      return str(fields.text) ? `Nudge: “${clip(str(fields.text), 50)}”` : 'Nudge';
    case null:
      return '…';
    default:
      return outcomeType(type)?.label ?? type;
  }
}

/** The state word on a step's pill. */
export const STEP_UI_TEXT: Record<PlanView['steps'][number]['ui'], string> = {
  proposed: 'Proposed',
  revising: 'Revising…',
  approved: 'Approved',
  running: 'Running',
  done: 'Done',
  waitingForYou: 'Waiting for you',
  blocked: 'Blocked',
  skipped: 'Skipped',
  stopped: 'Stopped',
};

/** "1 approved · 1 needs you on the way" for a plan being decided. */
export function planSummary(pl: PlanInput): string {
  const ids = pl.plan.steps;
  const approved = ids.filter((id) => pl.outcomes[id]?.state === 'approved').length;
  const done = ids.filter((id) => pl.outcomes[id]?.state === 'done').length;
  const gates = ids.filter(
    (id) =>
      pl.outcomes[id] &&
      outcomeKind(pl.outcomes[id]!.type) === 'human' &&
      pl.outcomes[id]!.state === 'proposed',
  ).length;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (approved) parts.push(`${approved} approved`);
  if (gates) parts.push(`${gates} ${gates === 1 ? 'needs' : 'need'} you on the way`);
  return parts.join(' · ');
}

export type PlanMain =
  | { kind: 'approvePlan' }
  | { kind: 'step'; index: number; outcomeId: string; gate: boolean }
  | { kind: 'retry'; index: number }
  | null;

/**
 * The plan's main action: Retry a blocked step; Approve plan while the plan is proposed and
 * agent steps wait; the step at its turn that waits for the member (a gate, or an agent step not
 * approved yet); else Approve plan while agent steps still wait.
 */
export function planMain(pl: PlanInput): PlanMain {
  const v = planView(pl.plan, pl.outcomes);
  if (v.state === 'blocked' && v.current) return { kind: 'retry', index: v.current.index };
  const agentWaits = v.steps.some((s) => s.kind === 'agent' && s.outcome?.state === 'proposed');
  if (v.state === 'proposed' && agentWaits) return { kind: 'approvePlan' };
  if (v.waitingForYou && v.waitingForYou.outcome?.state === 'proposed')
    return {
      kind: 'step',
      index: v.waitingForYou.index,
      outcomeId: v.waitingForYou.outcomeId,
      gate: v.waitingForYou.kind === 'human',
    };
  if (planLive(v.state) && agentWaits) return { kind: 'approvePlan' };
  return null;
}

/** Whether the member has something to decide on the plan (it then needs the panel open). */
export function planWaits(pl: PlanInput): boolean {
  return planMain(pl) !== null;
}

/** How each step state is drawn: its pill tone, number circle and progress bar segment. */
export const PILL: Record<PlanStepView['ui'], Tone> = {
  proposed: 'neutral',
  revising: 'agent',
  approved: 'approve',
  running: 'agent',
  done: 'approve',
  waitingForYou: 'gate',
  blocked: 'sendback',
  skipped: 'neutral',
  stopped: 'neutral',
};
export const CIRCLE: Record<PlanStepView['ui'], string> = {
  proposed: 'border-line-strong text-text-2',
  revising: 'border-dashed border-agent text-agent',
  approved: 'border-approve text-approve-text',
  running: 'border-agent text-agent',
  done: 'border-approve-solid bg-approve-solid text-on-solid',
  waitingForYou: 'border-gate bg-gate text-on-gate',
  blocked: 'border-sendback text-sendback',
  skipped: 'border-line text-text-3 line-through',
  stopped: 'border-line text-text-3',
};
export const BAR: Record<PlanStepView['ui'], string> = {
  proposed: 'bg-line',
  revising: 'bg-agent/40',
  approved: 'border border-approve bg-transparent',
  running: 'bg-agent',
  done: 'bg-approve-solid',
  waitingForYou: 'bg-gate',
  blocked: 'bg-sendback',
  skipped: 'bg-line',
  stopped: 'bg-line',
};
