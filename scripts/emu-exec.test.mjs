import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { pickPorts, preferredPorts, RULES_OFFSET } from './e2e-lib.mjs';
import { emuExecPlan } from './emu-exec-lib.mjs';

describe('ports for emulator runs other than the e2e (card 6gP0LNYO)', () => {
  it('gives rules runs the second half of the worktree block, so they never clash with its e2e', () => {
    const e2e = preferredPorts('/w/a');
    const rules = preferredPorts('/w/a', RULES_OFFSET);
    expect(rules.auth).toBe(e2e.auth + 5);
    expect(rules.websocket).toBe(e2e.auth + 9);
    expect(Object.values(rules).some((p) => Object.values(e2e).includes(p))).toBe(false);
  });
  it('pickPorts keeps the offset block when it is free', async () => {
    expect(await pickPorts('/r', async (p) => p, RULES_OFFSET)).toEqual(
      preferredPorts('/r', RULES_OFFSET),
    );
  });
});

describe('emuExecPlan', () => {
  const ports = { auth: 21005, firestore: 21006, hub: 21007, logging: 21008, websocket: 21009 };
  const plan = emuExecPlan({
    root: '/repo',
    config: '/t/firebase.json',
    tmp: '/t',
    ports,
    cmd: 'pnpm --filter @hive/shared test:rules',
    env: { PATH: '/bin', TMPDIR: '/tmp' },
  });
  it('runs the repo firebase with the run config, auth and firestore only', () => {
    expect(plan.file).toBe('/repo/node_modules/.bin/firebase');
    expect(plan.args).toEqual([
      'emulators:exec',
      '--config',
      '/t/firebase.json',
      '--only',
      'auth,firestore',
      '--project',
      'hive-board-43be',
      'pnpm --filter @hive/shared test:rules',
    ]);
  });
  it('gives the run its own TMPDIR (the hub locator file) and the emulator hosts', () => {
    expect(plan.env).toMatchObject({
      PATH: '/bin',
      TMPDIR: '/t',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:21006',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:21005',
      E2E_FRESH_SERVER: '1',
    });
  });
});

describe('emu-exec.mjs', () => {
  const script = new URL('./emu-exec.mjs', import.meta.url).pathname;
  it('refuses to run without a command', () => {
    const r = spawnSync('node', [script], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Usage/);
  });
});

describe('no machine-wide emulator lock left', () => {
  it('package.json runs every emulator script through emu-exec', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    for (const [name, s] of Object.entries(pkg.scripts)) {
      expect(s, name).not.toMatch(/with-lock/);
      if (/emulators:exec/.test(s)) throw new Error(`${name} starts emulators on fixed ports`);
    }
    expect(pkg.scripts['test:rules']).toMatch(/^node scripts\/emu-exec\.mjs /);
  });
});
