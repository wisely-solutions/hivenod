import type { ReactNode } from 'react';
import { FoldedBackdrop } from '../components/FoldedBackdrop';
import { Logo } from '../components/Logo';
import { Reveal } from '../ui/motion';

/** The calm centred card used by the sign-in related pages (invite, email links). */
export function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-canvas pt-[env(safe-area-inset-top)]">
      <FoldedBackdrop />
      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-[max(32px,env(safe-area-inset-bottom))] pt-10 sm:px-0">
        <Reveal>
          <a href="/" className="mb-6 flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
              Hivenod
            </span>
          </a>
          <div className="rounded-panel border border-line bg-surface/95 p-5 shadow-e2 backdrop-blur-sm">
            {children}
          </div>
        </Reveal>
      </div>
    </main>
  );
}
