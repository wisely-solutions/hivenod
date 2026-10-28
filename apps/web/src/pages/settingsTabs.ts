export const SETTINGS_TABS = [
  'profile',
  'organization',
  'members',
  'groups',
  'projects',
  'notifications',
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_LABELS: Record<SettingsTab, string> = {
  profile: 'Profile',
  organization: 'Organization',
  members: 'Members',
  groups: 'Groups',
  projects: 'Projects',
  notifications: 'Notifications',
};

export function isSettingsTab(v: string): v is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(v);
}
