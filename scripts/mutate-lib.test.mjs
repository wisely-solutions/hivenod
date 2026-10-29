import { describe, expect, it } from 'vitest';
import { assertWellFormed } from '../packages/shared/rules/mutate-lib.mjs';

describe('rules mutation list validation', () => {
  it('accepts well-formed entries', () => {
    expect(() =>
      assertWellFormed([
        ['a', [['x', 'y']]],
        ['b', [['x', '']]],
      ]),
    ).not.toThrow();
  });
  it('rejects an entry that swallowed the next one (missing bracket)', () => {
    expect(() => assertWellFormed([['a', [['x', 'y']], 'b', [['x', 'z']]]])).toThrow(
      /entry #1 "a".*2 items.*got 4/s,
    );
  });
  it('rejects bad names and edits', () => {
    expect(() => assertWellFormed([['', [['x', 'y']]]])).toThrow(/name/);
    expect(() => assertWellFormed([['a', []]])).toThrow(/non-empty/);
    expect(() => assertWellFormed([['a', [['x']]]])).toThrow(/\[find, replace\]/);
  });
});
