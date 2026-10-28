import {
  collection,
  doc,
  onSnapshot,
  type DocumentSnapshot,
  type FirestoreError,
  type Query,
  type QuerySnapshot,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { db } from './db';
import { countReads } from './reads';

/**
 * Listens to a document or query. Right after someone creates or joins a workspace, the server can
 * evaluate the listener a moment before it has committed their own write, and answers
 * "permission denied". So that one error is retried a few times before it counts.
 */
function listen<T>(
  start: (onNext: (v: T) => void, onError: (e: FirestoreError) => void) => () => void,
  onNext: (v: T) => void,
  onFail: (code: string) => void,
): () => void {
  let stop: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  let closed = false;
  const begin = () => {
    stop = start(onNext, (e) => {
      if (e.code === 'permission-denied' && tries < 4 && !closed) {
        tries += 1;
        timer = setTimeout(begin, 350 * tries);
      } else {
        onFail(e.code);
      }
    });
  };
  begin();
  return () => {
    closed = true;
    clearTimeout(timer);
    stop?.();
  };
}

export type Live<T> =
  | { state: 'loading' }
  | { state: 'error'; code: string }
  /** `fromCache`: the rows came from the local cache and the server has not confirmed them yet. */
  | { state: 'ready'; data: T; fromCache?: boolean };

/** Live document. `data` is null when it does not exist. Invalid documents surface as an error. */
export function useLiveDoc<S extends z.ZodType>(
  path: string | null,
  schema: S,
  /**
   * `synced`: also deliver the snapshot in which the server confirms a document first served from
   * the local cache, so `fromCache` turns false even when nothing changed. Use it where a missing
   * cached document must not pass for a missing one on the server (deciding "new user").
   */
  opts?: { synced?: boolean },
): Live<z.infer<S> | null> {
  const synced = Boolean(opts?.synced);
  const [value, setValue] = useState<{ key: string | null; live: Live<z.infer<S> | null> }>({
    key: null,
    live: { state: 'loading' },
  });
  useEffect(() => {
    if (!path) return;
    return listen<DocumentSnapshot>(
      (next, error) =>
        onSnapshot(doc(db, path), { includeMetadataChanges: synced }, { next, error }),
      (snap) => {
        countReads(snap);
        try {
          const data = snap.exists()
            ? (schema.parse(snap.data({ serverTimestamps: 'estimate' })) as z.infer<S>)
            : null;
          setValue({
            key: path,
            live: { state: 'ready', data, fromCache: snap.metadata.fromCache },
          });
        } catch {
          setValue({ key: path, live: { state: 'error', code: 'invalid-data' } });
        }
      },
      (code) => setValue({ key: path, live: { state: 'error', code } }),
    );
  }, [path, schema, synced]);
  return path && value.key === path ? value.live : { state: 'loading' };
}

export interface Row<T> {
  id: string;
  data: T;
  /** Written on this device and not yet confirmed by the server (only set while true). */
  pending?: true;
}

/** Live collection, validated row by row (a bad row is skipped, never crashes the screen). */
export function useLiveCollection<S extends z.ZodType>(
  path: string | null,
  schema: S,
  /** `synced`: also deliver the snapshot in which the server confirms cached rows (see useLiveQuery). */
  opts?: { synced?: boolean },
): Live<Row<z.infer<S>>[]> {
  const synced = Boolean(opts?.synced);
  const [value, setValue] = useState<{ key: string | null; live: Live<Row<z.infer<S>>[]> }>({
    key: null,
    live: { state: 'loading' },
  });
  useEffect(() => {
    if (!path) return;
    return listen<QuerySnapshot>(
      (next, error) =>
        onSnapshot(collection(db, path), { includeMetadataChanges: synced }, { next, error }),
      (snap) => {
        countReads(snap);
        const rows: Row<z.infer<S>>[] = [];
        snap.docs.forEach((d) => {
          const r = schema.safeParse(d.data({ serverTimestamps: 'estimate' }));
          if (r.success) rows.push({ id: d.id, data: r.data as z.infer<S> });
        });
        setValue({
          key: path,
          live: { state: 'ready', data: rows, fromCache: snap.metadata.fromCache },
        });
      },
      (code) => setValue({ key: path, live: { state: 'error', code } }),
    );
  }, [path, schema, synced]);
  return path && value.key === path ? value.live : { state: 'loading' };
}

/**
 * Live query, validated row by row. `key` identifies the query (it restarts the listener when it
 * changes); `build` must be stable for a given key. Pass a null key to stay idle.
 */
export function useLiveQuery<S extends z.ZodType>(
  key: string | null,
  build: () => Query,
  schema: S,
  /**
   * `synced`: also deliver the snapshot in which the server confirms rows first served from the
   * local cache, so `fromCache` turns false even when nothing changed. Use it where a partial
   * cached answer must not pass for the real one (money, counts that gate a layout).
   */
  opts?: { synced?: boolean },
): Live<Row<z.infer<S>>[]> {
  const synced = Boolean(opts?.synced);
  const [value, setValue] = useState<{ key: string | null; live: Live<Row<z.infer<S>>[]> }>({
    key: null,
    live: { state: 'loading' },
  });
  const buildRef = useRef(build);
  useEffect(() => {
    buildRef.current = build;
  });
  useEffect(() => {
    if (!key) return;
    return listen<QuerySnapshot>(
      (next, error) =>
        onSnapshot(buildRef.current(), { includeMetadataChanges: synced }, { next, error }),
      (snap) => {
        countReads(snap);
        const rows: Row<z.infer<S>>[] = [];
        snap.docs.forEach((d) => {
          const r = schema.safeParse(d.data({ serverTimestamps: 'estimate' }));
          if (r.success)
            rows.push({
              id: d.id,
              data: r.data as z.infer<S>,
              ...(d.metadata.hasPendingWrites ? { pending: true as const } : {}),
            });
        });
        setValue({ key, live: { state: 'ready', data: rows, fromCache: snap.metadata.fromCache } });
      },
      (code) => setValue({ key, live: { state: 'error', code } }),
    );
  }, [key, schema, synced]);
  return key && value.key === key ? value.live : { state: 'loading' };
}
