#!/usr/bin/env node
// Usage: node scripts/build-cli-bin.mjs <commit> <outDir> [cliProtocol]
// Cross-compiles the Go CLI (cli/) for the five targets into <outDir>/cli/bin with a .sha256
// next to each binary and latest.json, and copies install.sh and install.ps1 to <outDir>. Called
// by `pnpm release` before the hosting deploy (item zLwtX2WEEg3mER4CR74g). Prints the version.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { binVersionFor, ldflags, manifest, sumLine, TARGETS } from './cli-bin-lib.mjs';

const [commit, outArg, protocol] = process.argv.slice(2);
if (!commit || !outArg) {
  console.error('Usage: node scripts/build-cli-bin.mjs <commit> <outDir> [cliProtocol]');
  process.exit(1);
}
const root = resolve(new URL('..', import.meta.url).pathname);
const out = resolve(outArg);

function findGo() {
  for (const g of [
    process.env.HIVENOD_GO,
    join(homedir(), '.local/go/bin/go'),
    '/usr/local/go/bin/go',
    'go',
  ]) {
    if (!g || (g !== 'go' && !existsSync(g))) continue;
    if (spawnSync(g, ['version']).status === 0) return g;
  }
  throw new Error('Go is needed to build the hivenod CLI (set HIVENOD_GO or put go on PATH)');
}
const go = findGo();

// The version and commit of the CLI itself: the last commit that touched cli/.
const cliCommit = execFileSync('git', ['log', '-1', '--format=%H', commit, '--', 'cli'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const cliCommits = Number(
  execFileSync('git', ['rev-list', '--count', commit, '--', 'cli'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
);
const version = binVersionFor(cliCommits);
const dir = join(out, 'cli/bin');
mkdirSync(dir, { recursive: true });
const built = [];
for (const t of TARGETS) {
  const file = join(dir, t.name);
  execFileSync(
    go,
    [
      'build',
      '-trimpath',
      '-buildvcs=false',
      '-ldflags',
      ldflags(version, cliCommit),
      '-o',
      file,
      './cmd/hivenod',
    ],
    {
      cwd: join(root, 'cli'),
      stdio: 'inherit',
      env: {
        ...process.env,
        GOOS: t.goos,
        GOARCH: t.goarch,
        CGO_ENABLED: '0',
        GOFLAGS: '-mod=readonly',
      },
    },
  );
  const bytes = readFileSync(file);
  built.push({ ...t, bytes });
}
const m = manifest(
  { version, commit: cliCommit, cliProtocol: protocol ? Number(protocol) : undefined },
  built,
);
for (const t of TARGETS)
  writeFileSync(join(dir, `${t.name}.sha256`), sumLine(m.files[t.target].sha256, t.name));
writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(m, null, 2)}\n`);
copyFileSync(join(root, 'cli/install/install.sh'), join(out, 'install.sh'));
copyFileSync(join(root, 'cli/install/install.ps1'), join(out, 'install.ps1'));
for (const t of TARGETS)
  console.log(`${m.files[t.target].sha256}  ${t.name} (${m.files[t.target].size} bytes)`);
console.log(version);
