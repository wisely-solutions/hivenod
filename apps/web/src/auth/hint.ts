import { useSyncExternalStore } from 'react';

/**
 * A cheap hint that this browser may be signed in. With no hint, the sign-in page paints without
 * loading Firebase at all; with it, the signed-in code loads straight away. It is only a hint:
 * the real state always comes from Firebase Auth.
 */
const KEY = 'hive-auth';
const listeners = new Set<() => void>();

export function getAuthHint(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Set just before a sign-in redirect leaves the page. While it is set, a signed-out auth event
 * must not clear the hint: the signed-in code (loaded by the hint) can start up and see "no user"
 * before the browser has left, and with the hint gone the return trip would never finish signing in.
 */
const PENDING_KEY = 'hive-auth-redirect';
const PENDING_MS = 60_000; // a cancelled or abandoned redirect stops protecting the hint after this
export function setRedirectPending(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(PENDING_KEY, String(Date.now()));
    else sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage blocked: no protection, same as before */
  }
}
export function isRedirectPending(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PENDING_KEY));
    return at > 0 && Date.now() - at < PENDING_MS;
  } catch {
    return false;
  }
}

export function setAuthHint(on: boolean): void {
  if (!on && isRedirectPending()) return;
  // Signed in: the redirect has finished, so stop protecting the hint (a sign-out must clear it).
  if (on) setRedirectPending(false);
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the hint just stays off */
  }
  listeners.forEach((l) => l());
}
export function useAuthHint(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      window.addEventListener('storage', cb);
      return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', cb);
      };
    },
    getAuthHint,
    () => false,
  );
}
