// Helpers for scripts/e2e-emu.mjs and scripts/e2e-build.mjs (kept pure where possible so they test easily).
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';

/** The emulator ports one e2e run needs. */
export const PORT_NAMES = ['auth', 'firestore', 'hub', 'logging', 'websocket'];

/** Offset into the worktree block for the rules and integration runs (scripts/emu-exec.mjs): ports 5-9. */
export const RULES_OFFSET = 5;

/**
 * A fixed block of 10 ports per worktree (20000–31999, below Linux's ephemeral range), so repeated runs in
 * one worktree get the same ports and can reuse the emulator build of the web app, which bakes them in.
 * The e2e takes ports 0-4 of the block, the rules runs ports 5-9 (`offset` RULES_OFFSET), so both can run
 * at once in one worktree.
 */
export function preferredPorts(root, offset = 0) {
  const h = createHash('sha1').update(root).digest().readUInt32BE(0);
  const base = 20000 + (h % 1200) * 10 + offset;
  return Object.fromEntries(PORT_NAMES.map((n, i) => [n, base + i]));
}

/** Can we listen on this port on 127.0.0.1 (where the emulators bind) right now? Port 0: a free one. */
export function probe(port) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => {
      const got = s.address().port;
      s.close(() => resolve(got));
    });
  });
}

/** The worktree's own ports when they are all free, otherwise any free ones the OS hands out. */
export async function pickPorts(root, check = probe, offset = 0) {
  const want = preferredPorts(root, offset);
  const free = await Promise.all(Object.values(want).map((p) => check(p)));
  if (free.every((p, i) => p === Object.values(want)[i])) return want;
  const out = {};
  for (const n of PORT_NAMES) {
    let p;
    do p = await check(0);
    while (!p || Object.values(out).includes(p));
    out[n] = p;
  }
  return out;
}

/** firebase.json for this run: rules and indexes from the repo, every emulator on its own port. */
export function emulatorConfig(root, ports) {
  return {
    firestore: {
      rules: join(root, 'firestore.rules'),
      indexes: join(root, 'firestore.indexes.json'),
    },
    emulators: {
      auth: { port: ports.auth },
      firestore: { port: ports.firestore, websocketPort: ports.websocket },
      hub: { port: ports.hub },
      logging: { port: ports.logging },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  };
}

/** Every file under `dir` (skipping node_modules and dist), sorted, as absolute paths. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  if (statSync(dir).isFile()) return [dir];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.name !== 'node_modules' && e.name !== 'dist')
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => walk(join(dir, e.name)));
}

/** Fingerprint of what goes into the web build: its sources, the shared package, the lockfile and VITE_* env. */
export function buildStamp(root, env = process.env) {
  const h = createHash('sha256');
  const inputs = [
    'apps/web/src',
    'apps/web/public',
    'apps/web/index.html',
    'apps/web/vite.config.ts',
    'apps/web/package.json',
    'apps/web/tsconfig.json',
    'packages/shared/src',
    'packages/shared/package.json',
    'pnpm-lock.yaml',
  ];
  for (const f of inputs.flatMap((i) => walk(join(root, i)))) {
    h.update(relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  }
  for (const k of Object.keys(env)
    .filter((k) => k.startsWith('VITE_'))
    .sort())
    h.update(`${k}=${env[k]}\0`);
  return h.digest('hex');
}
