// Complete JSON export of one organization through the Firestore REST API with admin rights
// (Inbox item OE8Fm, slice 7). Same file format as the in-app export in Settings (see
// apps/web/src/orgs/exportOrg.ts), plus what no browser may read: the busy blocks in the members'
// stores and agentHomes. Read-only: it never writes to Firestore.

export const EXPORT_FORMAT = 'hivenod-org-export';
export const EXPORT_VERSION = 1;
const PAGE = 300;

/** The tree, in file order. Mirrored by EXPORT_TREE in apps/web/src/orgs/exportOrg.ts. */
export const EXPORT_TREE = [
  ['members', []],
  ['groups', []],
  ['agents', []],
  ['events', []],
  ['runs', [['log', []]]],
  [
    'projects',
    [
      [
        'items',
        [
          ['attachments', []],
          ['messages', []],
        ],
      ],
      ['decisions', []],
      ['stepProposals', []],
    ],
  ],
  ['calendar', []],
];

/** A REST Value as plain JSON; a timestamp is {"$timestamp": ISO}, as in the web export. */
export function decodeValue(v) {
  if (v === undefined || v === null) return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) {
    const n = Number(v.integerValue);
    return Number.isSafeInteger(n) ? n : v.integerValue;
  }
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return { $timestamp: new Date(v.timestampValue).toISOString() };
  if ('stringValue' in v) return v.stringValue;
  if ('bytesValue' in v) return { $bytes: v.bytesValue };
  if ('referenceValue' in v) return { $ref: v.referenceValue.replace(/^.*\/documents\//, '') };
  if ('geoPointValue' in v) return { $geo: v.geoPointValue };
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields);
  return null;
}
export function decodeFields(fields) {
  const o = {};
  for (const [k, x] of Object.entries(fields ?? {})) o[k] = decodeValue(x);
  return o;
}

/**
 * @param {{ project: string, token: string, wid: string, write: (s: string) => void|Promise<void>,
 *   fetchFn?: typeof fetch, base?: string, now?: Date, log?: (s: string) => void }} o
 * @returns {Promise<{ counts: Record<string, number>, total: number }>}
 */
export async function exportOrganization({
  project,
  token,
  wid,
  write,
  fetchFn = fetch,
  base = 'https://firestore.googleapis.com',
  now = new Date(),
  log = () => {},
}) {
  const root = `${base}/v1/projects/${project}/databases/(default)/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const counts = {};
  let total = 0;
  const seen = (name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    total++;
  };
  const idOf = (docName) => docName.slice(docName.lastIndexOf('/') + 1);
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

  async function getJson(url, init) {
    const res = await fetchFn(url, { headers, ...init });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Firestore ${res.status} for ${url.replace(root, '')}`);
    return res.json();
  }

  /** Pages of a collection, ordered by id. */
  async function* pages(colPath) {
    let pageToken;
    for (;;) {
      const qs = new URLSearchParams({ pageSize: String(PAGE) });
      if (pageToken) qs.set('pageToken', pageToken);
      const body = await getJson(`${root}/${enc(colPath)}?${qs}`);
      yield body?.documents ?? [];
      pageToken = body?.nextPageToken;
      if (!pageToken) return;
    }
  }

  async function walk(colPath, name, children) {
    await write('[');
    let first = true;
    for await (const docs of pages(colPath)) {
      for (const d of docs) {
        const id = idOf(d.name);
        seen(name);
        await write(
          `${first ? '' : ','}{"id":${JSON.stringify(id)},"data":${JSON.stringify(decodeFields(d.fields))}`,
        );
        first = false;
        for (const [cn, grand] of children) {
          await write(`,${JSON.stringify(cn)}:`);
          await walk(`${colPath}/${id}/${cn}`, cn, grand);
        }
        await write('}');
      }
      log(`${total} documents`);
    }
    await write(']');
  }

  const wsPath = `workspaces/${wid}`;
  const ws = await getJson(`${root}/${enc(wsPath)}`);
  if (!ws) throw new Error(`Organization ${wid} not found`);
  seen('workspace');
  await write(
    `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":${EXPORT_VERSION},"source":"script",` +
      `"exportedAt":${JSON.stringify(now.toISOString())},"workspaceId":${JSON.stringify(wid)},` +
      `"workspace":${JSON.stringify(decodeFields(ws.fields))}`,
  );
  const agentIds = new Set();
  for (const [name, children] of EXPORT_TREE) {
    await write(`,${JSON.stringify(name)}:`);
    if (name === 'agents') {
      // Remember the agent ids for agentHomes below.
      for await (const docs of pages(`${wsPath}/agents`))
        for (const d of docs) agentIds.add(idOf(d.name));
    }
    await walk(`${wsPath}/${name}`, name, children);
  }

  // Busy blocks live in the members' own stores: scan them all, keep this organization's.
  await write(',"busy":[');
  let firstBusy = true;
  let after = null;
  for (;;) {
    const structuredQuery = {
      from: [{ collectionId: 'busy', allDescendants: true }],
      orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
      limit: PAGE,
    };
    if (after) structuredQuery.startAt = { values: [{ referenceValue: after }], before: false };
    const rows = await getJson(`${root}:runQuery`, {
      method: 'POST',
      body: JSON.stringify({ structuredQuery }),
    });
    const docs = (rows ?? []).map((r) => r.document).filter(Boolean);
    for (const d of docs) {
      after = d.name;
      const f = decodeFields(d.fields);
      if (f.workspaceId !== wid) continue;
      seen('busy');
      const path = d.name.replace(/^.*\/documents\//, '');
      await write(
        `${firstBusy ? '' : ','}{"path":${JSON.stringify(path)},"data":${JSON.stringify(f)}}`,
      );
      firstBusy = false;
    }
    if (docs.length < PAGE) break;
  }
  await write(']');

  // agentHomes: this organization's agents (by id or by workspaceId).
  await write(',"agentHomes":[');
  let firstHome = true;
  for await (const docs of pages('agentHomes')) {
    for (const d of docs) {
      const f = decodeFields(d.fields);
      const id = idOf(d.name);
      if (!agentIds.has(id) && f.workspaceId !== wid) continue;
      seen('agentHomes');
      await write(
        `${firstHome ? '' : ','}{"id":${JSON.stringify(id)},"data":${JSON.stringify(f)}}`,
      );
      firstHome = false;
    }
  }
  await write(']');
  await write(`,"counts":${JSON.stringify(counts)}}`);
  return { counts, total };
}
