/**
 * Inbox plans (item qwFAWxZM5xkcE7PPjAzi): an agent proposes an ordered list of steps for a
 * thread instead of one outcome. Each step is an `inboxOutcomes` doc (with `planId`), so it keeps
 * everything an outcome has (registry type and fields, note, confidence, checks, versions, Ask
 * for changes, Edit on approve, carry_out, outcome_done). A small `inboxPlans/{pid}` doc holds the
 * order (`steps`, outcome ids) and whose turn it is (`cursor`). Steps run strictly in order: step
 * k is carried out only once steps 0..k-1 are done. A step of kind 'human' (type `approval`) is a
 * gate only the member decides, and only at its turn.
 *
 * This module is pure: the plan's schema, and what the UI and the thread show for a plan
 * (`planView`, `planThreadState`). The actions and rules come with them in inbox.ts and
 * firestore.rules.
 */
import { z } from 'zod';
import { timestamp } from './schema';
import { OUTCOME_CONFIDENCE, threadAfter, type InboxOutcome, type ThreadState } from './inbox';
import { outcomeKind, outcomeType, type OutcomeKind, type WaitingOn } from './outcomes';

export const PLAN_STATES = ['proposed', 'active', 'blocked', 'done', 'stopped'] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export const PLAN_LIMITS = {
  /** Steps per plan. */
  steps: 8,
  /** The plan's note, in characters (as an outcome's note). */
  note: 2000,
} as const;

export const inboxPlanSchema = z.object({
  memberUid: z.string(),
  threadId: z.string(),
  /** The agent that proposed it. */
  proposedBy: z.string(),
  /** The steps' outcome ids, in order. */
  steps: z.array(z.string()).min(1).max(PLAN_LIMITS.steps),
  /** The index of the step whose turn it is; steps.length once every step is through. */
  cursor: z.number().int().min(0).max(PLAN_LIMITS.steps),
  state: z.enum(PLAN_STATES),
  /** The agent's why for the whole plan. */
  note: z.string().max(PLAN_LIMITS.note),
  confidence: z.enum(OUTCOME_CONFIDENCE).nullable().optional(),
  createdAt: timestamp,
  updatedAt: timestamp,
  lastEventId: z.string(),
});
export type InboxPlan = z.infer<typeof inboxPlanSchema>;

/** What the views need of a plan and of its steps (listener data). */
export type PlanStateOf = Pick<InboxPlan, 'steps' | 'cursor' | 'state'>;
export type PlanOutcomeOf = Pick<InboxOutcome, 'type' | 'fields' | 'state'>;

/**
 * What a step shows (design table):
 * - proposed: not approved, not its turn;
 * - revising: the member asked the agent for changes;
 * - approved: approved, not yet its turn;
 * - running: approved at its turn (being carried out, or waiting until its date), or a Build it
 *   step waiting for its item;
 * - done;
 * - waitingForYou: its turn, and the member decides (a person step, or an agent step not
 *   approved yet);
 * - blocked: it failed (the member retries, skips or stops the plan);
 * - skipped: rejected (removed or skipped) while the plan went on;
 * - stopped: rejected with the plan.
 */
export type PlanStepUi =
  | 'proposed'
  | 'revising'
  | 'approved'
  | 'running'
  | 'done'
  | 'waitingForYou'
  | 'blocked'
  | 'skipped'
  | 'stopped';

export interface PlanStepView {
  /** 0-based position. */
  index: number;
  /** "3" of "3 of 5". */
  number: number;
  outcomeId: string;
  /** null while the step's outcome is not loaded. */
  outcome: PlanOutcomeOf | null;
  type: string | null;
  kind: OutcomeKind;
  label: string;
  ui: PlanStepUi;
  atCursor: boolean;
}
export interface PlanView {
  state: PlanState;
  cursor: number;
  total: number;
  /** Steps through (done or skipped). */
  through: number;
  steps: PlanStepView[];
  /** The step whose turn it is (null once the plan is through or stopped). */
  current: PlanStepView | null;
  /** The step that waits for the member, if the current one does. */
  waitingForYou: PlanStepView | null;
  /** "Step 3 of 5", or "Done" / "Stopped". */
  progress: string;
}

function stepUi(o: PlanOutcomeOf | null, atCursor: boolean, planState: PlanState): PlanStepUi {
  if (!o) return 'proposed';
  switch (o.state) {
    case 'done':
      return 'done';
    case 'failed':
      return 'blocked';
    case 'rejected':
      return planState === 'stopped' ? 'stopped' : 'skipped';
    case 'running':
      return 'running';
    case 'revising':
      return 'revising';
    case 'approved':
      return atCursor ? 'running' : 'approved';
    case 'proposed':
      return atCursor ? 'waitingForYou' : 'proposed';
  }
}

/** What the thread page and Today show of a plan. */
export function planView(
  plan: PlanStateOf,
  outcomes: Readonly<Record<string, PlanOutcomeOf | null | undefined>>,
): PlanView {
  const live = plan.state !== 'stopped' && plan.state !== 'done';
  const steps = plan.steps.map((oid, index): PlanStepView => {
    const o = outcomes[oid] ?? null;
    const atCursor = live && index === plan.cursor;
    const kind = o ? outcomeKind(o.type) : 'agent';
    return {
      index,
      number: index + 1,
      outcomeId: oid,
      outcome: o,
      type: o?.type ?? null,
      kind,
      label: o ? (outcomeType(o.type)?.label ?? o.type) : '…',
      ui: stepUi(o, atCursor, plan.state),
      atCursor,
    };
  });
  const current = steps.find((s) => s.atCursor) ?? null;
  const total = steps.length;
  const through = steps.filter((s) => s.ui === 'done' || s.ui === 'skipped').length;
  return {
    state: plan.state,
    cursor: plan.cursor,
    total,
    through,
    steps,
    current,
    waitingForYou: current?.ui === 'waitingForYou' ? current : null,
    progress:
      plan.state === 'stopped'
        ? 'Stopped'
        : current
          ? `Step ${current.number} of ${total}`
          : 'Done',
  };
}

/** A single outcome (no plan) drawn as a one-step plan (existing outcomes stay as they are). */
export function singlePlanView(outcomeId: string, outcome: PlanOutcomeOf): PlanView {
  const through = outcome.state === 'done' || outcome.state === 'rejected';
  return planView(
    {
      steps: [outcomeId],
      cursor: through ? 1 : 0,
      state:
        outcome.state === 'rejected'
          ? 'stopped'
          : outcome.state === 'done'
            ? 'done'
            : outcome.state === 'failed'
              ? 'blocked'
              : outcome.state === 'proposed' || outcome.state === 'revising'
                ? 'proposed'
                : 'active',
    },
    { [outcomeId]: outcome },
  );
}

export interface ThreadStateAfter {
  state: ThreadState;
  waiting: { on: WaitingOn; until: Date | null } | null;
}
const YOUR_CALL: ThreadStateAfter = { state: 'yourCall', waiting: null };

/**
 * The thread's state for a plan, set in every batch that changes the plan:
 * - stopped → investigating (the agent re-plans);
 * - the step at the cursor needs the member (a person step, an agent step not approved yet, or
 *   a failed step: retry, skip or stop) → yourCall;
 * - a Build it step running → waiting on the item;
 * - an approved snooze ("wait until") at the cursor → waiting until its date;
 * - another approved agent step at the cursor → the previous agent step's after-state (yourCall
 *   for the first one, like an approved single outcome);
 * - every step through → the last agent step's after-state (done if there is none).
 * Person steps and skipped steps have no after-state of their own: the one before them holds.
 */
export function planThreadState(
  plan: PlanStateOf,
  outcomes: Readonly<Record<string, PlanOutcomeOf | null | undefined>>,
): ThreadStateAfter {
  if (plan.state === 'stopped') return { state: 'investigating', waiting: null };
  const at = (i: number) => outcomes[plan.steps[i]!] ?? null;
  const before = (end: number): ThreadStateAfter | null => {
    for (let i = Math.min(end, plan.steps.length) - 1; i >= 0; i--) {
      const o = at(i);
      if (o && o.state === 'done' && outcomeKind(o.type) === 'agent')
        return threadAfter(o.type, o.fields);
    }
    return null;
  };
  if (plan.cursor >= plan.steps.length) return before(plan.steps.length) ?? afterDone;
  const o = at(plan.cursor);
  if (!o) return YOUR_CALL;
  if (o.state === 'running') return { state: 'waiting', waiting: { on: 'item', until: null } };
  if (o.state !== 'approved' || outcomeKind(o.type) === 'human') return YOUR_CALL;
  const t = outcomeType(o.type);
  if (t?.executor === 'none' && t.after.waitingOn === 'date') return threadAfter(o.type, o.fields);
  return before(plan.cursor) ?? YOUR_CALL;
}
const afterDone: ThreadStateAfter = { state: 'done', waiting: null };
