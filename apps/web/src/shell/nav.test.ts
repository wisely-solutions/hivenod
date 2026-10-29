import { describe, expect, it } from 'vitest';
import { NAV, TABS } from './nav';

describe('phone tabs', () => {
  it('are Needs you, Inbox, Projects, Settings; Activity stays in the sidebar', () => {
    expect(TABS.map((t) => t.to)).toEqual(['/', '/inbox', '/projects', '/settings']);
    expect(NAV.some((n) => n.to === '/activity')).toBe(true);
  });
});
