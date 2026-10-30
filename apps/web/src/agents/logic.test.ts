import type { Agent } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { agentStatus, colorIndex, statusText, timeAgo } from './logic';

const ts = (ms: number) => ({ toMillis: () => ms }) as never;
const NOW = new Date('2026-10-24T12:00:00').getTime();
const min = (m: number) => NOW - m * 60_000;

const agent = (over: Partial<Agent> = {}): Agent =>
  ({
    name: 'Scout',
    color: 'agent-2',
    projectIds: '*',
    createdBy: 'o',
    createdAt: ts(0),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: '…a7f3',
    previousAgentUid: null,
    lastEventId: 'e',
    ...over,
  }) as Agent;
describe('agent status', () => {
  it('is revoked first', () => {
    const s = agentStatus(agent({ revokedAt: ts(1), lastSeenAt: ts(min(1)) }), NOW);
    expect(s).toEqual({ kind: 'revoked' });
    expect(statusText(s, NOW)).toBe('Revoked');
  });
  it('is online when seen in the last two minutes, offline after', () => {
    const on = agentStatus(agent({ lastSeenAt: ts(min(1)) }), NOW);
    expect(on).toEqual({ kind: 'online' });
    expect(statusText(on, NOW)).toBe('Online · waiting for work');
    const idle = agentStatus(agent({ lastSeenAt: ts(min(180)) }), NOW);
    expect(statusText(idle, NOW)).toBe('Offline · last seen 3 h ago');
  });
  it('a paused agent shows as paused, not waiting for work', () => {
    const paused = agent({
      lastSeenAt: ts(min(1)),
      pausedAt: ts(min(5)),
      pausedReason: '3 failed runs in a row',
    });
    const s = agentStatus(paused, NOW);
    expect(s).toEqual({ kind: 'paused', reason: '3 failed runs in a row' });
    expect(statusText(s, NOW)).toBe('Paused · 3 failed runs in a row · takes no new work');
  });
  it('says not connected yet when there is no sign of life', () => {
    expect(statusText(agentStatus(agent(), NOW), NOW)).toBe('Offline · not connected yet');
  });
  it('is offline at once when the session said it stopped (Ctrl+C, --once, exit)', () => {
    const stopped = agent({ lastSeenAt: ts(min(1)), signedOutAt: ts(min(0.5)) });
    const s = agentStatus(stopped, NOW);
    expect(s.kind).toBe('idle');
    expect(statusText(s, NOW)).toBe('Offline · last seen 1 min ago');
    // Seen again after that (a new session): online.
    const back = agent({ lastSeenAt: ts(min(0.2)), signedOutAt: ts(min(0.5)) });
    expect(agentStatus(back, NOW).kind).toBe('online');
  });
});

describe('helpers', () => {
  it('formats time ago', () => {
    expect(timeAgo(new Date(NOW - 10_000), NOW)).toBe('just now');
    expect(timeAgo(new Date(min(5)), NOW)).toBe('5 min ago');
    expect(timeAgo(new Date(min(180)), NOW)).toBe('3 h ago');
    expect(timeAgo(new Date(min(60 * 24 * 4)), NOW)).toBe('4 d ago');
  });
  it('maps colours, with a stable fallback', () => {
    expect(colorIndex('agent-5', 'x')).toBe(5);
    const f = colorIndex('#2F5FD0', 'uid-1');
    expect(f).toBeGreaterThanOrEqual(1);
    expect(f).toBeLessThanOrEqual(8);
    expect(colorIndex('', 'uid-1')).toBe(f);
  });
});
