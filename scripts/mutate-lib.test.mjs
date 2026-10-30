import { describe, expect, it } from 'vitest';
import { assertWellFormed } from '../packages/shared/rules/mutate-lib.mjs';

describe('rules mutation list validation', () => {
  it('accepts well-formed entries', () => {
    expect(() =>
      assertWellFormed([
        ['a', [['x', 'y']]],
        ['b', [['x', '']]],
      ]),
    ).not.toThrow();
  });
  it('rejects an entry that swallowed the next one (missing bracket)', () => {
    expect(() => assertWellFormed([['a', [['x', 'y']], 'b', [['x', 'z']]]])).toThrow(
      /entry #1 "a".*2 items.*got 4/s,
    );
  });
  it('rejects bad names and edits', () => {
    expect(() => assertWellFormed([['', [['x', 'y']]]])).toThrow(/name/);
    expect(() => assertWellFormed([['a', []]])).toThrow(/non-empty/);
    expect(() => assertWellFormed([['a', [['x']]]])).toThrow(/\[find, replace\]/);
  });
});

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEdits, hasMutationLeftover } from '../packages/shared/rules/mutate-lib.mjs';

const ROOT = join(import.meta.dirname, '..');

describe('mutation leftovers guard', () => {
  it('tags every edit, including deletions', () => {
    const out = applyEdits('a b c', [
      ['b', 'X'],
      ['c', ''],
    ]);
    expect(out).toBe('a X/*MUTATED*/ /*MUTATED*/');
    expect(hasMutationLeftover(out)).toBe(true);
  });
  it('catches a fixture and passes clean rules', () => {
    expect(hasMutationLeftover('allow read: if true /*MUTATED*/;')).toBe(true);
    expect(hasMutationLeftover('allow read: if false;')).toBe(false);
  });
  it('the tracked firestore.rules has no leftover and no marker file exists', () => {
    expect(hasMutationLeftover(readFileSync(join(ROOT, 'firestore.rules'), 'utf8'))).toBe(false);
    expect(existsSync(join(ROOT, '.firestore.rules.mutating'))).toBe(false);
  });
});

describe('mutate.mjs runner', () => {
  const rulesPath = join(ROOT, 'firestore.rules');
  // A fake suite: passes on clean rules, fails on mutated ones (like a test catching the mutation).
  const FAKE = 'if grep -q MUTATED "$HIVE_RULES_FILE"; then exit 1; else exit 0; fi';
  const run = (env) =>
    new Promise((resolve) => {
      const c = spawn('node', ['packages/shared/rules/mutate.mjs'], {
        cwd: ROOT,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code, out }));
    });

  it('MUTATE_ONLY on 2 mutations reports them caught and leaves firestore.rules alone', async () => {
    const before = readFileSync(rulesPath, 'utf8');
    const r = await run({
      MUTATE_SUITE_CMD: FAKE,
      MUTATE_ONLY: 'summary: 6 bullets,send back: any count',
    });
    expect(r.out).toContain('caught    summary: 6 bullets');
    expect(r.out).toContain('caught    send back: any count');
    expect(r.out).toContain('2/2 mutations caught');
    expect(r.code).toBe(0);
    expect(readFileSync(rulesPath, 'utf8')).toBe(before);
  }, 30000);

  it('a SIGTERM mid-run leaves firestore.rules unchanged', async () => {
    const before = readFileSync(rulesPath, 'utf8');
    const dir = mkdtempSync(join(tmpdir(), 'mutate-kill-'));
    const ready = join(dir, 'ready');
    // Clean rules pass at once; the first mutation hangs, as a timed-out run would.
    const hang = `if grep -q MUTATED "$HIVE_RULES_FILE"; then touch ${ready}; sleep 60; else exit 0; fi`;
    const c = spawn('node', ['packages/shared/rules/mutate.mjs'], {
      cwd: ROOT,
      env: { ...process.env, MUTATE_SUITE_CMD: hang, MUTATE_ONLY: 'summary: 6 bullets' },
      stdio: 'ignore',
    });
    const exited = new Promise((res) => c.on('close', res));
    for (let i = 0; i < 100 && !existsSync(ready); i++)
      await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(ready)).toBe(true);
    c.kill('SIGTERM'); // our own child
    await exited;
    expect(readFileSync(rulesPath, 'utf8')).toBe(before);
    expect(hasMutationLeftover(readFileSync(rulesPath, 'utf8'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
