/** Groups: admins save and delete them (gates went with Projects, OE8Fm slice 11). */
import { describe, expect, it } from 'vitest';
import { deleteGroup, renameWorkspace, saveGroup } from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, ok, snap, useEmulator, W } from './harness';

useEmulator();

describe('groups', () => {
  it('an admin saves and deletes a group', async () => {
    const o = as('owner');
    await ok(
      o.run(
        saveGroup(o.ctx, {
          groupId: 'g1',
          name: 'Product',
          memberUids: ['alice', 'bob'],
          isNew: false,
        }),
      ),
    );
    expect((await snap(paths.group(W, 'g1'))).memberUids).toEqual(['alice', 'bob']);
    await ok(o.run(deleteGroup(o.ctx, { groupId: 'g1' })));
  });

  it('ATTACK: denies a plain member saving or deleting a group', async () => {
    const a = as('alice');
    await denied(
      a.run(
        saveGroup(a.ctx, {
          groupId: 'g1',
          name: 'Mine',
          memberUids: ['alice', 'dave'],
          isNew: false,
        }),
      ),
    );
    await denied(a.run(deleteGroup(a.ctx, { groupId: 'g1' })));
  });
});

describe('renaming the workspace', () => {
  it('lets the owner rename it and denies members', async () => {
    const o = as('owner');
    await ok(o.run(renameWorkspace(o.ctx, { name: 'Bee team' })));
    expect((await snap(paths.workspace(W))).name).toBe('Bee team');
    const a = as('alice');
    await denied(a.run(renameWorkspace(a.ctx, { name: 'Mine now' })));
  });
});
