import { describe, expect, it } from 'vitest';
import { nextKey, parseFilter, swipeAction, waitLabel } from './logic';

describe('Today helpers', () => {
  it('labels waiting time', () => {
    expect(waitLabel(0, 30_000)).toBe('just now');
    expect(waitLabel(0, 5 * 60_000)).toBe('5 min');
    expect(waitLabel(0, 3 * 3_600_000)).toBe('3 h');
    expect(waitLabel(0, 50 * 3_600_000)).toBe('2 d');
  });

  it('picks the next key after one leaves', () => {
    const l = ['a', 'b', 'c'].map((key) => ({ key }));
    expect(nextKey(l, 'a')).toBe('b');
    expect(nextKey(l, 'c')).toBe('b');
    expect(nextKey([l[0]!], 'a')).toBeNull();
  });

  it('reads swipes', () => {
    expect(swipeAction(120)).toBe('approve');
    expect(swipeAction(-120)).toBe('iterate');
    expect(swipeAction(40)).toBeNull();
  });

  it('parses the kind filter; findings are gone with Projects', () => {
    expect(parseFilter('approvals')).toBe('approvals');
    expect(parseFilter('questions')).toBe('questions');
    expect(parseFilter('findings')).toBe('all');
    expect(parseFilter(undefined)).toBe('all');
  });
});
