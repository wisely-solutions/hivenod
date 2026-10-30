/**
 * `hivenod connect` (item EJ2Cxq4k): a device-login style request (kind 'connect'). Any member
 * confirms it for projects they are in (at most 5, never all), within 10 minutes, once; they may
 * revoke the agent they made; nobody attaches an agent to projects they are not in.
 */
import { deleteDoc, doc, setDoc, Timestamp, updateDoc, type Firestore } from 'firebase/firestore';
import { describe, it } from 'vitest';
import { createAgent, revokeAgent, updateAgentSettings } from '../src/actions';
import { toFirestoreValue } from '../src/firestore';
import { pairingCompletion, pairingPath, pairingRequest } from '../src/pairing';
import { paths } from '../src/schema';
import { anon, as, denied, ok, put, useEmulator, W } from './harness';

useEmulator();

const CODE = 'K7QX29PD';
const PK = 'B' + 'x'.repeat(86);
const sealed = { epk: 'e'.repeat(87), iv: 'i'.repeat(16), ct: 'c'.repeat(300) };
const ref = (db: Firestore) => doc(db, pairingPath(CODE));

const connectRequest = () =>
  toFirestoreValue(
    pairingRequest({
      publicKey: PK,
      cli: 'claude',
      host: 'laptop',
      folder: 'blog',
      kind: 'connect',
    }),
  ) as Record<string, unknown>;

async function waiting(minutesOld = 0, kind: 'connect' | null = 'connect') {
  await put({
    [pairingPath(CODE)]: {
      publicKey: PK,
      cli: 'claude',
      host: 'laptop',
      folder: 'blog',
      status: 'pending',
      createdAt: Timestamp.fromMillis(Date.now() - minutesOld * 60_000),
      ...(kind ? { kind } : {}),
    },
  });
}

const agentInput = (over: Record<string, unknown> = {}) => ({
  agentUid: 'agentNew',
  name: 'Claude Code (laptop)',
  color: '#2F5FD0',
  projectIds: ['p1'] as string[] | '*',
  tokenHint: 'a7f3',
  ...over,
});

const completion = (by: string, over: Record<string, unknown> = {}) =>
  toFirestoreValue({
    ...pairingCompletion({
      workspaceId: W,
      agentUid: 'agentNew',
      agentName: 'Claude Code (laptop)',
      pairedBy: by,
      sealed,
    }),
    ...over,
  }) as Record<string, unknown>;

/** Alice (a plain member) creates the agent the way the confirm page does. */
async function alicesAgent(over: Record<string, unknown> = {}) {
  const alice = as('alice');
  await alice.run(createAgent(alice.ctx, agentInput(over)));
  return alice;
}

describe('connect: the terminal', () => {
  it('creates a pending connect request without signing in', async () => {
    await ok(setDoc(ref(anon()), connectRequest()));
  });
  it('cannot use another kind', async () => {
    await denied(setDoc(ref(anon()), { ...connectRequest(), kind: 'admin' }));
  });
});

describe('connect: a member creates the agent', () => {
  it('with no projects, or legacy project ids that are no longer checked (Projects removed)', async () => {
    await ok(alicesAgent({ projectIds: [] }));
    await ok(alicesAgent({ agentUid: 'agentNew2', projectIds: ['p1', 'missing'] }));
  });
  it('not for all projects, more than 5 ids, or an Inbox scope (admins only)', async () => {
    await denied(alicesAgent({ agentUid: 'agentX', projectIds: '*' }));
    await denied(alicesAgent({ agentUid: 'agentX', projectIds: ['a', 'b', 'c', 'd', 'e', 'f'] }));
    await denied(alicesAgent({ agentUid: 'agentX', projectIds: [], scope: 'inbox' }));
  });
  it('not with its own guardrails, and not before confirming their email', async () => {
    await denied(alicesAgent({ guardrails: { maxFailedRuns: 20 } }));
    const unverified = as('alice', { unverified: true });
    await denied(unverified.run(createAgent(unverified.ctx, agentInput())));
  });
  it('someone outside the organization cannot', async () => {
    const eve = as('eve');
    await denied(eve.run(createAgent(eve.ctx, agentInput())));
  });
  it('may revoke the agent they made, but not change it; others cannot revoke it', async () => {
    const alice = await alicesAgent();
    const bob = as('bob');
    await denied(bob.run(revokeAgent(bob.ctx, { agentUid: 'agentNew' })));
    await denied(
      alice.run(
        updateAgentSettings(alice.ctx, { agentUid: 'agentNew', name: 'x', projectIds: '*' }),
      ),
    );
    await ok(alice.run(revokeAgent(alice.ctx, { agentUid: 'agentNew' })));
    await denied(alice.run(revokeAgent(alice.ctx, { agentUid: 'agentNew' })));
  });
  it('cannot revoke an agent an admin made', async () => {
    const alice = as('alice');
    await denied(alice.run(revokeAgent(alice.ctx, { agentUid: 'agentA' })));
  });
});

describe('connect: the member confirms', () => {
  it('completes a connect request for their agent', async () => {
    await waiting();
    const alice = await alicesAgent();
    await ok(updateDoc(ref(alice.db), completion('alice')));
  });
  it('a reused request is refused', async () => {
    await waiting();
    const alice = await alicesAgent();
    await ok(updateDoc(ref(alice.db), completion('alice')));
    await denied(updateDoc(ref(alice.db), completion('alice')));
    await denied(updateDoc(ref(as('owner').db), completion('owner')));
  });
  it('an expired request (10 minutes) is refused, even for an admin', async () => {
    await waiting(11);
    const alice = await alicesAgent();
    await denied(updateDoc(ref(alice.db), completion('alice')));
    await put({
      [paths.agent(W, 'agentOwn')]: {
        name: 'Claude Code (laptop)',
        color: '#2F5FD0',
        projectIds: '*',
        createdBy: 'owner',
        createdAt: Timestamp.now(),
        revokedAt: null,
        lastSeenAt: null,
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    });
    await denied(updateDoc(ref(as('owner').db), completion('owner', { agentUid: 'agentOwn' })));
  });
  it('a pair request (no kind) still lasts 15 minutes and stays admin-only', async () => {
    await waiting(11, null);
    const alice = await alicesAgent();
    await denied(updateDoc(ref(alice.db), completion('alice')));
  });
  it('not for an agent someone else made', async () => {
    await waiting();
    await alicesAgent();
    await denied(updateDoc(ref(as('bob').db), completion('bob')));
  });
  it('the new agent removes the request once it has the token', async () => {
    await waiting();
    const alice = await alicesAgent();
    await ok(updateDoc(ref(alice.db), completion('alice')));
    await denied(deleteDoc(ref(anon())));
    await ok(deleteDoc(ref(as('agentNew').db)));
  });
});
