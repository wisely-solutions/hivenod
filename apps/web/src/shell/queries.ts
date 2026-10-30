import { collection, query, where } from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * The queries behind the shell's live feeds. Shared by the shell (shell/data.tsx) and the early
 * start (lib/prewarm.ts): Firestore serves listeners of the same query from one target, so the
 * early listeners and the shell's own ones must build exactly these.
 */
export const agentsQuery = (wid: string) => query(collection(db, `workspaces/${wid}/agents`));

/** The member's Inbox threads (Today's list starts from these). */
export const myThreadsQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/inboxThreads`), where('memberUid', '==', uid));
