import { EVENT_TYPES, type HiveEvent, type Project, type Run } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { Row } from '../lib/live';
import {
  describeEvent,
  describeEventWithItem,
  VERBS,
  latestByProject,
  orderProjects,
  projectColorIndex,
  summarize,
  timeAgo,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });
const NOW = 1_700_000_000_000;
const run = (over: Partial<Run>): Row<Run> => ({
  id: Math.random().toString(),
  data: {
    agentUid: 'a1',
    projectId: 'p1',
    status: 'running',
    endedAt: null,
    heartbeatAt: ts(NOW - 30_000),
    startedAt: ts(NOW - 60_000),
    costEur: 0.5,
    ...over,
  } as Run,
});
const project = (id: string, created: number): Row<Project> => ({
  id,
  data: { createdAt: ts(created), name: id } as unknown as Project,
});
const ev = (id: string, pid: string | null, at: number): Row<HiveEvent> => ({
  id,
  data: {
    actor: { type: 'agent', id: 'a1', name: 'Scout' },
    projectId: pid,
    type: 'item.completed',
    at: ts(at),
  } as unknown as HiveEvent,
});

describe('summarize', () => {
  it('counts open items, live agents and spend for one project', () => {
    const runs = [
      run({ costEur: 0.25 }),
      run({ agentUid: 'a2', costEur: 1 }),
      run({ agentUid: 'a1', costEur: 2 }),
      run({ agentUid: 'a3', status: 'done', endedAt: ts(NOW - 5000), costEur: 3 }),
      run({ projectId: 'p2', costEur: 99 }),
      run({ agentUid: 'a4', heartbeatAt: ts(NOW - 20 * 60_000), costEur: 1 }),
    ];
    const items = { p1: [{}, {}, {}] } as never;
    expect(summarize('p1', items, runs, 2, NOW)).toEqual({
      needsYou: 2,
      openItems: 3,
      agentsActive: 2,
      spend: 7.25,
    });
    expect(summarize('p9', {}, runs, 0, NOW)).toEqual({
      needsYou: 0,
      openItems: 0,
      agentsActive: 0,
      spend: 0,
    });
  });
});

describe('orderProjects', () => {
  it('puts projects that need you first, then the newest', () => {
    const rows = [project('old', 1), project('new', 3), project('mid', 2)];
    expect(orderProjects(rows, {}).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(orderProjects(rows, { old: 2, mid: 1 }).map((r) => r.id)).toEqual(['old', 'mid', 'new']);
  });
});

describe('events', () => {
  it('has a human label for every event type', () => {
    for (const t of EVENT_TYPES) {
      expect(VERBS[t], t).toBeTruthy();
      expect(VERBS[t]).not.toMatch(/[a-z]+\.[a-zA-Z]+/);
    }
    expect(Object.keys(VERBS).sort()).toEqual([...EVENT_TYPES].sort());
    expect(
      describeEvent({
        actor: { type: 'human', id: 'u', name: 'Ana' },
        type: 'project.membersChanged',
      }),
    ).toBe('Ana changed who is on the project');
  });
  it('says restored for a restored project', () => {
    const actor = { type: 'human' as const, id: 'u', name: 'Ana' };
    expect(describeEvent({ actor, type: 'project.updated', data: { restored: true } })).toBe(
      'Ana restored a project',
    );
    expect(describeEvent({ actor, type: 'project.updated', data: {} })).toBe(
      'Ana updated a project',
    );
  });
  it('describes who did what', () => {
    expect(describeEvent(ev('e', 'p1', 1).data)).toBe('Scout finished a step');
    expect(
      describeEvent({ actor: { type: 'human', id: 'u', name: '' }, type: 'project.created' }),
    ).toBe('Someone created a project');
  });
  it('finds the latest event per project and ignores workspace events', () => {
    const l = latestByProject([
      ev('a', 'p1', 5),
      ev('b', 'p1', 9),
      ev('c', null, 99),
      ev('d', 'p2', 1),
    ]);
    expect(Object.keys(l).sort()).toEqual(['p1', 'p2']);
    expect(l.p1!.id).toBe('b');
  });
});

describe('timeAgo', () => {
  it('reads naturally', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5 min ago');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(timeAgo(NOW - 24 * 3_600_000, NOW)).toBe('yesterday');
    expect(timeAgo(NOW - 5 * 24 * 3_600_000, NOW)).toBe('5 days ago');
  });
});

describe('projectColorIndex', () => {
  it('uses the stored colour, else a stable pick', () => {
    expect(projectColorIndex('agent-3', 'x')).toBe(3);
    expect(projectColorIndex('', 'abc')).toBe(projectColorIndex('', 'abc'));
    expect(projectColorIndex('zzz', 'abc')).toBeGreaterThanOrEqual(1);
  });

  it('names the item when its title is known', () => {
    const e = {
      actor: { type: 'human' as const, id: 'u', name: 'Rui' },
      type: 'decision.sentBack' as const,
      itemId: 'i1',
      data: {},
    };
    expect(describeEventWithItem(e, 'Ticket assignment rules')).toBe(
      'Rui sent “Ticket assignment rules” back',
    );
    expect(describeEventWithItem(e, null)).toBe(describeEvent(e));
    expect(describeEventWithItem({ ...e, itemId: null }, 'X')).toBe(describeEvent(e));
  });
});
