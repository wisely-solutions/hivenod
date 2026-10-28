import { CircleCheck, KeyRound, MailX } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/form';
import { Icon } from '../ui/icon';
import { AuthFrame } from './AuthFrame';

type State =
  | { kind: 'working' }
  | { kind: 'verified' }
  | { kind: 'reset' }
  | { kind: 'resetDone' }
  | { kind: 'failed'; message: string };

function Message({
  icon,
  title,
  children,
  action,
}: {
  icon: typeof CircleCheck;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div role="status">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-canvas text-text-2">
        <Icon icon={icon} size={20} />
      </span>
      <h1 className="text-20 font-semibold">{title}</h1>
      {children ? <p className="mt-1.5 text-14 text-text-2">{children}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

const open = (
  <a
    href="/"
    className="inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface"
  >
    Open Hivenod
  </a>
);

/**
 * https://hivenod.com/auth/action: where the links in Hivenod's own emails land (confirm your
 * address, choose a new password). It is a normal page of the app, not Firebase's.
 */
export function ActionPage() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode');
  const code = params.get('oobCode') ?? '';
  // Firebase's own email page sends people here when they press Continue (see emailContinueUrl).
  const done = params.get('done');
  const [state, setState] = useState<State>(
    done === 'verified'
      ? { kind: 'verified' }
      : done === 'reset'
        ? { kind: 'resetDone' }
        : mode === 'verifyEmail' && code
          ? { kind: 'working' }
          : mode === 'resetPassword' && code
            ? { kind: 'reset' }
            : {
                kind: 'failed',
                message: 'This link is not valid. Request a new email and try again.',
              },
  );
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Back from Firebase's page: if this browser is signed in, make the confirmed state count now.
    if (done !== 'verified') return;
    void import('../auth/signin').then((m) => m.refreshVerified()).catch(() => undefined);
  }, [done]);

  useEffect(() => {
    if (mode !== 'verifyEmail' || !code) return;
    let live = true;
    import('../auth/signin').then(async (m) => {
      try {
        await m.confirmEmailLink(code);
        if (live) setState({ kind: 'verified' });
      } catch (e) {
        if (live) setState({ kind: 'failed', message: m.signInMessage(e) });
      }
    });
    return () => {
      live = false;
    };
  }, [mode, code]);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    const m = await import('../auth/signin');
    try {
      const problem = m.passwordProblem(password);
      if (problem) {
        setError(problem);
        return;
      }
      await m.completeReset(code, password);
      setState({ kind: 'resetDone' });
    } catch (e) {
      setError(m.signInMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      {state.kind === 'working' ? (
        <Message icon={KeyRound} title="Confirming your email">
          One moment.
        </Message>
      ) : state.kind === 'verified' ? (
        <Message icon={CircleCheck} title="Email confirmed" action={open}>
          Thank you. Your address is confirmed, so you can start using Hivenod.
        </Message>
      ) : state.kind === 'resetDone' ? (
        <Message
          icon={CircleCheck}
          title="Password changed"
          action={
            <a
              href="/signin"
              className="inline-flex min-h-11 items-center rounded-btn bg-ink px-4 text-14 font-medium text-surface"
            >
              Sign in
            </a>
          }
        >
          Sign in with your new password.
        </Message>
      ) : state.kind === 'reset' ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <h1 className="text-20 font-semibold">Choose a new password</h1>
          <Input
            label="New password"
            type="password"
            name="password"
            autoComplete="new-password"
            required
            minLength={8}
            hint="At least 8 characters."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" loading={busy} className="w-full">
            Change password
          </Button>
          <p role="alert" className="min-h-5 text-13 text-sendback">
            {error}
          </p>
        </form>
      ) : (
        <Message icon={MailX} title="This link did not work" action={open}>
          {state.message}
        </Message>
      )}
    </AuthFrame>
  );
}
