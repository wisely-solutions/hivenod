import { useEffect, useState, useSyncExternalStore } from 'react';

const VISITS = 'hive-visits';
const DISMISSED = 'hive-install-dismissed';
export const INSTALL_HINT_DELAY_MS = 20_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the hint just may show again */
  }
}

/** Counts one visit per browser session. */
export function recordVisit(): number {
  try {
    if (sessionStorage.getItem('hive-visit-counted')) return Number(read(VISITS) ?? 1);
    sessionStorage.setItem('hive-visit-counted', '1');
  } catch {
    /* no session storage: count every load */
  }
  const n = Number(read(VISITS) ?? 0) + 1;
  write(VISITS, String(n));
  return n;
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !('MSStream' in window);
}

/** Pure rule for the install hint: second visit or later, not installed, not dismissed. */
export function shouldShowInstallHint(v: {
  visits: number;
  standalone: boolean;
  dismissed: boolean;
  canPrompt: boolean;
  ios: boolean;
}): boolean {
  return v.visits >= 2 && !v.standalone && !v.dismissed && (v.canPrompt || v.ios);
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function useInstallHint() {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [visits] = useState(() => recordVisit());
  const [dismissed, setDismissed] = useState(() => read(DISMISSED) === '1');
  const [installed, setInstalled] = useState(false);
  // Not the moment the app opens: let the person settle in first (and do what they came for).
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const t = setTimeout(
      () => setSettled(true),
      Number(read('hive-hint-delay-ms') ?? INSTALL_HINT_DELAY_MS),
    );
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const show =
    settled &&
    !installed &&
    shouldShowInstallHint({
      visits,
      standalone: isStandalone(),
      dismissed,
      canPrompt: event !== null,
      ios: isIos(),
    });

  return {
    show,
    ios: event === null && isIos(),
    install: async () => {
      if (!event) return;
      await event.prompt();
      const { outcome } = await event.userChoice;
      if (outcome === 'accepted') setInstalled(true);
      setEvent(null);
    },
    dismiss: () => {
      write(DISMISSED, '1');
      setDismissed(true);
    },
  };
}

function subscribeOnline(cb: () => void) {
  window.addEventListener('online', cb);
  window.addEventListener('offline', cb);
  // Some browsers and emulations flip navigator.onLine without firing an event.
  const poll = setInterval(cb, 3000);
  return () => {
    clearInterval(poll);
    window.removeEventListener('online', cb);
    window.removeEventListener('offline', cb);
  };
}
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Shows the Needs-you count on the installed app icon, where the browser supports it. */
export function useAppBadge(count: number | null) {
  useEffect(() => {
    if (count === null) return; // not final yet: leave the icon as it is
    const nav = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge) return;
    const p = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge?.();
    p?.catch(() => undefined);
  }, [count]);
}
