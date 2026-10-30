import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { checkConnect, CONNECT_ERRORS, newlyConnected } from './confirm';

const base = {
  publicKey: 'B' + 'x'.repeat(86),
  cli: 'claude',
  host: 'laptop',
  folder: 'blog',
  status: 'pending',
  kind: 'connect',
};
const at = (minutesAgo: number) => Timestamp.fromMillis(Date.now() - minutesAgo * 60_000);

describe('checkConnect', () => {
  it('accepts a fresh connect request', () => {
    const r = checkConnect('K7QX29PD', { ...base, createdAt: at(1) });
    expect(r.ok).toBe(true);
  });
  it('refuses an expired one after 10 minutes', () => {
    expect(checkConnect('K7QX29PD', { ...base, createdAt: at(11) })).toEqual({
      ok: false,
      error: CONNECT_ERRORS.expired,
    });
  });
  it('refuses a used one', () => {
    expect(checkConnect('K7QX29PD', { ...base, status: 'paired', createdAt: at(1) })).toMatchObject(
      { ok: false, error: CONNECT_ERRORS.used },
    );
  });
  it('refuses a missing one', () => {
    expect(checkConnect('K7QX29PD', null)).toMatchObject({ error: CONNECT_ERRORS.missing });
  });
  it('sends a hivenod pair code to the admins page', () => {
    expect(checkConnect('K7QX29PD', { ...base, kind: undefined, createdAt: at(1) })).toMatchObject({
      ok: false,
      pair: 'K7QX29PD',
    });
  });
});

describe('newlyConnected', () => {
  const a = (id: string, createdBy: string, minutesAgo: number, revokedAt: unknown = null) => ({
    id,
    data: { createdBy, createdAt: at(minutesAgo), revokedAt },
  });
  it('finds the newest agent this person made since the page opened', () => {
    const since = Date.now() - 5 * 60_000;
    expect(newlyConnected([a('old', 'me', 30), a('new', 'me', 1)], 'me', since)?.id).toBe('new');
    expect(newlyConnected([a('x', 'other', 1)], 'me', since)).toBeNull();
    expect(newlyConnected([a('r', 'me', 1, at(0))], 'me', since)).toBeNull();
    expect(newlyConnected([a('old', 'me', 30)], 'me', since)).toBeNull();
  });
});
