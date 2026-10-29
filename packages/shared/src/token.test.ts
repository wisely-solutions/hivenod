import { describe, expect, it } from 'vitest';
import {
  AGENT_EMAIL,
  decodeToken,
  encodeToken,
  fromBase64Url,
  mcpConfigSnippet,
  newAgentCredentials,
  TOKEN_PREFIX,
  tokenAsEnv,
  tokenHint,
  TokenError,
  toBase64Url,
} from './token';

const parts = {
  w: 'ws123',
  e: 'agent-abcdef123456@agents.hive-board.app',
  p: 'x'.repeat(20) + '-_Zz',
};

describe('token', () => {
  it('round-trips', () => {
    const t = encodeToken(parts);
    expect(t.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(decodeToken(t)).toEqual(parts);
    expect(decodeToken(`  ${t}\n`)).toEqual(parts);
  });
  it('uses url-safe base64 with no padding', () => {
    const t = encodeToken({ ...parts, p: '?>?>?>?>?>?>?>?>?>?>?>' });
    expect(t.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('rejects malformed tokens without echoing them', () => {
    const bad = [
      '',
      'nope',
      'hive_agt_',
      'hive_agt_!!!',
      `hive_agt_${toBase64Url(new TextEncoder().encode('not json'))}`,
      `hive_agt_${toBase64Url(new TextEncoder().encode('{"w":"a"}'))}`,
      `hive_agt_${toBase64Url(new TextEncoder().encode(JSON.stringify({ ...parts, e: 'a@b.co' })))}`,
      `hive_agt_${toBase64Url(new Uint8Array([0xff, 0xfe, 0xfd]))}`,
    ];
    for (const b of bad) {
      expect(() => decodeToken(b)).toThrow(TokenError);
      try {
        decodeToken(b);
      } catch (e) {
        expect(String((e as Error).message)).not.toContain(b || 'zzz-unlikely');
      }
    }
  });
  it('refuses to encode invalid parts', () => {
    expect(() => encodeToken({ ...parts, e: 'x@y.com' })).toThrow();
    expect(() => encodeToken({ ...parts, p: 'short' })).toThrow();
  });
  it('hint is the last four characters of the agent email name, never password characters', () => {
    const t = encodeToken(parts);
    const hint = tokenHint(t);
    expect(hint).toBe(`…${parts.e.split('@')[0]!.slice(-4)}`);
    expect(hint).toHaveLength(5);
    expect(t.slice(-4)).not.toBe(hint.slice(1));
  });
  it('differs between two agents (the raw token tail is identical for all of them)', () => {
    const mk = () => {
      const c = newAgentCredentials();
      return encodeToken({ w: 'ws1', e: c.email, p: c.password });
    };
    const [a, b] = [mk(), mk()];
    expect(a.slice(-4)).toBe(b.slice(-4));
    expect(tokenHint(a)).not.toBe(tokenHint(b));
  });
  it('generates unique credentials that match the rules email pattern', () => {
    const a = newAgentCredentials();
    const b = newAgentCredentials();
    expect(a.email).toMatch(AGENT_EMAIL);
    expect(a.email).not.toBe(b.email);
    expect(a.password).not.toBe(b.password);
    expect(fromBase64Url(a.password)).toHaveLength(32);
    expect(encodeToken({ w: 'w', ...a, e: a.email, p: a.password })).toContain(TOKEN_PREFIX);
  });
  it('formats the env var and the MCP snippet', () => {
    const t = encodeToken(parts);
    expect(tokenAsEnv(t)).toBe(`HIVENOD_TOKEN=${t}`);
    const cfg = JSON.parse(mcpConfigSnippet(t));
    expect(cfg.mcpServers.hivenod.env.HIVENOD_TOKEN).toBe(t);
    expect(cfg.mcpServers.hivenod).toMatchObject({ command: 'hivenod', args: ['mcp'] });
  });
});
