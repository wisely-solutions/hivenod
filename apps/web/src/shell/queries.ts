import { collection, collectionGroup, orderBy, query, where } from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * The queries behind the shell's live feeds. Shared by the shell (shell/data.tsx) and the early
 * start (lib/prewarm.ts): Firestore serves listeners of the same query from one target, so the
 * early listeners and the shell's own ones must build exactly these.
 */
export const OPEN_STATUSES = ['queued', 'working', 'waiting', 'suggested'];

/** Every project of the organization (admins). */
export const allProjectsQuery = (wid: string) => collection(db, `workspaces/${wid}/projects`);

/** The projects a member was added to (the rules allow nothing wider). */
export const myProjectsQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/projects`), where('memberUids', 'array-contains', uid));

export const agentsQuery = (wid: string) => query(collection(db, `workspaces/${wid}/agents`));

/** One project's open items and suggestions. */
export const openItemsQuery = (wid: string, pid: string) =>
  query(
    collection(db, `workspaces/${wid}/projects/${pid}/items`),
    where('status', 'in', OPEN_STATUSES),
  );

/** One project's agent questions nobody has answered yet. */
export const openQuestionsQuery = (wid: string, pid: string) =>
  query(
    collectionGroup(db, 'messages'),
    where('workspaceId', '==', wid),
    where('projectId', '==', pid),
    where('kind', '==', 'question'),
    where('answered', '==', false),
    orderBy('at', 'asc'),
  );
