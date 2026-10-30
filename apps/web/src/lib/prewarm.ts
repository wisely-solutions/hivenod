import { onAuthStateChanged } from 'firebase/auth';
import { doc, onSnapshot, type DocumentReference, type Query } from 'firebase/firestore';
import { paths } from '@hive/shared';
import { agentsQuery, myThreadsQuery } from '../shell/queries';
import { auth } from './app';
import { db } from './db';

/**
 * Starts the first screen's listeners as soon as Firebase is here (card CGPynEQY).
 *
 * The app learns what to load one step at a time: the profile names the organization, which has
 * its agents and the member's Inbox threads. Done by the screens, every step also waited for their
 * code to download and render, which on a slow phone put seconds between the steps. Here the same
 * chain runs on its own, right after the session is restored; the screens then attach to the very
 * same queries and Firestore serves them from these targets, with no second read.
 *
 * Every listener stops after a while: by then the screens hold their own. Errors are ignored
 * (a member removed meanwhile, a profile not created yet): the screens report their own.
 */
const KEEP_MS = 30_000;

export function prewarm(): void {
  const stops: Array<() => void> = [];
  const seen = new Set<string>();
  const listen = (
    key: string,
    target: Query | DocumentReference,
    next?: (snap: unknown) => void,
  ): void => {
    if (seen.has(key)) return;
    seen.add(key);
    const onNext = (snap: unknown) => next?.(snap);
    const stop =
      target.type === 'document'
        ? onSnapshot(target, { next: onNext, error: () => undefined })
        : onSnapshot(target, { next: onNext, error: () => undefined });
    stops.push(stop);
  };

  let first = true;
  const unsubAuth = onAuthStateChanged(auth, (user) => {
    if (!first) return;
    first = false;
    if (!user) return;
    performance.mark?.('hive:auth');
    const uid = user.uid;
    listen(`user:${uid}`, doc(db, paths.user(uid)), (snap) => {
      const wid = (snap as { data(): { workspaceId?: string } | undefined }).data()?.workspaceId;
      if (!wid) return;
      listen(`ws:${wid}`, doc(db, paths.workspace(wid)));
      listen(`agents:${wid}`, agentsQuery(wid));
      listen(`threads:${wid}:${uid}`, myThreadsQuery(wid, uid));
    });
  });

  setTimeout(() => {
    unsubAuth();
    stops.forEach((s) => s());
  }, KEEP_MS);
}
