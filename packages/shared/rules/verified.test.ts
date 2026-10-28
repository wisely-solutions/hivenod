/**
 * Card rxGgHFZs: an email/password account must confirm its address before it can create an
 * organization, join through an invite, or create an agent. Google accounts arrive confirmed.
 */
import { getDoc, doc } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { acceptInvite, createAgent, createInvite, createWorkspace } from '../src/actions';
import { paths } from '../src/schema';
import { as, denied, ok, useEmulator, W } from './harness';

const inFuture = () => new Date(Date.now() + 86_400_000);

useEmulator();

const profile = { name: 'N', email: 'n@example.com', photoURL: null, color: 'c1' };

describe('verified email', () => {
  it('creates an organization only once the address is confirmed', async () => {
    const u = as('newbie', { workspaceId: 'w9', email: 'n@example.com', unverified: true });
    await denied(u.run(createWorkspace(u.ctx, { name: 'Mine', profile }).ops));
    const v = as('newbie', { workspaceId: 'w9', email: 'n@example.com' });
    await ok(v.run(createWorkspace(v.ctx, { name: 'Mine', profile }).ops));
  });

  it('joins through an invite only when confirmed', async () => {
    const o = as('owner');
    await o.run(
      createInvite(o.ctx, {
        email: 'frank@example.com',
        role: 'member',
        expiresAt: inFuture(),
        code: 'c1',
      }),
    );
    const un = as('frank', { email: 'frank@example.com', unverified: true });
    await ok(getDoc(doc(un.db, paths.invite(W, 'c1')))); // reading is the same as before
    await denied(un.run(acceptInvite(un.ctx, { code: 'c1', role: 'member' })));
    const f = as('frank', { email: 'frank@example.com' });
    await ok(f.run(acceptInvite(f.ctx, { code: 'c1', role: 'member' })));
  });

  it('an unconfirmed admin cannot create an agent', async () => {
    const input = {
      agentUid: 'agentNew',
      name: 'Bot',
      color: 'c1',
      projectIds: '*' as const,
      tokenHint: '…a7f3',
    };
    const un = as('owner', { unverified: true });
    await denied(un.run(createAgent(un.ctx, input)));
    const o = as('owner');
    await ok(o.run(createAgent(o.ctx, input)));
  });
});
