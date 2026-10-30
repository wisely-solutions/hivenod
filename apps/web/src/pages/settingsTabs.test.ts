import { describe, expect, it } from 'vitest';
import { ACCOUNT_TABS, ORG_TABS, settingsTarget } from './settingsTabs';

describe('the Settings split (item icVly)', () => {
  it('keeps your own settings in Account and the rest in Organization settings', () => {
    expect([...ACCOUNT_TABS]).toEqual(['profile', 'notifications']);
    expect([...ORG_TABS]).toEqual(['organization', 'members', 'groups', 'labels']);
  });
  it('sends old addresses to the right tab', () => {
    expect(settingsTarget('profile')).toEqual({ to: '/account/$tab', tab: 'profile' });
    expect(settingsTarget('notifications')).toEqual({ to: '/account/$tab', tab: 'notifications' });
    expect(settingsTarget('members')).toEqual({ to: '/settings/$tab', tab: 'members' });
    expect(settingsTarget('labels')).toEqual({ to: '/settings/$tab', tab: 'labels' });
    expect(settingsTarget(undefined)).toEqual({ to: '/account/$tab', tab: 'profile' });
    expect(settingsTarget('nonsense')).toEqual({ to: '/account/$tab', tab: 'profile' });
    // The Projects tab was removed (OE8Fm slice 10): an old link opens Organization.
    expect(settingsTarget('projects')).toEqual({ to: '/settings/$tab', tab: 'organization' });
  });
});
