import {
  deleteGroup,
  saveGroup,
  type ActionContext,
  type ActionPlan,
  type Group,
} from '@hive/shared';
import type { Row } from '../lib/live';

type Run = (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;

/**
 * Saves a group. (Groups no longer feed project gates' deciders: Projects were removed, item
 * OE8FmrTaIxFVGcaeGG3N, slice 11.)
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
  await run(
    saveGroup(ctx, {
      groupId: args.groupId,
      name: args.name,
      memberUids: args.memberUids,
      isNew: !existing,
    }),
  );
}

/** Deletes a group. */
export async function deleteGroupFlow(args: {
  run: Run;
  ctx: ActionContext;
  groupId: string;
}): Promise<void> {
  await args.run(deleteGroup(args.ctx, { groupId: args.groupId }));
}

/** Removes a person from every group they are in. */
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
