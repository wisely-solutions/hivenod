/**
 * Which live feeds the server has answered on this device before (card CGPynEQY).
 *
 * Firestore keeps the last answer of every listened query in its persistent cache. A feed that
 * was in sync here once is served from that cache in full on the next visit, so the first screen
 * can show it at once instead of waiting for the server to confirm it (which, on a slow phone,
 * held "Needs you" back for seconds). A feed never answered here is different: a cached snapshot
 * of it is only whatever other queries happened to cache, so that one still waits for the server.
 *
 * Kept per person (the Firestore cache is per person) and cleared with the cache on sign-out.
 */
const KEY = 'hive-synced';
const MAX = 400;

type Store = Record<string, string[]>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Store) : {};
  } catch {
    return {};
  }
}

let memo: Store | null = null;
const store = () => (memo ??= read());

export function wasSynced(uid: string, feed: string): boolean {
  return store()[uid]?.includes(feed) ?? false;
}

export function markSynced(uid: string, feed: string): void {
  const s = store();
  const list = s[uid] ?? [];
  if (list.includes(feed)) return;
  // One person at a time: another person's keys are of no use once they signed out.
  memo = { [uid]: [...list, feed].slice(-MAX) };
  try {
    localStorage.setItem(KEY, JSON.stringify(memo));
  } catch {
    /* storage blocked: the next visit waits for the server, as before */
  }
}

export function clearSyncedFeeds(): void {
  memo = {};
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
