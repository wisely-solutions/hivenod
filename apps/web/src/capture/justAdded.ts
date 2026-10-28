import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * The item just added with quick capture. Its card, wherever it is on screen, shows a highlight
 * and scrolls into view once (card M3ipmzNY). A tiny store so the card needs no provider.
 */
let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** Cards that already played their pulse: it plays once per card id, even if the card remounts. */
const pulsed = new Set<string>();

export const HIGHLIGHT_MS = 4000;

export function markJustAdded(itemId: string) {
  current = itemId;
  clearTimeout(timer);
  timer = setTimeout(() => {
    current = null;
    listeners.forEach((l) => l());
  }, HIGHLIGHT_MS);
  listeners.forEach((l) => l());
}

export function clearJustAdded() {
  clearTimeout(timer);
  current = null;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True while `itemId` is the one just added. Attach the returned callback to its card to scroll it into view. */
export function useJustAdded(itemId: string) {
  const on = useSyncExternalStore(
    subscribe,
    () => current === itemId,
    () => false,
  );
  const el = useRef<HTMLElement | null>(null);
  const ref = useCallback((node: HTMLElement | null) => {
    el.current = node;
  }, []);
  useEffect(() => {
    if (!on) return;
    const node = el.current;
    if (!node || typeof node.scrollIntoView !== 'function') return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    node.scrollIntoView({
      block: 'center',
      inline: 'nearest',
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [on]);
  // The pulse (CSS animation) starts when this attribute first appears, so hand it out once per id.
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    if (on && !pulsed.has(itemId)) {
      pulsed.add(itemId);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot flag, set once per card id
      setPulse(true);
    }
  }, [on, itemId]);
  return [on, ref, on && pulse] as const;
}
