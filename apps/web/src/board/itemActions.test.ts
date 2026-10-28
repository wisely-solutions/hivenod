import { describe, expect, it } from 'vitest';
import { itemActionBlocker } from './itemActions';

const item = (over: Record<string, unknown> = {}) =>
  ({
    createdBy: { type: 'human', id: 'alice' },
    claim: null,
    status: 'queued',
    ...over,
  }) as Parameters<typeof itemActionBlocker>[1];
const alice = { uid: 'alice', isAdmin: false };
const bob = { uid: 'bob', isAdmin: false };
const admin = { uid: 'owner', isAdmin: true };

describe('itemActionBlocker', () => {
  it('lets the creator and an admin archive and delete an open item', () => {
    for (const w of [alice, admin])
      for (const k of ['archive', 'delete'] as const)
        expect(itemActionBlocker(k, item(), w)).toBeNull();
  });

  it('refuses other members', () => {
    expect(itemActionBlocker('archive', item(), bob)).toMatch(/creator or an admin/);
    expect(itemActionBlocker('delete', item(), bob)).toMatch(/creator or an admin/);
  });

  it('refuses an item an agent holds: stop work first', () => {
    const held = item({ status: 'working', claim: { runId: 'r', agentUid: 'a' } });
    expect(itemActionBlocker('delete', held, admin)).toMatch(/Stop work first/);
    expect(itemActionBlocker('archive', held, admin)).toMatch(/Stop work first/);
  });

  it('archives only open items, but deletes any finished one', () => {
    expect(itemActionBlocker('archive', item({ status: 'done' }), alice)).toMatch(/open/);
    expect(itemActionBlocker('delete', item({ status: 'done' }), alice)).toBeNull();
    expect(itemActionBlocker('delete', item({ status: 'stopped' }), alice)).toBeNull();
  });

  it('an item raised by an agent can be deleted by an admin, not a member', () => {
    const f = item({ createdBy: { type: 'agent', id: 'alice' } });
    expect(itemActionBlocker('delete', f, alice)).not.toBeNull();
    expect(itemActionBlocker('delete', f, admin)).toBeNull();
  });
});
