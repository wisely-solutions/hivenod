import { CloudOff, Download, RefreshCw, Share, WifiOff, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button, IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { EmptyState } from '../ui/feedback';
import { useToast } from '../ui/overlay';
import { haptic } from '../lib/mobile';
import { useInstallHint, useOnline } from './pwa';
import { useShellData } from './data';
import { useServerLink } from '../lib/connection';
import { useReady } from '../auth/context';

export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-ink px-4 py-2 text-13 text-surface"
    >
      <Icon icon={WifiOff} />
      {"You're offline. Changes will sync."}
    </div>
  );
}

/**
 * The browser is online but the live link to the server is down or stalled: what is on screen may
 * be behind. Goes away by itself as soon as the server answers again.
 */
export function ReconnectingBanner() {
  const { session } = useReady();
  const link = useServerLink(session.workspaceId);
  const online = useOnline();
  if (link === 'live' || !online) return null;
  return (
    <div
      role="status"
      data-testid="reconnecting"
      className="flex items-center justify-center gap-2 bg-ink px-4 py-2 text-13 text-surface"
    >
      <Icon icon={RefreshCw} />
      Reconnecting. What you see may be behind.
    </div>
  );
}

/** The projects list could not load (not the same as having none): say so and offer a retry. */
export function LoadErrorBanner() {
  const { failed } = useShellData();
  const online = useOnline();
  if (!failed || !online) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-sendback-bg px-4 py-2 text-13 text-sendback"
    >
      Some of your data could not load.
      <Button variant="secondary" className="min-h-11" onClick={() => window.location.reload()}>
        Reload
      </Button>
    </div>
  );
}

/** "Install Hivenod" hint after the second visit. Dismissible, and never shown once installed. */
export function InstallHint() {
  const { show, ios, install, dismiss } = useInstallHint();
  if (!show) return null;
  return (
    <section
      aria-label="Install Hivenod"
      className="fixed inset-x-3 bottom-[calc(76px+env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] z-30 mx-auto flex max-w-md items-start gap-3 rounded-card border border-line bg-surface p-3 shadow-e2 sm:bottom-4 sm:left-auto sm:right-4 sm:mx-0"
    >
      <span className="mt-0.5 text-gate-text">
        <Icon icon={ios ? Share : Download} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-14 font-medium">Install Hivenod</p>
        <p className="text-13 text-text-2">
          {ios
            ? 'Tap Share, then Add to Home Screen, for a full-screen app.'
            : 'Add it to your home screen for a full-screen app that opens fast.'}
        </p>
        {ios ? null : (
          <Button variant="primary" className="mt-2 min-h-11" onClick={() => void install()}>
            Install
          </Button>
        )}
      </div>
      <IconButton label="Dismiss install hint" variant="ghost" onClick={dismiss}>
        <Icon icon={X} />
      </IconButton>
    </section>
  );
}

/** When the connection comes back, say that what was queued offline is going out. */
export function OnlineAgainToast() {
  const online = useOnline();
  const toast = useToast();
  const was = useRef(online);
  useEffect(() => {
    if (online && !was.current) {
      haptic('tick');
      toast.push({ message: 'Back online. Your changes are syncing.', duration: 3500 });
    }
    was.current = online;
  }, [online, toast]);
  return null;
}

/**
 * Shown in place of a screen when the server has not answered and nothing is cached: an empty
 * list there would pass for "nothing here". Goes away by itself once the server answers.
 */
export function UnreachableState({
  onRetry,
  retrying = false,
}: {
  onRetry: () => void;
  /** A Retry is under way: the button stays, disabled, until it settles. */
  retrying?: boolean;
}) {
  return (
    <div role="alert" data-testid="unreachable" className="py-10">
      <EmptyState
        icon={CloudOff}
        title="Can't reach the server"
        description="Your data has not loaded yet, and this is not an empty list. Check your connection and try again. It loads by itself once the server answers."
        action={
          <Button onClick={onRetry} disabled={retrying} loading={retrying}>
            {retrying ? 'Retrying…' : 'Retry'}
          </Button>
        }
      />
    </div>
  );
}
