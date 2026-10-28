import { applyPlan } from '@hive/shared/firestore';
import { beginOrgDelete, calendarPaths, paths, type ActionContext } from '@hive/shared';
import { collection, getCountFromServer, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * Deleting an organization for good (card 9jpb1Q4a), with no server: rules cannot delete a tree, so
 * an admin's browser does it, document by document, in batches.
 *
 *  1. `beginOrgDelete` flags the organization (deletingAt). From then on the rules let admins delete
 *     anything under it and refuse every new event, so nobody can add to it meanwhile.
 *  2. `purgeOrg` removes the contents, children before parents, the agents first (an agent token
 *     works only while its agent document exists, so this cuts every token off at once) and the
 *     organization's own document last (the admin's power comes from it).
 *  3. Interrupted at any point (tab closed, offline), nothing is lost or half-visible: the flag
 *     stays, the same walk resumes from whatever is left, and any admin can run it again.
 */

/** The few things the walk needs, so it can be tested without Firestore. */
export interface TreeStore {
  /** Ids of up to `max` documents directly in the collection. */
  list(collectionPath: string, max: number): Promise<string[]>;
  /** Deletes these documents (at most `BATCH`). */
  remove(docPaths: string[]): Promise<void>;
}

export const BATCH = 400;

/** Empties a collection (and, through `before`, what hangs below each of its documents). */
async function empty(
  store: TreeStore,
  col: string,
  before: ((docPath: string) => Promise<void>) | undefined,
  count: { n: number },
) {
  for (;;) {
    const ids = await store.list(col, BATCH);
    if (ids.length === 0) return;
    const docPaths = ids.map((id) => `${col}/${id}`);
    if (before) for (const p of docPaths) await before(p);
    await store.remove(docPaths);
    count.n += docPaths.length;
  }
}

/**
 * Empties the organization's calendar and, with each event, its busy block in the member's own
 * store (users/{uid}/busy/{wid}_{eventId}): the rules let the deleting admin remove those while the
 * organization is flagged. An event id starts with its member's uid (no underscore in a uid). A
 * block that is already gone is deleted again harmlessly, so a resumed walk is safe.
 */
async function purgeCalendar(store: TreeStore, wid: string, count: { n: number }) {
  const col = calendarPaths.events(wid);
  for (;;) {
    const ids = await store.list(col, BATCH / 2);
    if (ids.length === 0) return;
    const blocks = ids.map((id) => `users/${id.split('_')[0]}/busy/${wid}_${id}`);
    await store.remove([...blocks, ...ids.map((id) => `${col}/${id}`)]);
    count.n += ids.length;
  }
}

/** Deletes everything in the organization, then its document. Returns how many documents went. */
export async function purgeOrg(store: TreeStore, wid: string): Promise<number> {
  const base = paths.workspace(wid);
  const count = { n: 0 };
  const flat = (name: string) => empty(store, `${base}/${name}`, undefined, count);

  await flat('agents');
  await empty(store, `${base}/runs`, (run) => empty(store, `${run}/log`, undefined, count), count);
  await empty(
    store,
    `${base}/projects`,
    async (project) => {
      await empty(
        store,
        `${project}/items`,
        async (item) => {
          await empty(store, `${item}/attachments`, undefined, count);
          await empty(store, `${item}/messages`, undefined, count);
        },
        count,
      );
      await empty(store, `${project}/decisions`, undefined, count);
      await empty(store, `${project}/stepProposals`, undefined, count);
    },
    count,
  );
  await purgeCalendar(store, wid, count);
  for (const name of ['events', 'groups', 'invites', 'notified', 'members']) await flat(name);
  await store.remove([base]);
  return count.n + 1;
}

/** The real store: the signed-in admin's Firestore. */
export const firestoreStore: TreeStore = {
  async list(col, max) {
    const snap = await getDocs(query(collection(db, col), limit(max)));
    return snap.docs.map((d) => d.id);
  },
  async remove(docPaths) {
    await applyPlan(db, { ops: docPaths.map((path) => ({ kind: 'delete' as const, path })) });
  },
};

/** What will go, for the confirm screen. */
export interface OrgCounts {
  members: number;
  projects: number;
  items: number;
  /** Agents that can still connect: their tokens stop working. */
  agents: number;
}

export async function countOrg(wid: string, members: number): Promise<OrgCounts> {
  const base = paths.workspace(wid);
  const projects = await getDocs(collection(db, `${base}/projects`));
  const perProject = await Promise.all(
    projects.docs.map((p) => getCountFromServer(collection(db, `${base}/projects/${p.id}/items`))),
  );
  const agents = await getCountFromServer(
    query(collection(db, `${base}/agents`), where('revokedAt', '==', null)),
  );
  return {
    members,
    projects: projects.size,
    items: perProject.reduce((sum, c) => sum + c.data().count, 0),
    agents: agents.data().count,
  };
}

/** Flags the organization (if it is not yet) and removes everything. Safe to call again after a stop. */
export async function deleteOrg(ctx: ActionContext, alreadyFlagged: boolean): Promise<void> {
  if (!alreadyFlagged) await applyPlan(db, beginOrgDelete(ctx));
  await purgeOrg(firestoreStore, ctx.workspaceId);
  // Your own first-run checklist for it (the rules allow this once the organization is gone).
  // Other members' copies stay: a few bytes each, and only their owners can remove them.
  try {
    await applyPlan(db, {
      ops: [{ kind: 'delete', path: `users/${ctx.actor.id}/firstrun/${ctx.workspaceId}` }],
    });
  } catch {
    /* best effort */
  }
}
