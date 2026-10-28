import type { ActionContext, ActionPlan, Role, User, Workspace } from '@hive/shared';
import { createContext, useContext } from 'react';

export const PROFILE_COLORS = 8;

export interface Me {
  uid: string;
  name: string;
  email: string;
  photoURL: string | null;
  /** False for an email/password account that has not confirmed its address yet. */
  verified: boolean;
}

export type Session =
  /**
   * `unreachable`: the server has not answered for a while (and nothing usable is cached), so the
   * wait is shown as "Can't reach the server" with Retry, never as a new or removed person.
   */
  | { status: 'loading'; unreachable?: boolean }
  | { status: 'signedOut' }
  /** Email/password account, address not confirmed: one "Check your email" screen, nothing else. */
  | { status: 'unverified'; me: Me }
  /** Signed in with Google, but no profile yet (first visit through an invite link). */
  | { status: 'newUser'; me: Me }
  /** The profile points at an organization this person is no longer in, and has no other. */
  | { status: 'removed'; me: Me; profile: User }
  | {
      status: 'ready';
      me: Me;
      profile: User;
      /** The organization on screen (its data lives at `workspaces/{workspaceId}`). */
      workspaceId: string;
      workspace: Workspace;
      role: Role;
      isAdmin: boolean;
    }
  | { status: 'error'; message: string };

export interface SessionApi {
  session: Session;
  /** Context for building actions as the signed-in person. */
  actionContext: (workspaceId: string) => ActionContext | null;
  /** Commit a plan. Local state updates at once; the promise settles when the server accepts it. */
  run: (plan: Pick<ActionPlan, 'ops'>) => Promise<void>;
  updateProfile: (patch: Partial<Pick<User, 'name' | 'color' | 'theme'>>) => Promise<void>;
  signOut: () => Promise<void>;
  /** Sends the confirmation email again. */
  resendVerification: () => Promise<void>;
  /** Asks Firebase whether the address is confirmed by now; the session moves on if it is. */
  recheckVerified: () => Promise<void>;
  /** Starts a fresh organization for someone who was removed from theirs. */
  startOwnWorkspace: () => Promise<void>;
  /** Makes another organization the one on screen. */
  switchOrg: (workspaceId: string) => Promise<void>;
  /** Creates an organization (the person becomes its admin) and switches to it. */
  createOrg: (name: string) => Promise<string>;
  /** Nudges the connection while the session waits on an unreachable server. */
  retry: () => void;
  /** A Retry is under way (the button stays, disabled). */
  retrying: boolean;
}

export const SessionContext = createContext<SessionApi | null>(null);

export function useSession(): SessionApi {
  const v = useContext(SessionContext);
  if (!v) throw new Error('useSession needs <SessionProvider>');
  return v;
}

/** The signed-in organization session. Only call below the sign-in gate. */
export function useReady() {
  const api = useSession();
  if (api.session.status !== 'ready') throw new Error('Not signed in to an organization');
  return { ...api, session: api.session };
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'Your';
}

export function defaultWorkspaceName(name: string): string {
  const n = firstName(name);
  return n === 'Your' ? 'My organization' : `${n}’s organization`;
}

/** What other members of an organization see of a person. */
export function memberCard(me: Me, profile: Pick<User, 'name' | 'color'>) {
  return { name: profile.name, email: me.email, photoURL: me.photoURL, color: profile.color };
}

/** A profile colour that is stable per person but varied across a team. */
export function profileColor(uid: string): string {
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `c${(h % PROFILE_COLORS) + 1}`;
}

export function newUserDoc(me: Me, workspaceId: string): User {
  return {
    name: me.name,
    email: me.email,
    photoURL: me.photoURL,
    color: profileColor(me.uid),
    workspaceId,
    workspaceIds: [workspaceId],
    theme: null,
  };
}
