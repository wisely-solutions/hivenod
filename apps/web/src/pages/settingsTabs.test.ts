import { describe, expect, it } from 'vitest';
import { ACCOUNT_TABS, ORG_TABS, settingsTarget } from './settingsTabs';

describe('the Settings split (item icVly)', () => {
  it('keeps your own settings in Account and the rest in Organization settings', () => {
    expect([...ACCOUNT_TABS]).toEqual(['profile', 'notifications']);
    expect([...ORG_TABS]).toEqual(['organization', 'members', 'groups', 'projects', 'labels']);
  });
  it('sends old addresses to the right tab', () => {
    expect(settingsTarget('profile')).toEqual({ to: '/account/$tab', tab: 'profile' });
    expect(settingsTarget('notifications')).toEqual({ to: '/account/$tab', tab: 'notifications' });
    expect(settingsTarget('members')).toEqual({ to: '/settings/$tab', tab: 'members' });
    expect(settingsTarget('labels')).toEqual({ to: '/settings/$tab', tab: 'labels' });
    expect(settingsTarget(undefined)).toEqual({ to: '/account/$tab', tab: 'profile' });
    expect(settingsTarget('nonsense')).toEqual({ to: '/account/$tab', tab: 'profile' });
  });
});
