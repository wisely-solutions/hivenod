import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { arrivalKey, compareArrival } from './client';

describe('hand-out order (item QjTTL)', () => {
  it('is oldest stepAt first, items without one before them, the id breaking ties', () => {
    const t = (ms: number) => Timestamp.fromMillis(ms);
    const items: Record<string, { stepAt?: Timestamp; updatedAt: Timestamp }> = {
      a: { stepAt: t(300), updatedAt: t(10) },
      e: { stepAt: t(100), updatedAt: t(900) },
      b: { stepAt: t(100), updatedAt: t(900) },
      c: { updatedAt: t(50) },
      d: { updatedAt: t(20) },
    };
    const keys = Object.entries(items).map(([id, it]) => arrivalKey(it, id));
    keys.sort(compareArrival);
    // The same order as TestOldestFirst in cli/internal/hive/handout_test.go.
    expect(keys.map((k) => k[2]).join('')).toBe('dcbea');
  });
});
