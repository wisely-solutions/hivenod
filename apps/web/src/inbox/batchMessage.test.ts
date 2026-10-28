import { describe, expect, it } from 'vitest';
import { batchMessage } from './useDecide';

describe('batchMessage', () => {
  it('says what was decided and what had already moved', () => {
    expect(batchMessage(3, 'approved', 0)).toBe('3 approved');
    expect(batchMessage(3, 'approved', 1)).toBe('3 approved, 1 had already moved');
    expect(batchMessage(2, 'rejected', 0)).toBe('2 rejected');
    expect(batchMessage(0, 'approved', 2)).toBe('Nothing approved: 2 had already moved');
  });
});
