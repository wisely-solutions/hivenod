import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCreateRate, CreateLimiter, createRateMessage } from './ratelimit';

describe('create_item rate limit (item DhsO9)', () => {
  const now = 10_000_000;
  it('allows 29 in the hour and refuses the 31st with when the next one can be made', () => {
    const times = Array.from({ length: 29 }, (_, i) => now - i * 60_000);
    expect(() => checkCreateRate(times, now)).not.toThrow();
    times.push(now - 50 * 60_000);
    expect(() => checkCreateRate(times, now)).toThrow(/at most 30 per hour.*in 10 minutes/);
  });

  it('forgets creations older than the hour', () => {
    const old = Array.from({ length: 40 }, (_, i) => now - 60 * 60_000 - i);
    expect(checkCreateRate(old, now)).toEqual([]);
  });

  it('rounds the wait up to a whole minute', () => {
    expect(createRateMessage(30, 30_000)).toMatch(/in 1 minute\.$/);
  });

  it('shares the count through the file, per agent, and frees a slot after the hour', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hivenod-rate-')), 'created-items.json');
    let at = 50_000_000;
    const a = new CreateLimiter(path, () => at, 3);
    for (let i = 0; i < 3; i++) {
      a.check('ag1');
      a.record('ag1');
      at += 60_000;
    }
    expect(() => a.check('ag1')).toThrow(/Rate limit/);
    // Another process on the same file sees the same count; another agent has its own.
    const b = new CreateLimiter(path, () => at, 3);
    expect(() => b.check('ag1')).toThrow(/Rate limit/);
    expect(() => b.check('ag2')).not.toThrow();
    at = 50_000_000 + 60 * 60_000 + 1000;
    expect(() => b.check('ag1')).not.toThrow();
  });

  it('counts in memory without a file', () => {
    const m = new CreateLimiter(null, () => now, 1);
    m.record('ag1');
    expect(() => m.check('ag1')).toThrow(/Rate limit/);
  });
});
