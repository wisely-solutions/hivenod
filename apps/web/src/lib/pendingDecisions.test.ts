import { SERVER_TIME } from '@hive/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventPath, forget, onLeave, readAll, stash, takeReplayable } from './pendingDecisions';

const plan = [
  { kind: 'update' as const, path: 'workspaces/w/projects/p/items/i', data: { at: SERVER_TIME } },
  { kind: 'set' as const, path: 'workspaces/w/events/e1', data: { at: SERVER_TIME } },
];

describe('pending decisions', () => {
  beforeEach(() => localStorage.clear());

  it('keeps placeholders across storage and clears on forget', () => {
    const done = stash('u', 'w', [plan], 'Saved');
    const [s] = readAll('u', 'w');
    expect(s?.plans[0]?.[0]?.data?.at).toBe(SERVER_TIME);
    expect(eventPath(s!.plans[0]!)).toBe('workspaces/w/events/e1');
    done();
    expect(readAll('u', 'w')).toEqual([]);
  });

  it('a page does not replay what it is still counting down itself', () => {
    stash('u', 'w', [plan], 'Saved');
    expect(takeReplayable('u', 'w').ready).toEqual([]);
  });

  it('replays a reloaded tab at once, another tab only after its window', () => {
    localStorage.setItem(
      'hive.pendingDecisions.u.w',
      JSON.stringify([
        { id: 'a', tab: 'x', at: 1000, plans: [], done: '' },
        { id: 'b', tab: 'other', at: 1000, plans: [], done: '' },
      ]),
    );
    sessionStorage.setItem('hive.tab', 'x');
    const early = takeReplayable('u', 'w', 2000);
    expect(early.ready.map((s) => s.id)).toEqual(['a']);
    expect(early.again).toBeGreaterThan(0);
    expect(takeReplayable('u', 'w', 9000).ready.map((s) => s.id)).toEqual(['a', 'b']);
    forget('u', 'w', 'a');
    expect(readAll('u', 'w').map((s) => s.id)).toEqual(['b']);
  });
});

describe('onLeave', () => {
  const setVisibility = (v: 'hidden' | 'visible') =>
    Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });

  it('flushes on pagehide and when the page becomes hidden, not while visible', () => {
    const flush = vi.fn();
    const off = onLeave(flush);
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(flush).toHaveBeenCalledTimes(2);
    off();
    window.dispatchEvent(new Event('pagehide'));
    expect(flush).toHaveBeenCalledTimes(2);
    setVisibility('visible');
  });
});
