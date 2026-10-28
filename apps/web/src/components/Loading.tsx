import type { ReactNode } from 'react';
import { getAuthHint } from '../auth/hint';
import { AppSkeleton } from './AppSkeleton';
import { Logo } from './Logo';

export function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-4">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

/**
 * While the session resolves: the app shell as skeleton for someone who looks signed in (the same
 * picture index.html paints), a quiet mark otherwise. Never a spinner page (SPEC section 2).
 */
export function LoadingMark() {
  if (getAuthHint()) return <AppSkeleton />;
  return (
    <Centered>
      <div className="flex justify-center" role="status" aria-label="Loading">
        <Logo size={40} className="animate-shimmer" />
      </div>
    </Centered>
  );
}
