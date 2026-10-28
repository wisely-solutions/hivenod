import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  browserSessionPersistence,
  connectAuthEmulator,
  indexedDBLocalPersistence,
  initializeAuth,
} from 'firebase/auth';
import { authDomainFor } from './auth-domain';

// Public web config (not a secret: a Firebase web apiKey only identifies the project; security is
// enforced by firestore.rules). The defaults are the hosted service at https://hivenod.com. To run
// your own, build with VITE_FIREBASE_* set to your project's web app config (docs/SELF-HOST.md).
const env = import.meta.env;
const config = {
  apiKey: env.VITE_FIREBASE_API_KEY || 'AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4',
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || 'hivenod.com',
  projectId: env.VITE_FIREBASE_PROJECT_ID || 'hive-board-43be',
  appId: env.VITE_FIREBASE_APP_ID || '1:493986079810:web:71cf28f12f79f3cf9bf9db',
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || '493986079810',
};

/** Build with VITE_USE_EMULATOR=1 to talk to the local Auth and Firestore emulators. */
export const USE_EMULATOR = import.meta.env.VITE_USE_EMULATOR === '1';
/** Emulator ports; the defaults match firebase.json. */
export const AUTH_EMULATOR_PORT = Number(import.meta.env.VITE_AUTH_EMULATOR_PORT ?? 9099);
export const FIRESTORE_EMULATOR_PORT = Number(import.meta.env.VITE_FIRESTORE_EMULATOR_PORT ?? 8080);

const authDomain = (): string => authDomainFor(window.location.host, config.authDomain);

export const app = initializeApp({ ...config, authDomain: authDomain() });

/**
 * Auth starts WITHOUT the popup/redirect resolver. With it (what getAuth() does) phones load
 * Google's sign-in iframe before the first auth state, about a second on a slow network, even
 * for someone who is already signed in (card CGPynEQY). Sign-in and redirect completion pass
 * `popupRedirectResolver` themselves, when they need it.
 */
export const auth = initializeAuth(app, {
  persistence: [indexedDBLocalPersistence, browserLocalPersistence, browserSessionPersistence],
});
export const popupRedirectResolver = browserPopupRedirectResolver;
if (USE_EMULATOR) {
  connectAuthEmulator(auth, `http://${window.location.hostname}:${AUTH_EMULATOR_PORT}`, {
    disableWarnings: true,
  });
}
