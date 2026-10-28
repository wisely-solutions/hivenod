// The Go CLI's release files and install.sh (item zLwtX2WEEg3mER4CR74g).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareVersions } from './release-lib.mjs';
import {
  binVersionFor,
  ldflags,
  manifest,
  servedProblems,
  sha256,
  sumLine,
  TARGETS,
} from './cli-bin-lib.mjs';

const root = join(import.meta.dirname, '..');

describe('cli-bin-lib', () => {
  it('versions sit above the last published 0.2.9, so installed CLIs update', () => {
    expect(binVersionFor(7)).toBe('0.2.107');
    expect(compareVersions(binVersionFor(1), '0.2.9')).toBeGreaterThan(0);
  });
  it('names five targets and builds the manifest with checksums', () => {
    expect(TARGETS.map((t) => t.target)).toEqual([
      'linux-x64',
      'linux-arm64',
      'darwin-x64',
      'darwin-arm64',
      'windows-x64',
    ]);
    const m = manifest({ version: binVersionFor(7), commit: 'abc', cliProtocol: 2 }, [
      { target: 'linux-x64', name: 'hivenod-linux-x64', bytes: Buffer.from('bin') },
    ]);
    expect(m).toEqual({
      version: '0.2.107',
      commit: 'abc',
      cliProtocol: 2,
      files: {
        'linux-x64': {
          name: 'hivenod-linux-x64',
          path: '/cli/bin/hivenod-linux-x64',
          sha256: sha256(Buffer.from('bin')),
          size: 3,
        },
      },
    });
    expect(sumLine('ab', 'x')).toBe('ab  x\n');
    expect(ldflags('0.2.7', 'abc')).toContain('internal/update.Version=0.2.7');
  });

  it('finds every difference between what was built and what is served', () => {
    const m = manifest({ version: '0.2.1', commit: 'c' }, [
      { target: 'linux-x64', name: 'a', bytes: Buffer.from('x') },
      { target: 'darwin-arm64', name: 'b', bytes: Buffer.from('y') },
    ]);
    const good = {
      manifest: { version: '0.2.1', commit: 'c' },
      files: {
        'linux-x64': {
          size: 1,
          sha256: sha256(Buffer.from('x')),
          sumFile: sumLine(sha256(Buffer.from('x')), 'a'),
        },
        'darwin-arm64': {
          size: 1,
          sha256: sha256(Buffer.from('y')),
          sumFile: sumLine(sha256(Buffer.from('y')), 'b'),
        },
      },
    };
    expect(servedProblems(m, good)).toEqual([]);
    const bad = structuredClone(good);
    bad.manifest.commit = 'old';
    delete bad.files['darwin-arm64'];
    bad.files['linux-x64'].sumFile = 'nope  a\n';
    expect(servedProblems(m, bad)).toHaveLength(3);
  });
});

// ---------- install.sh against a local site ----------

const target = `${platform() === 'darwin' ? 'darwin' : 'linux'}-${arch() === 'arm64' ? 'arm64' : 'x64'}`;
const fakeBin = Buffer.from('#!/bin/sh\necho "hivenod 9.9.9"\n');
let server;
let base = '';
let served = { bin: fakeBin, sum: sha256(fakeBin), side: sha256(fakeBin) };

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const name = `hivenod-${target}`;
    if (path === '/cli/bin/latest.json') {
      res.end(
        JSON.stringify(
          {
            version: '9.9.9',
            commit: 'c',
            files: {
              [target]: {
                name,
                path: `/cli/bin/${name}`,
                sha256: served.sum,
                size: served.bin.length,
              },
            },
          },
          null,
          2,
        ),
      );
    } else if (path === `/cli/bin/${name}`) res.end(served.bin);
    else if (path === `/cli/bin/${name}.sha256`) res.end(sumLine(served.side, name));
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server?.close());

/** Runs install.sh against the local site (async: the site runs in this process). */
function install() {
  const dir = mkdtempSync(join(tmpdir(), 'hivenod-install-'));
  const child = spawn('sh', [join(root, 'cli/install/install.sh')], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      HIVENOD_WEB_URL: base,
      HIVENOD_INSTALL_DIR: join(dir, 'bin'),
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve) =>
    child.on('close', (status) =>
      resolve({ status, stdout, stderr, file: join(dir, 'bin', 'hivenod') }),
    ),
  );
}

describe.skipIf(platform() === 'win32')('install.sh', () => {
  it('installs the binary for this machine after checking its checksum', async () => {
    served = { bin: fakeBin, sum: sha256(fakeBin), side: sha256(fakeBin) };
    const r = await install();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`Downloading hivenod 9.9.9 for ${target}`);
    expect(r.stdout).toContain('Installed hivenod 9.9.9');
    expect(readFileSync(r.file)).toEqual(fakeBin);
  });

  it('installs nothing when the download does not match the manifest or the .sha256 file', async () => {
    for (const s of [
      { bin: Buffer.from('tampered'), sum: sha256(fakeBin), side: sha256(fakeBin) },
      { bin: fakeBin, sum: sha256(fakeBin), side: '0'.repeat(64) },
      { bin: fakeBin, sum: 'not-a-checksum', side: sha256(fakeBin) },
    ]) {
      served = s;
      const r = await install();
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/checksum/);
      expect(existsSync(r.file)).toBe(false);
    }
  });
});

// ---------- the release smoke against a local site serving a real build ----------

import { execFileSync, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { cliBinProblems } from './cli-bin-smoke.mjs';
import { ldflags as flags } from './cli-bin-lib.mjs';

const go = [process.env.HIVENOD_GO, join(homedir(), '.local/go/bin/go'), 'go'].find(
  (g) => g && spawnSync(g, ['version']).status === 0,
);

describe.skipIf(!go || platform() !== 'linux' || arch() !== 'x64')(
  'release smoke (cliBinProblems)',
  () => {
    it('passes for what was built and names what differs', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'hivenod-bin-'));
      const file = join(dir, 'hivenod-linux-x64');
      execFileSync(
        go,
        [
          'build',
          '-trimpath',
          '-ldflags',
          flags('0.2.99', 'abcdef1234567'),
          '-o',
          file,
          './cmd/hivenod',
        ],
        {
          cwd: join(root, 'cli'),
          env: { ...process.env, CGO_ENABLED: '0' },
        },
      );
      const bin = readFileSync(file);
      const other = Buffer.from('mac binary');
      const m = manifest({ version: '0.2.99', commit: 'abcdef1234567' }, [
        { target: 'linux-x64', name: 'hivenod-linux-x64', bytes: bin },
        { target: 'darwin-arm64', name: 'hivenod-darwin-arm64', bytes: other },
      ]);
      let tamper = false;
      const site = createServer((req, res) => {
        const path = (req.url ?? '').split('?')[0];
        const f = Object.values(m.files).find(
          (x) => x.path === path || `${x.path}.sha256` === path,
        );
        if (path === '/cli/bin/latest.json') res.end(JSON.stringify(m));
        else if (path === '/install.sh')
          res.end(readFileSync(join(root, 'cli/install/install.sh')));
        else if (path === '/install.ps1')
          res.end(readFileSync(join(root, 'cli/install/install.ps1')));
        else if (f && path.endsWith('.sha256')) res.end(sumLine(f.sha256, f.name));
        else if (f) res.end(f.name.includes('darwin') ? (tamper ? Buffer.from('x') : other) : bin);
        else {
          res.statusCode = 404;
          res.end();
        }
      });
      await new Promise((r) => site.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${site.address().port}`;
      try {
        expect(await cliBinProblems(url, m, { pair: false })).toEqual([]);
        tamper = true;
        const bad = await cliBinProblems(url, m, { pair: false });
        expect(bad.join('\n')).toMatch(/hivenod-darwin-arm64 is 1 bytes/);
      } finally {
        site.close();
      }
    }, 120_000);
  },
);
