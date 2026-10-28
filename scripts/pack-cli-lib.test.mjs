import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cliVersionFor,
  LATEST_TARBALL,
  LEGACY_TARBALL,
  legacyStubPackage,
  legacyStubScript,
  migrationMessage,
  nextVersions,
  publishedPackage,
  tarballName,
} from './pack-cli-lib.mjs';

describe('pack-cli', () => {
  it('versions grow with the commit count', () => {
    expect(cliVersionFor(77)).toBe('0.1.77');
    expect(() => cliVersionFor(0)).toThrow();
    expect(tarballName('0.1.77')).toBe('hivenod-0.1.77.tgz');
    expect(LATEST_TARBALL).toBe('hivenod-latest.tgz');
  });
  it('publishes the agent as hivenod without the bundled workspace package', () => {
    const pkg = publishedPackage(
      { dependencies: { '@hive/shared': 'workspace:*', firebase: '^13', zod: '^4' } },
      { version: '0.1.77', commit: 'abc' },
    );
    expect(pkg.dependencies).toEqual({ firebase: '^13', zod: '^4' });
    expect(pkg.bin).toEqual({ hivenod: './dist/cli.js' });
    expect(pkg).toMatchObject({ name: 'hivenod', version: '0.1.77', hivenodCommit: 'abc' });
    expect(pkg.engines.node).toBe('>=20');
    // No `hive` bin: it would clash with an old global hive-cli install (npm EEXIST).
    expect(JSON.stringify(pkg)).not.toMatch(/"hive"/);
  });
  it('keeps the newest hivenod versions next to the latest and drops old hive tarballs', () => {
    const cur = { version: '0.1.9', commit: 'c', file: 'hivenod-0.1.9.tgz' };
    const prev = {
      latest: '0.1.8',
      versions: ['0.1.8', '0.1.7', '0.1.6', '0.1.5', '0.1.4'].map((version) => ({
        version,
        commit: 'x',
        file: `hivenod-${version}.tgz`,
      })),
    };
    const next = nextVersions(prev, cur, 3);
    expect(next.latest).toBe('0.1.9');
    expect(next.versions.map((v) => v.version)).toEqual(['0.1.9', '0.1.8', '0.1.7']);
    expect(nextVersions(null, cur).versions).toEqual([cur]);
    // Re-releasing the same version does not list it twice.
    expect(nextVersions({ versions: [cur] }, cur).versions).toEqual([cur]);
    // Hard cut (card wQ7ZfmYr): the old hive-<version>.tgz files are not carried over.
    const old = { versions: [{ version: '0.1.8', commit: 'x', file: 'hive-0.1.8.tgz' }] };
    expect(nextVersions(old, cur).versions).toEqual([cur]);
  });
});

describe('the old hive command (hard cut, card wQ7ZfmYr)', () => {
  const url = 'https://hivenod.com/cli/hivenod-latest.tgz';
  it('is served as the final hive-latest.tgz: package hive-cli, bin hive, nothing else', () => {
    expect(LEGACY_TARBALL).toBe('hive-latest.tgz');
    const pkg = legacyStubPackage({ version: '0.1.300' });
    expect(pkg).toMatchObject({ name: 'hive-cli', version: '0.1.300', bin: { hive: './hive.js' } });
    expect(pkg.dependencies).toBeUndefined();
    expect(migrationMessage(url)).toBe(
      `Hive is now Hivenod: install with npm install -g ${url}, then hivenod pair and follow https://hivenod.com/agents`,
    );
  });
  it('prints the migration message and exits 1, whatever it is asked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hive-stub-'));
    const file = join(dir, 'hive.js');
    writeFileSync(file, legacyStubScript(url));
    for (const args of [[], ['run', 'claude'], ['--version']]) {
      const r = spawnSync(process.execPath, [file, ...args], { encoding: 'utf8' });
      expect(r.status).toBe(1);
      expect(r.stderr.trim()).toBe(migrationMessage(url));
      expect(r.stdout).toBe('');
    }
    // A shebang so npm can link it as a bin.
    expect(legacyStubScript(url).startsWith('#!/usr/bin/env node\n')).toBe(true);
    // It is plain, dependency-free JavaScript.
    expect(() => execFileSync(process.execPath, ['--check', file])).not.toThrow();
  });
});
