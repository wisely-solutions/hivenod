import { describe, expect, it } from 'vitest';
import { isPersonalOrg, orgColor, orgColorIndex } from './color';

describe('organization colours (design 3.6)', () => {
  it('by name, then id, whatever order the member’s list is in', () => {
    const orgs = [
      { wid: 'w2', name: 'Northwind' },
      { wid: 'w1', name: 'Lindqvist Studio' },
      { wid: 'w3', name: 'Acme' },
    ];
    expect(orgColorIndex('w3', orgs)).toBe(1);
    expect(orgColorIndex('w1', orgs)).toBe(2);
    expect(orgColorIndex('w2', orgs)).toBe(3);
    expect(orgColor('w1', orgs)).toBe('var(--agent-2)');
  });
  it('shares a colour only beyond 8 organizations', () => {
    const orgs = Array.from({ length: 9 }, (_, i) => ({ wid: `w${i}`, name: `Org ${i}` }));
    const idx = orgs.map((o) => orgColorIndex(o.wid, orgs));
    expect(new Set(idx.slice(0, 8)).size).toBe(8);
    expect(idx[8]).toBe(idx[0]);
  });
});

describe('the Personal organization (item icVly)', () => {
  it('is the member’s own, named Personal, with only them in it', () => {
    expect(isPersonalOrg({ name: 'Personal', ownerUid: 'u1', members: 1 }, 'u1')).toBe(true);
    expect(isPersonalOrg({ name: ' personal ', ownerUid: 'u1', members: 1 }, 'u1')).toBe(true);
    expect(isPersonalOrg({ name: 'Personal', ownerUid: 'u2', members: 1 }, 'u1')).toBe(false);
    expect(isPersonalOrg({ name: 'Personal', ownerUid: 'u1', members: 3 }, 'u1')).toBe(false);
    expect(isPersonalOrg({ name: 'Northwind', ownerUid: 'u1', members: 1 }, 'u1')).toBe(false);
  });
});
