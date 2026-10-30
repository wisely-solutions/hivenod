import { describe, expect, it } from 'vitest';
import type { Agent } from '@hive/shared';
import { projectsToRelink } from './flow';
import { parseCount, settingsChanged, settingsDraft, settingsErrors } from './settings';

const agent = { projectIds: ['p1'] } as unknown as Agent;

describe('agent settings form', () => {
  it('starts from the defaults for an agent without settings', () => {
    expect(settingsDraft(agent)).toEqual({
      allProjects: false,
      projectIds: ['p1'],
      maxFailedRuns: '3',
    });
  });
  it('ignores stored token limits and permissions (old agents)', () => {
    const old = {
      projectIds: ['p1'],
      guardrails: { maxFailedRuns: 5, maxTokensPerItem: 250_000 },
      permissions: ['runCommands'],
    } as unknown as Agent;
    expect(settingsDraft(old)).toEqual({
      allProjects: false,
      projectIds: ['p1'],
      maxFailedRuns: '5',
    });
  });
  it('reads counts with separators and checks ranges', () => {
    expect(parseCount('500,000')).toBe(500000);
    expect(parseCount('1 000')).toBe(1000);
    expect(parseCount('1e6')).toBeNull();
    const d = settingsDraft(agent);
    expect(settingsErrors(d)).toEqual({});
    expect(settingsErrors({ ...d, projectIds: [], maxFailedRuns: '0' })).toEqual({
      projects: 'Pick at least one project.',
      maxFailedRuns: 'A whole number from 1 to 20.',
    });
    expect(settingsErrors({ ...d, allProjects: true, projectIds: [] })).toEqual({});
  });
  it('knows when something changed', () => {
    const d = settingsDraft(agent);
    expect(settingsChanged(d, { ...d, projectIds: ['p1'] })).toBe(false);
    expect(settingsChanged(d, { ...d, maxFailedRuns: '4' })).toBe(true);
    expect(settingsChanged(d, { ...d, allProjects: true })).toBe(true);
    expect(settingsChanged(d, { ...d, projectIds: ['p1', 'p2'] })).toBe(true);
  });
  it('a rotated agent takes over the steps limited to the old identity', () => {
    const projects: { id: string; data: { stepAgents: Record<string, string[]> } }[] = [
      { id: 'a', data: { stepAgents: { s1: ['old'] } } },
      { id: 'b', data: { stepAgents: { s1: ['other'] } } },
      { id: 'c', data: { stepAgents: {} } },
    ];
    expect(projectsToRelink(projects, 'old').map((p) => p.id)).toEqual(['a']);
  });
});

describe('an Inbox-only agent (item fJnu6)', () => {
  it('needs no projects, and the fields create it with none', async () => {
    const inbox = { projectIds: [], scope: 'inbox' } as unknown as Agent;
    const d = settingsDraft(inbox);
    expect(d.inboxOnly).toBe(true);
    expect(settingsErrors(d)).toEqual({});
    const { agentScopeInput } = await import('./NewAgentModal');
    expect(agentScopeInput({ scope: 'inbox', chosen: ['p1'] })).toEqual({
      projectIds: [],
      scope: 'inbox',
    });
    expect(agentScopeInput({ scope: 'all', chosen: [] })).toEqual({ projectIds: '*' });
    expect(agentScopeInput({ scope: 'some', chosen: ['p1'] })).toEqual({ projectIds: ['p1'] });
  });
});
