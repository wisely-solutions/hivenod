import { liveTerminal, AGENT_ONLINE_MS } from '@hive/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HiveClient } from './client';
import { EXIT, Runner, type RunnerClient } from './runner';

// Card wvLiSoy8, tester R107: idle presence gaps above the 120 s window and clock skew let a
// second terminal in while the first was alive.

const ts = (ms: number) => ({ toMillis: () => ms }) as never;

function clientWithSkew(skewMs: number, hostEndMs: number) {
  const c = Object.create(HiveClient.prototype) as HiveClient;
  (c as unknown as { clockOffsetMs: number }).clockOffsetMs = 0; // field initialisers do not run
  const serverNow = () => Date.now() + skewMs;
  const fetchFn = vi.fn(async () => ({
    headers: { get: () => new Date(Math.floor(serverNow() / 1000) * 1000).toUTCString() },
  })) as unknown as typeof fetch;
  void hostEndMs;
  return { c, fetchFn, serverNow };
}

describe('other-terminal check uses server time', () => {
  afterEach(() => vi.useRealTimers());

  for (const skew of [-39_000, 0, 39_000]) {
    it(`alive terminal seen 119 s ago on the server clock is detected with local clock skew ${skew} ms`, async () => {
      const { c, fetchFn, serverNow } = clientWithSkew(skew, 0);
      await c.syncServerClock(fetchFn);
      // The first terminal wrote presence 119 s ago (server time, 1 s resolution slack).
      (c as unknown as { agent: unknown }).agent = {
        lastSeenAt: ts(serverNow() - 119_000),
        signedOutAt: null,
        seenHost: 'laptop',
      };
      expect(() => c.checkNoOtherTerminal()).toThrow(/already running in another terminal/);
      // And one seen 125 s ago (crashed) does not block.
      (c as unknown as { agent: unknown }).agent = {
        lastSeenAt: ts(serverNow() - 125_000),
        signedOutAt: null,
        seenHost: 'laptop',
      };
      expect(() => c.checkNoOtherTerminal()).not.toThrow();
    });
  }

  it('a failing clock probe falls back to the local clock', async () => {
    const { c } = clientWithSkew(0, 0);
    await c.syncServerClock((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    expect(Math.abs(c.serverNow() - Date.now())).toBeLessThan(50);
  });
});

describe('runner presence while idle', () => {
  afterEach(() => vi.useRealTimers());

  it('writes presence at most 31 s apart over ten idle minutes, so the gap stays under the window', async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    const ac = new AbortController();
    const client = {
      markSeen: vi.fn(async () => void seen.push(Date.now())),
      markOffline: vi.fn(async () => undefined),
      // An idle wait slice: 55 s with nothing to do.
      waitForWork: vi.fn(
        () => new Promise((res) => setTimeout(() => res({ timedOut: true, work: [] }), 55_000)),
      ),
    } as unknown as RunnerClient;
    const r = new Runner({
      client,
      hiveCommand: ['hive'],
      terminal: { line: () => undefined },
      signal: ac.signal,
    });
    const done = r.run();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await done).toBe(EXIT.interrupted);
    expect(seen.length).toBeGreaterThan(18);
    const gaps = seen.slice(1).map((t, i) => t - seen[i]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(31_000);
    expect(Math.max(...gaps)).toBeLessThan(AGENT_ONLINE_MS);
    // A terminal alive and idle never looks dead to the check.
    const last = seen.at(-1)!;
    expect(
      liveTerminal({ lastSeenAt: ts(last), signedOutAt: null, seenHost: 'h' }, last + 31_000),
    ).not.toBeNull();
  });
});
