#!/usr/bin/env node
// Usage:
//   node scripts/deploy.mjs preview <name>   build + deploy a preview channel (7-14 day test link)
//   node scripts/deploy.mjs prod             build + deploy the current commit to production
//   node scripts/deploy.mjs release          the agent's production release from the VM (see docs/DEPLOY.md):
//                                            clean tree at origin/main -> build -> deploy -> smoke test
//                                            (live /version.json must show this commit) -> tag release-<n>
//   node scripts/deploy.mjs rollback         redeploy the release tag before the latest one, then smoke test
// Uses the service account in GOOGLE_APPLICATION_CREDENTIALS (or ~/.agent/secrets/gcp.env if present).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import {
  authHeaderProblems,
  discoveryProblems,
  existingTagFor,
  legacyRedirectProblems,
  authInitProblems,
  AUTH_INIT_URL,
  MAIN_AUTH_URLS,
  mainAuthProblems,
  aliasRedirectProblems,
  ALIAS_URL,
  nextReleaseTag,
  pendingIndexes,
  siteUrls,
  sortedReleaseTags,
  versionRegressions,
} from './release-lib.mjs';
import { cliBinProblems } from './cli-bin-smoke.mjs';
import { sweepPairings } from './pairing-sweep-lib.mjs';
import { fetchStars, starsJson } from './stars-lib.mjs';

const [mode, name] = process.argv.slice(2);
// Self-hosting: HIVENOD_FIREBASE_PROJECT is your Firebase project id (docs/SELF-HOST.md).
const project = process.env.HIVENOD_FIREBASE_PROJECT || 'hive-board-43be';
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// The main address (and the legacy one, when this commit has two hosting sites): see siteUrls().
const urlsFor = (cwd = process.cwd()) =>
  siteUrls(readJson(join(cwd, 'firebase.json')), {
    publicUrl: process.env.HIVENOD_PUBLIC_URL,
    project,
  });

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const envFile = join(homedir(), '.agent/secrets/gcp.env');
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(?:export )?GOOGLE_APPLICATION_CREDENTIALS=(.*)$/);
      if (m) process.env.GOOGLE_APPLICATION_CREDENTIALS = m[1].replace(/^["']|["']$/g, '');
    }
  }
}

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { stdio: 'inherit', env: process.env, cwd });
const out = (cmd, args, cwd) => execFileSync(cmd, args, { encoding: 'utf8', cwd }).trim();
const fb = (args, cwd) =>
  run('pnpm', ['exec', 'firebase', ...args, '--project', project, '--non-interactive'], cwd);
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** The CLI protocol of the commit in `cwd` (older commits have none). */
function cliProtocolOf(cwd) {
  const f = join(cwd, 'packages/shared/src/protocol.ts');
  if (!existsSync(f)) return {};
  const m = /export const CLI_PROTOCOL = (\d+);/.exec(readFileSync(f, 'utf8'));
  return m ? { cliProtocol: Number(m[1]) } : {};
}

/** Build, stamp dist/version.json with the commit, deploy hosting + firestore rules/indexes. */
async function deployProd(cwd = process.cwd(), { guardVersions = false } = {}) {
  const commit = out('git', ['rev-parse', 'HEAD'], cwd);
  run('pnpm', ['build'], cwd);
  // The npm tarball of the TypeScript CLI (card rifzGl8M) is no longer built (item
  // MlWOc3O5NyfZcLgetrVo): the Go CLI below is the only agent client.
  const { main: prodUrl } = urlsFor(cwd);
  // The Go CLI (item zLwtX2WEEg3mER4CR74g): five binaries + checksums + /cli/bin/latest.json, and
  // /install.sh, /install.ps1. Older commits (rollbacks) have no build script.
  let cliBin;
  if (existsSync(join(cwd, 'scripts/build-cli-bin.mjs'))) {
    const built = execFileSync(
      'node',
      [
        'scripts/build-cli-bin.mjs',
        commit,
        'apps/web/dist',
        String(cliProtocolOf(cwd).cliProtocol ?? ''),
      ],
      { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] },
    );
    process.stdout.write(built);
    cliBin = built.trim().split('\n').at(-1);
  }
  if (guardVersions) {
    // Installed CLIs only update to a higher version: never publish a lower one than the live one.
    let live = null;
    try {
      const res = await fetch(`${prodUrl}/version.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) live = await res.json();
    } catch {
      /* offline or first deploy: nothing to compare with */
    }
    const bad = versionRegressions({ cliBin }, live);
    if (bad.length)
      die(`Refusing to release: ${bad.join('; ')} (installed CLIs would not update).`);
  }
  writeFileSync(
    join(cwd, 'apps/web/dist/version.json'),
    JSON.stringify({
      commit,
      ...(cliBin ? { cliBin } : {}),
      // What the CLI must understand (card st5INNZj): hivenod run asks to update when it is older.
      ...cliProtocolOf(cwd),
      deployedAt: new Date().toISOString(),
    }) + '\n',
  );
  // The landing page's GitHub star count (item g17GWUkfKRFh4mgn0ciQ): asked once here, so visitors
  // never call GitHub. null on any failure; the page then shows no count.
  const stars = await fetchStars({ token: process.env.GH_TOKEN_WISELY || process.env.GH_TOKEN });
  writeFileSync(join(cwd, 'apps/web/dist/stars.json'), starsJson(stars));
  console.log(`GitHub stars: ${stars ?? 'unknown (the page shows no count)'}`);
  fb(['deploy', '--only', 'hosting,firestore', '--message', `commit ${commit.slice(0, 7)}`], cwd);
  return commit;
}

/**
 * The live site must serve this commit's /version.json and the app's index page, and every CLI
 * tarball the build in `cwd` made (only older commits, on rollback, make npm tarballs; since item
 * MlWOc3O5NyfZcLgetrVo a release ships the Go binaries only).
 */
async function smoke(commit, checkAuthHeaders = true, cwd = process.cwd()) {
  const { main: prodUrl, legacy } = urlsFor(cwd);
  const tarballs = ['hivenod-latest.tgz', 'hive-latest.tgz'].filter((n) =>
    existsSync(join(cwd, 'apps/web/dist/cli', n)),
  );
  for (let i = 0; i < 10; i++) {
    try {
      const v = await (
        await fetch(`${prodUrl}/version.json?t=${Date.now()}`, { cache: 'no-store' })
      ).json();
      const html = await (await fetch(`${prodUrl}/?t=${Date.now()}`, { cache: 'no-store' })).text();
      const head = await fetch(`${prodUrl}/?t=${Date.now()}`, { cache: 'no-store' });
      const problems = authHeaderProblems(
        (k) => head.headers.get(k),
        legacy ? 'https://hivenod.com' : `https://${project}.firebaseapp.com`,
      );
      if (checkAuthHeaders && v.commit === commit && problems.length > 0) {
        console.log(`Smoke test: auth headers wrong: ${problems.join('; ')}`);
        return false;
      }
      // A release that ships the CLI: hivenod-latest.tgz must be served, and the old
      // hive-latest.tgz too (the small `hive` stub with the migration message, card wQ7ZfmYr).
      if (v.commit === commit && v.cli && tarballs.length) {
        const tarball = async (name, min) => {
          const res = await fetch(`${prodUrl}/cli/${name}?t=${Date.now()}`, { cache: 'no-store' });
          const bytes = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
          const ok = bytes.length >= min && bytes[0] === 0x1f && bytes[1] === 0x8b;
          if (!ok)
            console.log(`Smoke test: ${prodUrl}/cli/${name} is not a tarball (${res.status})`);
          return ok ? bytes.length : 0;
        };
        const sizes = [];
        for (const n of tarballs)
          sizes.push(await tarball(n, n === 'hive-latest.tgz' ? 100 : 1000));
        if (sizes.includes(0)) return false;
        console.log(
          `Smoke test: CLI ${v.cli} served (${tarballs.join(', ')}: ${sizes.join(', ')} bytes)`,
        );
      }
      // The discovery file (item 07W4gCboOicS0lM1bqwZ): CLIs pointed at this site read their config
      // from it. Older commits (rollbacks) have none.
      if (v.commit === commit && existsSync(join(cwd, 'apps/web/dist/well-known/hivenod.json'))) {
        const r = await fetch(`${prodUrl}/.well-known/hivenod.json?t=${Date.now()}`, {
          cache: 'no-store',
        });
        const bad = discoveryProblems(
          r.status,
          r.headers.get('content-type'),
          await r.text().catch(() => ''),
          project,
        );
        if (bad.length) {
          console.log(`Smoke test: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(`Smoke test: ${prodUrl}/.well-known/hivenod.json served`);
      }
      // Two sites: the old address must 301 pages to the new one, but still serve the CLI tarballs
      // (existing installs and the `hive` stub live there), with no redirect.
      if (v.commit === commit && legacy) {
        const old = await fetch(`${legacy}/agents?t=${Date.now()}`, {
          redirect: 'manual',
          cache: 'no-store',
        });
        const loc = (old.headers.get('location') ?? '').replace(/\?t=\d+$/, '');
        const bad = legacyRedirectProblems({ status: old.status, location: loc }, prodUrl);
        for (const n of tarballs) {
          const t = await fetch(`${legacy}/cli/${n}?t=${Date.now()}`, {
            redirect: 'manual',
            cache: 'no-store',
          });
          const b = t.status === 200 ? Buffer.from(await t.arrayBuffer()) : Buffer.alloc(0);
          if (!(b.length > 100 && b[0] === 0x1f && b[1] === 0x8b))
            bad.push(`${legacy}/cli/${n} not served as a tarball (${t.status})`);
        }
        if (bad.length) {
          console.log(`Smoke test: old address wrong: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(`Smoke test: ${legacy} redirects to ${prodUrl}, CLI tarballs served there`);
      }
      // Firebase Auth's handler files on the legacy host (firebaseapp.com) must not be redirected.
      if (v.commit === commit && legacy) {
        const init = await fetch(`${AUTH_INIT_URL}?t=${Date.now()}`, {
          redirect: 'manual',
          cache: 'no-store',
        });
        const bad = authInitProblems({
          status: init.status,
          location: init.headers.get('location') ?? '',
        });
        if (bad.length) {
          console.log(`Smoke test: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(`Smoke test: ${AUTH_INIT_URL} served (200)`);
      }
      // hivenod.com is the Firebase authDomain: its handler files must answer 200 (card vyH5uux3).
      if (v.commit === commit && legacy) {
        const results = [];
        for (const url of MAIN_AUTH_URLS) {
          const r = await fetch(`${url}?t=${Date.now()}`, {
            redirect: 'manual',
            cache: 'no-store',
          });
          results.push({ url, status: r.status, location: r.headers.get('location') ?? '' });
        }
        const bad = mainAuthProblems(results);
        if (bad.length) {
          console.log(`Smoke test: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(`Smoke test: ${MAIN_AUTH_URLS.join(', ')} served (200)`);
      }
      // The default Hosting address is the same site as the main one: its pages redirect in the browser.
      if (v.commit === commit && legacy) {
        const js = await (
          await fetch(`${ALIAS_URL}/theme-init.js?t=${Date.now()}`, { cache: 'no-store' })
        ).text();
        const bad = aliasRedirectProblems(js, prodUrl);
        if (bad.length) {
          console.log(`Smoke test: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(`Smoke test: ${ALIAS_URL} sends pages to ${prodUrl}`);
      }
      // The Go CLI this build made must be what is served, and the linux-x64 binary must run.
      const binManifest = join(cwd, 'apps/web/dist/cli/bin/latest.json');
      if (v.commit === commit && existsSync(binManifest)) {
        const bad = await cliBinProblems(prodUrl, readJson(binManifest));
        if (bad.length) {
          console.log(`Smoke test: CLI binaries: ${bad.join('; ')}; retrying`);
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        console.log(
          `Smoke test: CLI ${v.cliBin} binaries served with matching checksums; linux-x64 runs (version, mcp, pair)`,
        );
      }
      if (v.commit === commit && html.includes('<div id="root">')) {
        console.log(`Smoke test OK: ${prodUrl} serves ${commit.slice(0, 7)}`);
        return true;
      }
      console.log(
        `Smoke test: live commit ${String(v.commit).slice(0, 7)}, want ${commit.slice(0, 7)}; retrying`,
      );
    } catch (e) {
      console.log(`Smoke test: ${e.message}; retrying`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

/** OAuth token for the service account (signed JWT, no extra dependencies). */
async function accessToken() {
  const key = JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3000,
  })}`;
  const sig = createSign('RSA-SHA256').update(head).sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${head}.${sig}`,
    }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  return (await res.json()).access_token;
}

/**
 * New composite indexes build for minutes after the deploy, and queries that need them fail
 * meanwhile. Wait until every index is READY (timeout 15 min) so nobody tests a half-built release.
 * Never fails the release: on timeout or an API problem it says so loudly and carries on.
 */
async function waitForIndexes(timeoutMs = 15 * 60 * 1000) {
  const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/collectionGroups/-/indexes`;
  const deadline = Date.now() + timeoutMs;
  let lastLog = '';
  for (;;) {
    let pending;
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` } });
      if (!res.ok) throw new Error(`index list failed: ${res.status}`);
      pending = pendingIndexes(await res.json());
    } catch (e) {
      console.warn(
        `WARNING: could not check Firestore index state (${e.message}); verify them by hand before testing.`,
      );
      return false;
    }
    if (pending.length === 0) {
      console.log('Firestore indexes: all READY');
      return true;
    }
    const msg = `Firestore indexes still building (${pending.length}): ${pending.join('; ')}`;
    if (msg !== lastLog) console.log(msg);
    lastLog = msg;
    if (Date.now() > deadline) {
      console.warn(
        `WARNING: indexes not READY after ${timeoutMs / 60000} min. Do NOT send a TEST REQUEST yet; Activity may show "still preparing".`,
      );
      return false;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
}

const releaseTags = () => sortedReleaseTags(out('git', ['tag', '-l', 'release-*']).split('\n'));

/**
 * Tag the released commit and push the tag. Idempotent: a commit that already has a release tag
 * keeps it (only the push is retried); a name that is taken by another commit (local or remote,
 * e.g. a hand-made tag) makes us take the next free number instead of failing with exit 128.
 * Existing tags are never moved or deleted.
 */
function tagRelease(commit) {
  const git = (args) => {
    try {
      return { ok: true, text: execFileSync('git', args, { encoding: 'utf8' }).trim() };
    } catch (e) {
      return { ok: false, text: `${e.stderr || ''}${e.message}` };
    }
  };
  git(['fetch', '--tags', 'origin']);
  let tag = existingTagFor(git(['tag', '--points-at', commit, '-l', 'release-*']).text.split('\n'));
  for (let attempt = 0; attempt < 5; attempt++) {
    if (!tag) {
      tag = nextReleaseTag(releaseTags());
      const r = git(['tag', tag, commit]);
      if (!r.ok) {
        console.warn(`git tag ${tag} failed (${r.text.split('\n')[0]}); retrying`);
        git(['fetch', '--tags', 'origin']);
        tag = null;
        continue;
      }
    }
    const push = git(['push', 'origin', `refs/tags/${tag}`]);
    if (push.ok) return tag;
    console.warn(`git push ${tag} failed (${push.text.split('\n')[0]}); retrying`);
    git(['fetch', '--tags', 'origin']);
    // Remote has this name on another commit: drop OUR new local tag (never an old one) and renumber.
    const remote = git(['ls-remote', 'origin', `refs/tags/${tag}^{}`, `refs/tags/${tag}`]).text;
    if (
      remote &&
      !remote.includes(commit) &&
      git(['rev-parse', `${tag}^{commit}`]).text === commit
    ) {
      git(['tag', '-d', tag]);
      tag = null;
    }
  }
  die(
    `Deployed ${commit.slice(0, 7)} but could not tag it; tag it by hand (next free release-<n>).`,
  );
}

/** Deploy an older commit from a throwaway worktree, so the working tree is never touched. */
async function deployRef(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'hive-deploy-'));
  try {
    run('git', ['worktree', 'add', '--detach', dir, ref]);
    run('pnpm', ['install', '--frozen-lockfile'], dir);
    const commit = await deployProd(dir);
    if (!(await smoke(commit, false, dir))) die(`Smoke test FAILED after deploying ${ref}`);
    return commit;
  } finally {
    run('git', ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
}

if (mode === 'preview') {
  if (!name || !/^[a-z0-9-]{1,40}$/.test(name)) {
    die('Usage: pnpm deploy:preview <name>  (lowercase letters, digits, dashes)');
  }
  run('pnpm', ['build']);
  fb(['hosting:channel:deploy', name, '--expires', '14d']);
  console.log('Preview channel on every hosting site; the app is on the site `hivenod`.');
} else if (mode === 'prod') {
  await deployProd(undefined, { guardVersions: true });
} else if (mode === 'release') {
  run('git', ['fetch', '--tags', 'origin', 'main']);
  if (out('git', ['status', '--porcelain']))
    die('Refusing to release: the working tree has changes.');
  const head = out('git', ['rev-parse', 'HEAD']);
  if (head !== out('git', ['rev-parse', 'origin/main'])) {
    die(
      'Refusing to release: HEAD is not origin/main. Merge to main first, then release from main.',
    );
  }
  const tags = releaseTags();
  const previous = tags.at(-1);
  const commit = await deployProd(undefined, { guardVersions: true });
  if (!(await smoke(commit))) {
    if (previous) {
      console.error(`Smoke test FAILED; rolling back to ${previous}`);
      await deployRef(previous);
    }
    die('Release FAILED (production rolled back to the previous release if there was one).');
  }
  await waitForIndexes();
  const tag = tagRelease(commit);
  // Expired terminal-pairing docs that a killed terminal left behind (card PXOzcYeG). Best effort:
  // a failed sweep never fails a release that is already live.
  try {
    const r = await sweepPairings({ project, token: await accessToken() });
    console.log(`Pairing sweep: deleted ${r.deleted} of ${r.found} expired pairing docs.`);
  } catch (e) {
    console.warn(`Pairing sweep skipped: ${e.message}`);
  }
  const prodUrl = urlsFor().main;
  console.log(
    `Released ${commit.slice(0, 7)} as ${tag}: ${prodUrl} (check ${prodUrl}/version.json)`,
  );
} else if (mode === 'rollback') {
  run('git', ['fetch', '--tags', 'origin']);
  const tags = releaseTags();
  if (tags.length < 2) die('No previous release to roll back to.');
  const target = tags.at(-2);
  const commit = await deployRef(target);
  console.log(
    `Rolled back production to ${target} (${commit.slice(0, 7)}). Fix forward on main, then release again.`,
  );
} else {
  die('Usage: node scripts/deploy.mjs preview <name> | prod | release | rollback');
}
