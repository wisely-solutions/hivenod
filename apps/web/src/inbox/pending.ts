import { useSyncExternalStore } from 'react';

/**
 * Entries the person has just decided and that are still counting down (Undo toast) or being
 * written. The inbox hides them at once; the rail and tab badges read this too, so every count on
 * screen drops together instead of the badge lagging behind the header.
 */
let keys: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

export function setPending(key: string, on: boolean): void {
  if (keys.has(key) === on) return;
  const next = new Set(keys);
  if (on) next.add(key);
  else next.delete(key);
  keys = next;
  for (const l of listeners) l();
}

export function usePendingKeys(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => keys,
  );
}
