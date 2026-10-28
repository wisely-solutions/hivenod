import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { FIRESTORE_EMULATOR_PORT, USE_EMULATOR } from './app';
import { db } from './db';

/** How long the server may stay silent (answers come only from the local cache) before we say so. */
export const RECONNECT_AFTER_MS = 4000;

/** Our own heartbeat: how often we knock on the Firestore host, and how long we wait for it. */
export const PROBE_EVERY_MS = 3000;
export const PROBE_TIMEOUT_MS = 2500;
/** Failed knocks in a row before we say the link is down (about 6 to 9 s after it drops). */
export const PROBE_FAILS = 2;
/** After the browser comes back online, how long a stale 'down' reading is ignored. */
export const SETTLE_MS = 1500;

const probeUrl = () =>
  USE_EMULATOR
    ? `http://${window.location.hostname}:${FIRESTORE_EMULATOR_PORT}/`
    : 'https://firestore.googleapis.com/generate_204'; // answers 204: no console error when healthy

/**
 * One knock on the Firestore host (no data, no billed read, opaque answer). Resolves true when
 * the host answered, false when the request failed or hung. Firestore itself only reports a
 * silently dropped transport after about 75 s; this is how the banner shows up in seconds.
 * It runs in every tab, so a tab that does not own the shared Firestore connection still shows it.
 */
export async function probeServer(): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(probeUrl(), { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Whether the live link to the server is up. One cheap listener on the organization document,
 * with metadata changes on: `fromCache` stays true while the connection is down. The first
 * moments after load do not count, and neither does a browser that knows it is offline (the
 * offline banner covers that).
 */
export function useServerLink(wid: string | null): 'live' | 'reconnecting' {
  const [cached, setCached] = useState(false);
  const [down, setDown] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [settling, setSettling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    // A new organization is a new listener: forget what the old one last said, so a stale
    // "from cache" reading can never outlive it (card fBvI3nno).
    const reset = setTimeout(() => {
      setCached(false);
      setDown(false);
    }, 0);
    if (!wid) return () => clearTimeout(reset);
    let retry: ReturnType<typeof setTimeout>;
    const off = onSnapshot(
      doc(db, `workspaces/${wid}`),
      { includeMetadataChanges: true },
      (snap) => setCached(snap.metadata.fromCache),
      () => {
        // A listener the server turned down (the new organization is not readable for a
        // moment) is dead, not a dropped link: its last "from cache" must not stick.
        setCached(false);
        retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_AFTER_MS);
      },
    );
    return () => {
      clearTimeout(reset);
      clearTimeout(retry);
      off();
    };
  }, [wid, attempt]);
  useEffect(() => {
    if (!wid) return;
    let stop = false;
    let fails = 0;
    let timer: ReturnType<typeof setTimeout>;
    const beat = async () => {
      // A hidden tab or a browser that knows it is offline is not a dropped connection.
      if (document.visibilityState === 'visible' && navigator.onLine) {
        const ok = await probeServer();
        if (stop) return;
        fails = ok ? 0 : fails + 1;
        setUnreachable(fails >= PROBE_FAILS);
      }
      if (!stop) timer = setTimeout(() => void beat(), PROBE_EVERY_MS);
    };
    timer = setTimeout(() => void beat(), PROBE_EVERY_MS);
    // Coming back online: start clean and give Firestore a moment to reattach, so the banner
    // does not flash while the link is already healing.
    let grace: ReturnType<typeof setTimeout>;
    const onOnline = () => {
      fails = 0;
      setUnreachable(false);
      setSettling(true);
      clearTimeout(grace);
      grace = setTimeout(() => setSettling(false), SETTLE_MS);
    };
    window.addEventListener('online', onOnline);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearTimeout(grace);
      window.removeEventListener('online', onOnline);
    };
  }, [wid]);
  useEffect(() => {
    if (!cached) {
      const t = setTimeout(() => setDown(false), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setDown(true), RECONNECT_AFTER_MS);
    return () => clearTimeout(t);
  }, [cached]);
  return !settling && ((down && cached) || unreachable) ? 'reconnecting' : 'live';
}
