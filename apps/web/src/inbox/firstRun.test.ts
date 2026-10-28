import { describe, expect, it } from 'vitest';
import { firstRunDone, firstRunState } from './firstRun';

const none = { projects: [], items: {}, agents: [] };

describe('firstRunState', () => {
  it('starts with nothing done', () => {
    const s = firstRunState(none);
    expect(s).toEqual({ project: false, idea: false, agent: false });
    expect(firstRunDone(s)).toBe(false);
  });
  it('ignores archived projects and revoked agents', () => {
    const s = firstRunState({
      projects: [{ data: { archivedAt: 1 } }],
      items: { a: [] },
      agents: [{ data: { revokedAt: 1 } }],
    });
    expect(s).toEqual({ project: false, idea: false, agent: false });
  });
  it('is done once all three exist', () => {
    const s = firstRunState({
      projects: [{ data: {} }],
      items: { p: [{}] },
      agents: [{ data: {} }],
    });
    expect(firstRunDone(s)).toBe(true);
  });
});

describe('steps already seen done', () => {
  it('stay done after the idea left the open list (REGRESSION: idea reached Done)', () => {
    const s = firstRunState({
      projects: [{ data: {} }],
      items: { p: [] },
      agents: [],
      ever: { project: true, idea: true },
    });
    expect(s).toEqual({ project: true, idea: true, agent: false });
  });
  it('a revoked agent does not undo a connected one', () => {
    const s = firstRunState({
      projects: [],
      items: {},
      agents: [{ data: { revokedAt: 1 } }],
      ever: { agent: true },
    });
    expect(s.agent).toBe(true);
  });
});
