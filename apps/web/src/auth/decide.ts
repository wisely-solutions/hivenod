import type { User, Workspace } from '@hive/shared';
import type { Live } from '../lib/live';
import type { Me, Session } from './context';

/**
 * Pure session decisions, kept apart from SessionCore so they can be tested without Firebase.
 *
 * The rule that matters most (card M0Caulbg): an empty local cache is not an answer. With a cold
 * cache and the server unreachable, the SDK serves "document does not exist" from the cache. If
 * that passed for a new user, the app would set up a fresh organization and rewrite the profile,
 * and the queued batch would be sent once the server came back. So "new user", "removed" and
 * every write that follows from them wait for the server to confirm.
 */

/** The profile document is confirmed missing by the server: only then is this a new user. */
export function confirmedNewUser(profileLive: Live<User | null>): boolean {
  return (
    profileLive.state === 'ready' && profileLive.data === null && profileLive.fromCache === false
  );
}

/**
 * True when the organization on screen no longer lists this person. A copy of it without them
 * (cached or not) is evidence; an organization merely missing from the cache is not: that is a
 * cold cache, and only the server can say it is gone.
 */
export function confirmedRemoved(
  wid: string | null,
  wsLive: Live<Workspace | null>,
  uid: string,
): boolean {
  if (!wid) return false;
  if (wsLive.state === 'error') return wsLive.code === 'permission-denied';
  if (wsLive.state !== 'ready') return false;
  return wsLive.data ? !wsLive.data.memberRoles[uid] : wsLive.fromCache === false;
}

export interface SessionInputs {
  bootError: string | null;
  /** undefined while auth has not resolved, null when signed out. */
  me: Me | null | undefined;
  profileLive: Live<User | null>;
  wsLive: Live<Workspace | null>;
  onJoinPage: boolean;
  /** The server has not answered for a while although the browser is online. */
  unreachable: boolean;
}

/**
 * The organization on screen is being deleted (card 9jpb1Q4a): an admin has flagged it and is erasing
 * it. Returns its name. Nobody stays in it: SessionCore moves them to another organization or a
 * fresh one, and until then the app waits.
 */
export function deletingName(wsLive: Live<Workspace | null>): string | null {
  return wsLive.state === 'ready' && wsLive.data?.deletingAt ? wsLive.data.name : null;
}

export function decideSession(i: SessionInputs): Session {
  const { bootError, me, profileLive, wsLive } = i;
  const waiting: Session = i.unreachable
    ? { status: 'loading', unreachable: true }
    : { status: 'loading' };
  if (bootError) return { status: 'error', message: bootError };
  if (me === undefined) return { status: 'loading' };
  if (!me) return { status: 'signedOut' };
  if (!me.verified) return { status: 'unverified', me };
  if (profileLive.state === 'error')
    return { status: 'error', message: 'Could not load your profile. Reload to try again.' };
  if (profileLive.state === 'loading') return waiting;
  const profile = profileLive.data;
  if (profile === null) {
    // Missing in the cache only: wait for the server, never treat it as a new person.
    if (!confirmedNewUser(profileLive)) return waiting;
    return i.onJoinPage ? { status: 'newUser', me } : { status: 'loading' };
  }
  const wid = profile.workspaceId;
  if (!wid) return { status: 'removed', me, profile };
  if (wsLive.state === 'loading') return waiting;
  if (wsLive.state === 'error')
    return wsLive.code === 'permission-denied'
      ? { status: 'removed', me, profile }
      : { status: 'error', message: 'Could not load your organization. Reload to try again.' };
  const workspace = wsLive.data;
  if (deletingName(wsLive) !== null) return waiting;
  const role = workspace?.memberRoles[me.uid];
  if (!workspace || !role) {
    // No organization in the cache is not proof you were removed: wait for the server.
    return confirmedRemoved(wid, wsLive, me.uid) ? { status: 'removed', me, profile } : waiting;
  }
  return {
    status: 'ready',
    me,
    profile,
    workspaceId: wid,
    workspace,
    role,
    isAdmin: role === 'admin',
  };
}

/** Waiting on the server (not on auth): the case that turns into "Can't reach the server". */
export function waitingOnServer(s: Session, me: Me | null | undefined): boolean {
  return s.status === 'loading' && Boolean(me);
}

/**
 * The server's own answer on whether this person is out of an organization (card gypyWz1I): the
 * document is gone, or it no longer lists them, or it is being deleted, or the rules refuse the read. Used to double-check
 * a cached or momentary "removed" before the profile's active organization is rewritten, so a
 * stale copy or a hiccup can never move someone to another organization by itself.
 */
export function serverSaysOut(
  answer:
    { exists: boolean; roles?: Record<string, string>; deleting?: boolean } | 'permission-denied',
  uid: string,
): boolean {
  if (answer === 'permission-denied') return true;
  return !answer.exists || !answer.roles?.[uid] || answer.deleting === true;
}
