import { describe, expect, it } from 'vitest';
import { formatStars, MIN_STARS } from './stars';

describe('formatStars', () => {
  it('hides the count under 50 or when unknown', () => {
    expect(MIN_STARS).toBe(50);
    expect(formatStars(null)).toBeNull();
    expect(formatStars(undefined)).toBeNull();
    expect(formatStars(0)).toBeNull();
    expect(formatStars(49)).toBeNull();
    expect(formatStars(Number.NaN)).toBeNull();
    expect(formatStars('120' as unknown as number)).toBeNull();
  });

  it('shows whole numbers under 1000, then k with one decimal', () => {
    expect(formatStars(50)).toBe('50');
    expect(formatStars(999)).toBe('999');
    expect(formatStars(1000)).toBe('1k');
    expect(formatStars(1234)).toBe('1.2k');
    expect(formatStars(12_960)).toBe('13k');
  });
});
