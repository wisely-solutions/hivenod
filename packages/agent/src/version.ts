/**
 * The CLI's version: from the package.json next to dist/ (the published tarball stamps it with
 * the release: `0.1.<commit count>` and `hivenodCommit`, see scripts/pack-cli.mjs). In the repo it
 * reads 0.0.0 with no commit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CLI_PROTOCOL, cliTooOld, siteProtocol } from '@hive/shared';

export function cliVersion(): { version: string; commit: string | null } {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8');
    const p = JSON.parse(raw) as { version?: unknown; hivenodCommit?: unknown };
    return {
      version: typeof p.version === 'string' ? p.version : '0.0.0',
      commit: typeof p.hivenodCommit === 'string' ? p.hivenodCommit : null,
    };
  } catch {
    return { version: '0.0.0', commit: null };
  }
}

export function versionLine(): string {
  const v = cliVersion();
  return `hivenod ${v.version}${v.commit ? ` (commit ${v.commit.slice(0, 7)})` : ''}`;
}

/**
 * Whether Hivenod needs a newer CLI than this one (card st5INNZj): /version.json says which CLI
 * protocol the site expects. Returns the message to show, or null (also when the site cannot be
 * read: a network hiccup never stops an agent).
 */
export async function updateNeeded(
  siteUrl: string,
  fetchFn: typeof fetch = fetch,
  own: number = CLI_PROTOCOL,
): Promise<string | null> {
  try {
    const res = await fetchFn(`${siteUrl}/version.json?t=${Date.now()}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const site = siteProtocol(await res.json());
    if (!cliTooOld(site, own)) return null;
    return `This hivenod CLI is too old for Hivenod now (new items have per-item paths). Update it and start again:\n  npm install -g ${siteUrl}/cli/hivenod-latest.tgz`;
  } catch {
    return null;
  }
}
