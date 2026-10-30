/**
 * Self-hosting end to end, locally (item 07W4gCboOicS0lM1bqwZ): a Hosting emulator serves the
 * site's /.well-known/hivenod.json through the repo's own firebase.json (rewrite and headers),
 * pointing at the Auth and Firestore emulators. The Go CLI, given nothing but the site's address
 * (`hivenod pair --server http://127.0.0.1:<port>`, no HIVENOD_FIREBASE_* or emulator variables),
 * pairs, saves the server with its token, and later commands find it again from agent.json alone.
 * Needs Go and the Auth/Firestore emulators (pnpm test:rules); the Hosting emulator is started
 * here, on free ports, and stopped by its own PID.
 */
import { createAgentIdentity } from '@hive/shared/agent-auth';
import { discoveryDocument, parseDiscovery } from '@hive/shared/discovery';
import { pairingCompletion, pairingPath, paths, sealToken } from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, now, put, reset, snap, useEmulator, W } from '../../../packages/shared/rules/harness';
import { GO, goBinary, REPO } from './gobin';

useEmulator();

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const FS_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const PROJECT = 'hive-rules-test';
const options = { apiKey: 'fake-api-key', projectId: PROJECT };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

let BIN = '';
let SITE = '';
let hosting: ChildProcess | null = null;
let hostingLog = '';

beforeAll(async () => {
  if (!GO) return;
  BIN = goBinary();
  const [port, hub, logging] = [await freePort(), await freePort(), await freePort()];
  SITE = `http://127.0.0.1:${port}`;
  // The site: the repo's hosting config (rewrites, headers) over a folder with only the
  // discovery file, as the web build writes it, pointing at the running emulators.
  const dir = mkdtempSync(join(tmpdir(), 'hivenod-site-'));
  mkdirSync(join(dir, 'public', 'well-known'), { recursive: true });
  writeFileSync(
    join(dir, 'public', 'well-known', 'hivenod.json'),
    JSON.stringify(
      discoveryDocument(
        {
          apiKey: 'fake-api-key',
          authDomain: '127.0.0.1',
          projectId: PROJECT,
          appId: '',
          messagingSenderId: '',
        },
        { emulators: { auth: AUTH_HOST, firestore: FS_HOST } },
      ),
    ),
  );
  writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html><title>Hivenod</title>');
  const repoConfig = JSON.parse(readFileSync(join(REPO, 'firebase.json'), 'utf8'));
  const app = repoConfig.hosting.find((h: { target?: string }) => h.target === 'app');
  const site = { ...app };
  delete site.target;
  writeFileSync(
    join(dir, 'firebase.json'),
    JSON.stringify({
      hosting: { ...site, public: 'public' },
      emulators: {
        hosting: { port, host: '127.0.0.1' },
        hub: { port: hub, host: '127.0.0.1' },
        logging: { port: logging, host: '127.0.0.1' },
        ui: { enabled: false },
        singleProjectMode: true,
      },
    }),
  );
  hosting = spawn(
    join(REPO, 'node_modules/.bin/firebase'),
    ['emulators:start', '--only', 'hosting', '--project', PROJECT],
    { cwd: dir, env: { ...process.env, FIREBASE_CLI_DISABLE_UPDATE_CHECK: '1' } },
  );
  hosting.stdout?.on('data', (d: Buffer) => (hostingLog += d.toString()));
  hosting.stderr?.on('data', (d: Buffer) => (hostingLog += d.toString()));
  const until = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${SITE}/.well-known/hivenod.json`);
      if (r.status === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > until || hosting.exitCode !== null)
      throw new Error(`Hosting emulator did not start:\n${hostingLog}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}, 300_000);

afterAll(async () => {
  // Only the emulator this file started, by its own PID.
  if (hosting?.pid && hosting.exitCode === null) {
    const gone = new Promise((r) => hosting!.once('exit', r));
    hosting.kill('SIGINT');
    await Promise.race([gone, new Promise((r) => setTimeout(r, 10_000))]);
    if (hosting.exitCode === null) hosting.kill('SIGKILL');
  }
}, 30_000);

describe.skipIf(!GO)('self-hosted site: the CLI needs only its address', () => {
  it('serves the discovery file at /.well-known/hivenod.json, as JSON, readable cross-origin', async () => {
    const r = await fetch(`${SITE}/.well-known/hivenod.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/application\/json/);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const d = parseDiscovery(SITE, await r.json());
    expect(d.firebase.projectId).toBe(PROJECT);
    expect(d.emulators).toEqual({ auth: AUTH_HOST, firestore: FS_HOST });
  });

  it('hivenod pair --server <site> pairs with no Firebase variables, and whoami finds the server again', async () => {
    await reset();
    const { uid, token } = await createAgentIdentity(options, W, {
      authEmulatorUrl: `http://${AUTH_HOST}`,
    });
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    // Nothing but PATH and a home folder: no project, key or emulator variables.
    const env = { PATH: process.env.PATH ?? '', HOME: home, HIVENOD_HOME: home };
    const child = spawn(BIN, ['pair', '--server', `${SITE}/`], { env });
    let said = '';
    child.stdout.on('data', (d: Buffer) => (said += d.toString()));
    child.stderr.on('data', (d: Buffer) => (said += d.toString()));
    const exited = new Promise<number | null>((r) => child.once('exit', r));
    await expect.poll(() => said, { timeout: 15_000 }).toMatch(/confirm the code/);
    const code = /code=([A-Z0-9]{4})-([A-Z0-9]{4})/.exec(said)!.slice(1).join('');
    // The link points at the self-hosted site, not at the hosted service.
    expect(said).toContain(`${SITE}/agents/connect?code=${code.slice(0, 4)}-${code.slice(4)}`);
    expect(said).not.toContain('hivenod.com');
    const owner = as('owner');
    const req = await getDoc(doc(owner.db, pairingPath(code)));
    expect(req.data()).toMatchObject({ status: 'pending', cli: 'claude' });
    await put({
      [paths.agent(W, uid)]: {
        name: 'Self-hosted bee',
        color: '#2F5FD0',
        createdBy: 'owner',
        createdAt: now(),
        revokedAt: null,
        lastSeenAt: null,
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    });
    const sealed = await sealToken(token, req.data()!.publicKey as string, code);
    await updateDoc(
      doc(owner.db, pairingPath(code)),
      toFirestoreValue(
        pairingCompletion({
          workspaceId: W,
          agentUid: uid,
          agentName: 'Self-hosted bee',
          pairedBy: 'owner',
          sealed,
        }),
      ) as Record<string, unknown>,
    );
    expect(await exited, said).toBe(0);
    expect(said).toContain('Paired: this machine is now the agent Self-hosted bee');
    expect(said).not.toContain(token);
    expect(await snap(pairingPath(code))).toEqual({});
    const saved = JSON.parse(readFileSync(join(home, 'agent.json'), 'utf8'));
    expect(saved).toMatchObject({
      token,
      agentName: 'Self-hosted bee',
      server: SITE,
      discovery: { site: SITE, firebase: { projectId: PROJECT } },
    });

    // Later commands: no --server, no variables; the server comes from agent.json.
    const who = spawnSync(BIN, ['whoami', '--json'], { encoding: 'utf8', env });
    expect(who.status, who.stderr).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ agentUid: uid, workspaceId: W });

    // The saved discovery carries the emulators too, so nothing else is needed later.
    expect(saved.discovery.emulators).toEqual({ auth: AUTH_HOST, firestore: FS_HOST });
  }, 90_000);

  it('a site that is not Hivenod gets a plain message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hivenod-home-'));
    const res = spawnSync(BIN, ['pair', '--server', `${SITE}/nothing-here`], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home, HIVENOD_HOME: home },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('does not look like a Hivenod site');
  }, 30_000);
});
