import { collection, doc, getDoc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../lib/db';

/** Where I stand in an organization, as far as I could tell. "unknown": a network or other error. */
export type Standing = 'member' | 'not-member' | 'unknown';

/**
 * Which organizations' busy blocks are stale: only those I am certainly not in (or that are gone).
 * An unknown standing (offline, error) deletes nothing.
 */
export function staleWorkspaceIds(
  blockWorkspaceIds: Iterable<string>,
  standing: Readonly<Record<string, Standing>>,
): string[] {
  return [...new Set(blockWorkspaceIds)].filter((w) => standing[w] === 'not-member');
}

/** Groups of at most `size` items (a write batch holds 500). */
export function chunks<T>(items: readonly T[], size = 400): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Am I a member of the organization? A missing or closed organization document means no. */
export async function standingIn(uid: string, wid: string): Promise<Standing> {
  try {
    const snap = await getDoc(doc(db, `workspaces/${wid}`));
    const roles = snap.exists()
      ? (snap.data().memberRoles as Record<string, unknown> | undefined)
      : undefined;
    return roles && uid in roles ? 'member' : 'not-member';
  } catch (e) {
    return (e as { code?: string }).code === 'permission-denied' ? 'not-member' : 'unknown';
  }
}

/**
 * Lazy self-cleanup (Inbox item 40jle): deletes my busy blocks of organizations I am no longer in
 * (left long ago, removed by an admin, deleted). The rules are the safety net: they refuse to
 * delete a block of an organization I am still in. Silent, idempotent, best effort. Returns how
 * many blocks it deleted.
 */
export async function cleanStaleBusy(uid: string): Promise<number> {
  const snap = await getDocs(collection(db, `users/${uid}/busy`));
  const byWorkspace = new Map<string, typeof snap.docs>();
  for (const d of snap.docs) {
    const w = d.data().workspaceId;
    if (typeof w !== 'string') continue;
    byWorkspace.set(w, [...(byWorkspace.get(w) ?? []), d]);
  }
  const standing: Record<string, Standing> = {};
  await Promise.all(
    [...byWorkspace.keys()].map(async (w) => {
      standing[w] = await standingIn(uid, w);
    }),
  );
  let deleted = 0;
  for (const w of staleWorkspaceIds(byWorkspace.keys(), standing)) {
    for (const part of chunks(byWorkspace.get(w)!)) {
      try {
        const batch = writeBatch(db);
        for (const d of part) batch.delete(d.ref);
        await batch.commit();
        deleted += part.length;
      } catch {
        // refused (still a member after all) or offline: leave it, the next visit tries again
      }
    }
  }
  return deleted;
}
