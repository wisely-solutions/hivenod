/**
 * Quick-create soak on the emulators (item VJHVv): N createItem batches as a web-SDK human, plain,
 * during forced ID-token refreshes, across offline/online toggles, and concurrent. Prints every
 * refusal with its code and the phase. Run through cli/spike/create-soak.sh.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { initializeApp } from 'firebase/app';
import {
  connectAuthEmulator,
  signInWithEmailAndPassword,
  inMemoryPersistence,
  initializeAuth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  disableNetwork,
  doc,
  getDocFromServer,
  enableNetwork,
  getFirestore,
} from 'firebase/firestore';
import {
  createItem,
  createProject,
  createWorkspace,
  paths,
  type ActionContext,
} from '../../packages/shared/src/index';
import { applyPlan } from '../../packages/shared/src/firestore';

const N = Number(process.env.N ?? 1000);
const app = initializeApp({ apiKey: 'fake-api-key', projectId: 'hive-board-43be' }, 'cs');
const auth = initializeAuth(app, { persistence: inMemoryPersistence });
connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
const db = getFirestore(app);
connectFirestoreEmulator(db, '127.0.0.1', 8080);

process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const req = createRequire(resolve('packages/notifier/package.json'));
const { initializeApp: initAdmin } = req('firebase-admin/app');
const { getAuth } = req('firebase-admin/auth');
const email = `cs-${Date.now()}@example.invalid`;
const password = 'pw-' + Math.random();
await getAuth(initAdmin({ projectId: 'hive-board-43be' }, 'adm')).createUser({
  email,
  password,
  emailVerified: true,
  displayName: 'Soak',
});
const cred = await signInWithEmailAndPassword(auth, email, password);
const ctx: ActionContext = {
  workspaceId: Math.random().toString(36).slice(2, 22),
  actor: { type: 'human', id: cred.user.uid, name: 'Soak' },
};
const steps = [{ id: 'build', name: 'Build', kind: 'agent', description: 'x' }] as never;
await applyPlan(db, createWorkspace(ctx, { name: 'soak' }));
const proj = createProject(ctx, {
  name: 'S',
  emoji: '🧪',
  color: '#2F5FD0',
  templateId: 'blank',
  steps,
  shapeNewItems: false,
});
await applyPlan(db, proj);
const project = { steps } as never;

const failures: { phase: string; i: number; code: string; landed: boolean; msg: string }[] = [];
let ok = 0;
async function create(phase: string, i: number) {
  const plan = createItem(ctx, {
    project,
    projectId: proj.projectId,
    title: `${phase}-${i}`,
    type: 'task',
  });
  try {
    await applyPlan(db, plan);
    ok++;
  } catch (e) {
    // Did the item land anyway (a replayed, already-committed batch)?
    const landed = (
      await getDocFromServer(doc(db, paths.item(ctx.workspaceId, proj.projectId, plan.itemId)))
    ).exists();
    failures.push({
      phase,
      i,
      code: (e as { code?: string }).code ?? '',
      landed,
      msg: (e as Error).message.slice(0, 80),
    });
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const q = Math.floor(N / 4);

for (let i = 0; i < q; i++) await create('plain', i);

let refreshing = true;
const refresher = (async () => {
  while (refreshing) {
    await auth.currentUser!.getIdToken(true).catch(() => {});
    await sleep(5);
  }
})();
for (let i = 0; i < q; i++) await create('refresh', i);
refreshing = false;
await refresher;

for (let i = 0; i < q; i += 5) {
  await disableNetwork(db);
  const p = Promise.all([0, 1, 2, 3, 4].map((k) => create('offline', i + k)));
  await sleep(20);
  await auth.currentUser!.getIdToken(true).catch(() => {});
  await enableNetwork(db);
  await p;
}
for (let i = 0; i < q; i += 10)
  await Promise.all(Array.from({ length: 10 }, (_, k) => create('concurrent', i + k)));

console.log(
  JSON.stringify({ N, ok, refused: failures.length, failures: failures.slice(0, 10) }, null, 1),
);
process.exit(failures.length ? 1 : 0);
