/**
 * Pairing a terminal with Hivenod (card MkUwvyWs): `hivenod run claude` without credentials shows a
 * short code; an admin opens Hivenod, confirms the code and creates the agent; the browser hands the
 * new agent token to the waiting terminal, encrypted for a key only that terminal holds.
 *
 *   pairings/{code}   (code = 8 characters, also the doc id; firestore.rules "pairings")
 *     terminal creates it (no sign-in): { publicKey, cli, host, folder, status: 'pending', createdAt }
 *     an admin completes it:            + { status: 'paired', workspaceId, agentUid, agentName,
 *                                           pairedBy, pairedAt, sealed: { epk, iv, ct } }
 *     the terminal (signed in as the new agent) deletes it once it has the token.
 *
 * Crypto: ECDH P-256 (terminal key + one-time browser key) -> HKDF-SHA-256 (info = code) ->
 * AES-256-GCM (additional data = code). WebCrypto only, so the same code runs in the browser and
 * in Node 22. The token itself never touches Firestore in clear text.
 */
import { z } from 'zod';
import { SERVER_TIME } from './actions';
import { timestamp } from './schema';
import { fromBase64Url, toBase64Url } from './token';

/** No 0/O, 1/I/L: easy to read out loud and type. 31 symbols, 8 of them: about 40 bits. */
export const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_LENGTH = 8;
/** How long a code can be confirmed (mirrored in firestore.rules). */
export const PAIRING_TTL_MS = 15 * 60_000;

export function newPairingCode(): string {
  const out: string[] = [];
  const n = PAIRING_CODE_ALPHABET.length;
  // Rejection sampling keeps every symbol equally likely.
  while (out.length < PAIRING_CODE_LENGTH) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 256 - (256 % n) && out.length < PAIRING_CODE_LENGTH)
        out.push(PAIRING_CODE_ALPHABET[b % n] as string);
    }
  }
  return out.join('');
}

/** K7QX29PD -> K7QX-29PD */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a person typed or pasted -> the stored code, or null when it cannot be one. */
export function normalizePairingCode(text: string): string | null {
  const c = text.toUpperCase().replace(/[\s-]/g, '');
  if (c.length !== PAIRING_CODE_LENGTH) return null;
  for (const ch of c) if (!PAIRING_CODE_ALPHABET.includes(ch)) return null;
  return c;
}

export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, '')}/agents/connect?code=${formatPairingCode(code)}`;
}

export const pairingPath = (code: string) => `pairings/${code}`;

/** What the terminal writes (no sign-in needed; firestore.rules "pairings"). */
export function pairingRequest(input: {
  publicKey: string;
  cli: string;
  host: string;
  folder: string;
}) {
  return {
    publicKey: input.publicKey,
    cli: input.cli.slice(0, 40),
    host: input.host.slice(0, 80),
    folder: input.folder.slice(0, 120),
    status: 'pending' as const,
    createdAt: SERVER_TIME,
  };
}

/** What the admin's browser adds once the agent exists. */
export function pairingCompletion(input: {
  workspaceId: string;
  agentUid: string;
  agentName: string;
  pairedBy: string;
  sealed: Sealed;
}) {
  return { status: 'paired' as const, ...input, pairedAt: SERVER_TIME };
}

export const sealedSchema = z.object({
  epk: z.string().min(1).max(200),
  iv: z.string().min(1).max(40),
  ct: z.string().min(1).max(2000),
});
export type Sealed = z.infer<typeof sealedSchema>;

export const pairingSchema = z.object({
  publicKey: z.string().min(80).max(200),
  cli: z.string().max(40),
  host: z.string().max(80),
  folder: z.string().max(120),
  status: z.enum(['pending', 'paired']),
  createdAt: timestamp,
  workspaceId: z.string().max(128).optional(),
  agentUid: z.string().max(128).optional(),
  agentName: z.string().max(80).optional(),
  pairedBy: z.string().max(128).optional(),
  pairedAt: timestamp.optional(),
  sealed: sealedSchema.optional(),
});
export type Pairing = z.infer<typeof pairingSchema>;

const EC = { name: 'ECDH', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();

export interface PairingKeys {
  /** Raw P-256 point, base64url; goes into the pairing doc. */
  publicKey: string;
  /** Stays in the terminal's memory. */
  privateKey: CryptoKey;
}

export async function pairingKeys(): Promise<PairingKeys> {
  const pair = await crypto.subtle.generateKey(EC, false, ['deriveBits']);
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey: toBase64Url(raw), privateKey: pair.privateKey };
}

const bytes = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

async function aesKey(privateKey: CryptoKey, peerPublic: string, code: string) {
  const peer = await crypto.subtle.importKey(
    'raw',
    bytes(fromBase64Url(peerPublic)),
    EC,
    false,
    [],
  );
  const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: enc.encode(`hive-pair:${code}`),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Browser side: encrypt the new agent's token for the terminal that showed `code`. */
export async function sealToken(
  token: string,
  terminalPublicKey: string,
  code: string,
): Promise<Sealed> {
  const eph = await crypto.subtle.generateKey(EC, false, ['deriveBits']);
  const key = await aesKey(eph.privateKey, terminalPublicKey, code);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(code) },
    key,
    enc.encode(token),
  );
  return {
    epk: toBase64Url(new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey))),
    iv: toBase64Url(iv),
    ct: toBase64Url(new Uint8Array(ct)),
  };
}

/** Terminal side: decrypt what the browser sealed. Throws if anything does not match. */
export async function openToken(
  sealed: Sealed,
  privateKey: CryptoKey,
  code: string,
): Promise<string> {
  const key = await aesKey(privateKey, sealed.epk, code);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes(fromBase64Url(sealed.iv)), additionalData: enc.encode(code) },
    key,
    bytes(fromBase64Url(sealed.ct)),
  );
  return new TextDecoder().decode(pt);
}
