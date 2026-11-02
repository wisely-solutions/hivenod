import { describe, expect, it } from 'vitest';
import { replacedLive } from './store';

const p = (id: string, threadId: string, state: string, at: number) => ({
  id,
  threadId,
  plan: { state },
  at,
});

describe('replacedLive', () => {
  it('marks a proposed plan replaced by a newer live plan on the same thread', () => {
    const r = replacedLive([p('old', 't1', 'proposed', 1), p('new', 't1', 'active', 2)]);
    expect([...r]).toEqual(['old']);
  });
  it('keeps plans of other threads and the newest plan', () => {
    const r = replacedLive([
      p('a', 't1', 'proposed', 1),
      p('b', 't2', 'proposed', 2),
      p('c', 't1', 'proposed', 3),
    ]);
    expect([...r]).toEqual(['a']);
  });
  it('an older active plan is never replaced', () => {
    expect(replacedLive([p('a', 't1', 'active', 1), p('b', 't1', 'proposed', 2)]).size).toBe(0);
  });
});
