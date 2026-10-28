/**
 * Where a paired terminal keeps its agent token: ~/.hivenod/agent.json (HIVENOD_HOME overrides the
 * folder). The folder is 0700 and the file 0600; it is written atomically. The token is never
 * printed: commands only show the agent's name and the file path. HIVENOD_TOKEN still wins.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodeToken } from '@hive/shared';
import { HiveError } from './errors';

export interface StoredCredentials {
  token: string;
  workspaceId: string;
  agentUid: string;
  agentName: string;
  savedAt: string;
}

export function hiveHome(): string {
  return process.env.HIVENOD_HOME || join(homedir(), '.hivenod');
}

/**
 * The old `hive` CLI's folder (before the rename to Hivenod). Never read; only kept out of reach of
 * the model, because a token saved there still works server-side.
 */
export function legacyHome(): string {
  return join(homedir(), '.hive');
}

export function credentialsPath(): string {
  return join(hiveHome(), 'agent.json');
}

/** What the saved file holds: nothing, something unusable, or a good token. */
export type SavedState =
  { state: 'missing' } | { state: 'damaged' } | { state: 'ok'; credentials: StoredCredentials };

export function damagedMessage(): string {
  return `The saved pairing in ${credentialsPath()} is damaged; run \`hivenod pair\` again.`;
}

/** Tells a missing file apart from an unreadable or corrupted one (bad JSON, bad token). */
export function inspectCredentials(): SavedState {
  let raw: string;
  try {
    raw = readFileSync(credentialsPath(), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'damaged' };
  }
  try {
    const c = JSON.parse(raw) as Partial<StoredCredentials> | null;
    if (!c || typeof c.token !== 'string') return { state: 'damaged' };
    decodeToken(c.token);
    return {
      state: 'ok',
      credentials: {
        token: c.token,
        workspaceId: String(c.workspaceId ?? ''),
        agentUid: String(c.agentUid ?? ''),
        agentName: String(c.agentName ?? ''),
        savedAt: String(c.savedAt ?? ''),
      },
    };
  } catch {
    return { state: 'damaged' };
  }
}

/** The saved credentials, or null when there are none (or the file is not usable). */
export function readCredentials(): StoredCredentials | null {
  const s = inspectCredentials();
  return s.state === 'ok' ? s.credentials : null;
}

export function saveCredentials(c: Omit<StoredCredentials, 'savedAt'>): string {
  const dir = hiveHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = credentialsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...c, savedAt: new Date().toISOString() }, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}

/**
 * Overwrites a file with random bytes (as long as the file), flushes it to disk, then deletes it,
 * so the token does not stay readable in freed disk blocks. Best effort on copy-on-write and
 * journaling file systems, like any shred.
 */
export function shredFile(file: string): void {
  const fd = openSync(file, 'r+');
  try {
    const size = fstatSync(fd).size;
    for (let pos = 0; pos < size;) {
      const chunk = randomBytes(Math.min(64 * 1024, size - pos));
      pos += writeSync(fd, chunk, 0, chunk.length, pos);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  rmSync(file, { force: true });
}

/** Logout: shreds the saved token. False when there was none. */
export function clearCredentials(): boolean {
  const file = credentialsPath();
  try {
    readFileSync(file);
  } catch {
    return false;
  }
  shredFile(file);
  return true;
}

/**
 * HIVENOD_TOKEN if set, else the saved token. Null when there is none; throws a HiveError when
 * the saved file exists but is damaged (not the same as "not paired").
 */
export function resolveToken(): { token: string; source: 'env' | 'file' } | null {
  const env = process.env.HIVENOD_TOKEN;
  if (env) return { token: env, source: 'env' };
  const saved = inspectCredentials();
  if (saved.state === 'damaged') throw new HiveError(damagedMessage());
  return saved.state === 'ok' ? { token: saved.credentials.token, source: 'file' } : null;
}
