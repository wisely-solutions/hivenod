import { describe, expect, it } from 'vitest';
import { chunks, staleWorkspaceIds } from './cleanup';

describe('staleWorkspaceIds', () => {
  it('keeps organizations I am in and deletes those I am not', () => {
    expect(
      staleWorkspaceIds(['a', 'b', 'c', 'b'], { a: 'member', b: 'not-member', c: 'not-member' }),
    ).toEqual(['b', 'c']);
  });
  it('deletes nothing while standing is unknown or missing', () => {
    expect(staleWorkspaceIds(['a', 'b'], { a: 'unknown' })).toEqual([]);
  });
});

describe('chunks', () => {
  it('splits over 400', () => {
    const parts = chunks(Array.from({ length: 900 }, (_, i) => i));
    expect(parts.map((p) => p.length)).toEqual([400, 400, 100]);
  });
  it('is empty for nothing', () => expect(chunks([])).toEqual([]));
});
