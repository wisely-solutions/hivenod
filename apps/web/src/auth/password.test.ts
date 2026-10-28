import { describe, expect, it } from 'vitest';
import { isCommonPassword, passwordProblem } from './password';

describe('passwordProblem', () => {
  it('needs 8 characters', () => {
    expect(passwordProblem('abc1!')).toMatch(/at least 8/);
    expect(passwordProblem('')).toMatch(/at least 8/);
  });
  it('refuses common passwords, any case', () => {
    for (const p of ['password', 'Password1', 'QWERTY123', 'iloveyou', 'welcome2024', '12345678'])
      expect(passwordProblem(p), p).toMatch(/too common/);
  });
  it('refuses single-character and sequence passwords', () => {
    for (const p of ['zzzzzzzz', 'abcdefgh', '87654321'])
      expect(passwordProblem(p), p).not.toBeNull();
  });
  it('accepts a good passphrase', () => {
    expect(passwordProblem('correct horse battery')).toBeNull();
    expect(passwordProblem('a brand new password')).toBeNull();
    expect(isCommonPassword('correct horse battery')).toBe(false);
  });
  it('is a real list', () => {
    let hits = 0;
    for (const p of ['password1', 'letmein123', 'dragon2020', 'sunshine1', 'monkey123'])
      if (isCommonPassword(p)) hits++;
    expect(hits).toBe(5);
  });
});
