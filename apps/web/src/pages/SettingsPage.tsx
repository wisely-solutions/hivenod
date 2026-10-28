import { useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { LoadingMark } from '../components/Loading';
import { Tabs } from '../ui/form';
import { PageHeader } from './Chrome';
import { isSettingsTab, SETTINGS_LABELS, SETTINGS_TABS, type SettingsTab } from './settingsTabs';

// Each tab is its own piece of code, loaded when opened.
const ProfileTab = lazy(() =>
  import('./settings/ProfileTab').then((m) => ({ default: m.ProfileTab })),
);
const OrganizationTab = lazy(() =>
  import('./settings/OrganizationTab').then((m) => ({ default: m.OrganizationTab })),
);
const ProjectsTab = lazy(() =>
  import('./settings/ProjectsTab').then((m) => ({ default: m.ProjectsTab })),
);
const MembersPage = lazy(() => import('./MembersPage').then((m) => ({ default: m.MembersPage })));
const GroupsPage = lazy(() => import('./GroupsPage').then((m) => ({ default: m.GroupsPage })));
const NotificationsPage = lazy(() =>
  import('./NotificationsPage').then((m) => ({ default: m.NotificationsPage })),
);

const CONTENT: Record<SettingsTab, React.JSX.Element> = {
  profile: <ProfileTab />,
  organization: <OrganizationTab />,
  members: <MembersPage />,
  groups: <GroupsPage />,
  projects: <ProjectsTab />,
  notifications: <NotificationsPage />,
};

/** One place for every setting: /settings/<tab>. */
export function SettingsPage() {
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const current: SettingsTab = tab && isSettingsTab(tab) ? tab : 'profile';
  return (
    <>
      <PageHeader title="Settings" />
      <Tabs
        label="Settings"
        value={current}
        onValueChange={(v) => {
          if (isSettingsTab(v)) void navigate({ to: '/settings/$tab', params: { tab: v } });
        }}
        tabs={SETTINGS_TABS.map((t) => ({
          value: t,
          label: SETTINGS_LABELS[t],
          content:
            t === current ? <Suspense fallback={<LoadingMark />}>{CONTENT[t]}</Suspense> : null,
        }))}
      />
    </>
  );
}
