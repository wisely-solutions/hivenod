/**
 * Which Hivenod this CLI talks to (item 07W4gCboOicS0lM1bqwZ), as in the Go CLI
 * (cli/internal/hive/config.go): --server, then HIVENOD_WEB_URL, then the server saved with the
 * token, then https://hivenod.com. The hosted service and explicit HIVENOD_FIREBASE_* variables
 * need no network; any other site is described by its /.well-known/hivenod.json, read once when
 * connecting and saved with the token.
 */
import {
  DiscoveryError,
  discoveryUrl,
  HOSTED_SITE,
  isHostedSite,
  normalizeSite,
  parseDiscovery,
  type Discovery,
} from '@hive/shared/discovery';
import { useFirebaseConfig } from './client';
import { readCredentials, type StoredCredentials } from './credentials';
import { HiveError } from './errors';

const EXPLICIT = [
  'HIVENOD_FIREBASE_API_KEY',
  'HIVENOD_FIREBASE_PROJECT_ID',
  'HIVENOD_PROJECT_ID',
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
];

export interface ResolvedServer {
  site: string;
  /** Set when the config came from the site's discovery file (saved with the token). */
  discovery?: Discovery;
}

let current: ResolvedServer = { site: process.env.HIVENOD_WEB_URL || HOSTED_SITE };

/** The site this process talks to (links, updates): https://hivenod.com until resolved. */
export function activeSite(): string {
  return current.site;
}

/** The server saved with the token in agent.json (only when HIVENOD_TOKEN does not override it). */
export function savedServer(): StoredCredentials | null {
  if (process.env.HIVENOD_TOKEN) return null;
  return readCredentials();
}

function wrap(e: unknown): never {
  if (e instanceof DiscoveryError) throw new HiveError(e.message);
  throw e;
}

export function siteFor(server?: string, saved: StoredCredentials | null = savedServer()): string {
  const raw = server || process.env.HIVENOD_WEB_URL || saved?.server || '';
  if (!raw) return HOSTED_SITE;
  try {
    return normalizeSite(raw);
  } catch (e) {
    return wrap(e);
  }
}

export async function fetchDiscovery(
  site: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Discovery> {
  let res: Response;
  try {
    res = await fetchImpl(discoveryUrl(site), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    if (e instanceof DiscoveryError) wrap(e);
    throw new HiveError(`Could not reach ${site}: ${(e as Error)?.message ?? e}`);
  }
  if (res.status !== 200)
    throw new HiveError(
      `${site} does not look like a Hivenod site (/.well-known/hivenod.json answered ${res.status}).`,
    );
  let doc: unknown;
  try {
    doc = JSON.parse(await res.text());
  } catch {
    throw new HiveError(
      `${site} does not look like a Hivenod site (/.well-known/hivenod.json is not JSON).`,
    );
  }
  try {
    return parseDiscovery(site, doc);
  } catch (e) {
    return wrap(e);
  }
}

/** Finds the server for a command and points this process's Firebase apps at it. */
export async function resolveServer(
  server?: string,
  saved: StoredCredentials | null = savedServer(),
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedServer> {
  const site = siteFor(server, saved);
  let out: ResolvedServer;
  if (EXPLICIT.some((k) => process.env[k]) || isHostedSite(site)) {
    out = { site };
    useFirebaseConfig(null);
  } else {
    const discovery =
      (saved?.server === site ? saved.discovery : undefined) ??
      (await fetchDiscovery(site, fetchImpl));
    out = { site: discovery.site, discovery };
    useFirebaseConfig({ firebase: discovery.firebase, emulators: discovery.emulators });
  }
  current = out;
  return out;
}

/** What to save with a new token: nothing for the hosted service (older CLIs read it the same). */
export function serverFields(r: ResolvedServer): Pick<StoredCredentials, 'server' | 'discovery'> {
  return r.discovery ? { server: r.discovery.site, discovery: r.discovery } : {};
}
