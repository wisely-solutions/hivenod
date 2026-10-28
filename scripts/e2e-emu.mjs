#!/usr/bin/env node
// Usage: node scripts/e2e-emu.mjs [playwright args...]   (what `pnpm e2e:emu` runs)
// Runs the web e2e suite against Auth and Firestore emulators of its own: every port (auth, firestore,
// hub, logging, websocket) is picked for this run and handed to the emulators through a generated
// firebase.json, and to the app and the specs through the environment. So worktrees run side by side
// with no machine-wide lock.
//
// The whole run must finish within E2E_BUDGET_MIN minutes (default 5, the team's hard limit): past
// that it is stopped and fails, so a slow suite is caught the day it gets slow.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emulatorConfig, pickPorts } from './e2e-lib.mjs';

const started = Date.now();
const budgetMin = Number(process.env.E2E_BUDGET_MIN || 5);
const budgetMs = budgetMin * 60_000;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ports = await pickPorts(root);

// Own temp dir: the emulator hub writes a per-project locator file to $TMPDIR, so separate runs must not share one.
const tmp = mkdtempSync(join(tmpdir(), 'hive-e2e-'));
const config = join(tmp, 'firebase.json');
writeFileSync(config, JSON.stringify(emulatorConfig(root, ports), null, 2));
console.log(
  `e2e: emulators on auth ${ports.auth}, firestore ${ports.firestore} (hub ${ports.hub}); budget ${budgetMin} min`,
);

const pwArgs = process.argv.slice(2).map((a) => `'${a.replace(/'/g, `'\\''`)}'`);
const child = spawn(
  join(root, 'node_modules/.bin/firebase'),
  [
    'emulators:exec',
    '--config',
    config,
    '--only',
    'auth,firestore',
    '--project',
    'hive-board-43be',
    ['pnpm e2e', ...pwArgs].join(' '),
  ],
  {
    cwd: root,
    stdio: ['inherit', 'pipe', 'inherit'], // stdout is echoed below and scanned for "did not run"
    detached: true, // own process group, so the budget timer can stop everything it started
    env: {
      ...process.env,
      TMPDIR: tmp,
      VITE_USE_EMULATOR: '1',
      VITE_AUTH_EMULATOR_PORT: String(ports.auth),
      VITE_FIRESTORE_EMULATOR_PORT: String(ports.firestore),
      E2E_AUTH_PORT: String(ports.auth),
      E2E_FIRESTORE_PORT: String(ports.firestore),
      // Playwright stops on its own a little before the hard stop below, so it still prints its report.
      E2E_DEADLINE: String(started + budgetMs - 15_000),
      // This run's own build of the app (it bakes in the ports above), kept for the next run here.
      E2E_DIST: `node_modules/.e2e-dist/${ports.auth}`,
      // A preview server left over from another run is never ours: always start a fresh one.
      E2E_FRESH_SERVER: '1',
    },
  },
);

// Playwright prints "N did not run" when the suite is cut short (its own deadline); never let that pass as green.
let tail = '';
let didNotRun = 0;
child.stdout.on('data', (buf) => {
  process.stdout.write(buf);
  tail = (tail + buf.toString()).slice(-400);
  const m = /(\d+) did not run/.exec(tail);
  if (m) didNotRun = Number(m[1]);
});

const killAll = (sig) => {
  try {
    process.kill(-child.pid, sig);
  } catch {
    /* already gone */
  }
};
let overBudget = false;
const timer = setTimeout(() => {
  overBudget = true;
  console.error(
    `\ne2e: FAILED: the run passed its ${budgetMin}-minute budget (E2E_BUDGET_MIN) and was stopped.` +
      `\n     The full suite must stay under ${budgetMin} minutes: find the slow specs (the list reporter prints each test's time).`,
  );
  killAll('SIGTERM');
  setTimeout(() => killAll('SIGKILL'), 5000).unref();
}, budgetMs);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => killAll(sig));

child.on('exit', (code, sig) => {
  clearTimeout(timer);
  killAll('SIGTERM'); // stray preview servers or browsers
  rmSync(tmp, { recursive: true, force: true });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`e2e: finished in ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`);
  if (didNotRun > 0) {
    console.error(
      `e2e: FAILED: ${didNotRun} tests did not run (the ${budgetMin}-minute budget cut the suite short). ` +
        `Find the slow specs, or raise E2E_BUDGET_MIN only with a measured reason.`,
    );
  }
  process.exit(overBudget || didNotRun > 0 ? 1 : (code ?? (sig ? 1 : 0)));
});
