import { describe, expect, it } from 'vitest';
import { NAV, ORG_NAV, TABS, YOU_NAV } from './nav';

describe('phone tabs', () => {
  it('are Today, Inbox, Calendar, Projects (item kt3E7); Activity stays in the sidebar', () => {
    expect(TABS.map((t) => t.to)).toEqual(['/', '/inbox', '/calendar', '/projects']);
    expect(TABS.map((t) => t.short ?? t.label)).toEqual(['Today', 'Inbox', 'Calendar', 'Projects']);
    expect(NAV.some((n) => n.to === '/activity')).toBe(true);
  });
});

describe('sidebar zones (item icVly, model A)', () => {
  it('puts Today, Inbox and Calendar under You, across every organization', () => {
    expect(YOU_NAV.map((n) => n.label)).toEqual(['Today', 'Inbox', 'Calendar']);
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
