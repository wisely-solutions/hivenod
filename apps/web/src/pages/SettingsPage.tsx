import { useNavigate, useParams } from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import { LoadingMark } from '../components/Loading';
import { Tabs } from '../ui/form';
import { PageHeader } from './Chrome';
import { useReady } from '../auth/context';
import { OrgMark, orgDetail } from '../orgs/OrgSwitcher';
import {
  ACCOUNT_TABS,
  isAccountTab,
  isOrgTab,
  ORG_TABS,
  SETTINGS_LABELS,
  type AccountTab,
  type OrgTab,
  type SettingsTab,
} from './settingsTabs';

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
const LabelsTab = lazy(() =>
  import('./settings/LabelsTab').then((m) => ({ default: m.LabelsTab })),
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
  labels: <LabelsTab />,
  notifications: <NotificationsPage />,
};

function SettingsTabs<T extends SettingsTab>({
  label,
  tabs,
  current,
  labels,
  route,
}: {
  label: string;
  tabs: readonly T[];
  current: T;
  labels?: Partial<Record<T, string>>;
  route: '/account/$tab' | '/settings/$tab';
}) {
  const navigate = useNavigate();
  return (
    <Tabs
      label={label}
      value={current}
      onValueChange={(v) => {
        const t = tabs.find((x) => x === v);
        if (t) void navigate({ to: route, params: { tab: t } });
      }}
      tabs={tabs.map((t) => ({
        value: t,
        label: labels?.[t] ?? SETTINGS_LABELS[t],
        content:
          t === current ? <Suspense fallback={<LoadingMark />}>{CONTENT[t]}</Suspense> : null,
      }))}
    />
  );
}

/** Your own settings, the same in every organization (item icVly): /account/<tab>. */
export function AccountPage() {
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const current: AccountTab = tab && isAccountTab(tab) ? tab : 'profile';
  return (
    <>
      <PageHeader title="Account" allOrgs subtitle="Profile, theme and notifications" />
      <SettingsTabs label="Account" tabs={ACCOUNT_TABS} current={current} route="/account/$tab" />
    </>
  );
}

/**
 * The organization picked in the switcher (item icVly): /settings/<tab>. Its name is on the page
 * and on its first tab, so it is clear whose settings these are.
 */
export function OrgSettingsPage() {
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const { session } = useReady();
  const current: OrgTab = tab && isOrgTab(tab) ? tab : 'organization';
  const name = session.workspace.name;
  const detail = orgDetail(session.role, Object.keys(session.workspace.memberRoles).length);
  return (
    <>
      <div className="mb-6">
        <h1 className="text-28 font-semibold">Organization settings</h1>
        <p data-org-scope="" className="mt-1.5 flex min-w-0 items-center gap-2 text-14 text-text-2">
          <OrgMark name={name} className="size-6 text-12" />
          <span className="min-w-0 truncate">
            <span className="font-medium text-ink">{name}</span> · {detail}
          </span>
        </p>
      </div>
      <SettingsTabs
        label="Organization settings"
        tabs={ORG_TABS}
        current={current}
        labels={{ organization: name }}
        route="/settings/$tab"
      />
    </>
  );
}
