/**
 * Pairing a terminal (card MkUwvyWs): anyone may create a pending request with a public key, only
 * an admin completes it for an agent they created, within 15 minutes, once; codes cannot be
 * listed; the terminal (as the new agent) deletes it.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
  updateDoc,
  type Firestore,
} from 'firebase/firestore';
import { describe, it } from 'vitest';
import { toFirestoreValue } from '../src/firestore';
import { pairingCompletion, pairingPath, pairingRequest } from '../src/pairing';
import { paths } from '../src/schema';
import { anon, as, denied, ok, put, useEmulator, W, W2 } from './harness';

useEmulator();

const CODE = 'K7QX29PD';
const PK = 'B' + 'x'.repeat(86);
const request = () =>
  toFirestoreValue(
    pairingRequest({ publicKey: PK, cli: 'claude', host: 'laptop', folder: 'blog' }),
  ) as Record<string, unknown>;
const sealed = { epk: 'e'.repeat(87), iv: 'i'.repeat(16), ct: 'c'.repeat(300) };

const ref = (db: Firestore, code = CODE) => doc(db, pairingPath(code));

async function pending(createdAt = Timestamp.now()) {
  await put({
    [pairingPath(CODE)]: {
      publicKey: PK,
      cli: 'claude',
      host: 'laptop',
      folder: 'blog',
      status: 'pending',
      createdAt,
    },
  });
}

/** An agent the owner created in W (the browser does this before completing the pairing). */
async function ownersAgent(uid = 'agentNew', over: Record<string, unknown> = {}) {
  await put({
    [paths.agent(W, uid)]: {
      name: 'Writer',
      color: '#2F5FD0',
      projectIds: '*',
      createdBy: 'owner',
      createdAt: Timestamp.now(),
      revokedAt: null,
      lastSeenAt: null,
      tokenHint: 'a7f3',
      previousAgentUid: null,
      lastEventId: 'seed',
      ...over,
    },
  });
}

const completion = (over: Record<string, unknown> = {}) =>
  toFirestoreValue({
    ...pairingCompletion({
      workspaceId: W,
      agentUid: 'agentNew',
      agentName: 'Writer',
      pairedBy: 'owner',
      sealed,
    }),
    ...over,
  }) as Record<string, unknown>;

describe('pairings: the terminal', () => {
  it('creates a pending request without signing in', async () => {
    await ok(setDoc(ref(anon()), request()));
  });
  it('cannot use a malformed code, extra fields, a set status or a client time', async () => {
    await denied(setDoc(ref(anon(), 'k7qx29pd'), request()));
    await denied(setDoc(ref(anon(), 'K7QX29P0'), request()));
    await denied(setDoc(ref(anon(), 'K7QX29PDX'), request()));
    await denied(setDoc(ref(anon()), { ...request(), agentUid: 'x' }));
    await denied(setDoc(ref(anon()), { ...request(), status: 'paired' }));
    await denied(setDoc(ref(anon()), { ...request(), createdAt: Timestamp.now() }));
    await denied(setDoc(ref(anon()), { ...request(), publicKey: 'short' }));
  });
  it('cannot overwrite an existing request', async () => {
    await pending();
    await denied(setDoc(ref(anon()), request()));
  });
  it('reads its own request by code, but nobody can list codes', async () => {
    await pending();
    await ok(getDoc(ref(anon())));
    await denied(getDocs(collection(anon(), 'pairings')));
    await denied(getDocs(collection(as('owner').db, 'pairings')));
  });
  it('may give up on a pending request', async () => {
    await pending();
    await ok(deleteDoc(ref(anon())));
  });
});

describe('pairings: the admin confirms', () => {
  it('completes it for an agent they just created', async () => {
    await pending();
    await ownersAgent();
    await ok(updateDoc(ref(as('owner').db), completion()));
  });
  it('only once', async () => {
    await pending();
    await ownersAgent();
    await ok(updateDoc(ref(as('owner').db), completion()));
    await denied(updateDoc(ref(as('owner').db), completion()));
  });
  it('not after 15 minutes', async () => {
    await pending(Timestamp.fromMillis(Date.now() - 16 * 60_000));
    await ownersAgent();
    await denied(updateDoc(ref(as('owner').db), completion()));
  });
  it('a member who is not an admin cannot', async () => {
    await pending();
    await ownersAgent('agentNew', { createdBy: 'alice' });
    await denied(updateDoc(ref(as('alice').db), completion({ pairedBy: 'alice' })));
  });
  it('an admin of another organization cannot claim an agent of this one', async () => {
    await pending();
    await ownersAgent();
    await denied(updateDoc(ref(as('eve').db), completion({ pairedBy: 'eve' })));
    await denied(updateDoc(ref(as('eve').db), completion({ pairedBy: 'eve', workspaceId: W2 })));
  });
  it('not for an agent someone else created, a revoked one, or under another name', async () => {
    await pending();
    await ownersAgent('agentOther', { createdBy: 'alice' });
    await denied(updateDoc(ref(as('owner').db), completion({ agentUid: 'agentOther' })));
    await ownersAgent('agentGone', { revokedAt: Timestamp.now() });
    await denied(updateDoc(ref(as('owner').db), completion({ agentUid: 'agentGone' })));
    await ownersAgent();
    await denied(updateDoc(ref(as('owner').db), completion({ agentName: 'Other' })));
  });
  it('cannot change the key, the time, or leave the token out', async () => {
    await pending();
    await ownersAgent();
    await denied(updateDoc(ref(as('owner').db), { ...completion(), publicKey: 'C' + PK.slice(1) }));
    await denied(updateDoc(ref(as('owner').db), { ...completion(), pairedAt: Timestamp.now() }));
    await denied(updateDoc(ref(as('owner').db), { ...completion(), sealed: { epk: 'e' } }));
    await denied(updateDoc(ref(anon()), completion()));
  });
});

describe('pairings: cleanup', () => {
  it('the new agent deletes the paired request; others cannot', async () => {
    await pending();
    await ownersAgent();
    await ok(updateDoc(ref(as('owner').db), completion()));
    await denied(deleteDoc(ref(anon())));
    await denied(deleteDoc(ref(as('agentA').db)));
    await ok(deleteDoc(ref(as('agentNew').db)));
  });
  it('an admin may delete a paired one', async () => {
    await pending();
    await ownersAgent();
    await ok(updateDoc(ref(as('owner').db), completion()));
    await ok(deleteDoc(ref(as('owner').db)));
  });
  const old = () => Timestamp.fromMillis(Date.now() - 16 * 60_000);
  const paired = (createdAt: Timestamp) =>
    put({
      [pairingPath(CODE)]: {
        publicKey: PK,
        cli: 'claude',
        host: 'laptop',
        folder: 'blog',
        status: 'paired',
        createdAt,
        workspaceId: W,
        agentUid: 'agentNew',
        agentName: 'Writer',
        pairedBy: 'owner',
        pairedAt: Timestamp.now(),
        sealed,
      },
    });
  it('anyone may delete an expired paired request', async () => {
    await paired(old());
    await ok(deleteDoc(ref(anon())));
  });
  it('anyone may delete an expired pending request', async () => {
    await pending(old());
    await ok(deleteDoc(ref(as('agentA').db)));
  });
  it('nobody but the agent or an admin may delete an unexpired paired request', async () => {
    await paired(Timestamp.now());
    await denied(deleteDoc(ref(anon())));
    await denied(deleteDoc(ref(as('agentA').db)));
    await ok(deleteDoc(ref(as('agentNew').db)));
  });
});
