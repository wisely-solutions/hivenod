/**
 * Settings is split in two (item icVly, model A): Account (yours, under the avatar: /account/<tab>)
 * and Organization settings (the organization picked in the switcher: /settings/<tab>).
 */
export const ACCOUNT_TABS = ['profile', 'notifications'] as const;
export type AccountTab = (typeof ACCOUNT_TABS)[number];

export const ORG_TABS = ['organization', 'members', 'groups', 'labels'] as const;
export type OrgTab = (typeof ORG_TABS)[number];

export const SETTINGS_TABS = [...ACCOUNT_TABS, ...ORG_TABS] as const;
export type SettingsTab = AccountTab | OrgTab;

export const SETTINGS_LABELS: Record<SettingsTab, string> = {
  profile: 'Profile',
  organization: 'Organization',
  members: 'Members',
  groups: 'Groups',
  labels: 'Inbox labels',
  notifications: 'Notifications',
};

export function isSettingsTab(v: string): v is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(v);
}
export function isAccountTab(v: string): v is AccountTab {
  return (ACCOUNT_TABS as readonly string[]).includes(v);
}
export function isOrgTab(v: string): v is OrgTab {
  return (ORG_TABS as readonly string[]).includes(v);
}

/**
 * Where an old or unknown settings address goes: account tabs to /account/<tab>, organization
 * tabs stay at /settings/<tab>, anything else to the Account profile.
 */
export function settingsTarget(
  tab: string | undefined,
): { to: '/account/$tab'; tab: AccountTab } | { to: '/settings/$tab'; tab: OrgTab } {
  if (tab && isOrgTab(tab)) return { to: '/settings/$tab', tab };
  // The Projects tab was removed (item OE8FmrTaIxFVGcaeGG3N, slice 10); its export lives on Organization.
  if (tab === 'projects') return { to: '/settings/$tab', tab: 'organization' };
  return { to: '/account/$tab', tab: tab && isAccountTab(tab) ? tab : 'profile' };
}
