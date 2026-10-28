import { describe, expect, it } from 'vitest';
import { HiveError, RATE_LIMIT_MESSAGE, isRateLimited } from './errors';
import { originalBytes } from './client';

describe('isRateLimited', () => {
  it('recognises Firebase rate and quota answers, not a revoked token', () => {
    expect(isRateLimited(Object.assign(new Error('x'), { code: 'auth/too-many-requests' }))).toBe(
      true,
    );
    expect(isRateLimited(Object.assign(new Error('x'), { code: 'auth/quota-exceeded' }))).toBe(
      true,
    );
    expect(isRateLimited(Object.assign(new Error('x'), { code: 'resource-exhausted' }))).toBe(true);
    expect(isRateLimited(new Error('Firebase: Error (QUOTA_EXCEEDED).'))).toBe(true);
    expect(
      isRateLimited(Object.assign(new Error('x'), { code: 'auth/invalid-custom-token' })),
    ).toBe(false);
    expect(isRateLimited(new HiveError('nope'))).toBe(false);
    // sign-in: HiveClient.connect turns the identitytoolkit 400 into this HiveError
    expect(isRateLimited(new HiveError(RATE_LIMIT_MESSAGE))).toBe(true);
  });
});

describe('originalBytes', () => {
  it('turns the stored data URL size back into the file size', () => {
    const buf = Buffer.alloc(588, 1);
    const content = `data:application/pdf;base64,${buf.toString('base64')}`;
    expect(originalBytes({ kind: 'pdf', content, bytes: content.length })).toBe(588);
    expect(originalBytes({ kind: 'markdown', content: 'abc', bytes: 3 })).toBe(3);
  });
});
