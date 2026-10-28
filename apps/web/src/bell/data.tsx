/**
 * The bell's data (item 3ENs): one listener on users/{uid}/notifications for the current
 * organization, the last 30 days, newest first. Read state lives in the documents, so it is the
 * same on every device. New entries that arrive while the app is open pop up once as a toast;
 * the first snapshot never does (sign-in shows no burst).
 */
import { BELL_KEEP_MS, BELL_LIMIT, bellEntrySchema, bellPath, bellPlain } from '@hive/shared';
import { useNavigate } from '@tanstack/react-router';
import {
  collection,
  doc,
  limit,
  orderBy,
  query,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveQuery } from '../lib/live';
import { useToast } from '../ui/overlay';
import { liveArrivals, unreadCount, type BellRow } from './logic';

export function bellQuery(uid: string, wid: string, since: number) {
  // Literal fields so scripts/check-firestore-indexes.mjs can match the index (BELL_QUERY).
  return query(
    collection(db, `users/${uid}/notifications`),
    where('workspaceId', '==', wid),
    where('at', '>=', since),
    orderBy('at', 'desc'),
    limit(BELL_LIMIT),
  );
}

interface BellApi {
  ready: boolean;
  rows: BellRow[];
  unread: number;
  /** Marks one entry read (no-op when it already is). */
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Opens the entry's item and marks it read. */
  open: (row: BellRow) => void;
}

const BellContext = createContext<BellApi | null>(null);

export function useBell(): BellApi {
  const ctx = useContext(BellContext);
  if (!ctx) throw new Error('useBell needs <BellProvider>');
  return ctx;
}

export function BellProvider({ children }: { children: ReactNode }) {
  const { session } = useReady();
  const uid = session.me.uid;
  const wid = session.workspaceId;
  const toast = useToast();
  const navigate = useNavigate();
  // Fixed for the session: entries older than 30 days are never shown (the notifier prunes them).
  const [sessionStart] = useState(() => Date.now());
  const live = useLiveQuery(
    `bell:${uid}:${wid}`,
    () => bellQuery(uid, wid, sessionStart - BELL_KEEP_MS),
    bellEntrySchema,
  );
  const rows = useMemo<BellRow[]>(
    () => (live.state === 'ready' ? live.data.map((r) => ({ id: r.id, data: r.data })) : []),
    [live],
  );

  const markRead = useCallback(
    (id: string) => {
      const row = rows.find((r) => r.id === id);
      if (!row || row.data.readAt !== null) return;
      void updateDoc(doc(db, bellPath.entry(uid, id)), { readAt: Date.now() }).catch(
        () => undefined,
      );
    },
    [rows, uid],
  );
  const markAllRead = useCallback(() => {
    const unread = rows.filter((r) => r.data.readAt === null);
    if (unread.length === 0) return;
    const batch = writeBatch(db);
    const at = Date.now();
    for (const r of unread) batch.update(doc(db, bellPath.entry(uid, r.id)), { readAt: at });
    void batch.commit().catch(() => undefined);
  }, [rows, uid]);
  const open = useCallback(
    (row: BellRow) => {
      markRead(row.id);
      void navigate({
        to: '/p/$pid',
        params: { pid: row.data.projectId },
        search: { item: row.data.itemId },
      });
    },
    [markRead, navigate],
  );

  // Live only: a toast for what arrives while the app is open, never for the first snapshot.
  const seen = useRef<Set<string> | null>(null);
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  });
  useEffect(() => {
    if (live.state !== 'ready') return;
    const fresh = liveArrivals(seen.current, rows, sessionStart);
    seen.current = new Set(rows.map((r) => r.id));
    for (const r of fresh.slice(0, 3)) {
      toast.push({
        message: bellPlain(r.data),
        actionLabel: 'Open',
        onAction: () => openRef.current(r),
        duration: 8000,
      });
    }
  }, [live.state, rows, sessionStart, toast]);
  // Another organization is another list: start over without popping up its history.
  useEffect(() => {
    seen.current = null;
  }, [uid, wid]);

  const value = useMemo<BellApi>(
    () => ({
      ready: live.state === 'ready',
      rows,
      unread: unreadCount(rows),
      markRead,
      markAllRead,
      open,
    }),
    [live.state, rows, markRead, markAllRead, open],
  );
  return <BellContext.Provider value={value}>{children}</BellContext.Provider>;
}
