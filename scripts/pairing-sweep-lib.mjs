// Sweep of expired terminal-pairing docs (card PXOzcYeG). A pairing doc is only meant to live for
// PAIRING_TTL (15 minutes); the terminal deletes its own, but a killed or crashed one leaves it
// behind and no client can list the collection. `pnpm release` runs this with the service account.
// It deletes only docs in `pairings` whose createdAt is older than the cutoff. EUR 0 (a few reads).

export const PAIRING_TTL_MS = 15 * 60 * 1000;

/** The ISO time before which a pairing doc is expired. */
export const cutoffIso = (now = Date.now(), ttlMs = PAIRING_TTL_MS) =>
  new Date(now - ttlMs).toISOString();

/**
 * @param {{ project: string, token: string, now?: number, dryRun?: boolean, fetchFn?: typeof fetch, base?: string }} o
 * @returns {Promise<{ found: number, deleted: number }>}
 */
export async function sweepPairings({
  project,
  token,
  now = Date.now(),
  dryRun = false,
  fetchFn = fetch,
  base = 'https://firestore.googleapis.com',
}) {
  const root = `${base}/v1/projects/${project}/databases/(default)/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const res = await fetchFn(`${root}:runQuery`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'pairings' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'createdAt' },
            op: 'LESS_THAN',
            value: { timestampValue: cutoffIso(now) },
          },
        },
        limit: 500,
      },
    }),
  });
  if (!res.ok) throw new Error(`pairing sweep query failed: ${res.status}`);
  const names = (await res.json())
    .map((r) => r.document?.name)
    // Belt and braces: only ever delete inside the pairings collection.
    .filter((n) => typeof n === 'string' && /\/documents\/pairings\/[A-Z0-9]+$/.test(n));
  let deleted = 0;
  if (!dryRun) {
    for (const name of names) {
      const del = await fetchFn(`${base}/v1/${name}`, { method: 'DELETE', headers });
      if (del.ok || del.status === 404) deleted++;
    }
  }
  return { found: names.length, deleted };
}
