/**
 * The "Personal" organization (Inbox item fJnu6, design 2026-10-28-hivenod-inbox-design): a member's
 * own organization with no development projects, for their Inbox only. Their personal
 * agent joins it with scope 'inbox' (Inbox only) and brings in their own requests there.
 *
 * It is created exactly as the app creates an organization (`createWorkspace`: the workspace doc,
 * the member's card and a `workspace.created` event in one batch), and it is added to the person's
 * switcher (`workspaceIds`). Unlike the app, it does not switch the person to it: an operator
 * creates it for them, and they open it when they want. Pure; the operator command is
 * `notifier personal-org` (packages/notifier/src/personalOrg.ts).
 */
import {
  ActionError,
  arrayUnion,
  createWorkspace,
  type ActionContext,
  type ActionPlan,
  type ProfileInput,
} from './actions';
import { paths } from './schema';

export const PERSONAL_ORG_NAME = 'Personal';

export interface OrgSummary {
  id: string;
  name: string;
  ownerUid: string;
}

/** The person's own organization with this name, if they already have one (so it is not made twice). */
export function existingPersonalOrg(
  orgs: readonly OrgSummary[],
  uid: string,
  name: string = PERSONAL_ORG_NAME,
): OrgSummary | null {
  const want = name.trim().toLowerCase();
  return orgs.find((o) => o.ownerUid === uid && o.name.trim().toLowerCase() === want) ?? null;
}

/**
 * The batch that creates the Personal organization for `ctx.actor` (a person), with
 * `ctx.workspaceId` as its id: what the app writes, plus the switcher entry.
 */
export function personalOrgPlan(
  ctx: ActionContext,
  input: { profile: ProfileInput; name?: string },
): ActionPlan & { workspaceId: string } {
  if (ctx.actor.type !== 'human')
    throw new ActionError('A Personal organization belongs to a person');
  const name = (input.name ?? PERSONAL_ORG_NAME).trim();
  if (!name || name.length > 120) throw new ActionError('The name is 1 to 120 characters');
  const p = createWorkspace(ctx, { name, profile: input.profile });
  return {
    ...p,
    ops: [
      ...p.ops,
      {
        kind: 'update',
        path: paths.user(ctx.actor.id),
        data: { workspaceIds: arrayUnion(ctx.workspaceId) },
      },
    ],
  };
}
