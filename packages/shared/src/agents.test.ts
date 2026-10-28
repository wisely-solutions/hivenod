import { describe, expect, it } from 'vitest';
import {
  agentMayTakeStep,
  allowedAgentsFor,
  canEditAgentSettings,
  formatTokens,
  guardrailsOf,
  newTokens,
  normalizeStepAgents,
  sameStepAgents,
  AGENT_ONLINE_MS,
  liveTerminal,
  streakAfter,
  tokenTotals,
} from './agents';
import { releaseClaim, endRun, completeStep, heartbeat, type ItemState } from './actions';

const ctx = { workspaceId: 'w', actor: { type: 'agent' as const, id: 'a1', name: 'A' } };
const steps = [
  { id: 'draft', kind: 'agent' },
  { id: 'review', kind: 'human' },
  { id: 'publish', kind: 'agent' },
];

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
  it('admins always; the project creator for a project’s step limits; nobody else', () => {
    expect(canEditAgentSettings({ uid: 'x', isAdmin: true })).toBe(true);
    expect(canEditAgentSettings({ uid: 'x', isAdmin: false })).toBe(false);
    expect(canEditAgentSettings({ uid: 'x', isAdmin: false }, { createdBy: 'x' })).toBe(true);
    expect(canEditAgentSettings({ uid: 'x', isAdmin: false }, { createdBy: 'y' })).toBe(false);
  });
});

describe('per-step allowed agents', () => {
  const project = { stepAgents: { draft: ['a1'], publish: [] } };
  it('an empty or missing list means any agent', () => {
    expect(agentMayTakeStep(project, 'draft', 'a1')).toBe(true);
    expect(agentMayTakeStep(project, 'draft', 'a2')).toBe(false);
    expect(agentMayTakeStep(project, 'publish', 'a2')).toBe(true);
    expect(agentMayTakeStep({ stepAgents: {} }, 'draft', 'a2')).toBe(true);
    expect(allowedAgentsFor(project, 'nope')).toEqual([]);
  });
  it('normalizes: steps that exist, non-empty, no duplicates', () => {
    expect(
      normalizeStepAgents(steps, {
        draft: ['a1', 'a1', 'a2'],
        review: ['a1'],
        publish: [],
        gone: ['a1'],
      }),
    ).toEqual({ draft: ['a1', 'a2'], review: ['a1'] });
  });
  it('compares maps regardless of order', () => {
    expect(sameStepAgents({ d: ['a', 'b'] }, { d: ['b', 'a'] })).toBe(true);
    expect(sameStepAgents({ d: ['a'] }, { d: ['a', 'b'] })).toBe(false);
    expect(sameStepAgents({ d: [] }, {})).toBe(true);
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

describe('failure streak', () => {
  it('done resets, failed adds one and pauses at the limit, released leaves it', () => {
    expect(streakAfter({}, 'done')).toBeNull();
    expect(streakAfter({ failStreak: 2 }, 'done')).toEqual({ failStreak: 0, pause: false });
    expect(streakAfter({ failStreak: 1 }, 'failed')).toEqual({ failStreak: 2, pause: false });
    expect(streakAfter({ failStreak: 2 }, 'failed')).toEqual({ failStreak: 3, pause: true });
    expect(streakAfter({ failStreak: 0, guardrails: { maxFailedRuns: 1 } }, 'failed')).toEqual({
      failStreak: 1,
      pause: true,
    });
    const paused = { failStreak: 5, pausedAt: { seconds: 1 } as never };
    expect(streakAfter(paused, 'failed')).toEqual({ failStreak: 6, pause: false });
    expect(streakAfter({ failStreak: 4 }, 'released')).toBeNull();
    // a paused agent finishing a live run stays paused with its streak
    expect(streakAfter({ failStreak: 3, pausedAt: { seconds: 1 } as never }, 'done')).toBeNull();
  });
  it('the run-ending actions carry the agent update in the same batch', () => {
    const item = {
      stepId: 'draft',
      claim: { runId: 'r1', agentUid: 'a1', heartbeatAt: {} },
      costEur: 0,
    } as unknown as ItemState;
    const failed = endRun(ctx, {
      projectId: 'p',
      itemId: 'i',
      runId: 'r1',
      result: { status: 'failed' },
      agent: { failStreak: 2 },
    });
    const agentOp = failed.ops.find((o) => o.path === 'workspaces/w/agents/a1');
    expect(agentOp?.data).toMatchObject({
      failStreak: 3,
      pausedReason: '3 failed runs in a row',
      lastEventId: failed.eventId,
    });
    const ev = failed.ops.find((o) => o.path.includes('/events/'));
    expect(ev?.data?.data).toMatchObject({ agentPaused: true });

    const rel = releaseClaim(ctx, {
      projectId: 'p',
      itemId: 'i',
      item: { ...item, costEur: 0.5 },
      status: 'failed',
      result: { tokensIn: 10, tokensCached: 50, costEur: 0.15 },
      agent: {},
    });
    // The run's cost counts on the item although the step was not completed (card JJ6fYb3b).
    expect(rel.ops.find((o) => o.path.includes('/items/'))?.data).toMatchObject({ costEur: 0.65 });
    const run = rel.ops.find((o) => o.path === 'workspaces/w/runs/r1');
    expect(run?.data).toMatchObject({ status: 'failed', tokensIn: 10, tokensCached: 10 });
    expect(rel.ops.find((o) => o.path === 'workspaces/w/agents/a1')?.data).toMatchObject({
      failStreak: 1,
    });

    const done = completeStep(ctx, {
      project: { steps: [{ id: 'draft', name: 'D', kind: 'agent', description: '' }] },
      projectId: 'p',
      itemId: 'i',
      item,
      agent: { failStreak: 0 },
    });
    expect(done.ops.some((o) => o.path === 'workspaces/w/agents/a1')).toBe(false);
  });
  it('heartbeats carry usage, clamped to whole numbers and cached <= in', () => {
    const p = heartbeat(ctx, {
      projectId: 'p',
      itemId: 'i',
      runId: 'r1',
      lastHeartbeatEventAtMs: Date.now(),
      usage: { tokensIn: 10.4, tokensOut: 2, tokensCached: 99, model: 'x'.repeat(100) },
    });
    expect(p.ops[0]?.data).toMatchObject({ tokensIn: 10, tokensOut: 2, tokensCached: 10 });
    expect((p.ops[0]?.data?.model as string).length).toBe(80);
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
