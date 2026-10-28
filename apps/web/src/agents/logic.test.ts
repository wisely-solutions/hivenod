import type { Agent, Item, Project, Run } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import { agentStatus, colorIndex, scopeText, statusText, timeAgo, todayStats } from './logic';

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
const run = (id: string, over: Partial<Run> = {}) => ({
  id,
  data: {
    agentUid: 'a1',
    projectId: 'p1',
    itemId: 'i1',
    stepId: 's',
    startedAt: ts(min(5)),
    heartbeatAt: ts(min(1)),
    endedAt: null,
    status: 'running',
    costEur: 0.5,
    ...over,
  } as Run,
});
const items = { p1: [{ id: 'i1', data: { title: 'Post about bees' } as Item }] };

describe('agent status', () => {
  it('is revoked first', () => {
    const s = agentStatus('a1', agent({ revokedAt: ts(1) }), [run('r')], items, NOW);
    expect(s).toEqual({ kind: 'revoked' });
    expect(statusText(s, NOW)).toBe('Revoked');
  });
  it('is online and working on the item of a fresh running run', () => {
    const s = agentStatus('a1', agent(), [run('r')], items, NOW);
    expect(s).toEqual({ kind: 'online', working: { title: 'Post about bees' } });
    expect(statusText(s, NOW)).toBe('Online · working on “Post about bees”');
  });
  it('says how many items an agent works on at once (card cGSENsRF)', () => {
    const rs = [run('r1'), run('r2', { itemId: 'i2' }), run('r3', { itemId: 'i3' })];
    const s = agentStatus('a1', agent(), rs, items, NOW);
    expect(s).toMatchObject({ kind: 'online', working: { items: 3 } });
    expect(statusText(s, NOW)).toBe('Online · working 3 items');
  });
  it('is online without an item title when the item is not loaded', () => {
    expect(agentStatus('a1', agent(), [run('r')], {}, NOW)).toEqual({
      kind: 'online',
      working: null,
    });
  });
  it('ignores stale heartbeats, ended runs and other agents', () => {
    const rs = [
      run('stale', { heartbeatAt: ts(min(3)) }),
      run('ended', { endedAt: ts(min(9)), heartbeatAt: ts(min(10)), status: 'done' }),
      run('other', { agentUid: 'a2' }),
    ];
    const s = agentStatus('a1', agent(), rs, items, NOW);
    expect(s.kind).toBe('idle');
    expect(statusText(s, NOW)).toBe('Offline · last seen 3 min ago');
  });
  it('is online when seen in the last two minutes, idle after', () => {
    expect(agentStatus('a1', agent({ lastSeenAt: ts(min(1)) }), [], items, NOW).kind).toBe(
      'online',
    );
    const idle = agentStatus('a1', agent({ lastSeenAt: ts(min(180)) }), [], items, NOW);
    expect(statusText(idle, NOW)).toBe('Offline · last seen 3 h ago');
  });
  it('a paused agent shows as paused, not waiting for work, unless a run is still going', () => {
    const paused = agent({
      lastSeenAt: ts(min(1)),
      pausedAt: ts(min(5)),
      pausedReason: '3 failed runs in a row',
    });
    const s = agentStatus('a1', paused, [], items, NOW);
    expect(s).toEqual({ kind: 'paused', reason: '3 failed runs in a row' });
    expect(statusText(s, NOW)).toBe('Paused · 3 failed runs in a row · takes no new work');
    expect(agentStatus('a1', paused, [run('r')], items, NOW).kind).toBe('online');
  });
  it('says not connected yet when there is no sign of life', () => {
    expect(statusText(agentStatus('a1', agent(), [], items, NOW), NOW)).toBe(
      'Offline · not connected yet',
    );
  });
  it('is offline at once when the session said it stopped (Ctrl+C, --once, exit)', () => {
    const stopped = agent({ lastSeenAt: ts(min(1)), signedOutAt: ts(min(0.5)) });
    // A run that ended just before the exit does not keep it online either.
    const ended = run('ended', {
      endedAt: ts(min(0.6)),
      heartbeatAt: ts(min(0.6)),
      status: 'done',
    });
    const s = agentStatus('a1', stopped, [ended], items, NOW);
    expect(s.kind).toBe('idle');
    expect(statusText(s, NOW)).toBe('Offline · last seen just now');
    // Seen again after that (a new session): online.
    const back = agent({ lastSeenAt: ts(min(0.2)), signedOutAt: ts(min(0.5)) });
    expect(agentStatus('a1', back, [], items, NOW).kind).toBe('online');
  });
  it('shows waiting for work when online with no run', () => {
    expect(statusText({ kind: 'online', working: null }, NOW)).toBe('Online · waiting for work');
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
  it('describes the project scope', () => {
    const projects = ['a', 'b', 'c'].map((id) => ({
      id,
      data: { name: id.toUpperCase() } as Project,
    }));
    expect(scopeText(agent(), projects)).toBe('All projects');
    expect(scopeText(agent({ projectIds: ['a'] }), projects)).toBe('A');
    expect(scopeText(agent({ projectIds: ['a', 'b', 'c'] }), projects)).toBe('A, B +1');
    expect(scopeText(agent({ projectIds: ['gone'] }), projects)).toBe('No projects');
  });
  it("counts today's runs and cost", () => {
    const rs = [
      run('1'),
      run('2', { costEur: 1 }),
      run('old', { startedAt: ts(NOW - 2 * 86_400_000) }),
      run('x', { agentUid: 'a2' }),
    ];
    expect(todayStats('a1', rs, NOW)).toEqual({ runs: 2, cost: 1.5 });
  });
});

describe('presence with parked items (item QjTTL)', () => {
  it('reads "working N · waiting M"', () => {
    const claim = (runId: string) => ({ runId, agentUid: 'a1', heartbeatAt: ts(min(1)) });
    const held = (id: string, runId: string, parked: boolean) => ({
      id,
      data: {
        title: id,
        status: 'working',
        claim: claim(runId),
        parked: parked ? { runId, reason: 'release batch', at: ts(min(30)) } : null,
      } as unknown as Item,
    });
    const its = { p1: [held('i1', 'r1', false), held('i2', 'r2', false), held('i3', 'r3', true)] };
    const rs = [run('r1'), run('r2', { itemId: 'i2' }), run('r3', { itemId: 'i3' })];
    const s = agentStatus('a1', agent(), rs, its, NOW);
    expect(s).toMatchObject({ kind: 'online', working: { items: 2, waiting: 1 } });
    expect(statusText(s, NOW)).toBe('Online · working 2 · waiting 1');
  });
});
