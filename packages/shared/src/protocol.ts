/**
 * What the hivenod CLI must understand to work with this release of Hivenod (card st5INNZj). The
 * deploy writes it into /version.json as `cliProtocol` and into /cli/bin/latest.json (the Go CLI
 * reads it there). Bump it when older CLIs would break.
 *  1: everything before per-item paths (CLIs before this number existed)
 *  2: per-item paths: shaping jobs, skipped steps, path tools
 */
// A plain constant (not a JSON import): this file is loaded by Vite, vitest, esbuild and Node's
// own ESM loader (Playwright), and only a .ts constant works in all four. scripts/deploy.mjs
// reads the number from this line.
export const CLI_PROTOCOL = 2;

/** The site's protocol from /version.json, or null when it does not say. */
export function siteProtocol(versionJson: unknown): number | null {
  const v = (versionJson as { cliProtocol?: unknown } | null)?.cliProtocol;
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

/** Whether this CLI is too old for the site. */
export function cliTooOld(site: number | null, own: number = CLI_PROTOCOL): boolean {
  return site !== null && site > own;
}
