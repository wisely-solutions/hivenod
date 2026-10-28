// Card HHyedSAg: only https://hivenod.com is ever given to people. No *.web.app or *.firebaseapp.com
// in user-facing code, defaults, docs or the release script, except the places listed in ALLOW.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const BAD = /[a-z0-9-]+\.(web\.app|firebaseapp\.com)\b/i;

/** file -> line substrings allowed to name those hosts, with the reason. */
const ALLOW = {
  // Firebase's own sign-in handler (technical, not shown as a link; the popup briefly shows it).
  'apps/web/src/lib/app.ts': ['authDomain'],
  'packages/agent/src/client.ts': ['authDomain'],
  'firebase.json': ['frame-src'], // CSP for the sign-in iframe
  'scripts/release-lib.mjs': [
    'frame-src',
    'ALIAS_URL',
    'LEGACY_URL',
    'old address',
    'authOrigin = ',
    'MAIN_AUTH_URLS',
    'AUTH_INIT_URL = ',
    'old site also serves',
  ], // CSP check + old hosts the smoke test follows
  // Redirect code and its docs/tests: these name the old hosts on purpose.
  'apps/web/public/theme-init.js': ['web\\.app', 'also answers on'],
  'apps/web/public/host-sw.js': ['web.app', 'web\\.app'],
  'apps/web/src/lib/host-sw.test.ts': ['web.app'],
  // authDomain choice per host: the tests name the hosts it must handle.
  'apps/web/src/lib/auth-domain.test.ts': ['web.app', 'firebaseapp.com'],
  'docs/DEPLOY.md': ['firebaseapp', 'web.app', 'hive-board-43be'],
  'docs/SPEC.md': ['web.app'],
  // Self-hosting: the sign-in handler of the self-hoster's own project, in setup instructions.
  'docs/SELF-HOST.md': ['firebaseapp.com'],
  // pnpm selfhost:init's tests: the default addresses of the self-hoster's own example project
  // (my-hivenod), never the hosted service (item 07W4gCboOicS0lM1bqwZ).
  'scripts/selfhost-lib.test.mjs': ['my-hivenod.web.app', 'my-hivenod.firebaseapp.com'],
  'scripts/release-lib.test.mjs': ['web.app', 'firebaseapp.com/__/'],
  'scripts/web-urls.test.mjs': [''], // this file
};

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(
    (f) =>
      f &&
      !/(^|\/)(pnpm-lock\.yaml|node_modules)\//.test(f) &&
      !/\.(png|jpg|ico|woff2?|tgz)$/.test(f),
  );

describe('only hivenod.com', () => {
  it('no *.web.app / *.firebaseapp.com outside the allow-list', () => {
    const found = [];
    for (const f of files) {
      let text;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue;
      }
      text.split('\n').forEach((line, i) => {
        if (!BAD.test(line)) return;
        if ((ALLOW[f] ?? []).some((a) => a === '' || line.includes(a))) return;
        found.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    expect(found).toEqual([]);
  });
});
