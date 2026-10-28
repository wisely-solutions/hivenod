// Pure helpers for scripts/pack-cli.mjs: the Hivenod CLI as an npm tarball served from Hivenod's
// hosting (card rifzGl8M). `npm install -g https://<host>/cli/hivenod-latest.tgz` installs it: no npm
// registry account and no public source. Versioned files stay next to it.
// The old name (card wQ7ZfmYr, hard cut): /cli/hive-latest.tgz is a tiny `hive` stub that only says
// how to install hivenod.

/** The CLI version of a release: 0.1.<number of commits on main>, so it only grows. */
export function cliVersionFor(commitCount) {
  if (!Number.isInteger(commitCount) || commitCount < 1) throw new Error('bad commit count');
  return `0.1.${commitCount}`;
}

/** package.json of the published tarball: the agent package, bundled, stamped with the release. */
export function publishedPackage(agentPkg, { version, commit }) {
  const deps = { ...agentPkg.dependencies };
  // @hive/shared is bundled into dist/cli.js (esbuild); only real npm dependencies stay.
  delete deps['@hive/shared'];
  return {
    name: 'hivenod',
    version,
    hivenodCommit: commit,
    description: 'The Hivenod agent client: hivenod pair, hivenod whoami, hivenod mcp',
    type: 'module',
    license: 'UNLICENSED',
    engines: { node: '>=20' },
    bin: { hivenod: './dist/cli.js' },
    files: ['dist/cli.js', 'README.md'],
    dependencies: deps,
  };
}

export const tarballName = (version) => `hivenod-${version}.tgz`;
export const LATEST_TARBALL = 'hivenod-latest.tgz';
/** The old address: it now serves the stub below. */
export const LEGACY_TARBALL = 'hive-latest.tgz';

/** What the old `hive` command says, with the new install command. */
export const migrationMessage = (installUrl) =>
  `Hive is now Hivenod: install with npm install -g ${installUrl}, then hivenod pair and follow https://hivenod.com/agents`;

/**
 * package.json of the final hive-cli: same package name and bin as before, so `npm install -g` of
 * the old address replaces a working `hive` with the stub. No dependencies.
 */
export function legacyStubPackage({ version }) {
  return {
    name: 'hive-cli',
    version,
    description: 'Hive is now Hivenod: this package only says how to install hivenod.',
    license: 'UNLICENSED',
    engines: { node: '>=20' },
    bin: { hive: './hive.js' },
    files: ['hive.js'],
  };
}

/** The stub's whole program: the message on stderr, exit 1. Reads no env vars and no files. */
export function legacyStubScript(installUrl) {
  return `#!/usr/bin/env node\nprocess.stderr.write(${JSON.stringify(migrationMessage(installUrl) + '\n')});\nprocess.exit(1);\n`;
}

/**
 * versions.json next to the tarballs: newest first, `keep` entries. The current release is
 * (re)listed first; earlier ones come from the previous versions.json when there was one. Only
 * hivenod tarballs are kept: the old hive-<version>.tgz files are dropped (hard cut).
 */
export function nextVersions(previous, current, keep = 5) {
  const old = Array.isArray(previous?.versions) ? previous.versions : [];
  const rest = old.filter(
    (v) =>
      v &&
      typeof v.version === 'string' &&
      v.version !== current.version &&
      v.file === tarballName(v.version),
  );
  const versions = [current, ...rest].slice(0, keep);
  return { latest: current.version, versions };
}
