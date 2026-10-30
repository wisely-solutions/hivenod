import { describe, expect, it } from 'vitest';
import { clampZoom, hostOf } from './logic';

describe('small helpers', () => {
  it('clamps zoom', () => {
    expect(clampZoom(99)).toBe(5);
    expect(clampZoom(0.1)).toBe(0.5);
  });
  it('shows a link host', () => {
    expect(hostOf('https://example.com/a?b')).toBe('example.com');
  });
});

