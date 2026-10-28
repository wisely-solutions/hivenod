import { afterEach, describe, expect, it } from 'vitest';
import { cooldownLeft, isTooManyRequests, resetCooldown, startCooldown } from './cooldown';

describe('resend cooldown', () => {
  afterEach(resetCooldown);

  it('is zero until a mail was sent', () => {
    expect(cooldownLeft('a@b.co', 1000)).toBe(0);
  });

  it('counts down from the send and ends', () => {
    startCooldown('a@b.co', 30, 0);
    expect(cooldownLeft('a@b.co', 0)).toBe(30);
    expect(cooldownLeft('a@b.co', 10_500)).toBe(20);
    expect(cooldownLeft('a@b.co', 30_000)).toBe(0);
    expect(cooldownLeft('a@b.co', 99_000)).toBe(0);
  });

  it('belongs to one address, case-insensitively', () => {
    startCooldown('A@b.co ', 30, 0);
    expect(cooldownLeft('a@b.co', 1000)).toBe(29);
    expect(cooldownLeft('other@b.co', 1000)).toBe(0);
  });

  it('recognises the rate-limit error only', () => {
    expect(isTooManyRequests({ code: 'auth/too-many-requests' })).toBe(true);
    expect(isTooManyRequests({ code: 'auth/network-request-failed' })).toBe(false);
    expect(isTooManyRequests(null)).toBe(false);
  });
});
