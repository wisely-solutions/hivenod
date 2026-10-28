import { describe, expect, it } from 'vitest';
import {
  CONNECT_TTL_MS,
  connectUrl,
  formatPairingCode,
  newPairingCode,
  normalizePairingCode,
  openToken,
  PAIRING_CODE_ALPHABET,
  pairingKeys,
  pairingRequest,
  pairingSchema,
  pairingTtlMs,
  PAIRING_TTL_MS,
  pairingUrl,
  sealToken,
} from './pairing';

describe('pairing codes', () => {
  it('are 8 characters from an unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const c = newPairingCode();
      expect(c).toMatch(/^[A-Z2-9]{8}$/);
      for (const ch of c) expect(PAIRING_CODE_ALPHABET).toContain(ch);
    }
    expect(PAIRING_CODE_ALPHABET).not.toMatch(/[01IOL]/);
  });
  it('format as XXXX-XXXX and normalize back from what people type', () => {
    expect(formatPairingCode('K7QX29PD')).toBe('K7QX-29PD');
    expect(normalizePairingCode(' k7qx-29pd ')).toBe('K7QX29PD');
    expect(normalizePairingCode('k7qx 29pd')).toBe('K7QX29PD');
    expect(normalizePairingCode('K7QX-29P')).toBeNull();
    expect(normalizePairingCode('K7QX-29P0')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });
  it('builds the link an admin opens', () => {
    expect(pairingUrl('https://hive.example', 'K7QX29PD')).toBe(
      'https://hive.example/agents/connect?code=K7QX-29PD',
    );
  });
});

describe('connect requests (hivenod connect)', () => {
  it('link to the one-click confirm page', () => {
    expect(connectUrl('https://hivenod.com/', 'K7QX29PD')).toBe(
      'https://hivenod.com/connect?code=K7QX-29PD',
    );
  });
  it('carry kind connect and last 10 minutes; a pair request has no kind and lasts 15', () => {
    const base = { publicKey: 'k', cli: 'claude', host: 'laptop', folder: 'blog' };
    expect(pairingRequest({ ...base, kind: 'connect' }).kind).toBe('connect');
    expect('kind' in pairingRequest(base)).toBe(false);
    expect(pairingTtlMs({ kind: 'connect' })).toBe(CONNECT_TTL_MS);
    expect(CONNECT_TTL_MS).toBe(10 * 60_000);
    expect(pairingTtlMs({})).toBe(PAIRING_TTL_MS);
  });
});

describe('sealing the token for the waiting terminal', () => {
  const token = 'hive_agt_' + 'a'.repeat(120);

  it('round-trips with the terminal key and is bound to the code', async () => {
    const keys = await pairingKeys();
    const sealed = await sealToken(token, keys.publicKey, 'K7QX29PD');
    expect(JSON.stringify(sealed)).not.toContain(token);
    expect(await openToken(sealed, keys.privateKey, 'K7QX29PD')).toBe(token);
    await expect(openToken(sealed, keys.privateKey, 'AAAABBBB')).rejects.toThrow();
  });

  it('cannot be opened with another key', async () => {
    const a = await pairingKeys();
    const b = await pairingKeys();
    const sealed = await sealToken(token, a.publicKey, 'K7QX29PD');
    await expect(openToken(sealed, b.privateKey, 'K7QX29PD')).rejects.toThrow();
  });

  it('rejects a public key that is not a P-256 point', async () => {
    await expect(sealToken(token, 'abc', 'K7QX29PD')).rejects.toThrow();
  });
});

describe('pairing doc schema', () => {
  it('accepts a pending request and a paired one', () => {
    const base = {
      publicKey: 'x'.repeat(87),
      cli: 'claude',
      host: 'laptop',
      folder: 'launch-blog',
      status: 'pending',
      createdAt: { seconds: 0, nanoseconds: 0, toMillis: () => 0 },
    };
    expect(pairingSchema.safeParse(base).success).toBe(true);
    expect(
      pairingSchema.safeParse({
        ...base,
        status: 'paired',
        workspaceId: 'w1',
        agentUid: 'u1',
        agentName: 'Writer',
        pairedBy: 'p1',
        pairedAt: { seconds: 0, nanoseconds: 0, toMillis: () => 0 },
        sealed: { epk: 'e', iv: 'i', ct: 'c' },
      }).success,
    ).toBe(true);
    expect(pairingSchema.safeParse({ ...base, status: 'nope' }).success).toBe(false);
  });
});
