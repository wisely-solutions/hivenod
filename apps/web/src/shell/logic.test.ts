import type { Agent, Item, Project, Run } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  agentActivity,
  itemsInWork,
  countNeedsYou,
  formatEur,
  isLive,
  monthSpend,
  needsMyDecision,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });
const NOW = new Date('2026-10-24T12:00:00Z');

function project(over: Partial<Project> = {}): Project {
  return {
    name: 'P',
    emoji: '',
    color: 'c1',
    templateId: 't',
    steps: [
      { id: 'a', name: 'Agent', kind: 'agent', description: '', outputs: [] },
      {
        id: 'h',
        name: 'Review',
        kind: 'human',
        description: '',
        outputs: [],
        gate: {
          deciderUids: ['me', 'you'],
          groupIds: [],
          rule: 'any',
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: 24,
        },
      },
    ],
    stepIndex: { a: 0, h: 1 },
    createdBy: 'me',
    createdAt: ts(0),
    archivedAt: null,
    lastEventId: 'e',
    ...over,
  } as unknown as Project;
}

function item(over: Partial<Item> = {}): Item {
  return {
    title: 'T',
    stepId: 'h',
    status: 'waiting',
    gate: { stepId: 'h', approvals: {}, rejections: {} },
    ...over,
  } as unknown as Item;
}

describe('needsMyDecision', () => {
  it('is true for a decider who has not decided', () => {
    expect(needsMyDecision(project(), item(), 'me')).toBe(true);
  });
  it('is false for non-deciders, decided people and non-waiting items', () => {
    expect(needsMyDecision(project(), item(), 'other')).toBe(false);
    const decided = item({
      gate: { stepId: 'h', approvals: { me: { at: ts(1), rationale: '' } }, rejections: {} },
    });
    expect(needsMyDecision(project(), decided, 'me')).toBe(false);
    expect(needsMyDecision(project(), item({ status: 'working' }), 'me')).toBe(false);
    expect(needsMyDecision(project(), item({ stepId: 'a' }), 'me')).toBe(false);
  });
});

describe('countNeedsYou', () => {
  it('counts per project and skips archived projects', () => {
    const rows = [
      { id: 'p1', data: project() },
      { id: 'p2', data: project({ archivedAt: ts(1) }) },
    ];
    const items = {
      p1: [
        { id: 'i1', data: item() },
        { id: 'i2', data: item({ status: 'done' }) },
      ],
      p2: [{ id: 'i3', data: item() }],
    };
    expect(countNeedsYou(rows, items, 'me')).toEqual({ total: 1, byProject: { p1: 1 } });
  });
});

describe('agents and spend', () => {
  const run = (over: Partial<Run>): { id: string; data: Run } => ({
    id: Math.random().toString(),
    data: {
      agentUid: 'a1',
      status: 'running',
      endedAt: null,
      heartbeatAt: ts(NOW.getTime() - 60_000),
      startedAt: ts(NOW.getTime() - 3600_000),
      costEur: 1.5,
      ...over,
    } as unknown as Run,
  });
  const agent = (id: string, revoked = false, over: Record<string, unknown> = {}) => ({
    id,
    data: {
      revokedAt: revoked ? ts(1) : null,
      lastSeenAt: ts(NOW.getTime() - 30_000),
      signedOutAt: null,
      ...over,
    } as unknown as Agent,
  });

  it('counts the items in work once each: live runs and fresh claims (card cGSENsRF)', () => {
    const runs = [
      { ...run({}), id: 'r1' },
      { ...run({ itemId: 'i2' }), id: 'r2' },
      { ...run({ itemId: 'i3', heartbeatAt: ts(NOW.getTime() - 3_600_000) }), id: 'r3' },
    ];
    const claim = (runId: string) => ({
      id: 'x',
      data: item({
        status: 'working',
        claim: { runId, agentUid: 'a1', heartbeatAt: ts(NOW.getTime() - 1000) },
      }),
    });
    expect(itemsInWork(runs, NOW.getTime())).toBe(2);
    expect(itemsInWork(runs, NOW.getTime(), [claim('r1'), claim('r9')])).toBe(3);
    expect(itemsInWork([], NOW.getTime())).toBe(0);
  });

  it('counts only fresh running runs as working, and ignores revoked agents', () => {
    const agents = [agent('a1'), agent('a2'), agent('a3', true)];
    const runs = [run({}), run({ agentUid: 'a2', heartbeatAt: ts(NOW.getTime() - 3_600_000) })];
    expect(agentActivity(agents, runs, NOW.getTime())).toEqual({ working: 1, idle: 1 });
    expect(isLive(runs[1]!.data, NOW.getTime())).toBe(false);
  });

  it('does not count an agent that signed out or went quiet as idle (the agent page says Offline)', () => {
    const agents = [
      agent('a1'),
      agent('a2', false, { signedOutAt: ts(NOW.getTime() - 5_000) }),
      agent('a3', false, { lastSeenAt: ts(NOW.getTime() - 3_600_000) }),
      agent('a4', false, { lastSeenAt: null }),
    ];
    expect(agentActivity(agents, [], NOW.getTime())).toEqual({ working: 0, idle: 1 });
  });

  it('does not count a paused agent as idle, even when seen a moment ago', () => {
    const agents = [agent('a1'), agent('a2', false, { pausedAt: ts(NOW.getTime() - 60_000) })];
    expect(agentActivity(agents, [], NOW.getTime())).toEqual({ working: 0, idle: 1 });
  });

  it('counts an agent holding a fresh claim as working, even before its run shows', () => {
    const agents = [agent('a1'), agent('a2')];
    const claim = (agentUid: string, ago: number) => ({
      id: 'i',
      data: item({
        status: 'working',
        claim: { runId: 'r', agentUid, heartbeatAt: ts(NOW.getTime() - ago) },
      }),
    });
    expect(agentActivity(agents, [], NOW.getTime(), [claim('a1', 1000)])).toEqual({
      working: 1,
      idle: 1,
    });
    expect(agentActivity(agents, [], NOW.getTime(), [claim('a1', 3_600_000)])).toEqual({
      working: 0,
      idle: 2,
    });
  });

  it('sums this month only', () => {
    const old = run({ startedAt: ts(new Date('2026-09-30T10:00:00Z').getTime()), costEur: 9 });
    expect(monthSpend([run({}), run({ costEur: 2 }), old], NOW)).toBe(3.5);
  });

  it('formats euros', () => {
    expect(formatEur(0)).toBe('€0');
    expect(formatEur(0.0027)).toBe('<€0.01');
    expect(formatEur(0.04)).toBe('€0.04');
    expect(formatEur(3.5)).toBe('€3.50');
    expect(formatEur(12.004)).toBe('€12');
  });
});

describe('spendText', () => {
  it('shows the spend only once it is final', async () => {
    const { spendText } = await import('./logic');
    expect(spendText(141, false)).toBe('€…');
    expect(spendText(141, true)).toBe('€141');
  });

  it('falls back to the last confirmed value while unconfirmed', async () => {
    const { spendText } = await import('./logic');
    expect(spendText(5, false, 'x')).toBe('€…');
    spendText(141, true, 'x');
    expect(spendText(5, false, 'x')).toBe('€141');
    expect(spendText(5, false, 'other')).toBe('€…');
  });
});
