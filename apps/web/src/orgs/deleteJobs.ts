import type { ActionContext } from '@hive/shared';
import { useEffect, useSyncExternalStore } from 'react';
import { useReady } from '../auth/context';
import { useToast } from '../ui/overlay';
import { deleteOrg } from './deleteOrg';
import { useOrgs } from './data';

/**
 * Organization deletions running in this tab (card 9jpb1Q4a). A job belongs to the page, not to a
 * screen: the admin is moved out of the organization the moment it is flagged, so the screen that
 * started it is gone long before it finishes.
 */
const running = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
// A new array only when the set changes, so useSyncExternalStore stays quiet in between.
let snapshot: readonly string[] = [];
const getSnapshot = () => snapshot;

/** Ids of the organizations this tab is deleting right now. */
export function useDeleting(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type Notify = (message: string) => void;

/** Starts (or restarts after a stop) the deletion; resolves when it ended. One job per organization. */
export async function runOrgDelete(
  ctx: ActionContext,
  name: string,
  flagged: boolean,
  notify: Notify,
): Promise<void> {
  const wid = ctx.workspaceId;
  if (running.has(wid)) return;
  running.add(wid);
  snapshot = [...running];
  emit();
  try {
    await deleteOrg(ctx, flagged);
    notify(`${name} was deleted.`);
  } catch {
    notify(`Deleting ${name} stopped. Open Organization settings and choose Continue.`);
    throw new Error('delete stopped');
  } finally {
    running.delete(wid);
    snapshot = [...running];
    emit();
  }
}

/**
 * An interrupted deletion carries on by itself: when this person is an admin of an organization
 * that is flagged and nothing in this tab is erasing it, start again (once per page load; the
 * Continue button is the retry). Mounted once, inside the app.
 */
const tried = new Set<string>();
export function useResumeOrgDeletes() {
  const { session, actionContext } = useReady();
  const toast = useToast();
  const orgs = useOrgs(session.me.uid, session.profile.workspaceIds);
  useEffect(() => {
    for (const o of orgs) {
      if (!o.deleting || o.role !== 'admin' || tried.has(o.id) || running.has(o.id)) continue;
      tried.add(o.id);
      const ctx = actionContext(o.id);
      if (ctx)
        void runOrgDelete(ctx, o.name, true, (m) => toast.push({ message: m })).catch(
          () => undefined,
        );
    }
  }, [orgs, actionContext, toast]);
}
