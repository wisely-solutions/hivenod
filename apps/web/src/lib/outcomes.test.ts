import { describe, expect, it } from 'vitest';
import { isSentBack, outcomeName } from './outcomes';

describe('outcomes', () => {
  it('counts only sentBack as sent back', () => {
    expect(isSentBack('sentBack')).toBe(true);
    for (const o of ['approved', 'stopped', 'answered'] as const) expect(isSentBack(o)).toBe(false);
  });
  it('names outcomes as the app does', () => {
    expect(outcomeName('approved')).toBe('Approved');
    expect(outcomeName('sentBack')).toBe('Sent back');
    expect(outcomeName('stopped')).toBe('Stopped');
  });
});
