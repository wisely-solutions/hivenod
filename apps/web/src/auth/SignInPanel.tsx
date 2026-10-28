import { useState, type FormEvent } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { EMAIL_SIGNIN } from '../lib/flags';

function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" width="20" height="20" aria-hidden>
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4.1 7.1-10.1 7.1-17.5z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.7c-.5-1.5-.8-3-.8-4.7s.3-3.2.8-4.7l-7.9-6.1C.9 16.4 0 20.100 0 24s.9 7.6 2.6 10.8l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.1 1.4-4.8 2.3-8.4 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}

export type PanelMode = 'signin' | 'create' | 'reset';

const link =
  'text-14 font-medium text-ink underline decoration-line-strong underline-offset-4 ' +
  'hov:decoration-ink';

/**
 * "Continue with Google", and (behind EMAIL_SIGNIN) email + password: sign in, create account,
 * forgot password. Each has its own error line.
 */
export function SignInPanel({
  label = 'Continue with Google',
  initialMode = 'signin',
  onModeChange,
}: {
  label?: string;
  initialMode?: PanelMode;
  onModeChange?: (mode: PanelMode) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [resetSent, setResetSent] = useState(false);
  // Create account on an address that is taken: the same neutral outcome as a new one.
  const [createdFor, setCreatedFor] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      // Firebase Auth loads only now, so the sign-in page itself stays light.
      const { signInWithGoogle } = await import('./signin');
      await signInWithGoogle();
    } catch (e) {
      const { signInMessage } = await import('./signin');
      setError(signInMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const m = await import('./signin');
    try {
      if (!m.isValidEmail(email)) {
        setError(m.INVALID_EMAIL);
        return;
      }
      if (mode === 'create') {
        const problem = m.passwordProblem(password);
        if (problem) {
          setError(problem);
          return;
        }
      }
      if (mode === 'reset') {
        await m.sendReset(email);
        setResetSent(true);
      } else if (mode === 'create') {
        await m.signUpWithEmail(email, password);
      } else {
        await m.signInWithEmail(email, password);
      }
    } catch (e) {
      if (mode === 'create' && (e as { code?: string }).code === 'auth/email-already-in-use') {
        // Never say whether an address has an account: show what a new sign-up shows (a
        // "Check your email" outcome) and point to sign in / reset for anyone who has one.
        setCreatedFor(email.trim());
      } else {
        setError(m.signInMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  function switchTo(next: PanelMode) {
    setMode(next);
    onModeChange?.(next);
    setError(null);
    setResetSent(false);
    setCreatedFor(null);
  }

  return (
    <div className="w-full">
      <Button
        variant="secondary"
        loading={busy && !EMAIL_SIGNIN}
        leading={<GoogleG />}
        onClick={go}
        className="min-h-14 w-full text-16 shadow-e1"
      >
        {label}
      </Button>
      {EMAIL_SIGNIN ? (
        <>
          <div className="my-4 flex items-center gap-3 text-13 text-text-2" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          {createdFor ? (
            <div role="status" className="text-14 text-text-2">
              <h2 className="text-16 font-semibold text-ink">Check your email</h2>
              <p className="mt-1.5">
                If <strong className="font-medium text-ink">{createdFor}</strong> can be used for a
                new account, we sent a link to confirm it. If you already have an account with this
                address, sign in or reset your password instead.
              </p>
            </div>
          ) : mode === 'reset' && resetSent ? (
            <p role="status" className="text-14 text-text-2">
              If an account exists for that address, a link to choose a new password is on its way.
              Check your email.
            </p>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
              <Input
                label="Email"
                type="email"
                name="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {mode !== 'reset' ? (
                <Input
                  label="Password"
                  type="password"
                  name="password"
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  required
                  hint={
                    mode === 'create'
                      ? 'At least 8 characters, and not a common password.'
                      : undefined
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              ) : null}
              <Button type="submit" loading={busy} className="min-h-11 w-full">
                {mode === 'create'
                  ? 'Create account'
                  : mode === 'reset'
                    ? 'Send reset link'
                    : 'Sign in'}
              </Button>
            </form>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {createdFor ? (
              <>
                <button type="button" className={link} onClick={() => switchTo('signin')}>
                  Sign in
                </button>
                <button type="button" className={link} onClick={() => switchTo('reset')}>
                  Forgot password?
                </button>
              </>
            ) : mode === 'signin' ? (
              <>
                <button type="button" className={link} onClick={() => switchTo('create')}>
                  Create account
                </button>
                <button type="button" className={link} onClick={() => switchTo('reset')}>
                  Forgot password?
                </button>
              </>
            ) : (
              <button type="button" className={link} onClick={() => switchTo('signin')}>
                {mode === 'create' ? 'Have an account? Sign in' : 'Back to sign in'}
              </button>
            )}
          </div>
          {mode === 'create' && !createdFor ? (
            <p className="mt-3 text-13 text-text-2">
              We email you a link to confirm your address before you start. See our{' '}
              <a href="/privacy" className="underline underline-offset-2">
                Privacy page
              </a>
              .
            </p>
          ) : null}
        </>
      ) : null}
      <p role="alert" className="mt-3 min-h-5 text-center text-13 text-sendback">
        {error}
      </p>
    </div>
  );
}
