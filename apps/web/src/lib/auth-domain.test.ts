import { describe, expect, it } from 'vitest';
import { authDomainFor } from './auth-domain';

describe('authDomainFor', () => {
  const cfg = 'hivenod.com';
  it('uses hivenod.com on the public address', () => {
    expect(authDomainFor('hivenod.com', cfg)).toBe('hivenod.com');
  });
  it('keeps the current host on Hosting hosts and previews', () => {
    expect(authDomainFor('hivenod--pr-1.web.app', cfg)).toBe('hivenod--pr-1.web.app');
    expect(authDomainFor('x.firebaseapp.com', cfg)).toBe('x.firebaseapp.com');
  });
  it('uses the configured domain elsewhere (emulator, self-host)', () => {
    expect(authDomainFor('localhost:4173', cfg)).toBe(cfg);
    expect(authDomainFor('evilhivenod.com', 'my.example')).toBe('my.example');
  });
});
