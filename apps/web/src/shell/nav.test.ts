import { describe, expect, it } from 'vitest';
import { NAV, TABS } from './nav';

describe('phone tabs', () => {
  it('are Today, Inbox, Calendar, Projects (item kt3E7); Activity stays in the sidebar', () => {
    expect(TABS.map((t) => t.to)).toEqual(['/', '/inbox', '/calendar', '/projects']);
    expect(TABS.map((t) => t.short ?? t.label)).toEqual(['Today', 'Inbox', 'Calendar', 'Projects']);
    expect(NAV.some((n) => n.to === '/activity')).toBe(true);
  });
});
