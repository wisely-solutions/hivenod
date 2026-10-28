// One-off cleanup of stale busy blocks (Inbox item 40jle). A busy block in users/{uid}/busy is
// stale when its organization has no document any more, or the user is not in its memberRoles.
// The web app now clears these itself on the member's next visit; this script handles the ones
// nobody has visited since. DRY RUN BY DEFAULT: nothing is deleted unless `apply: true`.
// It reads users/*/busy and workspaces/{id}, and deletes only stale users/*/busy docs.

const PAGE = 300;

/**
 * @param {{ project: string, token: string, apply?: boolean, fetchFn?: typeof fetch, base?: string }} o
 * @returns {Promise<{ scanned: number, stale: number, deleted: number, perOrg: Record<string, number>, perUser: Record<string, number> }>}
 */
export async function cleanStaleBusy({
  project,
  token,
  apply = false,
  fetchFn = fetch,
  base = 'https://firestore.googleapis.com',
}) {
  const root = `${base}/v1/projects/${project}/databases/(default)/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const workspaces = new Map(); // wid -> Set of member uids, or null when gone

  async function members(wid) {
    if (workspaces.has(wid)) return workspaces.get(wid);
    const res = await fetchFn(`${root}/workspaces/${encodeURIComponent(wid)}`, { headers });
    let set = null;
    if (res.status === 404) set = null;
    else if (!res.ok) throw new Error(`workspace read failed: ${res.status}`);
    else set = new Set(Object.keys((await res.json()).fields?.memberRoles?.mapValue?.fields ?? {}));
    workspaces.set(wid, set);
    return set;
  }

  const stale = [];
  let scanned = 0;
  let after = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'busy', allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: PAGE,
    };
    if (after) structuredQuery.startAt = { values: [{ referenceValue: after }], before: false };
    const res = await fetchFn(`${root}:runQuery`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ structuredQuery }),
    });
    if (!res.ok) throw new Error(`busy query failed: ${res.status}`);
    const docs = (await res.json()).map((r) => r.document).filter(Boolean);
    for (const d of docs) {
      scanned++;
      after = d.name;
      // Only ever touch users/{uid}/busy/{id}.
      const m = /\/documents\/users\/([^/]+)\/busy\/[^/]+$/.exec(d.name);
      const wid = d.fields?.workspaceId?.stringValue;
      if (!m || !wid) continue;
      const set = await members(wid);
      if (!set || !set.has(m[1])) stale.push({ name: d.name, uid: m[1], wid });
    }
    if (docs.length < PAGE) break;
  }

  const perOrg = {};
  const perUser = {};
  for (const s of stale) {
    perOrg[s.wid] = (perOrg[s.wid] ?? 0) + 1;
    perUser[s.uid] = (perUser[s.uid] ?? 0) + 1;
  }
  let deleted = 0;
  if (apply) {
    for (const s of stale) {
      const del = await fetchFn(`${base}/v1/${s.name}`, { method: 'DELETE', headers });
      if (del.ok || del.status === 404) deleted++;
    }
  }
  return { scanned, stale: stale.length, deleted, perOrg, perUser };
}
