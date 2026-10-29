import { tabTitle } from '@hive/shared';
import { Outlet, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { RemindersProvider } from '../notify/reminders';
import { BellLink } from '../bell/Bell';
import { BellProvider } from '../bell/data';
import { CaptureProvider } from '../capture/CaptureProvider';
import { Logo } from '../components/Logo';
import { OrgSwitcher } from '../orgs/OrgSwitcher';
import { cn } from '../ui/cn';
import { IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { Skeleton } from '../ui/feedback';
import { useKeyboardAvoidance } from '../lib/mobile';
import {
  InstallHint,
  LoadErrorBanner,
  OfflineBanner,
  ReconnectingBanner,
  OnlineAgainToast,
} from './banners';
import { useResumeOrgDeletes } from '../orgs/deleteJobs';
import { ShellDataProvider, useShellData } from './data';
import { NeedsAllProvider, useNeedsAll } from '../needs/data';
import { ErrorBoundary } from './ErrorBoundary';
import { UnreachableState } from './banners';
import { ModalProvider } from './modals';
import { ME, NAV, type NavEntry } from './nav';
import { ShellPalette } from './palette';
import { useAppBadge } from './pwa';
import { useCleanStaleBusy } from './useCleanStaleBusy';
import { useReplayPending } from './useReplayPending';
import { ShortcutsProvider, useShortcut } from './shortcuts';
import { useUndoLast } from '../ui/overlay';
import { Sidebar } from './Sidebar';
import { TabBar, useScrollHidden } from './TabBar';

/**
 * The frame every signed-in screen lives in: sidebar (tablet/desktop) or tab bar (phone), the
 * command palette, shortcuts, the global dialog, banners and the error boundary.
 */
export function Shell({ children }: { children?: ReactNode }) {
  return (
    <ShortcutsProvider>
      <ModalProvider>
        <ShellDataProvider>
          <NeedsAllProvider>
            <RemindersProvider>
              <BellProvider>
                <CaptureProvider>
                  <Frame>{children}</Frame>
                </CaptureProvider>
              </BellProvider>
            </RemindersProvider>
          </NeedsAllProvider>
        </ShellDataProvider>
      </ModalProvider>
    </ShortcutsProvider>
  );
}

function GoShortcut({ entry }: { entry: NavEntry }) {
  const navigate = useNavigate();
  useShortcut({
    id: `go:${entry.to}`,
    keys: ['g', entry.key],
    label: `Go to ${entry.label}`,
    group: 'Navigation',
    run: () => void navigate({ to: entry.to }),
  });
  return null;
}

function GoShortcuts({ onSearch }: { onSearch: () => void }) {
  // Z takes back the decision that is counting down on its button (card eLSSIGOs).
  const undoLast = useUndoLast();
  useShortcut({
    id: 'undo',
    keys: ['z'],
    label: 'Undo',
    group: 'Item',
    run: () => void undoLast(),
  });
  useShortcut({ id: 'search', keys: ['/'], label: 'Search', group: 'Navigation', run: onSearch });
  return (
    <>
      {[...NAV, ME].map((n) => (
        <GoShortcut key={n.to} entry={n} />
      ))}
    </>
  );
}

/** Phone header whose small title fades in once the page's own large title scrolls away. */
function useCondensedTitle(path: string) {
  const [state, setState] = useState<{ title: string; condensed: boolean }>({
    title: '',
    condensed: false,
  });
  const main = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = main.current;
    if (!root) return;
    let observed: Element | null = null;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        // Condensed only once it has left through the top, not while still below the fold.
        const above = e.boundingClientRect.bottom < 56;
        setState((s) => ({ ...s, condensed: !e.isIntersecting && above }));
      },
      { rootMargin: '-56px 0px 0px 0px' },
    );
    const find = () => {
      const h1 = root.querySelector('h1');
      if (h1 === observed) return;
      if (observed) io.unobserve(observed);
      observed = h1;
      if (h1) {
        io.observe(h1);
        setState({ title: h1.textContent ?? '', condensed: false });
      } else {
        setState({ title: '', condensed: false });
      }
    };
    find();
    const mo = new MutationObserver(find);
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [path]);
  return { main, ...state };
}

function Frame({ children }: { children?: ReactNode }) {
  const [palette, setPalette] = useState(false);
  useReplayPending();
  useCleanStaleBusy();
  const { needsReady, unreachable, retry, retrying } = useShellData();
  // Counts every organization (item 2YZRd): the app icon and the tab title too.
  const all = useNeedsAll();
  const needs = all.counts;
  const path = useRouterState({ select: (s) => s.location.pathname });
  const hidden = useScrollHidden();
  const { main, title, condensed } = useCondensedTitle(path);
  useAppBadge(all.ready ? needs.total : null);
  useResumeOrgDeletes();
  useKeyboardAvoidance();

  // Once the first screen has its data and the browser is idle, fetch the code of the main
  // screens so the first tap is already warm. Not before: on a slow link it shared the line with
  // the first screen's own data (card CGPynEQY).
  const router = useRouter();
  const [firstData, setFirstData] = useState(false);
  if (needsReady && !firstData) setFirstData(true);
  useEffect(() => {
    if (!firstData) return;
    const warm = () => {
      for (const to of ['/projects', '/activity', '/agents', '/insights'] as const) {
        void router.preloadRoute({ to }).catch(() => undefined);
      }
      void router
        .preloadRoute({ to: '/settings/$tab', params: { tab: 'profile' } })
        .catch(() => undefined);
    };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(warm);
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(warm, 2000);
    return () => clearTimeout(t);
  }, [router, firstData]);

  // Back at the top of a new screen.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [path]);

  // A new screen has its own tab title, and keyboard and screen-reader users start from its top.
  // Compare with the previous screen, not the first one: coming back to the screen the
  // session started on (usually Needs you) must move focus too.
  const lastPath = useRef(path);
  useEffect(() => {
    if (path !== lastPath.current) main.current?.focus({ preventScroll: true });
    lastPath.current = path;
  }, [path, main]);
  useEffect(() => {
    if (/\/view\/[^/]+\/?$/.test(path)) return; // the viewer names its own tab
    const base = path === '/' ? 'Today · Hivenod' : title ? `${title} · Hivenod` : 'Hivenod';
    // The count sits in front on every screen, so a background tab shows what waits.
    document.title = tabTitle(base, all.ready ? needs.total : null);
  }, [path, title, needs.total, all.ready]);

  // The full-page viewer owns the whole screen (SPEC 9.6): no sidebar, tabs or page padding.
  if (/^\/p\/[^/]+\/i\/[^/]+\/view\/[^/]+\/?$/.test(path)) {
    return (
      <ErrorBoundary key={path}>
        <OnlineAgainToast />
        <Suspense fallback={<RouteSkeleton />}>{children ?? <Outlet />}</Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <div className="flex min-h-dvh bg-canvas">
      <GoShortcuts onSearch={() => setPalette(true)} />
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[70] focus:rounded-btn focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <Sidebar onSearch={() => setPalette(true)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <OfflineBanner />
        <ReconnectingBanner />
        <LoadErrorBanner />
        <header
          style={{ viewTransitionName: 'shell-header' }}
          className={cn(
            'sticky top-0 z-20 border-b bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur-sm transition-colors duration-200 sm:hidden',
            condensed ? 'border-line' : 'border-transparent',
          )}
        >
          <div className="flex h-12 items-center justify-between px-4">
            <Logo size={26} />
            <p
              aria-hidden
              className={cn(
                'pointer-events-none absolute inset-x-28 truncate text-center text-14 font-semibold transition-opacity duration-200',
                condensed ? 'opacity-100' : 'opacity-0',
              )}
            >
              {title}
            </p>
            <div className="flex items-center gap-1">
              <BellLink />
              <OrgSwitcher compact className="w-11 border-transparent bg-transparent" />
              <IconButton label="Search" variant="ghost" onClick={() => setPalette(true)}>
                <Icon icon={Search} size={20} />
              </IconButton>
            </div>
          </div>
        </header>
        <main
          id="content"
          ref={main}
          tabIndex={-1}
          className={cn(
            'mx-auto w-full flex-1 outline-none px-4 pb-[calc(88px+env(safe-area-inset-bottom))] pt-4 sm:pb-16 sm:pt-8',
            pageWidth(path),
          )}
        >
          <ErrorBoundary key={path}>
            <Suspense fallback={<RouteSkeleton />}>
              {unreachable && !path.startsWith('/settings') ? (
                <UnreachableState onRetry={retry} retrying={retrying} />
              ) : (
                <div className="route-fade">{children ?? <Outlet />}</div>
              )}
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <TabBar hidden={hidden} />
      <OnlineAgainToast />
      <InstallHint />
      <ShellPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

/**
 * Three page widths, by kind of screen: the board and its list use the whole window; overviews
 * (Needs you, projects, activity, agents, insights, process) sit at 1120 px; forms and single
 * records (Me, an agent, members, groups) at 720 px.
 */
function pageWidth(path: string): string {
  if (/^\/p\/[^/]+\/?$/.test(path) || path === '/items') return 'max-w-[120rem]';
  if (
    path === '/' ||
    path === '/projects' ||
    path === '/activity' ||
    path === '/agents' ||
    // An Inbox thread or subject: the conversation and the agent panel (item kt3E7).
    /^\/inbox\/[^/]+\/[ts]\/[^/]+\/?$/.test(path) ||
    path.endsWith('/insights') ||
    path.endsWith('/process')
  )
    return 'max-w-[70rem]';
  return 'max-w-[45rem]';
}

function RouteSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-4">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}
