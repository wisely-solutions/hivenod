/**
 * Firebase Hosting serves the auth handler on every one of its domains. Using the current host as
 * the auth domain keeps the redirect flow same-origin, which browsers that block third-party
 * storage (Safari, iOS standalone) need. On hivenod.com that is hivenod.com itself, so Google's
 * popup says "continue to hivenod.com"; on Hosting preview hosts it is the preview host; anywhere
 * else (emulator, self-host) it is the configured domain.
 */
export function authDomainFor(host: string, configured: string): string {
  return /(^|\.)(web\.app|firebaseapp\.com)$/.test(host) || host === 'hivenod.com'
    ? host
    : configured;
}
