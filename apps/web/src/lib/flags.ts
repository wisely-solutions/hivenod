/**
 * Build-time switches (card rxGgHFZs). Each is a constant, so a build without the feature drops
 * its code; none of them is read at run time.
 *
 * To flip one for production: change its constant to `true`, commit, merge, `pnpm release`.
 * (A build with `VITE_EMAIL_SIGNIN=1` or `VITE_GITHUB_LINKS=1` in its environment turns it on
 * too.) The emulator and e2e builds (`VITE_USE_EMULATOR=1`) always have email sign-in on.
 */

/** Email + password sign-up and sign-in. Keep false until Email/Password is enabled in Firebase
 *  and the noreply@hivenod.com sender and action URL are set up. */
const EMAIL_SIGNIN_PRODUCTION = true;

/** The GitHub links on the landing page, to the public repository (open since 2026-10-28). */
const GITHUB_LINKS_PRODUCTION = true;

export const EMAIL_SIGNIN =
  import.meta.env.VITE_USE_EMULATOR === '1' ||
  import.meta.env.VITE_EMAIL_SIGNIN === '1' ||
  EMAIL_SIGNIN_PRODUCTION;

export const GITHUB_LINKS = import.meta.env.VITE_GITHUB_LINKS === '1' || GITHUB_LINKS_PRODUCTION;

export const GITHUB_URL = 'https://github.com/wisely-solutions/hivenod';
export const PRIVACY_EMAIL = 'privacy@hivenod.com';
