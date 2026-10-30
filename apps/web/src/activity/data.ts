import { inboxEventSchema, type InboxEvent } from '@hive/shared';
import { countReads } from '../lib/reads';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  startAfter,
  where,
  type DocumentData,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { db } from '../lib/db';
import type { Row } from '../lib/live';
import { isIndexBuilding, PAGE_SIZE } from './logic';
import { threadFeedConstraints, type ThreadGroupId } from './threadLogic';

/** A clock that re-renders every `ms` milliseconds. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function parse<S extends z.ZodType>(
  docs: QueryDocumentSnapshot<DocumentData>[],
  schema: S,
): Row<z.infer<S>>[] {
  const rows: Row<z.infer<S>>[] = [];
  for (const d of docs) {
    const r = schema.safeParse(d.data({ serverTimestamps: 'estimate' }));
    if (r.success) rows.push({ id: d.id, data: r.data as z.infer<S> });
  }
  return rows;
}

// ---------- the feed: one listener on the newest page, older pages on demand ----------

export interface Feed<T = InboxEvent> {
  state: 'loading' | 'ready' | 'error';
  rows: Row<T>[];
  /** Ids that arrived live after the first load (they get the soft highlight). */
  fresh: ReadonlySet<string>;
  hasMore: boolean;
  /** The server has answered and there is nothing older. */
  complete: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  /** The query failed because a Firestore index is still being built (try again in minutes). */
  indexBuilding: boolean;
}

interface FeedStore<T> {
  key: string;
  map: Map<string, Row<T>>;
  cursor: QueryDocumentSnapshot<DocumentData> | null;
  exhausted: boolean;
  /** True once an older page was read: the head snapshot no longer decides the cursor. */
  paged: boolean;
  /** The server (not just the cache) has answered the newest page. */
  settled: boolean;
  state: 'loading' | 'ready' | 'error';
  building: boolean;
}
function emptyStore<T>(key: string): FeedStore<T> {
  return {
    key,
    map: new Map(),
    cursor: null,
    exhausted: false,
    paged: false,
    settled: false,
    state: 'loading',
    building: false,
  };
}

/**
 * Activity on threads (slice 9): the member's own thread events, newest first, live; the same
 * paging as before. `group` narrows the types ('' = every type the feed shows).
 */
export function useThreadFeed(
  wid: string,
  uid: string,
  group: '' | ThreadGroupId,
  enabled: boolean,
): Feed<InboxEvent> {
  const key = `${wid}|${uid}|${group}`;
  return usePagedFeed(
    key,
    (after) => {
      const parts = [
        collection(db, `workspaces/${wid}/inboxEvents`),
        ...threadFeedConstraints(uid, group).map(([f, op, v]) => where(f, op, v)),
        orderBy('at', 'desc'),
        ...(after ? [startAfter(after)] : []),
        limit(PAGE_SIZE),
      ] as const;
      const [col, ...rest] = parts;
      return query(col, ...rest);
    },
    inboxEventSchema,
    enabled,
  );
}

/** One live listener on the newest page of `build()`, older pages read on demand. */
function usePagedFeed<S extends z.ZodType<{ at: { toMillis: () => number } }>>(
  key: string,
  buildQuery: (after?: QueryDocumentSnapshot<DocumentData>) => Query,
  schema: S,
  enabled: boolean,
): Feed<z.infer<S>> {
  type T = z.infer<S>;
  const [store, setStore] = useState<FeedStore<T>>(() => emptyStore<T>(key));
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const [loadingMore, setLoadingMore] = useState(false);
  const live = store.key === key ? store : null;
  const buildRef = useRef(buildQuery);
  useEffect(() => {
    buildRef.current = buildQuery;
  });
  // The query's parts are in `key`.
  const build = useCallback(
    (after?: QueryDocumentSnapshot<DocumentData>) => buildRef.current(after),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    if (!enabled) return;
    // Rows that arrive after the first server answer are "new"; the cache fill-in is not.
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = onSnapshot(
      build(),
      // Metadata changes tell us when the server (not just the cache) has answered.
      { includeMetadataChanges: true },
      (snap) => {
        countReads(snap);
        const wasSettled = settled;
        if (!snap.metadata.fromCache) settled = true;
        const added = snap.docChanges().filter((c) => c.type === 'added');
        setStore((cur) => {
          const base = cur.key === key ? cur : emptyStore<T>(key);
          // The first server answer replaces whatever the cache offered.
          const map = new Map(!wasSettled && !snap.metadata.fromCache ? [] : base.map);
          for (const r of parse(snap.docs, schema)) map.set(r.id, r);
          return {
            key,
            map,
            cursor: base.paged ? base.cursor : (snap.docs[snap.docs.length - 1] ?? null),
            exhausted: base.paged
              ? base.exhausted
              : snap.size < PAGE_SIZE && !snap.metadata.fromCache,
            paged: base.paged,
            settled: base.settled || !snap.metadata.fromCache,
            state: 'ready',
            building: false,
          };
        });
        if (wasSettled && added.length) {
          const ids = added.map((c) => c.doc.id);
          setFresh((cur) => new Set([...cur, ...ids]));
          timers.push(
            setTimeout(
              () =>
                setFresh((cur) => {
                  const next = new Set(cur);
                  ids.forEach((i) => next.delete(i));
                  return next;
                }),
              2400,
            ),
          );
        }
      },
      (err) =>
        setStore((cur) => ({
          ...(cur.key === key ? cur : emptyStore<T>(key)),
          state: 'error',
          building: isIndexBuilding(err),
        })),
    );
    return () => {
      stop();
      timers.forEach(clearTimeout);
    };
  }, [enabled, key, build, schema]);

  const busy = useRef(false);
  const loadMore = useCallback(() => {
    const cursor = live?.cursor;
    if (!cursor || !live?.settled || live.exhausted || busy.current) return;
    busy.current = true;
    setLoadingMore(true);
    getDocs(build(cursor))
      .then((snap) => {
        countReads(snap);
        setStore((cur) => {
          if (cur.key !== key) return cur;
          const map = new Map(cur.map);
          for (const r of parse(snap.docs, schema)) map.set(r.id, r);
          return {
            ...cur,
            map,
            cursor: snap.docs[snap.docs.length - 1] ?? cur.cursor,
            exhausted: snap.size < PAGE_SIZE,
            paged: true,
            settled: true,
          };
        });
      })
      .catch((err) =>
        setStore((cur) =>
          cur.key === key ? { ...cur, state: 'error', building: isIndexBuilding(err) } : cur,
        ),
      )
      .finally(() => {
        busy.current = false;
        setLoadingMore(false);
      });
  }, [live, build, key, schema]);

  const rows = useMemo(
    () =>
      live
        ? [...live.map.values()].sort(
            (a, b) => b.data.at.toMillis() - a.data.at.toMillis() || b.id.localeCompare(a.id),
          )
        : [],
    [live],
  );
  return {
    state: live ? live.state : 'loading',
    rows,
    fresh,
    hasMore: Boolean(live && live.settled && !live.exhausted && live.cursor),
    complete: Boolean(live && live.settled && live.exhausted),
    loadingMore,
    loadMore,
    indexBuilding: Boolean(live?.building),
  };
}

// ---------- thread titles (slice 9) ----------

const threadTitleCache = new Map<string, string | null>();

/** Titles of the threads the given events point at, read once each and remembered. */
export function useThreadTitles(
  wid: string,
  events: ReadonlyArray<{ threadId: string | null }>,
): ((tid: string | null) => string | null) & { settled: boolean } {
  const [, bump] = useState(0);
  const wanted = useMemo(
    () => [...new Set(events.flatMap((e) => (e.threadId ? [e.threadId] : [])))],
    [events],
  );
  useEffect(() => {
    let live = true;
    const missing = wanted.filter((t) => !threadTitleCache.has(`${wid}/${t}`));
    if (!missing.length) return;
    void Promise.all(
      missing.map(async (t) => {
        try {
          const snap = await getDoc(doc(db, `workspaces/${wid}/inboxThreads/${t}`));
          const title = snap.exists() ? (snap.data() as { title?: unknown }).title : null;
          threadTitleCache.set(`${wid}/${t}`, typeof title === 'string' ? title : null);
        } catch {
          threadTitleCache.set(`${wid}/${t}`, null);
        }
      }),
    ).then(() => live && bump((n) => n + 1));
    return () => {
      live = false;
    };
  }, [wid, wanted]);
  const settled = wanted.every((t) => threadTitleCache.has(`${wid}/${t}`));
  const titleOf = (tid: string | null) =>
    tid ? (threadTitleCache.get(`${wid}/${tid}`) ?? null) : null;
  return Object.assign(titleOf, { settled });
}
