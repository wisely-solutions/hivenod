/**
 * Inbox data (item 4PEHrOW5IfXBQWgOK9wo, part 3). Every query is the member's own: it filters on
 * memberUid == me, which is also all the rules let a member read (docs/INBOX.md, "Rules").
 */
import { useMemo } from 'react';
import { useReady } from '../auth/context';
import { useOrgs } from '../orgs/data';
import {
  inboxEventSchema,
  inboxMessageSchema,
  inboxOutcomeSchema,
  inboxPaths,
  inboxRelationSchema,
  inboxSubjectSchema,
  inboxThreadSchema,
  type InboxMessage,
  type InboxRelation,
  type InboxSubject,
  type InboxThread,
} from '@hive/shared';
import { collection, onSnapshot, query, where, type Query } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { db } from '../lib/db';
import { useLiveDoc, useLiveQuery } from '../lib/live';
import { countWaitingThreads, subjectRows, type ThreadRow } from './logic';

export const mySubjectsQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/inboxSubjects`), where('memberUid', '==', uid));
export const myThreadsQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/inboxThreads`), where('memberUid', '==', uid));
export const myMessagesQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/inboxMessages`), where('memberUid', '==', uid));
export const myRelationsQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/inboxRelations`), where('memberUid', '==', uid));
const threadMessagesQuery = (wid: string, uid: string, tid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxMessages`),
    where('memberUid', '==', uid),
    where('threadId', '==', tid),
  );
const threadOutcomesQuery = (wid: string, uid: string, tid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxOutcomes`),
    where('memberUid', '==', uid),
    where('threadId', '==', tid),
  );
const threadEventsQuery = (wid: string, uid: string, tid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxEvents`),
    where('memberUid', '==', uid),
    where('threadId', '==', tid),
  );
const subjectThreadsQuery = (wid: string, uid: string, sid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxThreads`),
    where('memberUid', '==', uid),
    where('subjectId', '==', sid),
  );
const subjectEventsQuery = (wid: string, uid: string, sid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxEvents`),
    where('memberUid', '==', uid),
    where('subjectId', '==', sid),
  );

type Part<T> = { state: 'loading' } | { state: 'ready'; rows: T[] } | { state: 'error' };

/** One listener per workspace, merged; an error in one workspace keeps the others. */
export function useAcross<S extends z.ZodType, T>(
  name: string,
  wids: readonly string[],
  uid: string,
  build: (wid: string, uid: string) => Query,
  schema: S,
  map: (wid: string, id: string, d: z.infer<S>) => T,
  enabled = true,
): { state: 'loading' | 'ready' | 'error'; rows: T[] } {
  const key = enabled ? `${name}|${uid}|${wids.join(',')}` : '';
  const [parts, setParts] = useState<{ key: string; by: Record<string, Part<T>> }>({
    key: '',
    by: {},
  });
  useEffect(() => {
    if (!key) return;
    const set = (wid: string, p: Part<T>) =>
      setParts((cur) => ({ key, by: { ...(cur.key === key ? cur.by : {}), [wid]: p } }));
    const stops = wids.map((wid) => {
      set(wid, { state: 'loading' });
      return onSnapshot(
        build(wid, uid),
        (snap) => {
          const rows: T[] = [];
          for (const d of snap.docs) {
            const r = schema.safeParse(d.data({ serverTimestamps: 'estimate' }));
            if (r.success) rows.push(map(wid, d.id, r.data as z.infer<S>));
          }
          set(wid, { state: 'ready', rows });
        },
        () => set(wid, { state: 'error' }),
      );
    });
    return () => stops.forEach((s) => s());
    // build, schema and map are fixed per name.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const ps: Part<T>[] =
      parts.key === key ? wids.map((w) => parts.by[w] ?? { state: 'loading' as const }) : [];
    if (!key || ps.length === 0 || ps.some((p) => p.state === 'loading'))
      return { state: wids.length === 0 && key ? 'ready' : 'loading', rows: [] };
    const rows = ps.flatMap((p) => (p.state === 'ready' ? p.rows : []));
    const failed = ps.some((p) => p.state === 'error');
    return { state: failed && rows.length === 0 ? 'error' : 'ready', rows };
  }, [parts, key, wids]);
}

export interface SubjectDoc {
  wid: string;
  id: string;
  data: InboxSubject;
}

/** The member's subjects and threads in the given workspaces. */
export function useInbox(uid: string, wids: readonly string[]) {
  const subjects = useAcross(
    'subjects',
    wids,
    uid,
    mySubjectsQuery,
    inboxSubjectSchema,
    (wid, id, data): SubjectDoc => ({ wid, id, data }),
  );
  const threads = useAcross(
    'threads',
    wids,
    uid,
    myThreadsQuery,
    inboxThreadSchema,
    (wid, id, data: InboxThread): ThreadRow => ({ wid, id, data }),
  );
  const state =
    subjects.state === 'error' || threads.state === 'error'
      ? 'error'
      : subjects.state === 'ready' && threads.state === 'ready'
        ? 'ready'
        : 'loading';
  return { state, subjects: subjects.rows, threads: threads.rows } as const;
}

/** The member's messages, for Find; only listened to while Find has a query. */
export function useMyMessages(uid: string, wids: readonly string[], enabled: boolean) {
  return useAcross(
    'messages',
    wids,
    uid,
    myMessagesQuery,
    inboxMessageSchema,
    (wid, _id, data: InboxMessage) => ({ wid, data }),
    enabled,
  );
}

/** The member's related-subject links (docs/INBOX.md, "Related subjects"). */
export function useMyRelations(uid: string, wids: readonly string[], enabled = true) {
  return useAcross(
    'relations',
    wids,
    uid,
    myRelationsQuery,
    inboxRelationSchema,
    (wid, id, data: InboxRelation) => ({ wid, id, data }),
    enabled,
  );
}

/** One thread with its messages, outcomes and events. */
export function useThread(wid: string, tid: string, uid: string) {
  const thread = useLiveDoc(inboxPaths.thread(wid, tid), inboxThreadSchema);
  const k = `${wid}/${tid}/${uid}`;
  const messages = useLiveQuery(
    `im:${k}`,
    () => threadMessagesQuery(wid, uid, tid),
    inboxMessageSchema,
  );
  const outcomes = useLiveQuery(
    `io:${k}`,
    () => threadOutcomesQuery(wid, uid, tid),
    inboxOutcomeSchema,
  );
  const events = useLiveQuery(`ie:${k}`, () => threadEventsQuery(wid, uid, tid), inboxEventSchema);
  const sid = thread.state === 'ready' ? (thread.data?.subjectId ?? null) : null;
  const subject = useLiveDoc(sid ? inboxPaths.subject(wid, sid) : null, inboxSubjectSchema);
  return { thread, messages, outcomes, events, subject };
}

/** One subject with its threads and its timeline events. */
export function useSubject(wid: string, sid: string, uid: string) {
  const subject = useLiveDoc(inboxPaths.subject(wid, sid), inboxSubjectSchema);
  const k = `${wid}/${sid}/${uid}`;
  const threads = useLiveQuery(
    `st:${k}`,
    () => subjectThreadsQuery(wid, uid, sid),
    inboxThreadSchema,
  );
  const events = useLiveQuery(`se:${k}`, () => subjectEventsQuery(wid, uid, sid), inboxEventSchema);
  return { subject, threads, events };
}

/** The member's other subjects in a workspace (merge targets, move targets). */
export function useMySubjects(wid: string, uid: string) {
  return useLiveQuery(`ms:${wid}/${uid}`, () => mySubjectsQuery(wid, uid), inboxSubjectSchema);
}

/**
 * Threads waiting for the member across all their organizations, for the phone Inbox tab. Null
 * until the feed is final (no climbing number). Same selector as the /inbox header line.
 */
export function useWaitingThreads(): number | null {
  const { session } = useReady();
  const uid = session.me.uid;
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  const wids = useMemo(() => orgs.filter((o) => !o.deleting).map((o) => o.id), [orgs]);
  const inbox = useInbox(uid, wids);
  const n = useMemo(
    () => countWaitingThreads(subjectRows(inbox.subjects, inbox.threads)),
    [inbox.subjects, inbox.threads],
  );
  return inbox.state === 'ready' ? n : null;
}
