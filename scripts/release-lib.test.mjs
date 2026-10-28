import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  previousTag,
  authHeaderProblems,
  MAIN_AUTH_URLS,
  mainAuthProblems,
  siteUrls,
  legacyRedirectProblems,
  authInitProblems,
  AUTH_INIT_URL,
  MAIN_URL,
  LEGACY_URL,
  ALIAS_URL,
  aliasRedirectProblems,
} from './release-lib.mjs';

describe('previousTag', () => {
  it('returns the release tag before the given one, by numeric order', () => {
    expect(previousTag(['release-9', 'release-10', 'release-2'], 'release-10')).toBe('release-9');
  });
  it('returns null when there is no earlier release', () => {
    expect(previousTag(['release-2'], 'release-2')).toBeNull();
  });
});

describe('hosting headers for Firebase Google sign-in', () => {
  const cfg = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
  const rule = cfg.hosting[0].headers.find((h) => h.source === '**');
  const map = Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
  it('firebase.json allows what sign-in needs', () => {
    expect(authHeaderProblems((k) => map[k])).toEqual([]);
  });
  it('keeps the rest strict', () => {
    const csp = map['content-security-policy'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });
  it('detects the old broken policy', () => {
    const old = { 'content-security-policy': "script-src 'self'; frame-src 'self' blob:" };
    expect(authHeaderProblems((k) => old[k]).length).toBeGreaterThan(3);
  });
});

import { pendingIndexes } from './release-lib.mjs';
describe('pendingIndexes', () => {
  it('lists indexes that are not READY', () => {
    const r = {
      indexes: [
        { name: 'p/x/indexes/a', state: 'READY', fields: [{ fieldPath: 'at' }] },
        {
          name: 'p/x/indexes/b',
          state: 'CREATING',
          queryScope: 'COLLECTION',
          fields: [{ fieldPath: 'at' }, { fieldPath: 'actor' }],
        },
      ],
    };
    expect(pendingIndexes(r)).toEqual(['b COLLECTION at,actor (CREATING)']);
    expect(pendingIndexes({})).toEqual([]);
  });
});

import { sortedReleaseTags, nextReleaseTag, existingTagFor } from './release-lib.mjs';

describe('release tag numbering', () => {
  it('sorts numerically: release-3 before release-30', () => {
    expect(sortedReleaseTags(['release-30', 'release-3', 'release-4', 'release-100', 'x'])).toEqual(
      ['release-3', 'release-4', 'release-30', 'release-100'],
    );
  });
  it('next is max + 1 even with a stray low tag and unsorted input', () => {
    expect(nextReleaseTag(['release-3', 'release-38', 'release-9', 'release-37'])).toBe(
      'release-39',
    );
  });
  it('starts at release-1; ignores junk, blanks and release-0', () => {
    expect(nextReleaseTag([])).toBe('release-1');
    expect(nextReleaseTag(['', 'release-', 'release-0', 'release-2x', 'foo'])).toBe('release-1');
  });
  it('reuses a tag already on the commit (idempotent), else null', () => {
    expect(existingTagFor(['release-31'])).toBe('release-31');
    expect(existingTagFor(['release-3', 'release-31'])).toBe('release-31');
    expect(existingTagFor([''])).toBeNull();
  });
});

describe('two hosting sites (card 9ZbSDmos)', () => {
  const real = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));

  it('knows the main and the old address from firebase.json', () => {
    expect(siteUrls(real)).toEqual({ main: MAIN_URL, legacy: LEGACY_URL });
    expect(siteUrls({ hosting: { public: 'x' } })).toEqual({ main: LEGACY_URL, legacy: null });
  });

  it('a self-hosted install has one site: its own project or public URL', () => {
    expect(siteUrls(real, { project: 'my-hive' })).toEqual({
      main: 'https://my-hive.web.app',
      legacy: null,
    });
    expect(siteUrls(real, { project: 'my-hive', publicUrl: 'https://board.example.org/' })).toEqual(
      {
        main: 'https://board.example.org',
        legacy: null,
      },
    );
    expect(siteUrls(real, { project: 'hive-board-43be' })).toEqual({
      main: MAIN_URL,
      legacy: LEGACY_URL,
    });
  });

  it('checks the old address answers 301 to the new one', () => {
    expect(legacyRedirectProblems({ status: 301, location: `${MAIN_URL}/agents` })).toEqual([]);
    expect(legacyRedirectProblems({ status: 200, location: '' }).length).toBe(2);
  });

  it('the old address redirects every page but keeps /cli/** (no redirect)', () => {
    const legacy = real.hosting.find((h) => h.target === 'legacy');
    const re = new RegExp(legacy.redirects[0].regex);
    for (const p of ['/', '/agents', '/assets/a.js', '/version.json', '/clients'])
      expect(re.test(p), p).toBe(true);
    for (const p of ['/cli/hivenod-latest.tgz', '/cli/hive-latest.tgz', '/cli/versions.json'])
      expect(re.test(p), p).toBe(false);
    // Firebase Auth's handler (/__/auth/handler, /__/firebase/init.json) is never redirected.
    for (const p of ['/__/firebase/init.json', '/__/auth/handler', '/__/auth/action', '/__/x'])
      expect(re.test(p), p).toBe(false);
    for (const p of ['/_next', '/_', '/__', '/__x/y', '/_a', '/c', '/cl', '/clients'])
      expect(re.test(p), p).toBe(true);
    expect(legacy.redirects[0].type).toBe(301);
    expect(legacy.redirects[0].destination).toBe(`${MAIN_URL}/:1`);
  });

  it('checks the hivenod.com Auth handler files answer 200', () => {
    expect(MAIN_AUTH_URLS).toEqual([
      'https://hivenod.com/__/auth/handler',
      'https://hivenod.com/__/firebase/init.json',
    ]);
    expect(mainAuthProblems(MAIN_AUTH_URLS.map((url) => ({ url, status: 200 })))).toEqual([]);
    expect(mainAuthProblems([{ url: MAIN_AUTH_URLS[0], status: 404 }])).toHaveLength(1);
  });

  it('checks the legacy Auth handler files answer 200', () => {
    expect(AUTH_INIT_URL).toBe('https://hive-board-43be.firebaseapp.com/__/firebase/init.json');
    expect(authInitProblems({ status: 200, location: '' })).toEqual([]);
    expect(
      authInitProblems({ status: 301, location: 'https://hivenod.com/__/firebase/init.json' }),
    ).toHaveLength(1);
  });

  it('the alias redirect script leaves /__/ alone', () => {
    const js = readFileSync(new URL('../apps/web/public/theme-init.js', import.meta.url), 'utf8');
    expect(js).toContain("location.pathname.indexOf('/__/') !== 0");
  });

  it('site targets map to the hivenod site and the old default site', () => {
    const rc = JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url), 'utf8'));
    expect(rc.targets['hive-board-43be'].hosting).toEqual({
      app: ['hivenod'],
      legacy: ['hive-board-43be'],
    });
    expect(real.hosting.map((h) => h.target)).toEqual(['app', 'legacy']);
  });

  it('main address is hivenod.com and the default-host redirect script is checked', () => {
    expect(MAIN_URL).toBe('https://hivenod.com');
    const js = readFileSync(new URL('../apps/web/public/theme-init.js', import.meta.url), 'utf8');
    expect(ALIAS_URL).toBe('https://hivenod.web.app');
    expect(aliasRedirectProblems(js)).toEqual([]);
    expect(aliasRedirectProblems('nothing').length).toBe(1);
  });
});
