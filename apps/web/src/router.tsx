import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { lazy, Suspense, useEffect } from 'react';
import { releaseBoot } from './lib/boot';
import { useRouterState } from '@tanstack/react-router';
import { getAuthHint, useAuthHint } from './auth/hint';
import { LoadingMark } from './components/Loading';
import { SignInPage } from './pages/SignInPage';
import { isAccountTab, isOrgTab, settingsTarget, type SettingsTab } from './pages/settingsTabs';
import { MotionProvider } from './ui/motion';

// Firebase Auth and Firestore are most of the app's weight. They load only for people who may be
// signed in (or are opening an invite), so the sign-in page paints without them.
const SignedIn = lazy(() => import('./auth/SignedIn'));
const ActionPage = lazy(() =>
  import('./pages/ActionPage').then((m) => ({ default: m.ActionPage })),
);
// The signed-out front page and the Privacy page are their own pieces: signed-in loads skip them.
const LandingPage = lazy(() => import('./landing/LandingPage'));
const PrivacyPage = lazy(() => import('./landing/PrivacyPage'));
const LegacyProjectLink = lazy(() =>
  import('./threads/LegacyProjectLink').then((m) => ({ default: m.LegacyProjectLink })),
);
const JoinPage = lazy(() => import('./pages/JoinPage').then((m) => ({ default: m.JoinPage })));

function Root() {
  const hint = useAuthHint();
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The app has rendered its own first frame (its skeleton or content): the HTML skeleton can go.
  useEffect(releaseBoot, []);
  let body;
  if (path.startsWith('/kit')) {
    body = <Outlet />;
  } else if (path === '/auth/action') {
    // The links in Hivenod's emails (confirm address, reset password): for anyone, signed in or not.
    body = (
      <Suspense fallback={<LoadingMark />}>
        <ActionPage />
      </Suspense>
    );
  } else if (path === '/privacy') {
    body = (
      <Suspense fallback={<LoadingMark />}>
        <PrivacyPage />
      </Suspense>
    );
  } else if (!hint && path === '/') {
    body = (
      <Suspense fallback={<LoadingMark />}>
        <LandingPage />
      </Suspense>
    );
  } else if (!hint && !path.startsWith('/join/')) {
    body = <SignInPage />;
  } else {
    body = (
      <Suspense fallback={<LoadingMark />}>
        <SignedIn>
          <Outlet />
        </SignedIn>
      </Suspense>
    );
  }
  return <MotionProvider>{body}</MotionProvider>;
}

// Needs you is the signed-in page at "/". The router loads a matched route's component ahead of
// rendering it, so signed-out visitors (who see the landing page there) would download it and
// Firebase for nothing; only a browser that may be signed in loads it early (item g17GWUkfKRFh4mgn0ciQ).
const InboxPage = lazyRouteComponent(() => import('./inbox/InboxPage'), 'InboxPage');
function IndexPage() {
  return <InboxPage />;
}
IndexPage.preload = () => (getAuthHint() ? InboxPage.preload?.() : undefined);

const rootRoute = createRootRoute({ component: Root });
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    sel?: string;
    f?: 'approvals' | 'questions' | 'findings';
    /** Who can act (item 2YZRd): only me, or shared with others. */
    who?: 'mine' | 'shared';
    /** One organization of the cross-organization list. */
    org?: string;
    /** One subject label (item YaOErIjeIFG8Y3EvZuIp): only Inbox threads with it. */
    label?: string;
  } => ({
    ...(typeof s.sel === 'string' && s.sel ? { sel: s.sel } : {}),
    ...(s.f === 'approvals' || s.f === 'questions' || s.f === 'findings' ? { f: s.f } : {}),
    ...(s.who === 'mine' || s.who === 'shared' ? { who: s.who } : {}),
    ...(typeof s.org === 'string' && s.org ? { org: s.org } : {}),
    ...(typeof s.label === 'string' && s.label ? { label: s.label } : {}),
  }),
  component: IndexPage,
});
// The style guide is route-split, so it never counts toward the initial JS budget.
const kitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kit',
  component: lazyRouteComponent(() => import('./kit/KitPage')),
});
// Settings is split (item icVly): Account (/account/<tab>, under the avatar) and Organization
// settings (/settings/<tab>). Old addresses, the Me pages included, forward to the right tab.
const toSettings = (tab: string | undefined) => {
  const t = settingsTarget(tab);
  return t.to === '/account/$tab'
    ? redirect({ to: '/account/$tab', params: { tab: t.tab }, replace: true })
    : redirect({ to: '/settings/$tab', params: { tab: t.tab }, replace: true });
};
const accountRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account',
  beforeLoad: () => {
    throw toSettings('profile');
  },
});
const accountTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/$tab',
  beforeLoad: ({ params }) => {
    if (!isAccountTab(params.tab)) throw toSettings(params.tab);
  },
  component: lazyRouteComponent(() => import('./pages/SettingsPage'), 'AccountPage'),
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw toSettings(undefined);
  },
});
const settingsTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$tab',
  beforeLoad: ({ params }) => {
    if (!isOrgTab(params.tab)) throw toSettings(params.tab);
  },
  component: lazyRouteComponent(() => import('./pages/SettingsPage'), 'OrgSettingsPage'),
});
const legacyMe = (path: string, tab: SettingsTab) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => {
      throw toSettings(tab);
    },
  });
const meRoute = legacyMe('/me', 'profile');
const membersRoute = legacyMe('/me/members', 'members');
const groupsRoute = legacyMe('/me/groups', 'groups');
const notificationsRoute = legacyMe('/me/notifications', 'notifications');
const rangeSearch = (s: Record<string, unknown>): { range?: 7 | 30 | 90 } =>
  s.range === 7 || s.range === 30 || s.range === 90 ? { range: s.range } : {};
const toInbox = () => {
  throw redirect({ to: '/inbox', replace: true });
};
// Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 10). Old links and bookmarks go to Inbox;
// an item moved to Inbox by the migration opens its thread (LegacyProjectLink).
const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  beforeLoad: toInbox,
});
const bellRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/notifications',
  component: lazyRouteComponent(() => import('./bell/Bell'), 'NotificationsHistoryPage'),
});
const allItemsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/items',
  beforeLoad: toInbox,
});
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pid',
  validateSearch: (s: Record<string, unknown>): { view?: 'list'; item?: string } => ({
    ...(s.view === 'list' ? { view: 'list' as const } : {}),
    ...(typeof s.item === 'string' && s.item ? { item: s.item } : {}),
  }),
  component: function OldProjectLink() {
    const { pid } = projectRoute.useParams();
    const { item } = projectRoute.useSearch();
    return <LegacyProjectLink pid={pid} {...(item ? { iid: item } : {})} />;
  },
});
const viewerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pid/i/$iid/view/$aid',
  component: function OldViewerLink() {
    const { pid, iid } = viewerRoute.useParams();
    return <LegacyProjectLink pid={pid} iid={iid} />;
  },
});
const processRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pid/process',
  beforeLoad: toInbox,
});
const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/insights',
  validateSearch: (s: Record<string, unknown>): { range?: 7 | 30 | 90; project?: string } => ({
    ...rangeSearch(s),
    ...(typeof s.project === 'string' && s.project ? { project: s.project } : {}),
  }),
  component: lazyRouteComponent(() => import('./insights/InsightsPage'), 'InsightsPage'),
});
const projectInsightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/p/$pid/insights',
  validateSearch: rangeSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: '/insights', search, replace: true });
  },
});
// The organization hub (item icVly): the phone's fifth tab, the organization in the switcher.
const orgHubRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/org',
  component: lazyRouteComponent(() => import('./orgs/OrgHubPage'), 'OrgHubPage'),
});
// Calendar was removed (item OE8FmrTaIxFVGcaeGG3N, slice 5): an old link or bookmark goes to Today.
const calendarGoneRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/calendar',
  beforeLoad: () => {
    throw redirect({ to: '/', replace: true });
  },
});
// Inbox (item 4PEHrOW5IfXBQWgOK9wo): the member's subjects and threads, all organizations or one.
const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox',
  validateSearch: (s: Record<string, unknown>): { org?: string; view?: 'waiting' } => ({
    ...(typeof s.org === 'string' && s.org ? { org: s.org } : {}),
    ...(s.view === 'waiting' ? { view: 'waiting' as const } : {}),
  }),
  component: lazyRouteComponent(() => import('./threads/InboxListPage'), 'InboxListPage'),
});
const inboxSubjectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox/$wid/s/$sid',
  component: lazyRouteComponent(() => import('./threads/SubjectPage'), 'SubjectPage'),
});
const inboxThreadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/inbox/$wid/t/$tid',
  // ?from=today: opened from the Today stack, the decision view (item kt3E7).
  validateSearch: (s: Record<string, unknown>): { from?: 'today' } =>
    s.from === 'today' ? { from: s.from } : {},
  component: lazyRouteComponent(() => import('./threads/ThreadPage'), 'ThreadPage'),
});
// Scheduled tasks, slice 6: the member's schedules across every organization.
const schedulesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/schedules',
  validateSearch: (s: Record<string, unknown>): { s?: string; view?: 'month'; at?: string } => ({
    ...(typeof s.s === 'string' && s.s ? { s: s.s } : {}),
    ...(s.view === 'month' ? { view: 'month' as const } : {}),
    ...(typeof s.at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.at) ? { at: s.at } : {}),
  }),
  component: lazyRouteComponent(() => import('./schedules/SchedulesPage'), 'SchedulesPage'),
});
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/activity',
  component: lazyRouteComponent(() => import('./activity/ActivityPage'), 'ActivityPage'),
});
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents',
  validateSearch: (
    s: Record<string, unknown>,
  ): {
    connect?: string;
    new?: 1;
    token?: 1;
    agent?: string;
  } => ({
    ...(typeof s.agent === 'string' && s.agent ? { agent: s.agent } : {}),
    ...(typeof s.connect === 'string' && s.connect ? { connect: s.connect } : {}),
    ...(s.new === 1 || s.new === '1' ? { new: 1 as const } : {}),
    ...(s.token === 1 || s.token === '1' ? { token: 1 as const } : {}),
  }),
  // The old links: `hivenod pair` used to print /agents?connect=CODE, and ?new=1 opened the dialog.
  // Both now open the Connect page, so CLIs already installed keep working.
  beforeLoad: ({ search }) => {
    if (search.connect || search.new)
      throw redirect({
        to: '/agents/connect',
        search: search.connect ? { code: search.connect } : {},
        replace: true,
      });
  },
  component: lazyRouteComponent(() => import('./agents/AgentsPage'), 'AgentsPage'),
});
const connectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/connect',
  validateSearch: (s: Record<string, unknown>): { code?: string } =>
    typeof s.code === 'string' && s.code ? { code: s.code } : {},
  component: lazyRouteComponent(() => import('./agents/ConnectPage'), 'ConnectPage'),
});
// `hivenod connect` opens this page (item EJ2Cxq4k): one click confirms the machine.
const confirmConnectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connect',
  validateSearch: (s: Record<string, unknown>): { code?: string } =>
    typeof s.code === 'string' && s.code ? { code: s.code } : {},
  component: lazyRouteComponent(() => import('./agents/ConfirmConnectPage'), 'ConfirmConnectPage'),
});
const agentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/agents/$id',
  component: lazyRouteComponent(() => import('./activity/AgentPage'), 'AgentPage'),
});
const actionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/auth/action',
  component: () => null, // Root renders ActionPage itself
});
// Signed-out visitors see the sign-in page at /signin; anyone already signed in goes home.
const signinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/signin',
  validateSearch: (s: Record<string, unknown>): { mode?: 'create' } =>
    s.mode === 'create' ? { mode: 'create' } : {},
  component: function SignInRedirect() {
    return <Navigate to="/" replace />;
  },
});
const privacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/privacy',
  component: () => null, // Root renders PrivacyPage itself
});
const joinRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/join/$wid/$code',
  component: function Join() {
    const { wid, code } = joinRoute.useParams();
    return (
      <Suspense fallback={<LoadingMark />}>
        <JoinPage wid={wid} code={code} />
      </Suspense>
    );
  },
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    kitRoute,
    accountRoute,
    accountTabRoute,
    settingsRoute,
    settingsTabRoute,
    meRoute,
    membersRoute,
    groupsRoute,
    notificationsRoute,
    projectsRoute,
    bellRoute,
    allItemsRoute,
    projectRoute,
    viewerRoute,
    processRoute,
    insightsRoute,
    projectInsightsRoute,
    orgHubRoute,
    calendarGoneRoute,
    inboxRoute,
    inboxSubjectRoute,
    inboxThreadRoute,
    schedulesRoute,
    activityRoute,
    agentsRoute,
    connectRoute,
    confirmConnectRoute,
    agentRoute,
    joinRoute,
    actionRoute,
    privacyRoute,
    signinRoute,
  ]),
  // Hover and touchstart start loading a route's code before the tap lands.
  defaultPreload: 'intent',
  defaultPreloadDelay: 20,
  defaultPendingMs: 150,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// Screen changes cross-fade (View Transitions). Switched on after the first load so opening the
// app never runs a transition, and the page is never inert while it starts.
const stopWaiting = router.subscribe('onResolved', () => {
  stopWaiting();
  router.update({ defaultViewTransition: true });
});
