import type { Agent } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { activityText, agentActivity, formatEur } from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });
const NOW = new Date('2026-10-24T12:00:00Z');

describe('shell logic', () => {
  const agent = (id: string, revoked = false, over: Record<string, unknown> = {}) => ({
    id,
    data: {
      revokedAt: revoked ? ts(1) : null,
      lastSeenAt: ts(NOW.getTime() - 30_000),
      signedOutAt: null,
      ...over,
    } as unknown as Agent,
  });

  it('counts connected agents as idle, never revoked, signed-out, quiet or paused ones', () => {
    const agents = [
      agent('a1'),
      agent('a2', false, { signedOutAt: ts(NOW.getTime() - 5_000) }),
      agent('a3', false, { lastSeenAt: ts(NOW.getTime() - 3_600_000) }),
      agent('a4', false, { lastSeenAt: null }),
      agent('a5', true),
      agent('a6', false, { pausedAt: ts(NOW.getTime() - 60_000) }),
    ];
    expect(agentActivity(agents, NOW.getTime())).toEqual({ working: 0, idle: 1 });
  });

  it('formats euros', () => {
    expect(formatEur(0)).toBe('€0');
    expect(formatEur(0.0027)).toBe('<€0.01');
    expect(formatEur(0.04)).toBe('€0.04');
    expect(formatEur(3.5)).toBe('€3.50');
    expect(formatEur(12.004)).toBe('€12');
  });
});

describe('footer agent line with parked items (item QjTTL)', () => {
  it('reads working N · waiting M, and as before without parked items', () => {
    expect(activityText({ working: 1, idle: 0, items: 3, waiting: 1 })).toBe(
      '1 agent · working 2 · waiting 1 · 0 idle',
    );
    expect(activityText({ working: 2, idle: 1, items: 3, waiting: 0 })).toBe(
      '2 agents working on 3 items · 1 idle',
    );
    expect(activityText({ working: 0, idle: 0, items: 0, waiting: 0 })).toBe(
      '0 agents working · 0 idle',
    );
  });
});
