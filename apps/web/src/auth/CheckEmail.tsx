import { Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { Icon } from '../ui/icon';
import type { Me } from './context';
import { useSession } from './context';
import { cooldownLeft } from './cooldown';

/**
 * The one screen an unconfirmed email/password account sees: where the link was sent, Resend,
 * Sign out. It notices by itself when the address gets confirmed (another tab or device).
 */
export function CheckEmail({ me }: { me: Me }) {
  const { resendVerification, recheckVerified, signOut } = useSession();
  const [left, setLeft] = useState(() => cooldownLeft(me.email));
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const check = () => void recheckVerified().catch(() => undefined);
    const onVisible = () => document.visibilityState === 'visible' && check();
    const t = window.setInterval(onVisible, 5000);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recheckVerified]);

  useEffect(() => {
    if (left <= 0) return;
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left]);

  async function resend() {
    setSending(true);
    setNote(null);
    try {
      await resendVerification();
      setNote('Sent again. It can take a minute to arrive; look in spam too.');
    } catch {
      if (cooldownLeft(me.email) <= 0)
        setNote('Could not send it now. Wait a minute and try again.');
    } finally {
      setLeft(cooldownLeft(me.email));
      setSending(false);
    }
  }

  return (
    <div role="status">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-canvas text-text-2">
        <Icon icon={Mail} size={20} />
      </span>
      <h1 className="text-20 font-semibold">Check your email</h1>
      <p className="mt-1.5 text-14 text-text-2">
        We sent a link to <strong className="font-medium text-ink">{me.email}</strong>. Open it to
        confirm your address, then this page moves on by itself.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <Button variant="secondary" loading={sending} disabled={left > 0} onClick={resend}>
          {left > 0 ? `Resend in ${left}s` : 'Resend email'}
        </Button>
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>
      <p aria-live="polite" className="mt-3 min-h-5 text-13 text-text-2">
        {left > 0 && !note?.startsWith('Sent') ? `Try again in ${left}s.` : note}
      </p>
    </div>
  );
}
