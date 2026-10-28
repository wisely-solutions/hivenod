import { createInvite, type Role } from '@hive/shared';
import { Check, Copy, Share2 } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { Button } from '../ui/button';
import { AnimatePresence, motion, tween } from '../ui/motion';
import { Input, RadioCards } from '../ui/form';
import { Icon } from '../ui/icon';

const QrCode = lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })));

export const INVITE_DAYS = 7;

export function inviteUrl(workspaceId: string, code: string, workspaceName: string): string {
  const q = new URLSearchParams({ w: workspaceName });
  return `${window.location.origin}/join/${workspaceId}/${code}?${q}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Copy button that says "Copied" for a moment. */
export function CopyButton({
  text,
  label = 'Copy link',
  name,
}: {
  text: string;
  label?: string;
  /** Accessible name when several copy buttons share a label ("Copy install command"). */
  name?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="secondary"
      aria-label={name}
      leading={<Icon icon={done ? Check : Copy} />}
      onClick={async () => {
        if (await copyText(text)) {
          if (typeof navigator.vibrate === 'function') navigator.vibrate(8);
          setDone(true);
          setTimeout(() => setDone(false), 1800);
        }
      }}
    >
      <span aria-live="polite" className="relative inline-grid">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={done ? 'done' : 'idle'}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={tween.fast}
          >
            {done ? 'Copied' : label}
          </motion.span>
        </AnimatePresence>
      </span>
    </Button>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { session, actionContext, run } = useReady();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [created, setCreated] = useState<{ url: string; email: string; expires: Date } | null>(
    null,
  );

  const reset = () => {
    setEmail('');
    setRole('member');
    setError(undefined);
    setCreated(null);
  };

  async function create() {
    const clean = email.trim().toLowerCase();
    if (!EMAIL.test(clean)) return setError('Enter the email they sign in with.');
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    setError(undefined);
    const expires = new Date(Date.now() + INVITE_DAYS * 86_400_000);
    try {
      const plan = createInvite(ctx, { email: clean, role, expiresAt: expires });
      await run(plan);
      setCreated({
        url: inviteUrl(session.workspaceId, plan.code, session.workspace.name),
        email: clean,
        expires,
      });
    } catch {
      setError('Could not create the invite. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  return (
    <ResponsiveModal
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          setTimeout(reset, 250);
        }
      }}
      title={created ? 'Invite link ready' : 'Invite someone'}
      description={
        created
          ? `Only ${created.email} can use it. It expires in ${INVITE_DAYS} days.`
          : 'They join with this email address, signing in with Google or a password.'
      }
      footer={
        created ? (
          <>
            <Button variant="secondary" onClick={reset}>
              Invite another
            </Button>
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy} onClick={create}>
              Create invite link
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <Input
            label="Invite link"
            readOnly
            value={created.url}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="flex flex-wrap gap-2">
            <CopyButton text={created.url} />
            {canShare ? (
              <Button
                variant="secondary"
                leading={<Icon icon={Share2} />}
                onClick={() =>
                  navigator
                    .share({ title: 'Join my Hivenod organization', url: created.url })
                    .catch(() => undefined)
                }
              >
                Share
              </Button>
            ) : null}
          </div>
          <div className="flex flex-col items-center gap-2 rounded-card border border-line bg-canvas p-4">
            <Suspense fallback={<div className="size-44 rounded-card bg-surface" />}>
              <QrCode value={created.url} label="QR code for the invite link" />
            </Suspense>
            <p className="text-13 text-text-2">Scan with a phone to open the link there.</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Input
            label="Email"
            type="email"
            autoComplete="off"
            inputMode="email"
            placeholder="name@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            error={error}
          />
          <RadioCards
            label="Role"
            value={role}
            onValueChange={(v) => setRole(v as Role)}
            options={[
              {
                value: 'member',
                title: 'Member',
                description: 'Works on the projects an admin adds them to.',
              },
              {
                value: 'admin',
                title: 'Admin',
                description: 'Sees every project and manages people, groups and agents.',
              },
            ]}
          />
        </div>
      )}
    </ResponsiveModal>
  );
}
