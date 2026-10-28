import { encodeToken, HOSTED_FIREBASE } from '@hive/shared';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { firebaseApp, useFirebaseConfig } from './client';
import { credentialsPath, readCredentials, saveCredentials } from './credentials';
import { activeSite, resolveServer, serverFields, siteFor } from './server';

const token = encodeToken({
  w: 'w1',
  e: 'agent-abcdef123456@agents.hive-board.app',
  p: 'p'.repeat(32),
});
const VARS = [
  'HIVENOD_HOME',
  'HIVENOD_TOKEN',
  'HIVENOD_WEB_URL',
  'HIVENOD_FIREBASE_API_KEY',
  'HIVENOD_FIREBASE_PROJECT_ID',
  'HIVENOD_PROJECT_ID',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  process.env.HIVENOD_HOME = join(mkdtempSync(join(tmpdir(), 'hive-srv-')), 'home');
});
afterEach(() => {
  for (const k of VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  useFirebaseConfig(null);
});

const doc = {
  service: 'hivenod',
  protocol: 1,
  firebase: { apiKey: 'self-key', authDomain: 'your.host', projectId: 'self-proj' },
};
function fakeFetch(body: unknown = doc, status = 200) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(String(url));
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const noFetch = (async () => {
  throw new Error('must not fetch');
}) as unknown as typeof fetch;

describe('resolveServer', () => {
  it('the hosted service needs no network, with or without an old agent.json', async () => {
    expect(await resolveServer(undefined, null, noFetch)).toEqual({ site: 'https://hivenod.com' });
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'a', agentName: 'Bee' });
    expect(readCredentials()?.server).toBeUndefined();
    expect(await resolveServer(undefined, undefined, noFetch)).toEqual({
      site: 'https://hivenod.com',
    });
    expect(serverFields({ site: 'https://hivenod.com' })).toEqual({});
  });

  it('reads the discovery file of a self-hosted site and points Firebase at it', async () => {
    const { f, calls } = fakeFetch();
    const r = await resolveServer('your.host/', null, f);
    expect(calls).toEqual(['https://your.host/.well-known/hivenod.json']);
    expect(r.site).toBe('https://your.host');
    expect(r.discovery?.firebase.projectId).toBe('self-proj');
    expect(activeSite()).toBe('https://your.host');
    const { app } = firebaseApp();
    expect(app.options.projectId).toBe('self-proj');
    expect(app.options.apiKey).toBe('self-key');
  });

  it('saves the server with the token and uses the copy without reading the site again', async () => {
    const { f } = fakeFetch();
    const r = await resolveServer('https://your.host', null, f);
    saveCredentials({
      token,
      workspaceId: 'w1',
      agentUid: 'a',
      agentName: 'Bee',
      ...serverFields(r),
    });
    const raw = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    expect(raw.server).toBe('https://your.host');
    const again = await resolveServer(undefined, undefined, noFetch);
    expect(again.discovery?.firebase.apiKey).toBe('self-key');
  });

  it('HIVENOD_WEB_URL works like --server; explicit Firebase variables win', async () => {
    process.env.HIVENOD_WEB_URL = 'https://your.host';
    expect(siteFor(undefined, null)).toBe('https://your.host');
    process.env.HIVENOD_FIREBASE_API_KEY = 'env-key';
    expect(await resolveServer(undefined, null, noFetch)).toEqual({ site: 'https://your.host' });
  });

  it('HIVENOD_TOKEN ignores the server saved with another token', async () => {
    saveCredentials({
      token,
      workspaceId: 'w1',
      agentUid: 'a',
      agentName: 'Bee',
      server: 'https://your.host',
    });
    process.env.HIVENOD_TOKEN = token;
    expect(siteFor()).toBe('https://hivenod.com');
  });

  it('plain messages for a bad address or a site that is not Hivenod', async () => {
    await expect(resolveServer('http://your.host', null, noFetch)).rejects.toThrow(/https/);
    await expect(resolveServer('your.host', null, fakeFetch('<html>').f)).rejects.toThrow(
      /not JSON/,
    );
    await expect(resolveServer('your.host', null, fakeFetch('nope', 404).f)).rejects.toThrow(
      /answered 404/,
    );
    await expect(
      resolveServer('your.host', null, fakeFetch({ ...doc, protocol: 9 }).f),
    ).rejects.toThrow(/hivenod update/);
  });
});

describe('agent.json with a server', () => {
  const write = (extra: Record<string, unknown>) => {
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'a', agentName: 'Bee' });
    const raw = JSON.parse(readFileSync(credentialsPath(), 'utf8'));
    writeFileSync(credentialsPath(), JSON.stringify({ ...raw, ...extra }));
  };
  it('the hosted service written out is the same as none', () => {
    write({ server: 'https://hivenod.com/' });
    expect(readCredentials()?.server).toBeUndefined();
  });
  it('a copy for another site is dropped, emulators never stick to a public site', () => {
    const d = {
      protocol: 1,
      backend: 'firestore',
      site: 'https://other.host',
      firebase: HOSTED_FIREBASE,
      cli: 'x',
    };
    write({ server: 'your.host', discovery: d });
    expect(readCredentials()).toMatchObject({ server: 'https://your.host' });
    expect(readCredentials()?.discovery).toBeUndefined();
    write({
      server: 'your.host',
      discovery: { ...d, site: 'https://your.host', emulators: { auth: '127.0.0.1:9099' } },
    });
    expect(readCredentials()?.discovery?.emulators).toBeUndefined();
  });
  it('an unusable server makes the file damaged', () => {
    write({ server: 'http://your.host' });
    expect(readCredentials()).toBeNull();
  });
});
