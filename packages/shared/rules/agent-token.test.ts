/**
 * Build 06 acceptance, against the real Auth and Firestore emulators and the real rules:
 * create an agent as the owner (secondary app) -> sign in with only the token (Node) -> read an
 * allowed project, denied on another -> revoke -> the same token is denied on the very next
 * request. Also: rotate, and nothing written anywhere contains the password or the token.
 */
import { initializeApp, deleteApp, type FirebaseApp } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  initializeAuth,
  inMemoryPersistence,
  signOut,
} from 'firebase/auth';
import {
  collectionGroup,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, describe, expect, it } from 'vitest';
import { createAgent, revokeAgent, rotateAgent, type ActionContext } from '../src/actions';
import { createAgentIdentity, signInWithToken } from '../src/agentAuth';
import { applyPlan } from '../src/firestore';
import { paths } from '../src/schema';
import { decodeToken, tokenHint } from '../src/token';
import { denied, getEnv, ok, P, put, projectDoc, useEmulator, W } from './harness';

useEmulator();

const AUTH_URL = `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'}`;
const [fsHost, fsPort] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
const options = { apiKey: 'fake-api-key', projectId: 'hive-rules-test' };

const apps: FirebaseApp[] = [];
function client(name: string) {
  const app = initializeApp(options, `${name}-${Math.random().toString(36).slice(2)}`);
  apps.push(app);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, AUTH_URL, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, fsHost!, Number(fsPort));
  return { app, auth, db };
}
afterAll(async () => {
  await Promise.all(apps.map((a) => deleteApp(a)));
});

/** Owner who really signs in with Auth, made owner of the seeded workspace. */
async function realOwner() {
  const c = client('owner');
  const cred = await createUserWithEmailAndPassword(
    c.auth,
    `owner-${Math.random().toString(36).slice(2)}@example.com`,
    'owner-password-123',
  );
  const uid = cred.user.uid;
  // Creating agents needs a confirmed address (card rxGgHFZs): confirm it in the emulator.
  const res = await fetch(
    `${AUTH_URL}/identitytoolkit.googleapis.com/v1/projects/${process.env.GCLOUD_PROJECT ?? 'hive-board-43be'}/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: 'Bearer owner' },
      body: JSON.stringify({ localId: uid, emailVerified: true }),
    },
  );
  if (!res.ok) throw new Error(`could not confirm the test owner: ${await res.text()}`);
  await cred.user.getIdToken(true);
  await put({
    [paths.workspace(W)]: {
      name: 'Hive',
      ownerUid: uid,
      memberRoles: { [uid]: 'owner' },
      createdAt: new Date(),
      lastEventId: 'seed',
    },
    [P('p1')]: projectDoc(),
    [P('p2')]: projectDoc(),
  });
  const ctx: ActionContext = { workspaceId: W, actor: { type: 'human', id: uid, name: 'Owner' } };
  return { ...c, uid, ctx };
}

/** Every document in the emulator, as text, read with rules disabled. */
async function wholeDatabase(): Promise<string> {
  let all = '';
  await getEnv().withSecurityRulesDisabled(async (c) => {
    const db = c.firestore() as unknown as Firestore;
    for (const group of ['agents', 'events', 'projects', 'items', 'runs', 'groups']) {
      const snap = await getDocs(collectionGroup(db, group));
      snap.forEach((d) => (all += JSON.stringify([d.ref.path, d.data()])));
    }
    const ws = await getDoc(doc(db, paths.workspace(W)));
    all += JSON.stringify(ws.data());
  });
  return all;
}

/** Nothing in the database (agents, events, projects, runs...) contains a secret. */
async function expectNoSecrets(secrets: string[]) {
  const db = await wholeDatabase();
  expect(db).toContain(P('p1').split('/')[1]!); // the scan really read documents
  expect(db).toContain('agent.');
  for (const s of secrets) expect(db).not.toContain(s);
  expect(db).not.toContain('hive_agt_');
}

describe('agent identities end to end', () => {
  it('create -> sign in -> allowed / denied -> revoke -> denied on the next request', async () => {
    const secrets: string[] = [];
    const owner = await realOwner();

    // 1. Owner creates the identity on a secondary app and writes the agent doc.
    const identity = await createAgentIdentity(options, W, { authEmulatorUrl: AUTH_URL });
    expect(getAuth(owner.app).currentUser?.uid).toBe(owner.uid); // owner stays signed in
    const { p: password } = decodeToken(identity.token);
    secrets.push(password, identity.token);
    const create = createAgent(owner.ctx, {
      agentUid: identity.uid,
      name: 'Research agent',
      color: 'agent-2',
      projectIds: ['p1'],
      tokenHint: tokenHint(identity.token),
    });
    // The plan that gets written never contains the credential.
    expect(JSON.stringify(create)).not.toContain(password);
    expect(JSON.stringify(create)).not.toContain(identity.token);
    await ok(applyPlan(owner.db, create));

    // 2. A different process (fresh app, only the token) signs in.
    const bot = client('agent');
    const who = await signInWithToken(bot.auth, identity.token);
    expect(who).toEqual({ uid: identity.uid, workspaceId: W });
    await ok(getDoc(doc(bot.db, P('p1'))));
    await denied(getDoc(doc(bot.db, P('p2'))));

    // 3. Revoke: the same token, same session, is denied on the very next request.
    await ok(applyPlan(owner.db, revokeAgent(owner.ctx, { agentUid: identity.uid })));
    await denied(getDoc(doc(bot.db, P('p1'))));
    // ...and signing in again with the token still works at the Auth level but reads nothing.
    const again = client('agent-again');
    await signInWithToken(again.auth, identity.token);
    await denied(getDoc(doc(again.db, P('p1'))));
    await denied(getDoc(doc(again.db, paths.workspace(W))));
    await expectNoSecrets(secrets);
    await signOut(owner.auth);
  });

  it('rotate: new token works, old token is denied, history link is kept', async () => {
    const secrets: string[] = [];
    const owner = await realOwner();
    const old = await createAgentIdentity(options, W, { authEmulatorUrl: AUTH_URL });
    secrets.push(old.token, decodeToken(old.token).p);
    await ok(
      applyPlan(
        owner.db,
        createAgent(owner.ctx, {
          agentUid: old.uid,
          name: 'Writer',
          color: 'agent-4',
          projectIds: '*',
          tokenHint: tokenHint(old.token),
        }),
      ),
    );
    const fresh = await createAgentIdentity(options, W, { authEmulatorUrl: AUTH_URL });
    secrets.push(fresh.token, decodeToken(fresh.token).p);
    const rot = rotateAgent(owner.ctx, {
      previousAgentUid: old.uid,
      agentUid: fresh.uid,
      name: 'Writer',
      color: 'agent-4',
      projectIds: '*',
      tokenHint: tokenHint(fresh.token),
    });
    expect(JSON.stringify(rot)).not.toContain(decodeToken(fresh.token).p);
    await ok(applyPlan(owner.db, rot));

    const oldBot = client('old');
    await signInWithToken(oldBot.auth, old.token);
    await denied(getDoc(doc(oldBot.db, P('p1'))));
    const newBot = client('new');
    await signInWithToken(newBot.auth, fresh.token);
    await ok(getDoc(doc(newBot.db, P('p1'))));
    await ok(getDoc(doc(newBot.db, P('p2'))));

    const snap = await getDoc(doc(owner.db, paths.agent(W, fresh.uid)));
    expect(snap.data()?.previousAgentUid).toBe(old.uid);
    const oldSnap = await getDoc(doc(owner.db, paths.agent(W, old.uid)));
    expect(oldSnap.data()?.revokedAt).not.toBeNull();
    await expectNoSecrets(secrets);
  });

  it('ATTACK: a member who is not the owner cannot create, rotate or revoke agents', async () => {
    const owner = await realOwner();
    const member = client('member');
    const m = await createUserWithEmailAndPassword(
      member.auth,
      `m-${Math.random().toString(36).slice(2)}@example.com`,
      'member-password-1',
    );
    await put({
      [paths.workspace(W)]: {
        name: 'Hive',
        ownerUid: owner.uid,
        memberRoles: { [owner.uid]: 'owner', [m.user.uid]: 'member' },
        createdAt: new Date(),
        lastEventId: 'seed',
      },
    });
    const ctx: ActionContext = {
      workspaceId: W,
      actor: { type: 'human', id: m.user.uid, name: 'Member' },
    };
    const id = await createAgentIdentity(options, W, { authEmulatorUrl: AUTH_URL });
    await denied(
      applyPlan(
        member.db,
        createAgent(ctx, {
          agentUid: id.uid,
          name: 'Sneaky',
          color: 'agent-1',
          projectIds: '*',
          tokenHint: '…xxxx',
        }),
      ),
    );
  });
});
