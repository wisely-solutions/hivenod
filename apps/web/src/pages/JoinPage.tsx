import { acceptInvite, arrayUnion, inviteSchema, paths, type Invite } from '@hive/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { doc, getDoc } from 'firebase/firestore';
import { CircleCheck, Clock, LinkIcon, MailX, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { CheckEmail } from '../auth/CheckEmail';
import { SignInPanel } from '../auth/SignInPanel';
import { memberCard, newUserDoc, useSession } from '../auth/context';
import { FoldedBackdrop } from '../components/FoldedBackdrop';
import { Logo } from '../components/Logo';
import { db } from '../lib/db';
import { Button } from '../ui/button';
import { Skeleton } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { Reveal } from '../ui/motion';

type InviteState =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'used'; byMe: boolean }
  | { kind: 'expired' }
  | { kind: 'open'; invite: Invite };

function Frame({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-canvas pt-[env(safe-area-inset-top)]">
      <FoldedBackdrop />
      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-[max(32px,env(safe-area-inset-bottom))] pt-10 sm:px-0">
        <Reveal>
          <div className="mb-6 flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
              Hivenod
            </span>
          </div>
          <div className="rounded-panel border border-line bg-surface/95 p-5 shadow-e2 backdrop-blur-sm">
            {children}
          </div>
        </Reveal>
      </div>
    </main>
  );
}

function Message({
  icon,
  title,
  children,
  action,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="status">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-canvas text-text-2">
        <Icon icon={icon} size={20} />
      </span>
      <h1 className="text-20 font-semibold">{title}</h1>
      <p className="mt-1.5 text-14 text-text-2">{children}</p>
      {action ? <div className="mt-5 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

/** Where an invite link lands: sign in if needed, then join with one tap. */
export function JoinPage({ wid, code }: { wid: string; code: string }) {
  const { session, run, actionContext, signOut } = useSession();
  const navigate = useNavigate();
  const [state, setState] = useState<InviteState>({ kind: 'loading' });
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Already a member of this organization, though it is not the one on screen.
  const [inOrg, setInOrg] = useState(false);

  // The organization name travels in the link for display only; the invitee cannot read the workspace yet.
  const label =
    new URLSearchParams(window.location.search).get('w')?.slice(0, 120) || 'an organization';

  const uid =
    session.status === 'newUser' || session.status === 'ready' || session.status === 'removed'
      ? session.me.uid
      : null;
  useEffect(() => {
    if (!uid) return;
    let live = true;
    getDoc(doc(db, paths.invite(wid, code)))
      .then((snap) => {
        if (!live) return;
        const r = snap.exists() ? inviteSchema.safeParse(snap.data()) : null;
        if (!r || !r.success) return setState({ kind: 'unavailable' });
        const inv = r.data;
        if (inv.usedBy) return setState({ kind: 'used', byMe: inv.usedBy === uid });
        if (inv.expiresAt.toMillis() <= Date.now()) return setState({ kind: 'expired' });
        setState({ kind: 'open', invite: inv });
      })
      // Rules answer "denied" for a missing invite and for one meant for another account.
      .catch(() => live && setState({ kind: 'unavailable' }));
    return () => {
      live = false;
    };
  }, [uid, wid, code]);

  const listed = session.status === 'ready' && session.profile.workspaceIds.includes(wid);
  useEffect(() => {
    if (!uid || !listed) return;
    let live = true;
    getDoc(doc(db, paths.workspace(wid)))
      .then((snap) => live && setInOrg(snap.exists() && uid in (snap.data()?.memberRoles ?? {})))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [uid, wid, listed]);

  if (session.status === 'loading') {
    return (
      <Frame>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="mt-3 h-4 w-full" />
        <Skeleton className="mt-6 h-14 w-full" />
      </Frame>
    );
  }
  if (session.status === 'error') {
    return (
      <Frame>
        <Message icon={LinkIcon} title="Something went wrong">
          {session.message}
        </Message>
      </Frame>
    );
  }
  if (session.status === 'unverified') {
    return (
      <Frame>
        <CheckEmail me={session.me} />
      </Frame>
    );
  }
  if (session.status === 'signedOut') {
    return (
      <Frame>
        <h1 className="text-20 font-semibold">You are invited to join {label}</h1>
        <p className="mb-5 mt-1.5 text-14 text-text-2">
          Sign in with the account this invite was sent to.
        </p>
        <SignInPanel />
      </Frame>
    );
  }

  const alreadyHere = session.status === 'ready' && (session.workspaceId === wid || inOrg);
  const switching = session.status === 'ready' && !alreadyHere;

  async function join(invite: Invite) {
    if (
      session.status === 'signedOut' ||
      session.status === 'unverified' ||
      session.status === 'loading' ||
      session.status === 'error'
    )
      return;
    const ctx = actionContext(wid);
    if (!ctx) return;
    setJoining(true);
    setError(null);
    try {
      const user = session.status === 'newUser' ? newUserDoc(session.me, wid) : session.profile;
      const { ops } = acceptInvite(ctx, {
        code,
        role: invite.role,
        profile: memberCard(session.me, user),
      });
      // Joining adds this organization to the person's list; the others stay as they are.
      const userOp =
        session.status === 'newUser'
          ? { kind: 'set' as const, path: paths.user(session.me.uid), data: user }
          : {
              kind: 'update' as const,
              path: paths.user(session.me.uid),
              // Appended on the server, so a stale local list can never drop an organization.
              data: { workspaceId: wid, workspaceIds: arrayUnion(wid) },
            };
      await run({ ops: [...ops, userOp] });
      await navigate({ to: '/' });
    } catch {
      setError('Could not join. The invite may have just been used or revoked.');
      setJoining(false);
    }
  }

  const home = (
    <Link
      to="/"
      className="inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface"
    >
      Open Hivenod
    </Link>
  );
  const switchAccount = (
    <Button variant="secondary" onClick={signOut}>
      Use a different account
    </Button>
  );
  const email = session.me.email;

  return (
    <Frame>
      {alreadyHere ? (
        <Message icon={CircleCheck} title="You are already in this organization" action={home}>
          Nothing to do here.
        </Message>
      ) : state.kind === 'loading' ? (
        <>
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="mt-3 h-4 w-full" />
          <Skeleton className="mt-6 h-11 w-full" />
        </>
      ) : state.kind === 'used' ? (
        <Message
          icon={state.byMe ? CircleCheck : MailX}
          title={state.byMe ? 'You already joined' : 'This invite was already used'}
          action={state.byMe ? home : switchAccount}
        >
          {state.byMe ? 'This invite has done its job.' : 'Ask an admin for a new invite link.'}
        </Message>
      ) : state.kind === 'expired' ? (
        <Message icon={Clock} title="This invite has expired" action={switchAccount}>
          Invites last 7 days. Ask an admin to send a new one.
        </Message>
      ) : state.kind === 'unavailable' ? (
        <Message icon={MailX} title="This invite is not available for you" action={switchAccount}>
          You are signed in as {email}. The invite may be for a different email, or it was revoked.
        </Message>
      ) : (
        <>
          <h1 className="text-20 font-semibold">Join {label}</h1>
          <p className="mt-1.5 text-14 text-text-2">
            You will join as {state.invite.role === 'admin' ? 'an admin' : 'a member'}, signed in as{' '}
            {email}.
          </p>
          {switching ? (
            <p className="mt-3 rounded-btn bg-gate-bg p-3 text-13 text-gate-text">
              You will switch to this organization. The others stay as they are, and you can switch
              back any time.
            </p>
          ) : null}
          <p role="alert" className="mt-3 min-h-5 text-13 text-sendback">
            {error}
          </p>
          <Button className="mt-2 w-full" loading={joining} onClick={() => join(state.invite)}>
            Join organization
          </Button>
        </>
      )}
    </Frame>
  );
}
