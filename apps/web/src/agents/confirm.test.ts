import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  checkConnect,
  CONNECT_ERRORS,
  initialChoice,
  newlyConnected,
  stepsLeftOut,
  withAgentOnSteps,
} from './confirm';

const base = {
  publicKey: 'B' + 'x'.repeat(86),
  cli: 'claude',
  host: 'laptop',
  folder: 'blog',
  status: 'pending',
  kind: 'connect',
};
const at = (minutesAgo: number) => Timestamp.fromMillis(Date.now() - minutesAgo * 60_000);

describe('checkConnect', () => {
  it('accepts a fresh connect request', () => {
    const r = checkConnect('K7QX29PD', { ...base, createdAt: at(1) });
    expect(r.ok).toBe(true);
  });
  it('refuses an expired one after 10 minutes', () => {
    expect(checkConnect('K7QX29PD', { ...base, createdAt: at(11) })).toEqual({
      ok: false,
      error: CONNECT_ERRORS.expired,
    });
  });
  it('refuses a used one', () => {
    expect(checkConnect('K7QX29PD', { ...base, status: 'paired', createdAt: at(1) })).toMatchObject(
      { ok: false, error: CONNECT_ERRORS.used },
    );
  });
  it('refuses a missing one', () => {
    expect(checkConnect('K7QX29PD', null)).toMatchObject({ error: CONNECT_ERRORS.missing });
  });
  it('sends a hivenod pair code to the admins page', () => {
    expect(checkConnect('K7QX29PD', { ...base, kind: undefined, createdAt: at(1) })).toMatchObject({
      ok: false,
      pair: 'K7QX29PD',
    });
  });
});

describe('projects and steps', () => {
  it('ticks all projects when they fit, none when a member has more than 5', () => {
    expect(initialChoice(['a', 'b'], false)).toEqual(['a', 'b']);
    expect(initialChoice(['a', 'b', 'c', 'd', 'e', 'f'], false)).toEqual([]);
    expect(initialChoice(['a', 'b', 'c', 'd', 'e', 'f'], true)).toHaveLength(6);
  });
  const steps = [
    { id: 'shape', kind: 'agent' },
    { id: 'approve', kind: 'human' },
    { id: 'build', kind: 'agent' },
  ] as never;
  it('adds the agent to limited agent steps only', () => {
    expect(withAgentOnSteps({ steps, stepAgents: {} }, 'n')).toBeNull();
    expect(withAgentOnSteps({ steps, stepAgents: { build: ['old'] } }, 'n')).toEqual({
      build: ['old', 'n'],
    });
    expect(withAgentOnSteps({ steps, stepAgents: { build: ['n'] } }, 'n')).toBeNull();
    expect(withAgentOnSteps({ steps, stepAgents: { approve: ['x'] } }, 'n')).toBeNull();
  });
  it('counts limited steps a plain member may not change', () => {
    const p = (createdBy: string) => ({
      id: createdBy,
      data: { steps, stepAgents: { build: ['old'] }, createdBy },
    });
    expect(stepsLeftOut({ uid: 'alice', isAdmin: false }, [p('alice'), p('owner')])).toBe(1);
    expect(stepsLeftOut({ uid: 'owner', isAdmin: true }, [p('alice')])).toBe(0);
  });
});

describe('newlyConnected', () => {
  const a = (id: string, createdBy: string, minutesAgo: number, revokedAt: unknown = null) => ({
    id,
    data: { createdBy, createdAt: at(minutesAgo), revokedAt },
  });
  it('finds the newest agent this person made since the page opened', () => {
    const since = Date.now() - 5 * 60_000;
    expect(newlyConnected([a('old', 'me', 30), a('new', 'me', 1)], 'me', since)?.id).toBe('new');
    expect(newlyConnected([a('x', 'other', 1)], 'me', since)).toBeNull();
    expect(newlyConnected([a('r', 'me', 1, at(0))], 'me', since)).toBeNull();
    expect(newlyConnected([a('old', 'me', 30)], 'me', since)).toBeNull();
  });
});
