import { describe, expect, it } from 'vitest';
import { isOrgPath, NAV, ORG_NAV, TABS, YOU_NAV } from './nav';

describe('phone tabs', () => {
  it('are Today, Inbox, then the organization (item icVly; no Calendar, OE8Fm slice 5)', () => {
    expect(TABS.map((t) => t.to)).toEqual(['/', '/inbox']);
    expect(NAV.some((n) => (n.to as string) === '/calendar')).toBe(false);
    expect(NAV.some((n) => n.to === '/activity')).toBe(true);
  });
  it('light the organization tab on every organization page', () => {
    for (const p of [
      '/org',
      '/projects',
      '/p/x',
      '/p/x/process',
      '/agents',
      '/agents/a1',
      '/activity',
      '/insights',
      '/items',
      '/settings/members',
    ])
      expect(isOrgPath(p), p).toBe(true);
    for (const p of ['/', '/inbox', '/inbox/w/t/1', '/account/profile', '/notifications'])
      expect(isOrgPath(p), p).toBe(false);
  });
});

describe('sidebar zones (item icVly, model A)', () => {
  it('puts Today and Inbox under You, across every organization', () => {
    expect(YOU_NAV.map((n) => n.label)).toEqual(['Today', 'Inbox']);
  });
  it('puts the organization pages under the switcher, with Projects renamed', () => {
    expect(ORG_NAV.map((n) => n.label)).toEqual([
      'Projects',
      'Agents',
      'Activity',
      'Decision insights',
    ]);
    expect(NAV.some((n) => n.label === 'All projects')).toBe(false);
  });
  it('keeps every go-to key unique', () => {
    const keys = NAV.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
