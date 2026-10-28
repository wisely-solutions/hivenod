// pnpm selfhost:init (item 07W4gCboOicS0lM1bqwZ): the steps run against fake firebase/build/network
// answers, so nothing here calls Google. The real-project run is a manual check (docs/SELF-HOST.md).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIREBASE_CONFIG_FILE,
  firebaseArgs,
  mergeSettings,
  nextSteps,
  parseArgs,
  planLines,
  runInit,
  selfhostFirebaseConfig,
  SETTINGS_FILE,
  settingsProblems,
  siteUrlFor,
  viteEnv,
} from './selfhost-lib.mjs';

const root = join(import.meta.dirname, '..');
const repoConfig = JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'));
const S = { project: 'my-hivenod', location: 'eur3', supportEmail: 'me@example.org' };

describe('parseArgs and settings', () => {
  it('reads the flags', () => {
    expect(
      parseArgs([
        '--project',
        'my-hivenod',
        '--location=nam5',
        '--support-email',
        'me@example.org',
        '--domain',
        'board.example.org',
        '-y',
        '--dry-run',
        '--skip-build',
      ]),
    ).toEqual({
      project: 'my-hivenod',
      location: 'nam5',
      supportEmail: 'me@example.org',
      domain: 'board.example.org',
      yes: true,
      dryRun: true,
      skipBuild: true,
      help: false,
    });
    expect(() => parseArgs(['--project'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--frob'])).toThrow(/unknown option/);
  });
  it('plain problems for unusable values', () => {
    expect(settingsProblems(S)).toEqual([]);
    expect(settingsProblems({ ...S, project: 'X' }).join()).toMatch(/not a Firebase project id/);
    expect(settingsProblems({ ...S, project: 'hive-board-43be' }).join()).toMatch(/hosted service/);
    expect(settingsProblems({ ...S, supportEmail: undefined }).join()).toMatch(/support email/);
    expect(settingsProblems({ ...S, domain: 'not a domain' }).join()).toMatch(/not a domain/);
    expect(settingsProblems({ ...S, domain: 'https://hivenod.com/' }).join()).toMatch(/hosted/);
    expect(settingsProblems({}).join()).toMatch(/project id is needed/);
  });
  it('flags win over saved settings; a saved site only counts for its own project', () => {
    const saved = { ...S, site: 'https://x', appId: 'a1', firebase: { apiKey: 'k' } };
    expect(mergeSettings({ domain: 'HTTPS://Board.Example.org/' }, saved)).toEqual({
      ...saved,
      domain: 'board.example.org',
    });
    expect(mergeSettings({ project: 'other-project' }, saved)).toEqual({
      project: 'other-project',
      location: 'eur3',
      supportEmail: 'me@example.org',
      domain: undefined,
    });
    expect(mergeSettings({}).location).toBe('eur3');
  });
});

describe('the deploy config for your project', () => {
  const cfg = selfhostFirebaseConfig(repoConfig, { ...S, domain: 'board.example.org' });
  const text = JSON.stringify(cfg);
  it('one hosting site, yours, with the app rewrites and headers (discovery file included)', () => {
    expect(Array.isArray(cfg.hosting)).toBe(false);
    expect(cfg.hosting.site).toBe('my-hivenod');
    expect(cfg.hosting.target).toBeUndefined();
    expect(cfg.hosting.rewrites).toEqual(repoConfig.hosting[0].rewrites);
    expect(cfg.hosting.rewrites[0]).toEqual({
      source: '/.well-known/hivenod.json',
      destination: '/well-known/hivenod.json',
    });
    expect(cfg.firestore).toEqual(repoConfig.firestore);
  });
  it('nothing of the hosted service is left; your sign-in hosts are in the CSP', () => {
    expect(text).not.toMatch(/hive-board-43be|https:\/\/hivenod\.com/);
    const csp = cfg.hosting.headers[0].headers.find((h) => h.key === 'Content-Security-Policy');
    expect(csp.value).toContain(
      "frame-src 'self' blob: https://board.example.org https://my-hivenod.firebaseapp.com https://accounts.google.com;",
    );
  });
  it('Auth: email and Google sign-in', () => {
    expect(cfg.auth.providers).toEqual({
      emailPassword: true,
      googleSignIn: { oAuthBrandDisplayName: 'Hivenod', supportEmail: 'me@example.org' },
    });
  });
  it('the repo config is not changed', () => {
    expect(JSON.parse(readFileSync(join(root, 'firebase.json'), 'utf8'))).toEqual(repoConfig);
  });
});

/** A fake firebase CLI: `state` says what already exists in the project. */
function fakeIo(state) {
  const calls = [];
  const files = {};
  const lines = [];
  const ok = (result) => JSON.stringify({ status: 'success', result });
  const io = {
    say: (l) => lines.push(l),
    confirm: async () => true,
    readRepoConfig: () => repoConfig,
    writeJson: (f, o) => (files[f] = o),
    build: async (env, site) => calls.push(['build', env, site]),
    fetchJson: async (url) => {
      calls.push(['fetch', url]);
      return { firebase: { projectId: state.deployed ? 'my-hivenod' : 'other' } };
    },
    firebase: async (args) => {
      calls.push(args.slice(0, 2).join(' '));
      switch (args[0]) {
        case 'projects:list':
          return ok(state.project ? [{ projectId: 'my-hivenod' }] : [{ projectId: 'else' }]);
        case 'projects:create':
          state.project = true;
          return ok({ projectId: 'my-hivenod' });
        case 'apps:list':
          return ok(state.app ? [{ appId: '1:2:web:3', displayName: 'Hivenod' }] : []);
        case 'apps:create':
          state.app = true;
          return ok({ appId: '1:2:web:3', displayName: 'Hivenod' });
        case 'apps:sdkconfig':
          return ok({
            sdkConfig: {
              apiKey: 'key',
              authDomain: 'my-hivenod.firebaseapp.com',
              projectId: 'my-hivenod',
              appId: args[2],
              messagingSenderId: '2',
            },
          });
        case 'firestore:databases:list':
          return ok(state.db ? [{ name: 'projects/my-hivenod/databases/(default)' }] : []);
        case 'firestore:databases:create':
          state.db = true;
          return ok({});
        case 'hosting:sites:list':
          return ok({
            sites: [
              {
                name: 'projects/my-hivenod/sites/my-hivenod',
                defaultUrl: 'https://my-hivenod.web.app',
                type: 'DEFAULT_SITE',
              },
            ],
          });
        case 'deploy':
          state.deployed = true;
          return '';
      }
      throw new Error(`unexpected firebase ${args.join(' ')}`);
    },
  };
  return { io, calls, files, lines };
}

describe('runInit', () => {
  it('an empty project: creates the project, web app and database, builds, deploys, checks', async () => {
    const state = {};
    const { io, calls, files } = fakeIo(state);
    const final = await runInit(S, io);
    expect(calls.filter((c) => typeof c === 'string')).toEqual([
      'projects:list --json',
      'projects:create my-hivenod',
      'apps:list WEB',
      'apps:create WEB',
      'apps:sdkconfig WEB',
      'firestore:databases:list --project',
      'firestore:databases:create (default)',
      'hosting:sites:list --project',
      'deploy --only',
    ]);
    const build = calls.find((c) => c[0] === 'build');
    expect(build[1]).toEqual(
      viteEnv({
        apiKey: 'key',
        authDomain: 'my-hivenod.firebaseapp.com',
        projectId: 'my-hivenod',
        appId: '1:2:web:3',
        messagingSenderId: '2',
      }),
    );
    expect(build[2]).toBe('https://my-hivenod.web.app');
    expect(calls.at(-1)).toEqual(['fetch', 'https://my-hivenod.web.app/.well-known/hivenod.json']);
    expect(files[SETTINGS_FILE]).toMatchObject({
      project: 'my-hivenod',
      site: 'https://my-hivenod.web.app',
      appId: '1:2:web:3',
      firebase: { apiKey: 'key' },
    });
    expect(files[FIREBASE_CONFIG_FILE].hosting.site).toBe('my-hivenod');
    expect(final.site).toBe('https://my-hivenod.web.app');
  });

  it('run again: nothing is created, only build and deploy', async () => {
    const state = { project: true, app: true, db: true };
    const { io, calls } = fakeIo(state);
    await runInit(S, io, { skipBuild: true });
    const fb = calls.filter((c) => typeof c === 'string');
    expect(fb.some((c) => /create/.test(c))).toBe(false);
    expect(fb.at(-1)).toBe('deploy --only');
    expect(calls.some((c) => c[0] === 'build')).toBe(false);
  });

  it('your domain is the address people get; the check reads the Hosting address', async () => {
    const { io, calls } = fakeIo({ project: true, app: true, db: true });
    const final = await runInit({ ...S, domain: 'board.example.org' }, io, { skipBuild: true });
    expect(final.site).toBe('https://board.example.org');
    expect(calls.at(-1)).toEqual(['fetch', 'https://my-hivenod.web.app/.well-known/hivenod.json']);
    expect(nextSteps(final.site, final).join('\n')).toContain(
      'hivenod connect --server https://board.example.org',
    );
  });

  it('a missing project is only created when confirmed', async () => {
    const { io, calls } = fakeIo({});
    io.confirm = async () => false;
    await expect(runInit(S, io)).rejects.toThrow(/does not exist/);
    expect(calls.some((c) => c === 'projects:create my-hivenod')).toBe(false);
  });

  it('a firebase CLI error is passed on plainly', async () => {
    const { io } = fakeIo({});
    io.firebase = async () => JSON.stringify({ status: 'error', error: 'Not logged in.' });
    await expect(runInit(S, io)).rejects.toThrow('Not logged in.');
  });
});

describe('--dry-run', () => {
  it('prints every step and calls nothing (no firebase, no network, no build)', () => {
    // PATH holds only node: any attempt to run pnpm, firebase or git would fail, and the proxy
    // points nowhere, so a network call would fail too.
    const res = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/selfhost-init.mjs'),
        '--dry-run',
        '--project',
        'my-hivenod',
        '--support-email',
        'me@example.org',
      ],
      {
        encoding: 'utf8',
        cwd: root,
        env: {
          PATH: dirname(process.execPath),
          HOME: '/nonexistent',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          HTTP_PROXY: 'http://127.0.0.1:9',
        },
      },
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('Dry run: these are the steps; nothing is called.');
    for (const l of planLines({ ...S })) expect(res.stdout).toContain(l);
    expect(res.stdout).toContain('firebase projects:create my-hivenod --display-name Hivenod');
    expect(res.stdout).toContain(
      'firebase deploy --only hosting,firestore,auth --config firebase.selfhost.json --project my-hivenod',
    );
  });
  it('without a terminal and without --yes it stops and says what to pass', () => {
    const res = spawnSync(
      process.execPath,
      [join(root, 'scripts/selfhost-init.mjs'), '--project', 'my-hivenod'],
      { encoding: 'utf8', cwd: root, env: { PATH: dirname(process.execPath) }, input: '' },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('pass --yes with --project and --support-email');
  });
  it('bad values stop before anything runs', () => {
    const res = spawnSync(
      process.execPath,
      [join(root, 'scripts/selfhost-init.mjs'), '--dry-run', '--project', 'hive-board-43be'],
      { encoding: 'utf8', cwd: root, env: { PATH: dirname(process.execPath) } },
    );
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/hosted service/);
  });
});

describe('helpers', () => {
  it('site address and firebase args', () => {
    expect(siteUrlFor({ project: 'my-hivenod' })).toBe('https://my-hivenod.web.app');
    expect(siteUrlFor({ project: 'p', domain: 'board.example.org' }, 'x')).toBe(
      'https://board.example.org',
    );
    expect(firebaseArgs('databases:create', S)).toEqual([
      'firestore:databases:create',
      '(default)',
      '--location',
      'eur3',
      '--project',
      'my-hivenod',
      '--json',
    ]);
    expect(() => firebaseArgs('nope', S)).toThrow();
  });
});
