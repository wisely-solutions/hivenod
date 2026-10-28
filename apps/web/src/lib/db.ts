import {
  connectFirestoreEmulator,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
} from 'firebase/firestore';
import { app, FIRESTORE_EMULATOR_PORT, USE_EMULATOR } from './app';

// Firestore is the heaviest part of the app, so only the signed-in code imports this module.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
if (USE_EMULATOR) connectFirestoreEmulator(db, window.location.hostname, FIRESTORE_EMULATOR_PORT);
