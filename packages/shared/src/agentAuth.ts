/**
 * Firebase Auth side of agent identities (SPEC section 6): create the Auth user on a throw-away
 * secondary app (so the owner stays signed in) and sign in with a token. Shared by the web app,
 * the agent CLI and the tests. Import from '@hive/shared/agent-auth'.
 *
 * Nothing here logs, stores or returns the password except inside the token.
 */
import { deleteApp, initializeApp, type FirebaseOptions } from 'firebase/app';
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  inMemoryPersistence,
  initializeAuth,
  signInWithEmailAndPassword,
  signOut,
  type Auth,
} from 'firebase/auth';
import { randomId } from './actions';
import { decodeToken, encodeToken, newAgentCredentials } from './token';

export interface AgentIdentity {
  /** The new Auth uid; also the agent doc id. */
  uid: string;
  /** Show once, then drop. */
  token: string;
}

/**
 * Creates the Auth user. The secondary app keeps its session in memory only and is deleted
 * before returning, so the credential does not outlive this call anywhere in the browser.
 */
export async function createAgentIdentity(
  options: FirebaseOptions,
  workspaceId: string,
  opts: { authEmulatorUrl?: string } = {},
): Promise<AgentIdentity> {
  const { email, password } = newAgentCredentials();
  const app = initializeApp(options, `hive-agent-create-${randomId(8)}`);
  try {
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    if (opts.authEmulatorUrl)
      connectAuthEmulator(auth, opts.authEmulatorUrl, { disableWarnings: true });
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    await signOut(auth);
    return { uid, token: encodeToken({ w: workspaceId, e: email, p: password }) };
  } finally {
    await deleteApp(app);
  }
}

/** Signs an Auth instance in as the agent a token describes. */
export async function signInWithToken(
  auth: Auth,
  token: string,
): Promise<{ uid: string; workspaceId: string }> {
  const { w, e, p } = decodeToken(token);
  const cred = await signInWithEmailAndPassword(auth, e, p);
  return { uid: cred.user.uid, workspaceId: w };
}
