import { describe, expect, it } from 'vitest';
import { formatWait, median, parseRange, rangeStart } from './logic';

describe('median', () => {
  it('handles odd, even and empty', () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe('range', () => {
  it('parses and defaults to 30', () => {
    expect(parseRange('7')).toBe(7);
    expect(parseRange('x')).toBe(30);
  });
  it('window starts at local midnight', () => {
    const now = new Date(2026, 9, 25, 15, 30).getTime();
    expect(new Date(rangeStart(7, now)).getDate()).toBe(19);
    expect(new Date(rangeStart(7, now)).getHours()).toBe(0);
  });
});

describe('formatWait', () => {
  it('reads naturally', () => {
    expect(formatWait(null)).toBe('n/a');
    expect(formatWait(20_000)).toBe('<1 min');
    expect(formatWait(25 * 60_000)).toBe('25 min');
    expect(formatWait(90 * 60_000)).toBe('1.5 h');
    expect(formatWait(3 * 86_400_000)).toBe('3 d');
  });
});
