import { useRouterState } from '@tanstack/react-router';
import { TriangleAlert, UserX } from 'lucide-react';
import type { ReactNode } from 'react';
import { CheckEmail } from '../auth/CheckEmail';
import { useSession } from '../auth/context';
import { Centered, LoadingMark } from '../components/Loading';
import { Logo } from '../components/Logo';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';
import { Shell } from '../shell/Shell';
import { UnreachableState } from '../shell/banners';
import { SignInPage } from './SignInPage';

/**
 * Decides what the whole app shows: sign-in, a calm wait, the removed/error screens, or the app.
 * `/join/...` handles its own sign-in, so it passes through.
 */
export function Gate({ children }: { children: ReactNode }) {
  const { session, signOut, startOwnWorkspace, retry, retrying } = useSession();
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (path.startsWith('/join/')) return <>{children}</>;

  switch (session.status) {
    case 'loading':
      // Waiting on the server, never guessing: no new organization, no empty screens.
      return session.unreachable ? (
        <Centered>
          <UnreachableState onRetry={retry} retrying={retrying} />
        </Centered>
      ) : (
        <LoadingMark />
      );
    case 'signedOut':
      return <SignInPage />;
    case 'unverified':
      return (
        <Centered>
          <div className="mx-auto w-full max-w-md px-4">
            <div className="rounded-panel border border-line bg-surface p-5 shadow-e2">
              <CheckEmail me={session.me} />
            </div>
          </div>
        </Centered>
      );
    case 'error':
      return (
        <Centered>
          <EmptyState
            icon={TriangleAlert}
            title="Something went wrong"
            description={session.message}
            action={<Button onClick={() => window.location.reload()}>Reload</Button>}
          />
        </Centered>
      );
    case 'newUser':
      return (
        <Centered>
          <Logo size={40} className="mx-auto animate-shimmer" />
        </Centered>
      );
    case 'removed':
      return (
        <Centered>
          <EmptyState
            icon={UserX}
            title="You are no longer in this organization"
            description="You left, or an admin removed you. You can start your own organization, or ask for a new invite."
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={startOwnWorkspace}>Start my own organization</Button>
                <Button variant="secondary" onClick={signOut}>
                  Sign out
                </Button>
              </div>
            }
          />
        </Centered>
      );
    case 'ready':
      return <Shell>{children}</Shell>;
  }
}
