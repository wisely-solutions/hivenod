import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** KEY=VALUE lines (quotes optional, # comments). Values never reach a log. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

export function secretsDir(): string {
  return process.env.HIVE_SECRETS_DIR ?? join(homedir(), '.agent', 'secrets');
}

/** Where the notifier's own secrets live: TELEGRAM_BOT_TOKEN, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. */
export function notifyEnvPath(): string {
  return process.env.HIVE_NOTIFY_ENV ?? join(secretsDir(), 'hive-notify.env');
}

export function readEnvFile(path: string): Record<string, string> {
  return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
}

/** Appends KEY=VALUE lines to the secrets file (created 0600). */
export function appendEnv(path: string, values: Record<string, string>): void {
  const old = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const sep = old && !old.endsWith('\n') ? '\n' : '';
  const add = Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(path, `${old}${sep}${add}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
