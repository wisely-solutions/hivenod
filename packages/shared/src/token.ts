/**
 * Agent tokens (SPEC section 6).
 *
 *   hive_agt_<base64url(json{w: workspaceId, e: email, p: password})>
 *
 * The token is the agent's whole credential: an email/password pair for a Firebase Auth user plus
 * the workspace it belongs to. It exists only in memory, in the dialog that shows it once, and in
 * whatever the owner pastes it into. It is never written to Firestore, logs or analytics; only
 * `tokenHint` (the last four characters of the agent's random email name) is stored.
 */
import { z } from 'zod';

export const TOKEN_PREFIX = 'hive_agt_';
export const AGENT_EMAIL_DOMAIN = 'agents.hive-board.app';
/** Matches the `isAgentEmail()` check in firestore.rules. */
export const AGENT_EMAIL = /^agent-[a-z0-9]{12}@agents\.hive-board\.app$/;

export interface TokenParts {
  /** Workspace id. */
  w: string;
  /** The agent's Firebase Auth email. */
  e: string;
  /** The agent's Firebase Auth password. */
  p: string;
}

const partsSchema = z.object({
  w: z.string().min(1).max(128),
  e: z.string().regex(AGENT_EMAIL),
  p: z.string().min(16).max(256),
});

/** Thrown for any token that cannot be used. The message never contains the token. */
export class TokenError extends Error {
  constructor(message = 'This is not a valid Hivenod agent token') {
    super(message);
    this.name = 'TokenError';
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TokenError();
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/**
 * Key order is deliberate: the password comes first and the email last, so the last four
 * characters of the token (the stored hint) come from the non-secret email and never leak
 * password characters.
 */
export function encodeToken(parts: TokenParts): string {
  const { w, e, p } = partsSchema.parse(parts);
  return TOKEN_PREFIX + toBase64Url(new TextEncoder().encode(JSON.stringify({ p, w, e })));
}

export function decodeToken(token: string): TokenParts {
  const t = token.trim();
  if (!t.startsWith(TOKEN_PREFIX)) throw new TokenError();
  try {
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      fromBase64Url(t.slice(TOKEN_PREFIX.length)),
    );
    const r = partsSchema.safeParse(JSON.parse(json));
    if (!r.success) throw new TokenError();
    return { w: r.data.w, e: r.data.e, p: r.data.p };
  } catch {
    throw new TokenError();
  }
}

/** What is stored and shown next to an agent so the owner can tell tokens apart: `…a7f3`. */
export function tokenHint(token: string): string {
  // The token's last characters are the same for every agent (the end of the email domain, base64
  // encoded), so the hint comes from the end of the agent's own random email address instead.
  // That part is not secret. Anything that is not a valid token falls back to its last characters.
  try {
    const { e } = decodeToken(token);
    return `…${e.slice(0, e.indexOf('@')).slice(-4)}`;
  } catch {
    return `…${token.slice(-4)}`;
  }
}

const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Fresh credentials for a new agent: a random email and a 32-byte random password. */
export function newAgentCredentials(): { email: string; password: string } {
  const r = crypto.getRandomValues(new Uint8Array(12));
  const local = Array.from(r, (b) => LOWER_ALNUM[b % LOWER_ALNUM.length]).join('');
  return {
    email: `agent-${local}@${AGENT_EMAIL_DOMAIN}`,
    password: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
  };
}

/** `HIVENOD_TOKEN=…` for a shell or .env file. */
export const tokenAsEnv = (token: string) => `HIVENOD_TOKEN=${token}`;

/** The Claude Code MCP config snippet for an agent (SPEC section 10). */
export function mcpConfigSnippet(token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        hivenod: {
          command: 'node',
          args: ['/path/to/hivenod/packages/agent/dist/cli.js', 'mcp'],
          env: { HIVENOD_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}
