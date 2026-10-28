import { encodeToken } from '@hive/shared';
import { linkSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCredentials,
  damagedMessage,
  inspectCredentials,
  credentialsPath,
  legacyHome,
  readCredentials,
  resolveToken,
  saveCredentials,
} from './credentials';

const token = encodeToken({
  w: 'w1',
  e: 'agent-abcdef123456@agents.hive-board.app',
  p: 'p'.repeat(32),
});

let saved: { home?: string; tok?: string };
beforeEach(() => {
  saved = { home: process.env.HIVENOD_HOME, tok: process.env.HIVENOD_TOKEN };
  process.env.HIVENOD_HOME = join(mkdtempSync(join(tmpdir(), 'hive-cred-')), 'home');
  delete process.env.HIVENOD_TOKEN;
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.HIVENOD_HOME;
  else process.env.HIVENOD_HOME = saved.home;
  if (saved.tok === undefined) delete process.env.HIVENOD_TOKEN;
  else process.env.HIVENOD_TOKEN = saved.tok;
});

describe('saved credentials', () => {
  it('are written to HIVENOD_HOME/agent.json, readable only by the owner', () => {
    const file = saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'Writer' });
    expect(file).toBe(credentialsPath());
    expect(file.endsWith('/home/agent.json')).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    expect(readCredentials()).toMatchObject({ token, agentName: 'Writer', agentUid: 'u1' });
  });

  it('are ignored when missing or not a token', () => {
    expect(readCredentials()).toBeNull();
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    writeFileSync(credentialsPath(), '{"token":"nope"}');
    expect(readCredentials()).toBeNull();
    writeFileSync(credentialsPath(), 'not json');
    expect(readCredentials()).toBeNull();
  });

  it('HIVENOD_TOKEN wins over the file', () => {
    expect(resolveToken()).toBeNull();
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    expect(resolveToken()).toEqual({ token, source: 'file' });
    process.env.HIVENOD_TOKEN = 'hive_agt_env';
    expect(resolveToken()).toEqual({ token: 'hive_agt_env', source: 'env' });
  });

  it('never reads the old hive names: HIVE_TOKEN, HIVE_HOME or ~/.hive (hard cut, card wQ7ZfmYr)', () => {
    const old = { tok: process.env.HIVE_TOKEN, home: process.env.HIVE_HOME };
    try {
      process.env.HIVE_TOKEN = 'hive_agt_old';
      process.env.HIVE_HOME = mkdtempSync(join(tmpdir(), 'hive-old-'));
      writeFileSync(join(process.env.HIVE_HOME, 'agent.json'), JSON.stringify({ token }));
      expect(resolveToken()).toBeNull();
      expect(credentialsPath()).not.toContain(process.env.HIVE_HOME);
      delete process.env.HIVENOD_HOME;
      expect(credentialsPath()).toBe(join(homedir(), '.hivenod', 'agent.json'));
      expect(legacyHome()).toBe(join(homedir(), '.hive'));
    } finally {
      if (old.tok === undefined) delete process.env.HIVE_TOKEN;
      else process.env.HIVE_TOKEN = old.tok;
      if (old.home === undefined) delete process.env.HIVE_HOME;
      else process.env.HIVE_HOME = old.home;
    }
  });

  it('logout removes them', () => {
    expect(clearCredentials()).toBe(false);
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    expect(clearCredentials()).toBe(true);
    expect(() => readFileSync(credentialsPath())).toThrow();
  });

  it('logout shreds the token: the file bytes are overwritten before it is deleted', () => {
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    const before = readFileSync(credentialsPath());
    // A second name for the same disk blocks shows what is left after logout.
    const spy = join(process.env.HIVENOD_HOME!, '..', 'blocks');
    linkSync(credentialsPath(), spy);
    expect(clearCredentials()).toBe(true);
    const after = readFileSync(spy);
    expect(after.length).toBe(before.length);
    expect(after.equals(before)).toBe(false);
    expect(after.toString('latin1')).not.toContain(token);
    expect(() => readFileSync(credentialsPath())).toThrow();
  });
});

describe('a damaged saved pairing is not "not paired"', () => {
  const damage: [string, string][] = [
    ['bad JSON', 'not json'],
    ['JSON without a token', '{"agentName":"W"}'],
    ['JSON null', 'null'],
    ['a token in the wrong format', '{"token":"nope"}'],
    ['the right prefix with a damaged tail', JSON.stringify({ token: `${token.slice(0, -6)}%%%` })],
    ['the right prefix and nothing else', '{"token":"hive_agt_"}'],
  ];

  it('inspect tells missing, damaged and ok apart', () => {
    expect(inspectCredentials().state).toBe('missing');
    for (const [, body] of damage) {
      saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
      writeFileSync(credentialsPath(), body);
      expect(inspectCredentials().state).toBe('damaged');
    }
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    expect(inspectCredentials().state).toBe('ok');
  });

  it('resolveToken throws the damaged message for every kind of damage, null when missing', () => {
    expect(resolveToken()).toBeNull();
    for (const [, body] of damage) {
      saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
      writeFileSync(credentialsPath(), body);
      expect(() => resolveToken()).toThrow(
        `The saved pairing in ${credentialsPath()} is damaged; run \`hivenod pair\` again.`,
      );
    }
    expect(damagedMessage()).toContain(credentialsPath());
  });

  it('HIVENOD_TOKEN still wins over a damaged file', () => {
    saveCredentials({ token, workspaceId: 'w1', agentUid: 'u1', agentName: 'W' });
    writeFileSync(credentialsPath(), 'not json');
    process.env.HIVENOD_TOKEN = 'hive_agt_env';
    expect(resolveToken()).toEqual({ token: 'hive_agt_env', source: 'env' });
  });
});
