/**
 * The discovery file (item 07W4gCboOicS0lM1bqwZ): every Hivenod site serves
 * /.well-known/hivenod.json with what a CLI or agent needs to talk to it (the public Firebase web
 * config, the CLI download base, the protocol). So an agent needs only the site's address
 * (`hivenod connect --server https://your.host` or HIVENOD_WEB_URL), not five Firebase variables.
 *
 * The Go CLI has the same parser (cli/internal/discovery); both are checked against the shared
 * cases in cli/internal/discovery/testdata/cases.json.
 */

/** Where the file is served, relative to the site. */
export const DISCOVERY_PATH = '/.well-known/hivenod.json';
/** The newest discovery format this code understands. Bump it when older CLIs would misread it. */
export const DISCOVERY_PROTOCOL = 1;

/** The hosted service. Installs without a server use it, as before discovery existed. */
export const HOSTED_SITE = 'https://hivenod.com';

/** A Firebase web app config. Public by design: security is enforced by firestore.rules. */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  messagingSenderId: string;
}

/** The hosted service's web config (the built-in default of the web app and both CLIs). */
export const HOSTED_FIREBASE: FirebaseWebConfig = {
  apiKey: 'AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4',
  authDomain: 'hivenod.com',
  projectId: 'hive-board-43be',
  appId: '1:493986079810:web:71cf28f12f79f3cf9bf9db',
  messagingSenderId: '493986079810',
};

export interface Discovery {
  protocol: number;
  backend: 'firestore';
  /** The normalized site address the file was read from. */
  site: string;
  firebase: FirebaseWebConfig;
  /** Absolute base of the CLI downloads (latest.json lives under <cli>/bin/). */
  cli: string;
  /** Local emulators (host:port), only ever honoured for a site on this machine (tests). */
  emulators?: { auth?: string; firestore?: string };
}

export type DiscoveryErrorCode =
  | 'bad-site'
  | 'insecure-site'
  | 'not-hivenod'
  | 'newer-protocol'
  | 'unknown-backend'
  | 'missing-field'
  | 'bad-cli';

// No parameter properties: vite.config.ts loads this file with Node's type stripping.
export class DiscoveryError extends Error {
  readonly code: DiscoveryErrorCode;
  constructor(code: DiscoveryErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'DiscoveryError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostOf(u: URL): string {
  return u.hostname.toLowerCase();
}

/** Whether an address is on this machine (the only place plain http and emulators are allowed). */
export function isLoopbackSite(site: string): boolean {
  try {
    return LOOPBACK.has(hostOf(new URL(site)));
  } catch {
    return false;
  }
}

/**
 * The canonical form of a site address: https (http only on this machine), no credentials, query
 * or fragment, no trailing slash. "your.host" means https://your.host.
 */
export function normalizeSite(raw: string): string {
  let s = (raw ?? '').trim();
  if (!s) throw new DiscoveryError('bad-site', 'The server address is empty.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new DiscoveryError('bad-site', `"${raw}" is not a web address.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new DiscoveryError('bad-site', `"${raw}" is not a web address (use https://…).`);
  if (u.username || u.password || u.search || u.hash || !u.hostname)
    throw new DiscoveryError(
      'bad-site',
      `"${raw}" must be just the site address, like https://your.host.`,
    );
  if (u.protocol === 'http:' && !LOOPBACK.has(hostOf(u)))
    throw new DiscoveryError(
      'insecure-site',
      `"${raw}" uses http; Hivenod sites must use https (http only for localhost).`,
    );
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** The URL of the discovery file of a (normalized) site. */
export function discoveryUrl(site: string): string {
  return `${normalizeSite(site)}${DISCOVERY_PATH}`;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const HOST_PORT = /^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$/;

/** Reads a discovery file fetched from `site`. Unknown fields are ignored. */
export function parseDiscovery(site: string, doc: unknown): Discovery {
  const base = normalizeSite(site);
  if (!isObj(doc) || doc.service !== 'hivenod')
    throw new DiscoveryError('not-hivenod', `${base} does not look like a Hivenod site.`);
  const protocol = doc.protocol;
  if (typeof protocol !== 'number' || !Number.isInteger(protocol) || protocol < 1)
    throw new DiscoveryError('not-hivenod', `${base} does not look like a Hivenod site.`);
  if (protocol > DISCOVERY_PROTOCOL)
    throw new DiscoveryError(
      'newer-protocol',
      `${base} needs a newer hivenod CLI (protocol ${protocol}); run \`hivenod update\`.`,
    );
  const backend = doc.backend === undefined ? 'firestore' : doc.backend;
  if (backend !== 'firestore')
    throw new DiscoveryError(
      'unknown-backend',
      `${base} uses a backend this CLI does not know (${String(backend)}); run \`hivenod update\`.`,
    );
  const fb = isObj(doc.firebase) ? doc.firebase : {};
  const firebase: FirebaseWebConfig = {
    apiKey: str(fb.apiKey),
    authDomain: str(fb.authDomain),
    projectId: str(fb.projectId),
    appId: str(fb.appId),
    messagingSenderId: str(fb.messagingSenderId),
  };
  for (const k of ['apiKey', 'authDomain', 'projectId'] as const)
    if (!firebase[k])
      throw new DiscoveryError('missing-field', `${base}${DISCOVERY_PATH} has no firebase.${k}.`);
  const loopback = isLoopbackSite(base);
  let cli: string;
  try {
    const u = new URL(str(doc.cli) || 'cli', `${base}/`);
    const ok =
      (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(hostOf(u)))) &&
      !u.username &&
      !u.password;
    if (!ok) throw new Error('scheme');
    cli = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    throw new DiscoveryError('bad-cli', `${base}${DISCOVERY_PATH} has an unusable cli address.`);
  }
  const out: Discovery = { protocol, backend: 'firestore', site: base, firebase, cli };
  // Emulators are a testing aid: only for a site on this machine, and only local ones.
  if (loopback && isObj(doc.emulators)) {
    const emu: { auth?: string; firestore?: string } = {};
    for (const k of ['auth', 'firestore'] as const) {
      const v = str(doc.emulators[k]);
      if (HOST_PORT.test(v)) emu[k] = v;
    }
    if (emu.auth || emu.firestore) out.emulators = emu;
  }
  return out;
}

/** The discovery file a site serves (written by the web build). */
export function discoveryDocument(
  firebase: FirebaseWebConfig,
  opts: { cli?: string; emulators?: { auth?: string; firestore?: string } } = {},
): Record<string, unknown> {
  return {
    service: 'hivenod',
    protocol: DISCOVERY_PROTOCOL,
    backend: 'firestore',
    firebase: { ...firebase },
    cli: opts.cli ?? '/cli',
    ...(opts.emulators ? { emulators: opts.emulators } : {}),
  };
}

/** Whether a site is the hosted service (then the built-in config is used, nothing is fetched). */
export function isHostedSite(site: string): boolean {
  try {
    return normalizeSite(site) === HOSTED_SITE;
  } catch {
    return false;
  }
}
