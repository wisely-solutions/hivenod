import { afterEach, describe, expect, it } from 'vitest';
import { getAuthHint, setAuthHint, setRedirectPending } from './hint';

describe('auth hint', () => {
  afterEach(() => {
    setRedirectPending(false);
    setAuthHint(false);
  });

  it('is cleared by a signed-out event', () => {
    setAuthHint(true);
    setAuthHint(false);
    expect(getAuthHint()).toBe(false);
  });

  it('survives a signed-out event while a sign-in redirect is pending', () => {
    setAuthHint(true);
    setRedirectPending(true);
    setAuthHint(false);
    expect(getAuthHint()).toBe(true);
    setRedirectPending(false);
    setAuthHint(false);
    expect(getAuthHint()).toBe(false);
  });

  it('stops protecting the hint once signed in', () => {
    setRedirectPending(true);
    setAuthHint(true);
    setAuthHint(false);
    expect(getAuthHint()).toBe(false);
  });
});
