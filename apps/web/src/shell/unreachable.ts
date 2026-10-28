import { disableNetwork, enableNetwork } from 'firebase/firestore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../lib/db';
import { e2eMs } from '../lib/undoWindow';
import { useOnline } from './pwa';

/** How long the server may stay silent (while the browser is online) before a load counts as stuck. */
export const UNREACHABLE_AFTER_MS = 8000;

/**
 * True once `stuck` (waiting on the server) has lasted UNREACHABLE_AFTER_MS while online.
 * `initiallyStalled` keeps an already-shown "Can't reach the server" up across a Retry remount, so
 * the screen does not flash back to unconfirmed content for another few seconds.
 */
export function useUnreachable(stuck: boolean, initiallyStalled = false): boolean {
  const [stalled, setStalled] = useState(initiallyStalled);
  const online = useOnline();
  useEffect(() => {
    if (!stuck || !online) {
      const t = setTimeout(() => setStalled(false), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setStalled(true), e2eMs('unreachableMs', UNREACHABLE_AFTER_MS));
    return () => clearTimeout(t);
  }, [stuck, online]);
  return stuck && stalled && online;
}

/** Nudges the SDK out of its reconnect back-off. */
export function kickNetwork() {
  void disableNetwork(db)
    .then(() => enableNetwork(db))
    .catch(() => undefined);
}

/**
 * The Retry action: kicks the connection and reports `retrying` until the server answers
 * (`settle()`) or one more UNREACHABLE_AFTER_MS passes, so the button can stay visible but disabled.
 */
export function useRetry(onRetry?: () => void) {
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const retry = useCallback(() => {
    kickNetwork();
    setRetrying(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setRetrying(false),
      e2eMs('unreachableMs', UNREACHABLE_AFTER_MS),
    );
    onRetry?.();
  }, [onRetry]);
  const settle = useCallback(() => {
    clearTimeout(timer.current);
    setRetrying(false);
  }, []);
  return { retry, retrying, settle };
}
