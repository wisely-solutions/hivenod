import { beforeEach, describe, expect, it } from 'vitest';
import { countReads } from './reads';

const w = window as unknown as { __hiveReads?: number };

describe('countReads', () => {
  beforeEach(() => {
    w.__hiveReads = undefined;
  });
  it('counts the documents the server delivered', () => {
    countReads({ metadata: { fromCache: false }, docChanges: () => [1, 2, 3] });
    countReads({ metadata: { fromCache: false } });
    expect(w.__hiveReads).toBe(4);
  });
  it('ignores answers that came from the cache', () => {
    countReads({ metadata: { fromCache: true }, docChanges: () => [1, 2] });
    expect(w.__hiveReads).toBeUndefined();
  });
});
