import {
  MAX_MOVES_PER_SAVE,
  defaultGate,
  moveTargets,
  randomId,
  validateProcess,
  type ItemMove,
  type ProcessIssue,
  type Step,
  type StepKind,
} from '@hive/shared';

/** Steps as saved: an emptied optional text is the same as one never set (undefined vs ''). */
export function normalizeSteps(steps: readonly Step[]): Step[] {
  return steps.map((s) => {
    const { instructions, ...rest } = s;
    return instructions ? { ...rest, instructions } : rest;
  });
}

/** True when two step lists differ in anything the person would save. */
export function stepsDiffer(a: readonly Step[], b: readonly Step[]): boolean {
  return JSON.stringify(normalizeSteps(a)) !== JSON.stringify(normalizeSteps(b));
}

/** A step the person deleted that still held open items: they go to `target` when saved. */
export interface Removed {
  step: Step;
  /** Where it sat, so Restore puts it back. */
  index: number;
  itemIds: string[];
  target: string | null;
}

export const OUTPUT_CHOICES = [
  { id: 'html', label: 'HTML' },
  { id: 'pdf', label: 'PDF' },
  { id: 'link', label: 'Link' },
  { id: 'code', label: 'Code' },
  { id: 'text', label: 'Text' },
] as const;

/**
 * Mirrors firestore.rules gatesAllowed(): a gate's deciders change only by an admin, the project's
 * creator, or a current decider of that step. A step added in this draft may only start with an
 * empty gate, so a plain member cannot name themselves.
 */
export function canChangeGate(
  base: readonly Step[],
  stepId: string,
  who: { uid: string; isAdmin: boolean; createdBy: string },
): boolean {
  if (who.isAdmin || who.createdBy === who.uid) return true;
  const was = base.find((s) => s.id === stepId);
  return !!was?.gate?.deciderUids.includes(who.uid);
}

/** The uid a new gate starts with: the creator when they may name deciders, nobody otherwise. */
export function newStep(kind: StepKind, creatorUid: string | null): Step {
  const id = `s-${randomId(8)}`;
  return kind === 'human'
    ? {
        id,
        name: 'New decision',
        kind,
        description: '',
        gate: defaultGate(creatorUid ? [creatorUid] : []),
      }
    : { id, name: 'New step', kind, description: '' };
}

/** Switching kind keeps the text; a gate appears or goes. */
export function withKind(step: Step, kind: StepKind, creatorUid: string | null): Step {
  if (step.kind === kind) return step;
  const { gate: _gate, ...rest } = step;
  void _gate;
  return kind === 'human'
    ? { ...rest, kind, gate: step.gate ?? defaultGate(creatorUid ? [creatorUid] : []) }
    : { ...rest, kind };
}

export function insertAfter<T>(list: readonly T[], index: number | null, item: T): T[] {
  const at = index === null || index < 0 ? list.length : index + 1;
  return [...list.slice(0, at), item, ...list.slice(at)];
}

/** Moves and issues for the removed steps, given the steps that will be saved. */
export function planMoves(
  before: readonly Step[],
  after: readonly Step[],
  removed: readonly Removed[],
): { moves: ItemMove[]; issues: ProcessIssue[] } {
  const issues: ProcessIssue[] = [];
  const moves: ItemMove[] = [];
  for (const r of removed) {
    const ok = moveTargets(before, r.step.id, after).some((s) => s.id === r.target);
    if (!r.target || !ok) {
      const n = r.itemIds.length;
      issues.push({
        stepId: r.step.id,
        message: `Choose where the ${n} ${n === 1 ? 'item' : 'items'} on ${r.step.name} go.`,
      });
      continue;
    }
    for (const itemId of r.itemIds) moves.push({ itemId, toStepId: r.target });
  }
  if (moves.length > MAX_MOVES_PER_SAVE)
    issues.push({
      stepId: '',
      message: `One save can move up to ${MAX_MOVES_PER_SAVE} items. Remove fewer steps at a time.`,
    });
  return { moves, issues };
}

export function checkDraft(
  before: readonly Step[],
  steps: readonly Step[],
  removed: readonly Removed[],
) {
  const { moves, issues: moveIssues } = planMoves(before, steps, removed);
  return { moves, issues: [...validateProcess(steps), ...moveIssues] };
}
