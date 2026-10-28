import { describe, expect, it } from 'vitest';
import { stepOfText } from './path';

const project = {
  steps: [
    { id: 'a', name: 'A', kind: 'agent' },
    { id: 'b', name: 'B', kind: 'agent' },
    { id: 'c', name: 'C', kind: 'human' },
    { id: 'd', name: 'D', kind: 'agent' },
  ],
} as never;

describe('stepOfText', () => {
  it('counts only the steps on the item path', () => {
    expect(stepOfText(project, { stepId: 'c', pathSkips: { b: 'no' } } as never)).toBe('2 of 3');
    expect(stepOfText(project, { stepId: 'c', pathSkips: {} } as never)).toBe('3 of 4');
  });
  it('is empty when the step is not on the path', () => {
    expect(stepOfText(project, { stepId: 'zz' } as never)).toBe('');
  });
});
