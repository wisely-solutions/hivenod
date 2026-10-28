import { describe, expect, it } from 'vitest';
import { existingPersonalOrg, personalOrgPlan } from './personalOrg';

const ctx = (type: 'human' | 'agent' = 'human') => ({
  workspaceId: 'wP',
  actor: { type, id: 'u1', name: 'João' },
  newId: (() => {
    let n = 0;
    return () => `id${++n}`;
  })(),
});
const profile = { name: 'João', email: 'j@example.com', photoURL: null, color: 'c1' };

describe('personalOrgPlan', () => {
  it('writes the workspace, the member card, the event and the switcher entry', () => {
    const p = personalOrgPlan(ctx() as never, { profile });
    expect(p.workspaceId).toBe('wP');
    expect(p.ops.map((o) => `${o.kind} ${o.path}`)).toEqual([
      'set workspaces/wP',
      'set workspaces/wP/members/u1',
      `set workspaces/wP/events/${p.eventId}`,
      'update users/u1',
    ]);
    expect(p.ops[0]!.data).toMatchObject({ name: 'Personal', ownerUid: 'u1' });
    expect(p.ops[3]!.data).toEqual({ workspaceIds: { __hive: 'arrayUnion', values: ['wP'] } });
  });
  it('takes another name, refuses an empty one and agents', () => {
    expect(personalOrgPlan(ctx() as never, { profile, name: ' Home ' }).ops[0]!.data).toMatchObject(
      { name: 'Home' },
    );
    expect(() => personalOrgPlan(ctx() as never, { profile, name: '  ' })).toThrow(/1 to 120/);
    expect(() => personalOrgPlan(ctx('agent') as never, { profile })).toThrow(/person/);
  });
});

describe('existingPersonalOrg', () => {
  it('finds the person’s own one by name, not someone else’s', () => {
    const orgs = [
      { id: 'a', name: 'Wisely', ownerUid: 'u1' },
      { id: 'b', name: 'personal', ownerUid: 'u2' },
      { id: 'c', name: 'Personal ', ownerUid: 'u1' },
    ];
    expect(existingPersonalOrg(orgs, 'u1')?.id).toBe('c');
    expect(existingPersonalOrg(orgs, 'u3')).toBeNull();
  });
});
