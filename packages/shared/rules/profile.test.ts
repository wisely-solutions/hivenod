/**
 * The person's profile (users/{uid}) can only gain organizations (card M0Caulbg). A client that
 * mistook a cold cache for a new person would queue "create an organization + rewrite the
 * profile with only that one": the server must reject that batch whole, and the real way to add
 * an organization (appending with arrayUnion) must keep every other field.
 */
import { doc, getDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { arrayUnion, createWorkspace } from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, ok, put, snap, useEmulator, W } from './harness';

useEmulator();

const profile = {
  name: 'Alice',
  email: 'alice@example.com',
  photoURL: null,
  color: '#000',
  workspaceId: W,
  workspaceIds: [W],
  theme: 'dark',
};

describe('profile writes never drop organizations', () => {
  it('REGRESSION: rejects the cold-cache "new user" batch for someone who has a profile', async () => {
    await put({ [paths.user('alice')]: profile });
    const a = as('alice', { workspaceId: 'w9' });
    const card = { name: 'Alice', email: 'alice@example.com', photoURL: null, color: '#000' };
    await denied(
      a.run([
        ...createWorkspace(a.ctx, { name: 'Alice’s organization', profile: card }).ops,
        {
          kind: 'set',
          path: paths.user('alice'),
          data: { ...card, workspaceId: 'w9', workspaceIds: ['w9'], theme: null },
        },
      ]),
    );
    // Nothing of the batch landed: the profile is intact and no stray organization exists.
    expect(await snap(paths.user('alice'))).toEqual(profile);
    const stray = await getDoc(doc(as('alice').db, paths.workspace('w9'))).catch(() => null);
    expect(stray?.exists() ?? false).toBe(false);
  });

  it('adding an organization appends to the list and keeps the theme', async () => {
    await put({ [paths.user('alice')]: profile });
    const a = as('alice', { workspaceId: 'w8' });
    await ok(
      a.run([
        ...createWorkspace(a.ctx, { name: 'Second' }).ops,
        {
          kind: 'update',
          path: paths.user('alice'),
          data: { workspaceId: 'w8', workspaceIds: arrayUnion('w8') },
        },
      ]),
    );
    expect(await snap(paths.user('alice'))).toEqual({
      ...profile,
      workspaceId: 'w8',
      workspaceIds: [W, 'w8'],
    });
  });

  it('ATTACK: a full rewrite that shrinks or replaces the list is denied', async () => {
    await put({ [paths.user('alice')]: { ...profile, workspaceIds: [W, 'w2'] } });
    const a = as('alice');
    await denied(a.run([{ kind: 'set', path: paths.user('alice'), data: profile }]));
    await denied(
      a.run([
        { kind: 'set', path: paths.user('alice'), data: { ...profile, workspaceIds: ['w2', W] } },
      ]),
    );
  });
});
