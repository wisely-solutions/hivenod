import { FoldedBackdrop } from '../components/FoldedBackdrop';
import { Logo } from '../components/Logo';
import { useState } from 'react';
import { SignInPanel, type PanelMode } from '../auth/SignInPanel';
import { Reveal } from '../ui/motion';

const COPY: Record<PanelMode, { lead: string; foot: string }> = {
  signin: {
    lead: 'Sign in to see what is waiting on you.',
    foot: 'New here? Choose Create account, or continue with Google.',
  },
  create: {
    lead: 'Create your account and start your first workspace.',
    foot: 'Your workspace is set up once your email address is confirmed.',
  },
  reset: {
    lead: 'Forgot your password? We email you a link to choose a new one.',
    foot: 'The link works once. Nothing changes until you use it.',
  },
};

/** The signed-out front door. */
export function SignInPage() {
  // /signin?mode=create (the landing page's "Get started") opens on Create account.
  const create = new URLSearchParams(window.location.search).get('mode') === 'create';
  const [mode, setMode] = useState<PanelMode>(create ? 'create' : 'signin');
  return (
    <main className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-canvas pt-[env(safe-area-inset-top)]">
      <FoldedBackdrop />
      <div className="relative z-10 mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-[max(32px,env(safe-area-inset-bottom))] pt-10 sm:px-0">
        <Reveal>
          <div className="mb-8 flex items-center gap-2.5">
            <Logo size={32} />
            <span className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-gate-text">
              Hivenod
            </span>
          </div>
          <h1 className="text-balance text-28 font-semibold sm:text-34">
            Agents do the work.
            <br />
            You make the decisions.
          </h1>
          <p className="mt-3 max-w-sm text-16 text-text-2">{COPY[mode].lead}</p>
        </Reveal>
        <Reveal delay={0.08}>
          <div className="mt-8 rounded-panel border border-line bg-surface/90 p-4 shadow-e2 backdrop-blur-sm">
            <SignInPanel initialMode={create ? 'create' : 'signin'} onModeChange={setMode} />
            <p className="mt-2 text-center text-13 text-text-2">{COPY[mode].foot}</p>
          </div>
        </Reveal>
      </div>
    </main>
  );
}
