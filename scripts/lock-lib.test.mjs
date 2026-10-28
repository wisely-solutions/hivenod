import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAlive } from './lock-lib.mjs';

describe('isAlive', () => {
  it('is true for this process and false for junk pids', () => {
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(NaN)).toBe(false);
    expect(isAlive(0)).toBe(false);
  });
  it('treats ESRCH as dead and EPERM as alive', () => {
    expect(
      isAlive(5, () => {
        throw Object.assign(new Error(), { code: 'ESRCH' });
      }),
    ).toBe(false);
    expect(
      isAlive(5, () => {
        throw Object.assign(new Error(), { code: 'EPERM' });
      }),
    ).toBe(true);
  });
});

describe('with-lock.mjs', () => {
  const script = new URL('./with-lock.mjs', import.meta.url).pathname;
  it('runs the command, passes the exit code and releases the lock', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'lk-')), 'l');
    const env = { ...process.env, HIVE_LOCK_DIR: lock };
    const r = spawnSync('node', [script, 'node', '-e', 'process.exit(7)'], { env });
    expect(r.status).toBe(7);
    expect(existsSync(lock)).toBe(false);
  });
  it('takes over a lock whose holder is dead', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'lk-')), 'l');
    const env = { ...process.env, HIVE_LOCK_DIR: lock };
    spawnSync('node', [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(lock)});require('fs').writeFileSync(${JSON.stringify(lock + '/pid')},'999999999\\n')`,
    ]);
    const r = spawnSync('node', [script, 'node', '-e', 'process.exit(0)'], { env });
    expect(r.status).toBe(0);
  });
  it('waits for a live holder, then gives up at the timeout', () => {
    const lock = join(mkdtempSync(join(tmpdir(), 'lk-')), 'l');
    spawnSync('node', [
      '-e',
      `require('fs').mkdirSync(${JSON.stringify(lock)});require('fs').writeFileSync(${JSON.stringify(lock + '/pid')},'${process.pid}\\n')`,
    ]);
    const env = { ...process.env, HIVE_LOCK_DIR: lock, HIVE_LOCK_TIMEOUT_MIN: '0.01' };
    const r = spawnSync('node', [script, 'node', '-e', 'process.exit(0)'], { env });
    expect(r.status).toBe(1);
  });
});
