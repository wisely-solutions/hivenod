/**
 * The Go CLI as an agent (`hivenod mcp`, black box; Go-only since item MlWOc3O5NyfZcLgetrVo),
 * against the real Auth and Firestore emulators and the real rules. Projects were removed (item
 * OE8FmrTaIxFVGcaeGG3N, slice 11): what is left here is the agent itself (revoked, whoami) and
 * pairing; the thread tools are covered by go.test.ts and channel.test.ts.
 */
import { pairingPath } from '@hive/shared';
import { spawn } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { snap, useEmulator } from '../../../packages/shared/rules/harness';
import { GoAgent, newAgent } from './agentcli';
import { GO, goBinary, goEnv } from './gobin';

useEmulator();

const d = GO ? describe : describe.skip;
beforeAll(() => {
  if (GO) goBinary();
}, 300_000);

const clients: GoAgent[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(a: { uid: string; token: string }) {
  const c = await GoAgent.start(a.uid, a.token);
  clients.push(c);
  return c;
}

d('the Go CLI as an agent, against the emulators', () => {
  it('tells a revoked agent plainly', async () => {
    const c = await connect(await newAgent({ revoked: true }));
    await expect(c.call('inbox_list')).rejects.toThrow(/revoked/);
    expect(() => c.whoami()).toThrow(/revoked/);
  });

  it('whoami shows the settings with defaults for an agent that never had them', async () => {
    const c = await connect(await newAgent());
    expect(c.whoami()).toMatchObject({
      paused: false,
      guardrails: { maxFailedRuns: 3 },
    });
    expect(c.whoami()).not.toHaveProperty('permissions');
    expect(c.whoami()).not.toHaveProperty('projectIds');
  });

  it('an item tool of an old session says projects were removed (slice 11)', async () => {
    const c = await connect(await newAgent());
    await expect(c.call('list_work')).rejects.toThrow(
      /Projects were removed from Hivenod; work arrives as Inbox threads/,
    );
  });
});

d('pairing (Go CLI)', () => {
  it('cancelling hivenod pair (Ctrl+C) deletes its pending pairing doc (card PXOzcYeG)', async () => {
    const child = spawn(goBinary(), ['pair'], { env: goEnv() });
    let said = '';
    child.stdout.on('data', (b: Buffer) => (said += b.toString()));
    child.stderr.on('data', (b: Buffer) => (said += b.toString()));
    const gone = new Promise((r) => child.once('exit', r));
    try {
      await expect.poll(() => said, { timeout: 15_000 }).toMatch(/confirm the code/);
      const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
      expect(Object.keys(await snap(pairingPath(code))).length).toBeGreaterThan(0);
      child.kill('SIGINT');
      await gone;
      expect(await snap(pairingPath(code))).toEqual({});
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
