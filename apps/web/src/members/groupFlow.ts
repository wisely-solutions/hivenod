import {
  deleteGroup,
  projectSchema,
  saveGroup,
  syncGroupDeciders,
  type ActionContext,
  type ActionPlan,
  type Group,
  type ProjectSteps,
} from '@hive/shared';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/db';
import type { Row } from '../lib/live';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

export class PartialSyncError extends Error {}

async function loadProjects(workspaceId: string): Promise<ProjectSteps[]> {
  const snap = await getDocs(collection(db, `workspaces/${workspaceId}/projects`));
  const out: ProjectSteps[] = [];
  for (const d of snap.docs) {
    const r = projectSchema.safeParse(d.data({ serverTimestamps: 'estimate' }));
    if (r.success) out.push({ id: d.id, steps: r.data.steps, memberUids: r.data.memberUids });
  }
  return out;
}

function othersOf(groups: readonly Row<Group>[], groupId: string): Record<string, string[]> {
  return Object.fromEntries(
    groups.filter((g) => g.id !== groupId).map((g) => [g.id, g.data.memberUids]),
  );
}

/**
 * Saves a group, then recomputes `deciderUids` on every project step that uses it. The rules cap
 * how many documents one batch may touch, so projects go in small batches. If a later batch fails
 * the group itself is already saved; the error says so and saving again finishes the job.
 */
export async function saveGroupFlow(args: {
  run: Run;
  ctx: ActionContext;
  groups: readonly Row<Group>[];
  groupId?: string;
  name: string;
  memberUids: string[];
}): Promise<void> {
  const { run, ctx, groups } = args;
  const existing = args.groupId ? groups.find((g) => g.id === args.groupId) : undefined;
  const save = saveGroup(ctx, {
    groupId: args.groupId,
    name: args.name,
    memberUids: args.memberUids,
    isNew: !existing,
  });
  const projects = existing ? await loadProjects(ctx.workspaceId) : [];
  await run(save);
  if (!existing) return;
  const batches = syncGroupDeciders(
    ctx,
    {
      groupId: save.groupId,
      before: existing.data.memberUids,
      after: args.memberUids,
      others: othersOf(groups, save.groupId),
    },
    projects,
  );
  try {
    for (const b of batches) await run(b);
  } catch {
    throw new PartialSyncError('The group is saved, but some projects were not updated.');
  }
}

/** Takes the group off every gate that used it, then deletes it. */
export async function deleteGroupFlow(args: {
  run: Run;
  ctx: ActionContext;
  groups: readonly Row<Group>[];
  groupId: string;
}): Promise<void> {
  const { run, ctx, groups, groupId } = args;
  const existing = groups.find((g) => g.id === groupId);
  const projects = await loadProjects(ctx.workspaceId);
  const batches = syncGroupDeciders(
    ctx,
    {
      groupId,
      before: existing?.data.memberUids ?? [],
      after: [],
      deleted: true,
      others: othersOf(groups, groupId),
    },
    projects,
  );
  for (const b of batches) await run(b);
  await run(deleteGroup(ctx, { groupId }));
}

/** Removes a person from every group they are in, keeping gates in step. */
export async function removeFromGroupsFlow(args: {
  run: Run;
  ctx: ActionContext;
  groups: readonly Row<Group>[];
  uid: string;
}): Promise<void> {
  const { groups, uid } = args;
  let current = groups;
  for (const g of groups.filter((x) => x.data.memberUids.includes(uid))) {
    const memberUids = g.data.memberUids.filter((u) => u !== uid);
    await saveGroupFlow({ ...args, groups: current, groupId: g.id, name: g.data.name, memberUids });
    current = current.map((x) => (x.id === g.id ? { ...x, data: { ...x.data, memberUids } } : x));
  }
}
