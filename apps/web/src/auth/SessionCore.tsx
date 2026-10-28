import {
  getRedirectResult,
  onAuthStateChanged,
  signOut as fbSignOut,
  type User as AuthUser,
} from 'firebase/auth';
import { clearIndexedDbPersistence, doc, getDocFromServer, terminate } from 'firebase/firestore';
import { applyPlan } from '@hive/shared/firestore';
import {
  arrayUnion,
  createWorkspace,
  memberProfileOp,
  paths,
  randomId,
  userSchema,
  workspaceSchema,
  type ActionContext,
  type ActionPlan,
} from '@hive/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { auth, FIRESTORE_EMULATOR_PORT, popupRedirectResolver, USE_EMULATOR } from '../lib/app';
import { configureBeacon } from '../lib/leaveBeacon';
import { eventPath } from '../lib/pendingDecisions';
import { isRefused } from '../lib/replay';
import { db } from '../lib/db';
import { useLiveDoc } from '../lib/live';
import { clearSyncedFeeds } from '../lib/syncedFeeds';
import { useToast } from '../ui/overlay';
import { useRetry, useUnreachable } from '../shell/unreachable';
import { applyPreference } from '../theme';
import {
  confirmedNewUser,
  confirmedRemoved,
  decideSession,
  deletingName,
  serverSaysOut,
  waitingOnServer,
} from './decide';
import { isRedirectPending, setAuthHint, setRedirectPending } from './hint';
import {
  defaultWorkspaceName,
  memberCard,
  newUserDoc,
  SessionContext,
  type Me,
  type Session,
  type SessionApi,
} from './context';

function toMe(u: AuthUser): Me {
  const email = (u.email ?? '').toLowerCase();
  return {
    uid: u.uid,
    email,
    name: (u.displayName ?? '').trim() || email.split('@')[0] || 'Someone',
    photoURL: u.photoURL ?? null,
    // Google (and other providers) vouch for the address; a password account must confirm it.
    verified: u.emailVerified || !u.providerData.some((p) => p.providerId === 'password'),
  };
}

function onJoinPage(): boolean {
  return window.location.pathname.startsWith('/join/');
}

export default function SessionCore({ children }: { children: ReactNode }) {
  // undefined = auth not resolved yet
  const [authUser, setAuthUser] = useState<AuthUser | null | undefined>(undefined);
  const [bootError, setBootError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    // Completes a redirect sign-in; the user also arrives through onAuthStateChanged. It loads
    // Google's sign-in iframe, so a normal visit of someone already signed in must not wait for
    // it (card CGPynEQY): it runs at once only when coming back from a redirect, or when the
    // first auth state says "nobody" (a redirect may still be on its way in, e.g. a lost flag).
    const finish = () =>
      getRedirectResult(auth, popupRedirectResolver).catch(() => {
        setRedirectPending(false);
        setBootError('Sign-in did not finish. Try again.');
        return null;
      });
    let checked = false;
    if (isRedirectPending()) {
      checked = true;
      void finish();
    }
    return onAuthStateChanged(auth, (u) => {
      if (u === null && !checked) {
        checked = true;
        void finish().then(() => {
          if (!auth.currentUser) {
            setAuthHint(false);
            setAuthUser(null);
          }
        });
        return;
      }
      setAuthHint(u !== null);
      setAuthUser(u);
    });
  }, []);

  const uid = authUser && toMe(authUser).verified ? authUser.uid : null;
  // `synced`: a profile missing from the cache is only missing once the server says so.
  const profileLive = useLiveDoc(uid ? paths.user(uid) : null, userSchema, { synced: true });
  const profile = profileLive.state === 'ready' ? profileLive.data : undefined;
  const wid = profile?.workspaceId ?? null;
  const wsLive = useLiveDoc(wid ? paths.workspace(wid) : null, workspaceSchema, { synced: true });

  // `checked` bumps after a reload of the same Firebase user object (email just confirmed).
  const [checked, setChecked] = useState(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const me = useMemo(() => (authUser ? toMe(authUser) : null), [authUser, checked]);

  // First sign-in: one batch creates the workspace, its event and the profile. Only when the
  // server itself says the profile does not exist: a cold cache (new browser, cleared storage)
  // with the server unreachable also reads as "no profile", and acting on that would queue a
  // batch that replaces a real person's profile once the server is back (card M0Caulbg).
  const bootstrapping = useRef<string | null>(null);
  const newUser = confirmedNewUser(profileLive);
  const [bootTry, setBootTry] = useState(0);
  useEffect(() => {
    if (!me || !me.verified || !newUser || onJoinPage()) return;
    if (bootstrapping.current === me.uid) return;
    bootstrapping.current = me.uid;
    (async () => {
      // Ask the server once more right before writing; never write from the cache's say-so.
      let exists: boolean;
      try {
        exists = (await getDocFromServer(doc(db, paths.user(me.uid)))).exists();
      } catch {
        // Unreachable: write nothing, ask again in a moment.
        bootstrapping.current = null;
        setTimeout(() => setBootTry((n) => n + 1), 3000);
        return;
      }
      if (exists) return; // the profile listener catches up by itself
      const workspaceId = randomId();
      const ctx: ActionContext = {
        workspaceId,
        actor: { type: 'human', id: me.uid, name: me.name },
      };
      const user = newUserDoc(me, workspaceId);
      const { ops } = createWorkspace(ctx, {
        name: defaultWorkspaceName(me.name),
        profile: memberCard(me, user),
      });
      await applyPlan(db, {
        ops: [...ops, { kind: 'set', path: paths.user(me.uid), data: user }],
      });
    })().catch(() => {
      bootstrapping.current = null;
      setBootError('Could not set up your organization. Check your connection and reload.');
    });
  }, [me, newUser, bootTry]);

  // The person's theme choice follows them across devices.
  useEffect(() => {
    if (profile) applyPreference(profile.theme ?? 'system');
  }, [profile]);

  const me_ = authUser === undefined ? undefined : me;
  const joinPage = onJoinPage();
  const waiting = useMemo(
    () =>
      waitingOnServer(
        decideSession({
          bootError,
          me: me_,
          profileLive,
          wsLive,
          onJoinPage: joinPage,
          unreachable: false,
        }),
        me_,
      ),
    [bootError, me_, profileLive, wsLive, joinPage],
  );
  const unreachable = useUnreachable(waiting);
  const { retry, retrying, settle } = useRetry();
  useEffect(() => {
    if (!waiting) settle();
  }, [waiting, settle]);

  const session: Session = useMemo(
    () =>
      decideSession({ bootError, me: me_, profileLive, wsLive, onJoinPage: joinPage, unreachable }),
    [bootError, me_, profileLive, wsLive, joinPage, unreachable],
  );

  const actionContext = useCallback(
    (workspaceId: string): ActionContext | null =>
      me ? { workspaceId, actor: { type: 'human', id: me.uid, name: me.name } } : null,
    [me],
  );

  // The keepalive commit sent when the page is left (lib/leaveBeacon.ts) signs in as this person.
  useEffect(() => {
    if (!me) return;
    const dbName = `projects/${db.app.options.projectId}/databases/(default)`;
    const root = USE_EMULATOR
      ? `http://${window.location.hostname}:${FIRESTORE_EMULATOR_PORT}`
      : 'https://firestore.googleapis.com';
    configureBeacon({
      commitUrl: `${root}/v1/${dbName}/documents:commit`,
      db: dbName,
      getToken: async () => {
        const u = auth.currentUser;
        if (!u) throw new Error('signed out');
        return u.getIdToken();
      },
    });
  }, [me]);

  // A plan whose event already exists has landed (the leave beacon wrote it first): saved, not failed.
  const run = useCallback(async (plan: Pick<ActionPlan, 'ops'>) => {
    try {
      await applyPlan(db, plan);
    } catch (e) {
      const path = eventPath(plan.ops);
      if (path && isRefused(e)) {
        const landed = await getDocFromServer(doc(db, path)).then(
          (d) => d.exists(),
          () => false,
        );
        if (landed) return;
      }
      throw e;
    }
  }, []);

  const updateProfile = useCallback<SessionApi['updateProfile']>(
    async (patch) => {
      if (!me || !profile) return;
      if (patch.theme !== undefined) applyPreference(patch.theme ?? 'system');
      const card = patch.name !== undefined || patch.color !== undefined;
      await applyPlan(db, {
        ops: [
          { kind: 'update', path: paths.user(me.uid), data: patch },
          ...(card && profile.workspaceId
            ? [
                memberProfileOp(
                  profile.workspaceId,
                  me.uid,
                  memberCard(me, { ...profile, ...patch }),
                ),
              ]
            : []),
        ],
      });
    },
    [me, profile],
  );

  const signOut = useCallback(async () => {
    try {
      setAuthHint(false);
      clearSyncedFeeds();
      await fbSignOut(auth);
      await terminate(db);
      await clearIndexedDbPersistence(db);
    } catch {
      /* the cache is cleared on a best-effort basis */
    }
    window.location.replace('/');
  }, []);

  const resendVerification = useCallback(async () => {
    const { resendVerification: send } = await import('./signin');
    await send();
  }, []);

  const recheckVerified = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return;
    await u.reload();
    if (u.emailVerified) await u.getIdToken(true); // the rules read the token's claim
    setChecked((n) => n + 1);
  }, []);

  const createOrg = useCallback(
    async (name: string) => {
      if (!me || !profile) throw new Error('Not signed in');
      const workspaceId = randomId();
      const ctx: ActionContext = {
        workspaceId,
        actor: { type: 'human', id: me.uid, name: me.name },
      };
      const { ops } = createWorkspace(ctx, { name, profile: memberCard(me, profile) });
      await applyPlan(db, {
        ops: [
          ...ops,
          {
            kind: 'update',
            path: paths.user(me.uid),
            // Appended on the server, so a stale local list can never drop an organization.
            data: { workspaceId, workspaceIds: arrayUnion(workspaceId) },
          },
        ],
      });
      return workspaceId;
    },
    [me, profile],
  );

  const createOrgRef = useRef(createOrg);
  useEffect(() => {
    createOrgRef.current = createOrg;
  });

  const startOwnWorkspace = useCallback(async () => {
    if (!me) return;
    await createOrg(defaultWorkspaceName(me.name));
  }, [me, createOrg]);

  const switchOrg = useCallback(
    async (workspaceId: string) => {
      if (!me || !profile || workspaceId === profile.workspaceId) return;
      // Refresh the card others see of you there, in case your name or colour changed meanwhile.
      await applyPlan(db, {
        ops: [
          { kind: 'update', path: paths.user(me.uid), data: { workspaceId } },
          memberProfileOp(workspaceId, me.uid, memberCard(me, profile)),
        ],
      });
    },
    [me, profile],
  );

  // Removed from the organization on screen, or it is being deleted (card 9jpb1Q4a): go to another
  // one they are in, or (deleted, nowhere else to go) to a fresh one, instead of stranding them on
  // a dead end. Candidates that no longer let them in simply fail to load.
  const removed = me !== null && profile != null && confirmedRemoved(wid, wsLive, me.uid);
  const flaggedName = me !== null && profile != null ? deletingName(wsLive) : null;
  // Once seen being deleted, an organization stays "deleted" for this screen even when its document
  // vanishes a moment later (the read then fails): the hand-off must not be cancelled by that.
  const [seenDeleting, setSeenDeleting] = useState<{ wid: string; name: string } | null>(null);
  if (flaggedName && wid && (seenDeleting?.wid !== wid || seenDeleting.name !== flaggedName))
    setSeenDeleting({ wid, name: flaggedName });
  const deleting =
    flaggedName ?? (seenDeleting && seenDeleting.wid === wid ? seenDeleting.name : null);
  const others = profile ? profile.workspaceIds.filter((w) => w !== wid) : [];
  const othersKey = others.join('|');
  const freshFor = useRef<string | null>(null);
  useEffect(() => {
    if (!me || (!removed && deleting === null)) return;
    if (!othersKey && deleting === null) return;
    let live = true;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const refused = (e: unknown) => (e as { code?: string }).code === 'permission-denied';
    const duration = 12_000; // long enough to be read, wherever the person was looking
    /** One go at the hand-off: 'done', or 'retry' after a failure that may pass (offline, slow). */
    const attempt = async (): Promise<'done' | 'retry'> => {
      // The only automatic change of the active organization. A cached copy or a momentary
      // refusal is not enough: the server must say the current one is really gone (card
      // gypyWz1I). A live "being deleted" flag needs no second opinion: it is never taken off.
      if (flaggedName === null) {
        try {
          const cur = await getDocFromServer(doc(db, paths.workspace(wid ?? '')));
          const data = cur.data();
          const roles = data?.memberRoles as Record<string, string> | undefined;
          const flagged = data?.deletingAt != null;
          if (!serverSaysOut({ exists: cur.exists(), roles, deleting: flagged }, me.uid))
            return 'done';
        } catch (e) {
          if (!refused(e)) return 'retry';
        }
      }
      for (const candidate of othersKey ? othersKey.split('|') : []) {
        let snap;
        try {
          snap = await getDocFromServer(doc(db, paths.workspace(candidate)));
        } catch (e) {
          if (refused(e)) continue; // not a member any more: try the next one
          return 'retry'; // could not ask: do not guess
        }
        const roles = snap.data()?.memberRoles as Record<string, string> | undefined;
        if (!(snap.exists() && roles && me.uid in roles && snap.data()?.deletingAt == null))
          continue;
        if (!live) return 'done';
        const name = snap.data()?.name as string | undefined;
        try {
          const written = applyPlan(db, {
            ops: [{ kind: 'update', path: paths.user(me.uid), data: { workspaceId: candidate } }],
          });
          // The local write is applied at once: say so now, not when the server has answered.
          toast.push({
            duration,
            message: deleting
              ? `${deleting} was deleted. Switched to ${name ?? 'another organization'}.`
              : `You are no longer in your previous organization. Switched to ${name ?? 'another one'}.`,
          });
          await written;
        } catch {
          return 'retry';
        }
        return 'done';
      }
      // Nowhere else to go after a delete: a fresh, empty organization, as on first sign-in.
      if (deleting !== null && live && wid && freshFor.current !== wid) {
        freshFor.current = wid;
        try {
          await createOrgRef.current(defaultWorkspaceName(me.name));
          toast.push({
            duration,
            message: `${deleting} was deleted. Here is a fresh organization.`,
          });
        } catch {
          freshFor.current = null;
          return 'retry';
        }
      }
      return 'done';
    };
    (async () => {
      for (let i = 1; live; i++) {
        if ((await attempt()) === 'done') return;
        await pause(Math.min(1000 * i, 5000));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removed, deleting, flaggedName, me, othersKey]);

  const api = useMemo<SessionApi>(
    () => ({
      session,
      actionContext,
      run,
      updateProfile,
      signOut,
      resendVerification,
      recheckVerified,
      startOwnWorkspace,
      switchOrg,
      createOrg,
      retry,
      retrying,
    }),
    [
      session,
      actionContext,
      run,
      updateProfile,
      signOut,
      resendVerification,
      recheckVerified,
      startOwnWorkspace,
      switchOrg,
      createOrg,
      retry,
      retrying,
    ],
  );
  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}
