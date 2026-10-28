/**
 * Groups feed gates: a gate stores the resolved `deciderUids` (people + group members), so saving
 * or deleting a group has to recompute them on every step that uses it (card 04, SPEC §5).
 */
import {
  ActionError,
  addDecidersOps,
  plan,
  randomId,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import { paths, type Step } from './schema';

/** How many projects fit in one batch: Firestore rules allow 20 document lookups per batch. */
export const PROJECTS_PER_BATCH = 6;

export interface GroupChange {
  groupId: string;
  /** Members before the change. */
  before: readonly string[];
  /** Members after the change (empty when the group is deleted). */
  after: readonly string[];
  deleted?: boolean;
  /** Current members of every other group, by id. */
  others: Readonly<Record<string, readonly string[]>>;
}

/**
 * The gate after a group change, or null when nothing changes.
 *
 * A gate keeps no separate list of directly chosen people, so a person who is both chosen directly
 * and in the group is treated as a group member: removing them from the group removes them from the
 * gate unless another group on the same gate still holds them.
 */
export function recomputeGate(step: Step, change: GroupChange): Step | null {
  const gate = step.gate;
  if (!gate || !gate.groupIds.includes(change.groupId)) return null;

  const stillCovered = new Set<string>();
  for (const gid of gate.groupIds) {
    if (gid !== change.groupId) for (const u of change.others[gid] ?? []) stillCovered.add(u);
  }
  const after = new Set(change.after);
  const dropped = new Set(change.before.filter((u) => !after.has(u) && !stillCovered.has(u)));

  const next = gate.deciderUids.filter((u) => !dropped.has(u));
  const have = new Set(next);
  for (const u of change.after) if (!have.has(u)) next.push(u);

  const groupIds = change.deleted
    ? gate.groupIds.filter((g) => g !== change.groupId)
    : gate.groupIds;
  const kept = new Set(next);
  const mustInclude = gate.mustInclude.filter((u) => kept.has(u));
  const n = next.length > 0 ? Math.min(gate.n, next.length) : gate.n;

  const same =
    next.length === gate.deciderUids.length &&
    next.every((u, i) => u === gate.deciderUids[i]) &&
    groupIds.length === gate.groupIds.length &&
    mustInclude.length === gate.mustInclude.length &&
    n === gate.n;
  if (same) return null;
  return { ...step, gate: { ...gate, deciderUids: next, groupIds, mustInclude, n } };
}

export interface ProjectSteps {
  id: string;
  steps: readonly Step[];
  /** The project's people now; when given, new deciders are added to them. */
  memberUids?: readonly string[];
}

/**
 * One plan per batch of projects. Each project gets its own `project.processChanged` event, because
 * the rules tie a project write to an event for that project. Returns [] when no gate uses the group.
 */
export function syncGroupDeciders(
  ctx: ActionContext,
  change: GroupChange,
  projects: readonly ProjectSteps[],
): ActionPlan[] {
  if (ctx.actor.type !== 'human') throw new ActionError('Only people can do this');
  const perProject: ActionPlan[] = [];
  for (const p of projects) {
    let touched = false;
    const steps = p.steps.map((s) => {
      const next = recomputeGate(s, change);
      if (next) touched = true;
      return next ?? s;
    });
    if (!touched) continue;
    const added = addDecidersOps(ctx, p.id, p.memberUids ?? [], steps);
    perProject.push(
      plan(
        ctx,
        'project.processChanged',
        { projectId: p.id },
        { reason: change.deleted ? 'group.deleted' : 'group.updated', groupId: change.groupId },
        (eventId): WriteOp[] => [
          {
            kind: 'update',
            path: paths.project(ctx.workspaceId, p.id),
            data: { steps, ...(p.memberUids ? added.data : {}), lastEventId: eventId },
          },
          ...(p.memberUids ? added.ops : []),
        ],
        (ctx.newId ?? randomId)(),
      ),
    );
  }
  const batches: ActionPlan[] = [];
  for (let i = 0; i < perProject.length; i += PROJECTS_PER_BATCH) {
    const slice = perProject.slice(i, i + PROJECTS_PER_BATCH);
    batches.push({ eventId: slice[0]!.eventId, ops: slice.flatMap((s) => s.ops) });
  }
  return batches;
}
