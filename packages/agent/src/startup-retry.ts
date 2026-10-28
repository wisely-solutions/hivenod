import { isRateLimited } from './errors';

/** Same backoff as the work loop: 10 s, doubling, capped at 2 minutes. */
export function backoffMs(failures: number, baseMs = 10_000, capMs = 120_000): number {
  return Math.min(baseMs * 2 ** failures, capMs);
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

/**
 * Runs a startup step (sign-in and first reads) and, while Firebase answers "slow down", waits and
 * tries again like the work loop does. Any other error, or Ctrl+C, ends it at once.
 */
export async function retryOnRateLimit<T>(
  step: () => Promise<T>,
  o: {
    say: (s: string) => void;
    signal?: AbortSignal;
    baseMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  for (let failures = 0; ; failures++) {
    try {
      return await step();
    } catch (e) {
      if (!isRateLimited(e) || o.signal?.aborted) throw e;
      const waitMs = backoffMs(failures, o.baseMs);
      o.say(
        `! Firebase is limiting requests for a moment, retrying in ${Math.max(1, Math.round(waitMs / 1000))} s.`,
      );
      await sleep(waitMs, o.signal);
      if (o.signal?.aborted) throw e;
    }
  }
}
