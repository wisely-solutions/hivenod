import { describe, expect, it } from 'vitest';
import {
  canEditAgentSettings,
  formatTokens,
  guardrailsOf,
  newTokens,
  AGENT_ONLINE_MS,
  liveTerminal,
  tokenTotals,
} from './agents';

describe('guardrails defaults', () => {
  it('fills defaults for agents created before the settings existed', () => {
    expect(guardrailsOf({})).toEqual({ maxFailedRuns: 3 });
    expect(guardrailsOf({ guardrails: { maxFailedRuns: 5 } })).toEqual({ maxFailedRuns: 5 });
  });
  it('ignores a stored token limit (usage is tracked, never limited)', () => {
    const old = { guardrails: { maxFailedRuns: 4, maxTokensPerItem: 1000 } };
    expect(guardrailsOf(old as never)).toEqual({ maxFailedRuns: 4 });
  });
});

describe('who may edit agent settings (the one place)', () => {
  it('admins only', () => {
    expect(canEditAgentSettings({ uid: 'x', isAdmin: true })).toBe(true);
    expect(canEditAgentSettings({ uid: 'x', isAdmin: false })).toBe(false);
  });
});

describe('tokens', () => {
  it('new tokens leave cache reads out', () => {
    expect(newTokens({ tokensIn: 1000, tokensCached: 800, tokensOut: 50 })).toBe(250);
    expect(newTokens({ tokensIn: 10, tokensOut: 5 })).toBe(15);
  });
  it('totals and models over runs', () => {
    const t = tokenTotals([
      { tokensIn: 100, tokensOut: 10, tokensCached: 50, model: 'm1' },
      { tokensIn: 200, tokensOut: 20, model: 'm2' },
      { tokensIn: 0, tokensOut: 0, model: 'm2' },
      { tokensIn: 1, tokensOut: 1, model: null },
    ]);
    expect(t).toMatchObject({ tokensIn: 301, tokensOut: 31, tokensCached: 50, newTokens: 282 });
    expect(t.models).toEqual(['m2', 'm1']);
  });
  it('formats compactly', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(41_000)).toBe('41k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(2_000_000)).toBe('2M');
  });
});

describe('one terminal per agent', () => {
  const ts = (ms: number) => ({ toMillis: () => ms }) as never;
  const now = 10_000_000;
  it('a fresh presence is a live terminal, with its host', () => {
    const t = liveTerminal({ lastSeenAt: ts(now - 30_000), seenHost: 'laptop' }, now);
    expect(t?.host).toBe('laptop');
    expect(t?.since.getTime()).toBe(now - 30_000);
  });
  it('a stale presence (a crashed terminal) does not count after the online window', () => {
    expect(liveTerminal({ lastSeenAt: ts(now - AGENT_ONLINE_MS) }, now)).toBeNull();
    expect(liveTerminal({ lastSeenAt: ts(now - AGENT_ONLINE_MS + 1) }, now)).not.toBeNull();
  });
  it('a signed-out terminal and a never-seen agent do not count', () => {
    expect(
      liveTerminal({ lastSeenAt: ts(now - 1000), signedOutAt: ts(now - 500) }, now),
    ).toBeNull();
    expect(liveTerminal({ lastSeenAt: null }, now)).toBeNull();
    expect(
      liveTerminal({ lastSeenAt: ts(now - 1000), signedOutAt: ts(now - 2000) }, now),
    ).not.toBeNull();
  });
});
