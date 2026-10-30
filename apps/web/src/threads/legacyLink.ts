/**
 * Old project links (item OE8FmrTaIxFVGcaeGG3N, slice 10). Projects were removed from the web app;
 * an item that the migration moved to Inbox (scripts/migrate-project-lib.mjs) lives on as a thread
 * whose id is derived from its organization, project and item: `mg` + the first 24 hex digits of
 * sha256("<wid>\0<pid>\0<iid>"). So an old `/p/<pid>?item=<iid>` link can open that thread without
 * reading the (gone) project.
 */
export async function migratedThreadId(wid: string, pid: string, iid: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${wid}\u0000${pid}\u0000${iid}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `mg${hex.slice(0, 24)}`;
}

/** The organizations to look in: the one on screen first, then the person's others. */
export function orgsToTry(current: string, all: readonly string[]): string[] {
  return [current, ...all.filter((w) => w !== current)].slice(0, 10);
}
