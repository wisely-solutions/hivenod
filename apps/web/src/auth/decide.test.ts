import type { User, Workspace } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { Live } from '../lib/live';
import type { Me } from './context';
import {
  confirmedNewUser,
  confirmedRemoved,
  decideSession,
  deletingName,
  serverSaysOut,
  waitingOnServer,
} from './decide';

const me: Me = { uid: 'u1', name: 'Ana', email: 'ana@x.io', photoURL: null, verified: true };
const profile: User = {
  name: 'Ana',
  email: 'ana@x.io',
  photoURL: null,
  color: '1',
  workspaceId: 'w1',
  workspaceIds: ['w1', 'w2'],
  theme: 'dark',
};
const ws = { name: 'Org', memberRoles: { u1: 'admin' } } as unknown as Workspace;
const wsWithout = { name: 'Org', memberRoles: {} } as unknown as Workspace;

const cachedMissing: Live<User | null> = { state: 'ready', data: null, fromCache: true };
const serverMissing: Live<User | null> = { state: 'ready', data: null, fromCache: false };

function decide(over: Partial<Parameters<typeof decideSession>[0]> = {}) {
  return decideSession({
    bootError: null,
    me,
    profileLive: { state: 'ready', data: profile, fromCache: false },
    wsLive: { state: 'ready', data: ws, fromCache: false },
    onJoinPage: false,
    unreachable: false,
    ...over,
  });
}

describe('new user only on the server’s word (card M0Caulbg)', () => {
  it('an empty cold cache is not a new user', () => {
    expect(confirmedNewUser(cachedMissing)).toBe(false);
    expect(confirmedNewUser({ state: 'loading' })).toBe(false);
    expect(confirmedNewUser(serverMissing)).toBe(true);
  });

  it('waits (loading) on a cached "missing" profile, even on an invite link', () => {
    expect(decide({ profileLive: cachedMissing }).status).toBe('loading');
    expect(decide({ profileLive: cachedMissing, onJoinPage: true }).status).toBe('loading');
  });

  it('shows the unreachable state once the server stays silent', () => {
    expect(decide({ profileLive: cachedMissing, unreachable: true })).toEqual({
      status: 'loading',
      unreachable: true,
    });
    expect(decide({ profileLive: { state: 'loading' }, unreachable: true })).toEqual({
      status: 'loading',
      unreachable: true,
    });
  });

  it('a server-confirmed missing profile on an invite link is a new user', () => {
    expect(decide({ profileLive: serverMissing, onJoinPage: true }).status).toBe('newUser');
  });
});

describe('removed only on the server’s word', () => {
  it('an organization missing from the cache waits for the server', () => {
    expect(confirmedRemoved('w1', { state: 'ready', data: null, fromCache: true }, 'u1')).toBe(
      false,
    );
    expect(decide({ wsLive: { state: 'ready', data: null, fromCache: true } }).status).toBe(
      'loading',
    );
  });

  it('a copy of the organization without me is evidence (e.g. right after leaving)', () => {
    expect(decide({ wsLive: { state: 'ready', data: wsWithout, fromCache: true } }).status).toBe(
      'removed',
    );
  });

  it('the server saying so (or denying) means removed', () => {
    expect(decide({ wsLive: { state: 'ready', data: wsWithout, fromCache: false } }).status).toBe(
      'removed',
    );
    expect(decide({ wsLive: { state: 'error', code: 'permission-denied' } }).status).toBe(
      'removed',
    );
  });
});

describe('cached data still shows (warm cache, server unreachable)', () => {
  it('a cached profile and organization are ready', () => {
    const s = decide({
      profileLive: { state: 'ready', data: profile, fromCache: true },
      wsLive: { state: 'ready', data: ws, fromCache: true },
    });
    expect(s.status).toBe('ready');
    expect(waitingOnServer(s, me)).toBe(false);
  });

  it('waiting on auth is not waiting on the server', () => {
    expect(waitingOnServer(decide({ me: undefined }), undefined)).toBe(false);
    expect(waitingOnServer(decide({ profileLive: cachedMissing }), me)).toBe(true);
  });
});

describe('unconfirmed email accounts (card rxGgHFZs)', () => {
  it('see only the check-your-email state, whatever else is loaded', () => {
    const unverified = { ...me, verified: false };
    expect(decide({ me: unverified })).toEqual({ status: 'unverified', me: unverified });
    expect(decide({ me: unverified, profileLive: { state: 'loading' } }).status).toBe('unverified');
    expect(decide({ me: unverified, onJoinPage: true }).status).toBe('unverified');
  });
  it('a confirmed one gets the app', () => {
    expect(decide().status).toBe('ready');
  });
});

describe('serverSaysOut: the double-check before the active organization is rewritten', () => {
  it('still listed means stay', () => {
    expect(serverSaysOut({ exists: true, roles: { u1: 'member' } }, 'u1')).toBe(false);
  });
  it('gone, unlisted or refused means out', () => {
    expect(serverSaysOut({ exists: false }, 'u1')).toBe(true);
    expect(serverSaysOut({ exists: true, roles: { u2: 'admin' } }, 'u1')).toBe(true);
    expect(serverSaysOut('permission-denied', 'u1')).toBe(true);
  });
  it('an organization being deleted means out, even though they are still listed', () => {
    expect(serverSaysOut({ exists: true, roles: { u1: 'admin' }, deleting: true }, 'u1')).toBe(
      true,
    );
    expect(serverSaysOut({ exists: true, roles: { u1: 'admin' }, deleting: false }, 'u1')).toBe(
      false,
    );
  });
});

describe('an organization being deleted (card 9jpb1Q4a)', () => {
  const flagged = {
    name: 'Org',
    memberRoles: { u1: 'admin' },
    deletingAt: { seconds: 1, nanoseconds: 0, toMillis: () => 1000 },
  } as unknown as Workspace;
  const live: Live<Workspace | null> = { state: 'ready', data: flagged, fromCache: false };

  it('names it, and only when flagged', () => {
    expect(deletingName(live)).toBe('Org');
    expect(deletingName({ state: 'ready', data: ws, fromCache: false })).toBeNull();
    expect(deletingName({ state: 'loading' })).toBeNull();
  });
  it('is never shown as the ready organization: the app waits while the hand-off happens', () => {
    expect(decide({ wsLive: live }).status).toBe('loading');
  });
});
