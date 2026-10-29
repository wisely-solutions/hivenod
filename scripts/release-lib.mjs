// Pure helpers for the release workflow (tested in release-lib.test.mjs).

const num = (t) => Number(t.replace('release-', ''));
const isReleaseTag = (t) => /^release-[1-9]\d*$/.test(t);

/** Release tags (release-<n>, n >= 1) sorted by their number, so release-3 sorts before release-30. */
export function sortedReleaseTags(tags) {
  return tags
    .map((t) => t.trim())
    .filter(isReleaseTag)
    .sort((a, b) => num(a) - num(b));
}

/** The next tag name: highest existing number + 1 (stray low tags like release-3 are ignored). */
export function nextReleaseTag(tags) {
  const sorted = sortedReleaseTags(tags);
  return `release-${sorted.length ? num(sorted.at(-1)) + 1 : 1}`;
}

/** If the commit already carries a release tag, reuse it (idempotent re-run); else null. */
export function existingTagFor(tagsAtCommit) {
  const sorted = sortedReleaseTags(tagsAtCommit);
  return sorted.length ? sorted.at(-1) : null;
}

export function previousTag(tags, current) {
  const earlier = tags.filter((t) => /^release-\d+$/.test(t) && num(t) < num(current));
  if (earlier.length === 0) return null;
  return earlier.sort((a, b) => num(b) - num(a))[0];
}

/** What Firebase Google sign-in needs from the response headers. Returns a list of problems (empty = ok). */
export function authHeaderProblems(get, authOrigin = 'https://hivenod.com') {
  const csp = get('content-security-policy') || '';
  const dir = (name) =>
    (csp.split(';').find((d) => d.trim().startsWith(name + ' ')) || '').split(/\s+/);
  const need = [
    ['script-src', 'https://apis.google.com'],
    ['frame-src', authOrigin],
    ['frame-src', 'https://accounts.google.com'],
    ['img-src', 'https://lh3.googleusercontent.com'],
    ['img-src', 'https://www.google.com'],
    ['connect-src', 'https://*.googleapis.com'],
  ];
  const problems = need
    .filter(([d, v]) => !dir(d).includes(v))
    .map(([d, v]) => `CSP ${d} lacks ${v}`);
  if (
    dir('script-src').includes("'unsafe-inline'") ||
    dir('script-src').includes("'unsafe-eval'")
  ) {
    problems.push('CSP script-src must stay strict');
  }
  if (get('cross-origin-opener-policy') !== 'same-origin-allow-popups') {
    problems.push('Cross-Origin-Opener-Policy must be same-origin-allow-popups');
  }
  return problems;
}

/** Composite indexes from the Firestore admin API that are not READY yet (empty = all ready). */
export function pendingIndexes(apiResponse) {
  return (apiResponse?.indexes ?? [])
    .filter((i) => i.state && i.state !== 'READY')
    .map((i) => {
      const fields = (i.fields ?? []).map((f) => f.fieldPath).join(',');
      return `${
        String(i.name ?? '')
          .split('/')
          .slice(-1)[0]
      } ${i.queryScope ?? ''} ${fields} (${i.state})`.trim();
    });
}

export const MAIN_URL = 'https://hivenod.com';
/** Same Hosting site as MAIN_URL; its pages redirect in the browser (theme-init.js), data and /cli stay served. */
export const ALIAS_URL = 'https://hivenod.web.app';
export const LEGACY_URL = 'https://hive-board-43be.web.app';

/**
 * Which live addresses a build serves, from its firebase.json. Since card 9ZbSDmos (Hivenod phase 2)
 * hosting is an array: target `app` (site hivenod, the main address) and target `legacy` (the old
 * address: 301 to the main one, except /cli/**). Older commits (rollbacks) have one site, the old address.
 */
export function siteUrls(firebaseJson, { publicUrl, project } = {}) {
  const two = Array.isArray(firebaseJson?.hosting) && firebaseJson.hosting.length > 1;
  // A self-hosted install (HIVENOD_PUBLIC_URL or a different project) has one site and no old address.
  if (publicUrl) return { main: publicUrl.replace(/\/$/, ''), legacy: null };
  if (project && project !== 'hive-board-43be')
    return { main: `https://${project}.web.app`, legacy: null };
  return two ? { main: MAIN_URL, legacy: LEGACY_URL } : { main: LEGACY_URL, legacy: null };
}

/** The old address must 301 to the main one (path kept) for a normal page; empty list = ok. */
export function legacyRedirectProblems({ status, location }, main = MAIN_URL, path = '/agents') {
  const problems = [];
  if (status !== 301) problems.push(`old address answered ${status}, want 301`);
  if (location !== `${main}${path}`)
    problems.push(`old address redirects to ${location}, want ${main}${path}`);
  return problems;
}

/** The old site also serves hive-board-43be.firebaseapp.com: Firebase Auth's handler files under
 *  /__/ (init.json, auth/handler) must answer 200 there, never a 301 to hivenod.com. */
export const AUTH_INIT_URL = 'https://hive-board-43be.firebaseapp.com/__/firebase/init.json';

/** hivenod.com is the Firebase authDomain: its handler and init.json must answer 200 too (card vyH5uux3). */
export const MAIN_AUTH_URLS = [
  'https://hivenod.com/__/auth/handler',
  'https://hivenod.com/__/firebase/init.json',
];

export function mainAuthProblems(results) {
  return results
    .filter((r) => r.status !== 200)
    .map((r) => `${r.url} answered ${r.status}${r.location ? ` -> ${r.location}` : ''}, want 200`);
}

export function authInitProblems({ status, location }) {
  return status === 200
    ? []
    : [`${AUTH_INIT_URL} answered ${status}${location ? ` -> ${location}` : ''}, want 200`];
}

/**
 * The default Hosting address (ALIAS_URL) is the same site as hivenod.com, so it cannot 301 by host; its
 * pages send people to hivenod.com from theme-init.js. The smoke test checks that script is live there.
 */
export function aliasRedirectProblems(themeInitJs, main = MAIN_URL) {
  return themeInitJs.includes(`location.replace('${main}'`)
    ? []
    : [`${ALIAS_URL}/theme-init.js has no redirect to ${main}`];
}

/** Numeric dotted compare: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Problems when a release would publish a CLI version lower than the live one (equal is fine). */
export function versionRegressions(next, live) {
  const problems = [];
  for (const key of ['cliBin', 'cli']) {
    if (live?.[key] && next?.[key] && compareVersions(next[key], live[key]) < 0) {
      problems.push(`${key} ${next[key]} is lower than the live ${live[key]}`);
    }
  }
  return problems;
}

/**
 * The live /.well-known/hivenod.json (item 07W4gCboOicS0lM1bqwZ): JSON, a Hivenod discovery file,
 * naming the project that was deployed. [] when it is right.
 */
export function discoveryProblems(status, contentType, body, project) {
  if (status !== 200) return [`/.well-known/hivenod.json answered ${status}`];
  const bad = [];
  if (!/application\/json/.test(contentType ?? ''))
    bad.push(`/.well-known/hivenod.json is ${contentType}`);
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return [...bad, '/.well-known/hivenod.json is not JSON'];
  }
  if (doc?.service !== 'hivenod' || typeof doc?.protocol !== 'number')
    bad.push('/.well-known/hivenod.json is not a Hivenod discovery file');
  else if (doc.firebase?.projectId !== project)
    bad.push(`/.well-known/hivenod.json names ${doc.firebase?.projectId}, not ${project}`);
  return bad;
}

/**
 * Should `firebase deploy` be retried once? Only for an HTTP 503 from the Firestore rules API
 * (firebaserules.googleapis.com): nothing is deployed when that fails. Any other error stops.
 * @param {string} output combined stdout/stderr of the failed deploy
 */
export function isRulesApi503(output) {
  const text = String(output ?? '');
  return /firebaserules\.googleapis\.com/.test(text) && /\b503\b/.test(text);
}
