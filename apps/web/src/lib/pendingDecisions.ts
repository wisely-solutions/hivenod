import { DELETE_FIELD, SERVER_TIME, type WriteOp } from '@hive/shared';
import { sendKeepalive, warmToken } from './leaveBeacon';
import { undoWindowMs } from './undoWindow';

/**
 * Durable Undo window (card ZVS8ag5i). A decision waits 5 s behind an Undo toast before it is
 * written. So that a full reload, a tab close or a killed page cannot lose it, the plan is saved
 * here (localStorage, per person and workspace) when the toast starts and removed when the write
 * settles or Undo is tapped. On the next load `takeReplayable` hands back what is left so it can be
 * written. Replaying is safe: events are append-only (a plan that already landed fails as a whole)
 * and the rules refuse decisions on an item that moved on.
 */
const WINDOW_MS = 5000; // the e2e builds may shorten it: undoWindowMs
const GRACE_MS = 1500;
const TAB_KEY = 'hive.tab';

export interface Stashed {
  id: string;
  tab: string;
  at: number;
  plans: WriteOp[][];
  /** Toast shown once the replayed decision is saved. */
  done: string;
}

function tabId(): string {
  try {
    let t = sessionStorage.getItem(TAB_KEY);
    if (!t) {
      t = Math.random().toString(36).slice(2);
      sessionStorage.setItem(TAB_KEY, t);
    }
    return t;
  } catch {
    return 'no-session-storage';
  }
}

/** Entries this page is counting down or writing itself: never replayed by this page. */
const live = new Set<string>();
/** Plans of entries still inside their Undo window or being written, for the leave beacon. */
const livePlans = new Map<string, WriteOp[][]>();

const storeKey = (uid: string, ws: string) => `hive.pendingDecisions.${uid}.${ws}`;

/** JSON that keeps the SERVER_TIME / DELETE_FIELD placeholders and Dates recognisable. */
function replacer(_k: string, v: unknown): unknown {
  if (v === SERVER_TIME) return { __hive: 'serverTime' };
  if (v === DELETE_FIELD) return { __hive: 'deleteField' };
  return v;
}
function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object') {
    const h = (v as { __hive?: unknown }).__hive;
    if (h === 'serverTime') return SERVER_TIME;
    if (h === 'deleteField') return DELETE_FIELD;
  }
  return v;
}

export function readAll(uid: string, ws: string): Stashed[] {
  try {
    const raw = localStorage.getItem(storeKey(uid, ws));
    return raw ? (JSON.parse(raw, reviver) as Stashed[]) : [];
  } catch {
    return [];
  }
}

function writeAll(uid: string, ws: string, all: Stashed[]): void {
  try {
    if (all.length) localStorage.setItem(storeKey(uid, ws), JSON.stringify(all, replacer));
    else localStorage.removeItem(storeKey(uid, ws));
  } catch {
    // Storage blocked or full: the in-page flow still works, only reload safety is lost.
  }
}

/** Saves a decision that is about to wait out its Undo window. Returns a function that forgets it. */
export function stash(uid: string, ws: string, plans: WriteOp[][], done: string): () => void {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  writeAll(uid, ws, [...readAll(uid, ws), { id, tab: tabId(), at: Date.now(), plans, done }]);
  live.add(id);
  livePlans.set(id, plans);
  warmToken();
  return () => {
    live.delete(id);
    livePlans.delete(id);
    writeAll(
      uid,
      ws,
      readAll(uid, ws).filter((s) => s.id !== id),
    );
  };
}

/**
 * What a fresh load should write. Entries from this same tab (a reload) are written at once; an
 * entry from another open tab is left until its window has certainly passed, so that tab's Undo
 * still works. Returns the ready ones and the milliseconds to wait before asking again (or null).
 */
export function takeReplayable(
  uid: string,
  ws: string,
  now = Date.now(),
): { ready: Stashed[]; again: number | null } {
  const mine = tabId();
  const ready: Stashed[] = [];
  let again: number | null = null;
  for (const s of readAll(uid, ws)) {
    if (live.has(s.id)) continue;
    const due = s.at + undoWindowMs(WINDOW_MS) + GRACE_MS;
    if (s.tab === mine || now >= due) ready.push(s);
    else again = Math.min(again ?? Infinity, due - now);
  }
  return { ready, again };
}

/** Marks an entry as being written by this page right now (so a later tick does not repeat it). */
export function setBusy(id: string, busy: boolean): void {
  if (busy) live.add(id);
  else live.delete(id);
}

/** Keeps only the plans that are still unresolved (the others landed), so a retry writes just those. */
export function keepPlans(uid: string, ws: string, id: string, plans: WriteOp[][]): void {
  writeAll(
    uid,
    ws,
    readAll(uid, ws).map((s) => (s.id === id ? { ...s, plans } : s)),
  );
}

export function forget(uid: string, ws: string, id: string): void {
  writeAll(
    uid,
    ws,
    readAll(uid, ws).filter((s) => s.id !== id),
  );
}

/** The event document a plan creates, if any (used to tell that the plan already landed). */
export function eventPath(plan: WriteOp[]): string | null {
  return (
    plan.find((o) => o.kind === 'set' && /\/(events|inboxEvents)\/[^/]+$/.test(o.path))?.path ??
    null
  );
}

/**
 * Leaving the page (card 6OVGEySr). The Undo window is 5 s, so a tab closed inside it would
 * otherwise write nothing until the next load. Every Undo-pending write goes through a toast, and
 * the toast layer registers ONE flush here: it runs on `pagehide` and when the page becomes hidden
 * (`visibilitychange`, the last event a phone gives a killed tab), and commits every toast still
 * counting down, which issues its write at once. The localStorage stash stays until the write
 * settles, so a page that dies before the acknowledgement is still replayed on the next load.
 * Behaviour to know: a flushed decision is final. Its Undo button is gone when the page comes back
 * (Undo needs the page to be visible); a mistaken one is reversed like any other decision.
 * Both events can fire for one leave; each toast commits once. A closing page cannot finish an SDK
 * write, so the plans are also posted as keepalive REST commits (leaveBeacon.ts); if both land, the
 * second fails on the create-only event, which `run` reads as already saved.
 */
export function onLeave(flush: () => void): () => void {
  const leave = () => {
    // First the keepalive request (the only write a closing page can finish), then the SDK commit.
    sendKeepalive([...livePlans.values()].flat());
    flush();
  };
  const hidden = () => {
    if (document.visibilityState === 'hidden') leave();
  };
  window.addEventListener('pagehide', leave);
  document.addEventListener('visibilitychange', hidden);
  return () => {
    window.removeEventListener('pagehide', leave);
    document.removeEventListener('visibilitychange', hidden);
  };
}
