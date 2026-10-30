import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the migration script has no types
import { threadIdFor } from '../../../../scripts/migrate-project-lib.mjs';
import { migratedThreadId, orgsToTry } from './legacyLink';

describe('old project links', () => {
  it('derive the same thread id as the migration', async () => {
    expect(await migratedThreadId('w1', 'p1', 'i1')).toBe(threadIdFor('w1', 'p1', 'i1'));
    const hex = createHash('sha256').update('wA\u0000pB\u0000iC').digest('hex');
    expect(await migratedThreadId('wA', 'pB', 'iC')).toBe(`mg${hex.slice(0, 24)}`);
  });
  it('look in the organization on screen first', () => {
    expect(orgsToTry('b', ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });
});
