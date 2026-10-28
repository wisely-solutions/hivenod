import { describe, expect, it, vi } from 'vitest';
import { HiveError, RATE_LIMIT_MESSAGE } from './errors';
import { backoffMs, retryOnRateLimit } from './startup-retry';

const limited = () => Object.assign(new Error('x'), { code: 'auth/too-many-requests' });

describe('backoffMs', () => {
  it('doubles from 10 s and stops at 2 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((n) => backoffMs(n))).toEqual([
      10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000,
    ]);
  });
});

describe('retryOnRateLimit', () => {
  it('retries a rate limit with the work loop backoff, then succeeds', async () => {
    const step = vi
      .fn()
      .mockRejectedValueOnce(limited())
      .mockRejectedValueOnce(limited())
      .mockResolvedValue('ok');
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const say = vi.fn();
    expect(await retryOnRateLimit(step, { say, sleep })).toBe('ok');
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([10_000, 20_000]);
    expect(say.mock.calls[0]?.[0]).toContain('limiting requests');
    expect(say.mock.calls[1]?.[0]).toContain('20 s');
  });

  it('does not retry other errors', async () => {
    const step = vi.fn().mockRejectedValue(new Error('bad token'));
    const sleep = vi.fn();
    await expect(retryOnRateLimit(step, { say: vi.fn(), sleep })).rejects.toThrow('bad token');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops on Ctrl+C', async () => {
    const ac = new AbortController();
    const step = vi.fn().mockRejectedValue(limited());
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => ac.abort());
    await expect(
      retryOnRateLimit(step, { say: vi.fn(), sleep, signal: ac.signal }),
    ).rejects.toThrow();
    expect(step).toHaveBeenCalledTimes(1);
  });

  it('retries a sign-in rate limit (HiveError from connect) 10 s doubling, cap 2 min', async () => {
    const waits: number[] = [];
    let n = 0;
    const step = vi.fn(async () => {
      if (n++ < 7) throw new HiveError(RATE_LIMIT_MESSAGE);
      return 'ok';
    });
    const sleep = vi.fn(async (ms: number) => void waits.push(ms));
    expect(await retryOnRateLimit(step, { say: vi.fn(), sleep })).toBe('ok');
    expect(waits).toEqual([10_000, 20_000, 40_000, 80_000, 120_000, 120_000, 120_000]);
  });

  it('Ctrl+C during the wait rethrows the rate limit for the caller to turn into exit 130', async () => {
    const ac = new AbortController();
    const err = new HiveError(RATE_LIMIT_MESSAGE);
    const sleep = vi.fn(async () => ac.abort());
    await expect(
      retryOnRateLimit(async () => Promise.reject(err), { say: vi.fn(), sleep, signal: ac.signal }),
    ).rejects.toBe(err);
  });
});
