#!/usr/bin/env node
// `pnpm selfhost:init`: run Hivenod in a Firebase project of your own (docs/SELF-HOST.md).
// The steps and their checks are in selfhost-lib.mjs; this file connects them to the firebase CLI
// (repo devDependency), the build and the terminal. --dry-run prints the steps and calls nothing.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  HELP,
  mergeSettings,
  nextSteps,
  parseArgs,
  planLines,
  runInit,
  SETTINGS_FILE,
  settingsProblems,
} from './selfhost-lib.mjs';

const root = resolve(new URL('..', import.meta.url).pathname);
const say = (line = '') => process.stdout.write(`${line}\n`);
const die = (msg) => {
  process.stderr.write(`selfhost:init: ${msg}\n`);
  process.exit(1);
};

let flags;
try {
  flags = parseArgs(process.argv.slice(2));
} catch (e) {
  die(e.message);
}
if (flags.help) {
  say(HELP);
  process.exit(0);
}

const readJson = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const saved = existsSync(join(root, SETTINGS_FILE)) ? readJson(SETTINGS_FILE) : {};
const interactive = !flags.yes && !flags.dryRun && process.stdin.isTTY && process.stdout.isTTY;
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const ask = async (q, def) => {
  const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
  return a || def || '';
};
const confirm = async (q) => {
  if (!rl) return flags.yes;
  return /^(y|yes|)$/i.test((await rl.question(`${q} [Y/n] `)).trim());
};

let s = mergeSettings(flags, saved);
if (interactive) {
  say('Hivenod self-host setup. Enter keeps the value in brackets.');
  s.project = await ask('Firebase project id (an existing one, or a new one to create)', s.project);
  s = mergeSettings({ ...flags, project: s.project }, saved);
  s.location = await ask('Firestore location for a new database', s.location);
  s.supportEmail = await ask('Support email for Google sign-in', s.supportEmail);
  const d = await ask('Your own domain (Enter for none)', s.domain);
  s.domain = d ? d : undefined;
  s = mergeSettings({ ...s }, saved);
} else if (!flags.yes && !flags.dryRun) {
  die('no terminal to ask in: pass --yes with --project and --support-email (or --dry-run).');
}

const problems = settingsProblems(s);
if (problems.length) die(problems.join('; '));

say();
say(flags.dryRun ? 'Dry run: these are the steps; nothing is called.' : 'The steps:');
for (const l of planLines(s, { skipBuild: flags.skipBuild })) say(`  ${l}`);
say();
if (flags.dryRun) process.exit(0);
if (!(await confirm('Go ahead?'))) {
  rl?.close();
  die('stopped, nothing changed.');
}

// The service account the release script also understands, when no `firebase login` is used.
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const envFile = join(homedir(), '.agent/secrets/gcp.env');
  if (existsSync(envFile))
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const m = line.match(/^(?:export )?GOOGLE_APPLICATION_CREDENTIALS=(.*)$/);
      if (m) process.env.GOOGLE_APPLICATION_CREDENTIALS = m[1].replace(/^["']|["']$/g, '');
    }
}

const firebaseBin = join(root, 'node_modules/.bin/firebase');
const io = {
  say,
  confirm,
  readRepoConfig: () => readJson('firebase.json'),
  writeJson: (f, obj) => writeFileSync(join(root, f), `${JSON.stringify(obj, null, 2)}\n`),
  firebase: async (args, { inherit = false } = {}) => {
    if (inherit) {
      const r = spawnSync(firebaseBin, args, { cwd: root, stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`firebase ${args[0]} failed`);
      return '';
    }
    const r = spawnSync(firebaseBin, args, { cwd: root, encoding: 'utf8' });
    if (r.status !== 0 && !r.stdout) throw new Error(`firebase ${args[0]} failed: ${r.stderr}`);
    return r.stdout;
  },
  build: async (env) => {
    const run = (cmd, args, extra = {}) =>
      execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...extra } });
    const out = (cmd, args) =>
      execFileSync(cmd, args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    run('pnpm', ['build'], env);
    let commit = 'selfhost';
    try {
      commit = out('git', ['rev-parse', 'HEAD']).trim();
    } catch {
      /* not a git checkout: the CLI versions say "selfhost" */
    }
    const proto = /export const CLI_PROTOCOL = (\d+);/.exec(
      readFileSync(join(root, 'packages/shared/src/protocol.ts'), 'utf8'),
    )?.[1];
    // The CLI downloads under /cli, so agents install from your site; the Go binaries need Go.
    let cliBin;
    try {
      cliBin = out('node', ['scripts/build-cli-bin.mjs', commit, 'apps/web/dist', proto ?? ''])
        .trim()
        .split('\n')
        .at(-1);
    } catch {
      say(
        '• The Go CLI was not built (Go not found?). Agents can install it from https://hivenod.com/install.sh and use --server.',
      );
    }
    writeFileSync(
      join(root, 'apps/web/dist/version.json'),
      `${JSON.stringify({
        commit,
        ...(cliBin ? { cliBin } : {}),
        ...(proto ? { cliProtocol: Number(proto) } : {}),
        deployedAt: new Date().toISOString(),
      })}\n`,
    );
  },
  fetchJson: async (url) => {
    for (let i = 0; i < 10; i++) {
      try {
        const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (r.ok) return await r.json();
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  },
};

try {
  const final = await runInit(s, io, { skipBuild: flags.skipBuild });
  say();
  for (const l of nextSteps(final.site, final)) say(l);
} catch (e) {
  die(e.message);
} finally {
  rl?.close();
}
