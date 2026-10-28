/**
 * Pairing this terminal with Hivenod (card MkUwvyWs): show a short code, wait until an admin confirms
 * it in Hivenod, receive the new agent's token encrypted for a key that never leaves this process.
 * See packages/shared/src/pairing.ts for the protocol and firestore.rules "pairings" for who may
 * do what.
 */
import { hostname } from 'node:os';
import { basename } from 'node:path';
import {
  formatPairingCode,
  newPairingCode,
  openToken,
  PAIRING_TTL_MS,
  pairingKeys,
  pairingPath,
  pairingRequest,
  pairingSchema,
  pairingUrl,
  type Pairing,
} from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { deleteApp } from 'firebase/app';
import { deleteDoc, doc, onSnapshot, setDoc, terminate } from 'firebase/firestore';
import { firebaseApp, type ConnectOptions } from './client';
import { errorCode, HiveError } from './errors';

// Self-hosting: HIVENOD_WEB_URL points the CLI at your own deployment (docs/SELF-HOST.md).
export const HIVENOD_WEB_URL = process.env.HIVENOD_WEB_URL || 'https://hivenod.com';

export interface Paired {
  code: string;
  token: string;
  workspaceId: string;
  agentUid: string;
  agentName: string;
}

export interface PairOptions extends Pick<
  ConnectOptions,
  'authEmulator' | 'firestoreEmulator' | 'projectId'
> {
  cli: string;
  /** Prints one line to the person at the terminal. */
  say: (line: string) => void;
  folder?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function pairTerminal(opts: PairOptions): Promise<Paired> {
  const keys = await pairingKeys();
  const { app, db } = firebaseApp(opts);
  let code: string;
  try {
    const request = toFirestoreValue(
      pairingRequest({
        publicKey: keys.publicKey,
        cli: opts.cli,
        host: hostname(),
        folder: opts.folder ?? basename(process.cwd()),
      }),
    ) as Record<string, unknown>;
    for (let attempt = 0; ; attempt++) {
      code = newPairingCode();
      try {
        await setDoc(doc(db, pairingPath(code)), request);
        break;
      } catch (e) {
        // Denied means the code is taken (a create cannot overwrite): draw another one.
        if (errorCode(e) !== 'permission-denied' || attempt >= 4) throw e;
      }
    }
    const web = process.env.HIVENOD_WEB_URL || HIVENOD_WEB_URL;
    const ttl = opts.timeoutMs ?? PAIRING_TTL_MS;
    opts.say(`This terminal is not connected to Hivenod yet. To connect it, open`);
    opts.say(`  ${pairingUrl(web, code)}`);
    opts.say(
      `and confirm the code ${formatPairingCode(code)} (Agents, Connect a terminal). It expires in ${Math.round(ttl / 60_000)} minutes.`,
    );
    opts.say('Waiting for confirmation… (Ctrl+C to cancel)');
    const paired = await waitForPairing(db, code, ttl, opts.signal);
    if (!paired) {
      await deleteDoc(doc(db, pairingPath(code))).catch(() => undefined);
      throw new HiveError(
        opts.signal?.aborted
          ? 'Pairing cancelled.'
          : 'The code expired before anyone confirmed it. Run the command again for a new code.',
      );
    }
    let token: string;
    try {
      token = await openToken(paired.sealed!, keys.privateKey, code);
    } catch {
      throw new HiveError(
        'Hivenod answered, but the token could not be decrypted for this terminal. Run the command again for a new code.',
      );
    }
    return {
      code,
      token,
      workspaceId: paired.workspaceId!,
      agentUid: paired.agentUid!,
      agentName: paired.agentName ?? 'agent',
    };
  } finally {
    await terminate(db).catch(() => undefined);
    await deleteApp(app).catch(() => undefined);
  }
}

function waitForPairing(
  db: ReturnType<typeof firebaseApp>['db'],
  code: string,
  ttl: number,
  signal?: AbortSignal,
): Promise<Pairing | null> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (v: Pairing | null, err?: unknown) => {
      if (done) return;
      done = true;
      stop();
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve(v);
    };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), ttl);
    if (signal?.aborted) {
      setTimeout(onAbort, 0);
    }
    signal?.addEventListener('abort', onAbort);
    const stop = onSnapshot(
      doc(db, pairingPath(code)),
      (snap) => {
        if (snap.metadata.fromCache || !snap.exists()) return;
        const p = pairingSchema.safeParse(snap.data());
        if (p.success && p.data.status === 'paired' && p.data.sealed) finish(p.data);
      },
      (e) => finish(null, e),
    );
  });
}
