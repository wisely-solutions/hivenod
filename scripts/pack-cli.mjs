#!/usr/bin/env node
// Usage: node scripts/pack-cli.mjs <commit> <outDir> [prodUrl]
// Packs packages/agent (already built: dist/cli.js) into <outDir>/hivenod-<version>.tgz plus
// hivenod-latest.tgz and versions.json, for `npm install -g <host>/cli/hivenod-latest.tgz`, and the
// old hive-latest.tgz as the final `hive` stub that only prints how to move to hivenod (card wQ7ZfmYr).
// Called by `pnpm release` before the hosting deploy; the CLI's own `hivenod --version` shows the
// same version, and /version.json carries it as "cli".
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  cliVersionFor,
  LATEST_TARBALL,
  LEGACY_TARBALL,
  legacyStubPackage,
  legacyStubScript,
  nextVersions,
  publishedPackage,
  tarballName,
} from './pack-cli-lib.mjs';

const [commit, outArg, prodUrl = 'https://hivenod.com'] = process.argv.slice(2);
if (!commit || !outArg) {
  console.error('Usage: node scripts/pack-cli.mjs <commit> <outDir> [prodUrl]');
  process.exit(1);
}
const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(outArg);
const agent = join(root, 'packages/agent');
const bundle = join(agent, 'dist/cli.js');
if (!existsSync(bundle)) throw new Error('packages/agent/dist/cli.js is missing: run pnpm build');

const count = Number(
  execFileSync('git', ['rev-list', '--count', commit], { cwd: root, encoding: 'utf8' }).trim(),
);
const version = cliVersionFor(count);
const agentPkg = JSON.parse(readFileSync(join(agent, 'package.json'), 'utf8'));

const tmp = mkdtempSync(join(tmpdir(), 'hivenod-cli-pack-'));
try {
  mkdirSync(join(tmp, 'dist'));
  copyFileSync(bundle, join(tmp, 'dist/cli.js'));
  copyFileSync(join(agent, 'README.md'), join(tmp, 'README.md'));
  writeFileSync(
    join(tmp, 'package.json'),
    JSON.stringify(publishedPackage(agentPkg, { version, commit }), null, 2) + '\n',
  );
  mkdirSync(out, { recursive: true });
  execFileSync('npm', ['pack', '--pack-destination', out, '--silent'], { cwd: tmp });
  // npm names it <name>-<version>.tgz, which is already hivenod-<version>.tgz.
  const named = join(out, tarballName(version));
  if (!existsSync(named)) throw new Error(`npm pack did not write ${named}`);
  copyFileSync(named, join(out, LATEST_TARBALL));

  // The old address keeps answering, with the stub (hard cut: no working hive any more).
  const stub = join(tmp, 'hive-stub');
  mkdirSync(stub);
  writeFileSync(
    join(stub, 'package.json'),
    JSON.stringify(legacyStubPackage({ version }), null, 2) + '\n',
  );
  writeFileSync(join(stub, 'hive.js'), legacyStubScript(`${prodUrl}/cli/${LATEST_TARBALL}`), {
    mode: 0o755,
  });
  const stubDir = join(tmp, 'hive-stub-out');
  mkdirSync(stubDir);
  execFileSync('npm', ['pack', '--pack-destination', stubDir, '--silent'], { cwd: stub });
  copyFileSync(join(stubDir, `hive-cli-${version}.tgz`), join(out, LEGACY_TARBALL));

  // Keep earlier versions next to it (best effort: the live versions.json lists them).
  let previous = null;
  try {
    const res = await fetch(`${prodUrl}/cli/versions.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) previous = await res.json();
  } catch {
    /* first release, or offline: only the current version */
  }
  const list = nextVersions(previous, { version, commit, file: tarballName(version) });
  for (const v of list.versions) {
    if (v.version === version) continue;
    try {
      const res = await fetch(`${prodUrl}/cli/${v.file}`);
      if (!res.ok) throw new Error(String(res.status));
      writeFileSync(join(out, v.file), Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      console.warn(`pack-cli: could not keep ${v.file} (${e.message}); dropped from the list`);
      list.versions = list.versions.filter((x) => x !== v);
    }
  }
  writeFileSync(join(out, 'versions.json'), JSON.stringify(list, null, 2) + '\n');
  console.log(`CLI packed: ${tarballName(version)} (${commit.slice(0, 7)}) in ${out}`);
  console.log(version);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
