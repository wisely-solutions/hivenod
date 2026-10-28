// The Go CLI's release files (item zLwtX2WEEg3mER4CR74g): five binaries, a SHA-256 file next to
// each, and the manifest /cli/bin/latest.json that install.sh, install.ps1 and `hivenod update`
// read. Pure helpers; scripts/build-cli-bin.mjs does the building.
import { createHash } from 'node:crypto';

/** target -> Go GOOS/GOARCH and the file name. */
export const TARGETS = [
  { target: 'linux-x64', goos: 'linux', goarch: 'amd64', name: 'hivenod-linux-x64' },
  { target: 'linux-arm64', goos: 'linux', goarch: 'arm64', name: 'hivenod-linux-arm64' },
  { target: 'darwin-x64', goos: 'darwin', goarch: 'amd64', name: 'hivenod-darwin-x64' },
  { target: 'darwin-arm64', goos: 'darwin', goarch: 'arm64', name: 'hivenod-darwin-arm64' },
  { target: 'windows-x64', goos: 'windows', goarch: 'amd64', name: 'hivenod-windows-x64.exe' },
];

export const BIN_PATH = '/cli/bin';

/**
 * The binary's version: 0.2.<commits that touched cli/>. It changes only when the CLI does, so
 * a release that leaves cli/ alone ships byte-identical binaries (reproducible build).
 */
export const binVersionFor = (cliCommits) => `0.2.${cliCommits}`;

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** The .sha256 file next to a binary, in the sha256sum format. */
export const sumLine = (hex, name) => `${hex}  ${name}\n`;

/** -ldflags that stamp the version and the commit into the binary. */
export function ldflags(version, commit) {
  const pkg = 'github.com/wisely-solutions/hivenod/cli/internal/update';
  return `-s -w -X ${pkg}.Version=${version} -X ${pkg}.Commit=${commit}`;
}

/** The manifest from what was built: [{target, name, bytes}]. */
export function manifest({ version, commit, cliProtocol }, built) {
  const files = {};
  for (const b of built)
    files[b.target] = {
      name: b.name,
      path: `${BIN_PATH}/${b.name}`,
      sha256: sha256(b.bytes),
      size: b.bytes.length,
    };
  return { version, commit, ...(cliProtocol ? { cliProtocol } : {}), files };
}

/** Problems with what the site serves, compared with the manifest that was built. */
export function servedProblems(m, served) {
  const out = [];
  if (served.manifest?.version !== m.version || served.manifest?.commit !== m.commit)
    out.push(
      `latest.json says ${served.manifest?.version}/${served.manifest?.commit}, built ${m.version}/${m.commit}`,
    );
  for (const [t, f] of Object.entries(m.files)) {
    const s = served.files[t];
    if (!s) {
      out.push(`${f.path} is not served`);
      continue;
    }
    if (s.size !== f.size) out.push(`${f.path} is ${s.size} bytes, built ${f.size}`);
    if (s.sha256 !== f.sha256) out.push(`${f.path} has SHA-256 ${s.sha256}, built ${f.sha256}`);
    if ((s.sumFile ?? '').split(/\s+/)[0] !== f.sha256) out.push(`${f.path}.sha256 does not match`);
  }
  return out;
}
