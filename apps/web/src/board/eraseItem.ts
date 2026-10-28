import { applyPlan } from '@hive/shared/firestore';
import {
  beginItemErase,
  finishItemErase,
  paths,
  type ActionContext,
  type ItemState,
} from '@hive/shared';
import { collection, getDocs, limit, query, where } from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * Deleting an item for good, with no server: rules cannot delete a tree, so the person's browser
 * does it in chunks (same approach as the organization delete). `beginItemErase` flags the item,
 * the walk below removes its log lines, runs, messages and files (log lines first, so a run is
 * only deleted once nothing hangs below it), `finishItemErase` removes the item. Interrupted at any
 * point the flag stays and the same walk resumes; running it twice is harmless.
 */

export const ERASE_BATCH = 400;

/** The few things the walk needs, so it can be tested without Firestore. */
export interface ItemEraseStore {
  /** Ids of up to `max` documents directly in the collection. */
  list(collectionPath: string, max: number): Promise<string[]>;
  /** Ids of up to `max` runs of this item. */
  listRuns(max: number): Promise<string[]>;
  /** Deletes these documents (at most `ERASE_BATCH`). */
  remove(docPaths: string[]): Promise<void>;
}

/** Removes everything below the item. Returns how many documents went. */
export async function eraseItemHistory(
  store: ItemEraseStore,
  wid: string,
  pid: string,
  iid: string,
): Promise<number> {
  let n = 0;
  const empty = async (col: string) => {
    for (;;) {
      const ids = await store.list(col, ERASE_BATCH);
      if (ids.length === 0) return;
      await store.remove(ids.map((id) => `${col}/${id}`));
      n += ids.length;
    }
  };
  for (;;) {
    const runs = await store.listRuns(ERASE_BATCH);
    if (runs.length === 0) break;
    for (const r of runs) await empty(`${paths.run(wid, r)}/log`);
    await store.remove(runs.map((r) => paths.run(wid, r)));
    n += runs.length;
  }
  await empty(`${paths.item(wid, pid, iid)}/messages`);
  await empty(`${paths.item(wid, pid, iid)}/attachments`);
  return n;
}

function firestoreStore(wid: string, pid: string, iid: string): ItemEraseStore {
  return {
    async list(col, max) {
      const snap = await getDocs(query(collection(db, col), limit(max)));
      return snap.docs.map((d) => d.id);
    },
    async listRuns(max) {
      const snap = await getDocs(
        query(
          collection(db, `${paths.workspace(wid)}/runs`),
          where('projectId', '==', pid),
          where('itemId', '==', iid),
          limit(max),
        ),
      );
      return snap.docs.map((d) => d.id);
    },
    async remove(docPaths) {
      await applyPlan(db, { ops: docPaths.map((path) => ({ kind: 'delete' as const, path })) });
    },
  };
}

/** Flags the item (if it is not yet), erases its history, deletes it. Safe to call again after a stop. */
export async function eraseItem(
  ctx: ActionContext,
  input: { projectId: string; itemId: string; item: ItemState & { erasing?: boolean } },
): Promise<void> {
  const { projectId, itemId, item } = input;
  if (!item.erasing) await applyPlan(db, beginItemErase(ctx, { projectId, itemId, item }));
  await eraseItemHistory(
    firestoreStore(ctx.workspaceId, projectId, itemId),
    ctx.workspaceId,
    projectId,
    itemId,
  );
  await applyPlan(db, finishItemErase(ctx, { projectId, itemId, title: item.title }));
}
