import { REFUSED_COOLDOWN_S, SEND_COOLDOWN_S, isTooManyRequests, startCooldown } from './cooldown';
import {
  applyActionCode,
  confirmPasswordReset,
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  type AuthError,
} from 'firebase/auth';
import { auth, popupRedirectResolver } from '../lib/app';
export { isValidEmail, passwordProblem } from './password';
import { setAuthHint, setRedirectPending } from './hint';

/** Popup on desktop; redirect on phones, tablets and the installed iOS app (popups fail there). */
export function shouldRedirect(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  return window.matchMedia('(pointer: coarse)').matches && window.innerWidth < 1024;
}

/**
 * The JSON the Auth emulator takes as a Google ID token, from `localStorage['hive.e2e.signin']`
 * ({ email, name }). Only an emulator build looks at it (VITE_USE_EMULATOR is never set in
 * production, so the branch is removed from that build).
 */
function fakeGoogleIdToken(): string | null {
  if (import.meta.env.VITE_USE_EMULATOR !== '1') return null;
  try {
    const raw = localStorage.getItem('hive.e2e.signin');
    if (!raw) return null;
    const who = JSON.parse(raw) as { email: string; name: string };
    return JSON.stringify({
      sub: who.email,
      email: who.email,
      email_verified: true,
      display_name: who.name,
      name: who.name,
    });
  } catch {
    return null;
  }
}

export type SignInResult = 'started' | 'cancelled';

export async function signInWithGoogle(): Promise<SignInResult> {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const fake = fakeGoogleIdToken();
    if (fake) {
      // e2e only: the Auth emulator accepts a plain JSON "ID token", so a spec can sign in without
      // driving its fake Google page (the popup and redirect flows are still covered in auth.spec).
      await signInWithCredential(auth, GoogleAuthProvider.credential(fake));
      setAuthHint(true);
    } else if (shouldRedirect()) {
      // Set before leaving, so the signed-in code is loaded to finish the sign-in on return.
      setAuthHint(true);
      setRedirectPending(true);
      await signInWithRedirect(auth, provider, popupRedirectResolver);
    } else {
      await signInWithPopup(auth, provider, popupRedirectResolver);
      setAuthHint(true);
    }
    return 'started';
  } catch (e) {
    const code = (e as AuthError).code;
    setRedirectPending(false);
    setAuthHint(false);
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return 'cancelled';
    }
    throw e;
  }
}

/**
 * Where Firebase's own email page sends people after they confirm an address or change a password
 * (its "Continue" button). The template's action URL can't be changed for this project, so each
 * email carries this continue URL instead. Emulator builds stay on the local origin.
 */
export function emailContinueUrl(done: 'verified' | 'reset'): string {
  const origin =
    import.meta.env.VITE_USE_EMULATOR === '1' ? window.location.origin : 'https://hivenod.com';
  return `${origin}/auth/action?done=${done}`;
}

/** Creates a password account and sends the confirmation email. The account stays unconfirmed
 *  (one "Check your email" screen) until the link in that email is opened. */
export async function signUpWithEmail(email: string, password: string): Promise<void> {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  const sent = cred.user.email ?? email.trim();
  try {
    await sendEmailVerification(cred.user, { url: emailContinueUrl('verified') });
    startCooldown(sent, SEND_COOLDOWN_S);
  } catch (err) {
    if (isTooManyRequests(err)) startCooldown(sent, REFUSED_COOLDOWN_S);
    // otherwise Resend is on the next screen
  }
  // Only now: the hint swaps this page for the signed-in code, so a failed try keeps its form.
  setAuthHint(true);
}

export async function signInWithEmail(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(auth, email.trim(), password);
  setAuthHint(true);
}

/** Always looks successful to the caller for unknown addresses (email-enumeration protection). */
export async function sendReset(email: string): Promise<void> {
  await sendPasswordResetEmail(auth, email.trim(), { url: emailContinueUrl('reset') });
}

export async function resendVerification(): Promise<void> {
  const user = auth.currentUser;
  if (!user) return;
  try {
    await sendEmailVerification(user, { url: emailContinueUrl('verified') });
    startCooldown(user.email ?? '', SEND_COOLDOWN_S);
  } catch (err) {
    if (isTooManyRequests(err)) startCooldown(user.email ?? '', REFUSED_COOLDOWN_S);
    throw err;
  }
}

/** Opens the app's own page for the link in a verify or reset email (see ActionPage). */
export async function confirmEmailLink(code: string): Promise<void> {
  await applyActionCode(auth, code);
  // If this browser is signed in as that person, make the new state count at once.
  if (auth.currentUser) {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
  }
}

/** After the address was confirmed elsewhere: if someone is signed in here, pick that up. */
export async function refreshVerified(): Promise<void> {
  await auth.authStateReady();
  if (auth.currentUser) {
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
  }
}

export async function completeReset(code: string, password: string): Promise<void> {
  await confirmPasswordReset(auth, code, password);
}

export const INVALID_EMAIL = 'Enter a valid email address';

/** A short, plain message for a failed sign-in. */
export function signInMessage(e: unknown): string {
  switch ((e as AuthError | undefined)?.code) {
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your network and try again.';
    case 'auth/unauthorized-domain':
      return 'Sign-in is not enabled for this address yet.';
    case 'auth/operation-not-allowed':
    case 'auth/configuration-not-found':
      return 'This way of signing in is not switched on for Hivenod yet.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match. Try again, or choose Forgot password.';
    case 'auth/invalid-email':
      return INVALID_EMAIL;
    case 'auth/weak-password':
      return 'Choose a less guessable password (at least 8 characters).';
    case 'auth/too-many-requests':
      return 'Too many tries. Wait a minute and try again.';
    case 'auth/expired-action-code':
    case 'auth/invalid-action-code':
      return 'This link has expired or was already used. Request a new one.';
    default:
      return 'Sign-in did not work. Try again.';
  }
}
