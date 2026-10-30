/**
 * Today's extra data (item kt3E7u9EliL3q2veDDI0), beside the Needs-you feeds (needs/data.tsx):
 * the messages of the last 24 hours (the brief), the sender of each thread in the stack, the
 * latest agent note of each thread being investigated and the member's subjects (area chips).
 * Every query is the member's own
 * (memberUid == me), which is all the rules let them read.
 */
import {
  inboxEventSchema,
  inboxMessageSchema,
  inboxOutcomeSchema,
  stepSilentText,
  inboxSubjectSchema,
  type InboxEvent,
  type InboxMessage,
} from '@hive/shared';
import { collection, query, Timestamp, where } from 'firebase/firestore';
import { useMemo } from 'react';
import { db } from '../lib/db';
import { mySubjectsQuery, useAcross } from '../threads/data';

/** At most this many threads per organization are looked up by id (Firestore's `in` limit). */
const IN_MAX = 30;

/** The member's thread steps in agent hands (item KZ6O9): approved or running outcomes. */
const stepsInHandsQuery = (wid: string, uid: string) =>
  query(
    collection(db, `workspaces/${wid}/inboxOutcomes`),
    where('memberUid', '==', uid),
    where('state', 'in', ['approved', 'running']),
  );

/**
 * Reach out (item KZ6O9): the member's threads whose step in agent hands went silent, by
 * `wid/threadId`, with the flag's text ("Hive silent for 41 min").
 */
export function useSilentThreads(uid: string, wids: readonly string[], now: number) {
  const r = useAcross(
    'steps-in-hands',
    wids,
    uid,
    stepsInHandsQuery,
    inboxOutcomeSchema,
    (wid, _id, data) => ({ key: `${wid}/${data.threadId}`, data }),
  );
  return useMemo(() => {
    const out = new Map<string, string>();
    for (const row of r.rows) {
      const text = stepSilentText(row.data, now);
      if (text) out.set(row.key, text);
    }
    return out;
  }, [r.rows, now]);
}

const messagesSinceQuery = (wid: string, uid: string, since: number) =>
  query(
    collection(db, `workspaces/${wid}/inboxMessages`),
    where('memberUid', '==', uid),
    where('receivedAt', '>=', Timestamp.fromMillis(since)),
  );
const threadMessagesQuery = (wid: string, uid: string, ids: readonly string[]) =>
  query(
    collection(db, `workspaces/${wid}/inboxMessages`),
    where('memberUid', '==', uid),
    where('threadId', 'in', ids),
  );
const threadEventsQuery = (wid: string, uid: string, ids: readonly string[]) =>
  query(
    collection(db, `workspaces/${wid}/inboxEvents`),
    where('memberUid', '==', uid),
    where('threadId', 'in', ids),
  );

/** Messages received since `since` (ms) in the given organizations. */
export function useMessagesSince(uid: string, wids: readonly string[], since: number) {
  return useAcross(
    `messages-since:${since}`,
    wids,
    uid,
    (wid, u) => messagesSinceQuery(wid, u, since),
    inboxMessageSchema,
    (wid, id, data: InboxMessage) => ({ wid, id, data }),
  );
}

type ByOrg = ReadonlyArray<{ wid: string; id: string }>;

function grouped(threads: ByOrg): { wids: string[]; ids: Record<string, string[]>; key: string } {
  const ids: Record<string, string[]> = {};
  for (const t of threads) {
    const list = (ids[t.wid] ??= []);
    if (list.length < IN_MAX && !list.includes(t.id)) list.push(t.id);
  }
  for (const w of Object.keys(ids)) ids[w]!.sort();
  const wids = Object.keys(ids).sort();
  return { wids, ids, key: wids.map((w) => `${w}:${ids[w]!.join(',')}`).join('|') };
}

/** Every message of the given threads, by thread id. */
export function useThreadMessages(uid: string, threads: ByOrg) {
  const g = useMemo(() => grouped(threads), [threads]);
  const r = useAcross(
    `thread-messages:${g.key}`,
    g.wids,
    uid,
    (wid, u) => threadMessagesQuery(wid, u, g.ids[wid] ?? []),
    inboxMessageSchema,
    (wid, id, data: InboxMessage) => ({ wid, id, data }),
    g.wids.length > 0,
  );
  return useMemo(() => {
    const by = new Map<string, InboxMessage[]>();
    for (const m of r.rows) {
      const k = `${m.wid}/${m.data.threadId}`;
      by.set(k, [...(by.get(k) ?? []), m.data]);
    }
    for (const list of by.values())
      list.sort((a, b) => a.receivedAt.toMillis() - b.receivedAt.toMillis());
    return by;
  }, [r.rows]);
}

/** The latest agent note of each given thread, by `wid/threadId`. */
export function useLatestNotes(uid: string, threads: ByOrg) {
  const g = useMemo(() => grouped(threads), [threads]);
  const r = useAcross(
    `thread-events:${g.key}`,
    g.wids,
    uid,
    (wid, u) => threadEventsQuery(wid, u, g.ids[wid] ?? []),
    inboxEventSchema,
    (wid, id, data: InboxEvent) => ({ wid, id, data }),
    g.wids.length > 0,
  );
  return useMemo(() => {
    const by = new Map<string, { text: string; agent: string; at: number }>();
    for (const e of r.rows) {
      if (e.data.type !== 'thread.note' || !e.data.threadId) continue;
      const k = `${e.wid}/${e.data.threadId}`;
      const at = e.data.at.toMillis();
      const text = String((e.data.data as { text?: unknown }).text ?? '');
      if (!by.has(k) || by.get(k)!.at < at) by.set(k, { text, agent: e.data.actor.name, at });
    }
    return by;
  }, [r.rows]);
}

/** The member's subjects (names and areas), by `wid/subjectId`. */
export function useSubjectsById(uid: string, wids: readonly string[]) {
  const r = useAcross(
    'today-subjects',
    wids,
    uid,
    mySubjectsQuery,
    inboxSubjectSchema,
    (wid, id, data) => ({ wid, id, data }),
  );
  return useMemo(() => new Map(r.rows.map((s) => [`${s.wid}/${s.id}`, s.data] as const)), [r.rows]);
}
