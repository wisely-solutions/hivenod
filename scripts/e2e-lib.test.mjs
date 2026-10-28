import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStamp, emulatorConfig, pickPorts, preferredPorts, probe } from './e2e-lib.mjs';

describe('preferredPorts', () => {
  it('is stable per worktree, below the ephemeral range, and differs between worktrees', () => {
    const a = preferredPorts('/home/user/worktrees/a');
    expect(preferredPorts('/home/user/worktrees/a')).toEqual(a);
    expect(a.auth).toBeGreaterThanOrEqual(20000);
    expect(a.websocket).toBeLessThan(32768);
    expect(Object.values(a)).toEqual([a.auth, a.auth + 1, a.auth + 2, a.auth + 3, a.auth + 4]);
    expect(preferredPorts('/home/user/worktrees/b').auth).not.toBe(a.auth);
  });
});

describe('pickPorts', () => {
  it('keeps the worktree ports when all are free', async () => {
    const ports = await pickPorts('/r', async (p) => p);
    expect(ports).toEqual(preferredPorts('/r'));
  });
  it('falls back to distinct free ports when one is taken', async () => {
    const taken = preferredPorts('/r').hub;
    let next = 40000;
    const ports = await pickPorts('/r', async (p) => (p === taken ? null : p === 0 ? next++ : p));
    expect(ports).toEqual({
      auth: 40000,
      firestore: 40001,
      hub: 40002,
      logging: 40003,
      websocket: 40004,
    });
  });
  it('probes real ports', async () => {
    const p = await probe(0);
    expect(p).toBeGreaterThan(0);
  });
});

describe('emulatorConfig', () => {
  it('points rules at the repo and every emulator at its port', () => {
    const c = emulatorConfig('/repo', {
      auth: 1,
      firestore: 2,
      hub: 3,
      logging: 4,
      websocket: 5,
    });
    expect(c.firestore.rules).toBe('/repo/firestore.rules');
    expect(c.emulators).toMatchObject({
      auth: { port: 1 },
      firestore: { port: 2, websocketPort: 5 },
      hub: { port: 3 },
      logging: { port: 4 },
      ui: { enabled: false },
    });
  });
});

describe('buildStamp', () => {
  it('changes with the sources and with VITE_* settings, not with other env', () => {
    const root = mkdtempSync(join(tmpdir(), 'stamp-'));
    mkdirSync(join(root, 'apps/web/src'), { recursive: true });
    writeFileSync(join(root, 'apps/web/src/a.ts'), 'one');
    const env = { VITE_USE_EMULATOR: '1', HOME: '/x' };
    const s1 = buildStamp(root, env);
    expect(buildStamp(root, { ...env, HOME: '/y' })).toBe(s1);
    expect(buildStamp(root, { ...env, VITE_AUTH_EMULATOR_PORT: '9' })).not.toBe(s1);
    writeFileSync(join(root, 'apps/web/src/a.ts'), 'two');
    expect(buildStamp(root, env)).not.toBe(s1);
  });
});
