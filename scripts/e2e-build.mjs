#!/usr/bin/env node
// Usage (from apps/web): node ../../scripts/e2e-build.mjs <outDir>
// Builds the web app for an e2e run into <outDir>, unless it already holds a build of exactly these
// sources and VITE_* settings. scripts/e2e-emu.mjs gives every run a directory named after its
// emulator ports, so runs going at the same time never build over each other's files, and a plain
// `pnpm build` (which empties dist) never pulls them away. Type checking is `pnpm typecheck`'s job,
// so this runs `vite build` only.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildStamp } from './e2e-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web');
const out = resolve(web, process.argv[2] || 'dist');
const stampFile = join(out, '.e2e-stamp'); // vite build empties the directory, so a rebuild drops it
const stamp = buildStamp(root);

if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) {
  console.log(`e2e: sources unchanged, reusing ${out}`);
} else {
  const r = spawnSync(
    'pnpm',
    ['exec', 'vite', 'build', '--logLevel', 'warn', '--outDir', out, '--emptyOutDir'],
    { cwd: web, stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
  writeFileSync(stampFile, stamp);
}

// Builds for ports nobody used for a day (a run that fell back to random ports) are just clutter.
const parent = dirname(out);
for (const d of existsSync(parent) ? readdirSync(parent) : []) {
  const p = join(parent, d);
  if (p !== out && existsSync(join(p, '.e2e-stamp')) && Date.now() - statSync(p).mtimeMs > 864e5)
    rmSync(p, { recursive: true, force: true });
}
