// Deletion of the removed Projects and Calendar data of one organization (item OE8Fm, slice 11),
// after its export (scripts/export-org.mjs). It talks to Firestore through the REST API with admin
// rights (no rules apply) and never touches anything else: the Inbox, members, groups, agents and
// workspace events stay.
//
// Safety: it refuses unless the export file is a complete operator export of this organization
// (format hivenod-org-export, source "script", busy and agentHomes included) whose counts match
// what is in the database now, collection by collection. Anything written since the export makes
// the counts differ, so the data is exported again before it can go.

export const EXPORT_FORMAT = 'hivenod-org-export';
const PAGE = 300;
/** Deletes per commit (Firestore allows 500 writes per commit). */
export const DELETE_PAGE = 400;

/** What goes, as in the export file: [collection, children]. Children are deleted first. */
export const REMOVED_TREE = [
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

/** The counts compared with the export file, in report order. */
export const COUNTED = [
  'runs',
  'log',
  'projects',
  'items',
  'attachments',
  'messages',
  'decisions',
  'stepProposals',
  'calendar',
  'busy',
  'agentHomes',
  'projectEvents',
];

/** Is this workspace event about a project (an item, a run, a decision...)? */
const isProjectEvent = (data) =>
  data?.projectId != null || data?.itemId != null || data?.runId != null;

/**
 * Reads and checks the export file text: the counts to compare (`projectEvents` counted from the
 * file's events). Throws with the reason when it is not a usable export of `wid`.
 */
export function readExport(text, wid) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error('The export file is not valid JSON.');
  }
  if (j?.format !== EXPORT_FORMAT) throw new Error('Not a Hivenod organization export.');
  if (j.workspaceId !== wid)
    throw new Error(`The export is of organization ${j.workspaceId}, not ${wid}.`);
  if (j.source !== 'script' || !Array.isArray(j.busy) || !Array.isArray(j.agentHomes))
    throw new Error(
      'The export must come from scripts/export-org.mjs (the in-app export has no busy blocks or agentHomes).',
    );
  if (!j.counts || typeof j.counts !== 'object') throw new Error('The export has no counts.');
  const counts = {};
  for (const k of COUNTED) counts[k] = Number(j.counts[k] ?? 0);
  counts.projectEvents = (j.events ?? []).filter((e) => isProjectEvent(e.data)).length;
  return counts;
}

/**
 * What is in the database now: the counts and every document path to delete, children before
 * their parents (a parent is never deleted while something hangs below it).
 * `rest` needs listIds(collectionPath) -> ids, list(collectionPath) -> [{id, data}],
 * busyOf(wid) -> [docPath] (every member's users/{uid}/busy blocks of this organization).
 */
export async function inventory(rest, wid) {
  const ws = `workspaces/${wid}`;
  const counts = Object.fromEntries(COUNTED.map((k) => [k, 0]));
  const paths = [];
  async function walk(colPath, name, children) {
    for (const id of await rest.listIds(colPath)) {
      const p = `${colPath}/${id}`;
      for (const [cn, grand] of children) await walk(`${p}/${cn}`, cn, grand);
      paths.push(p);
      counts[name]++;
    }
  }
  for (const [name, children] of REMOVED_TREE) await walk(`${ws}/${name}`, name, children);

  for (const p of await rest.busyOf(wid)) {
    paths.push(p);
    counts.busy++;
  }
  const agentIds = new Set(await rest.listIds(`${ws}/agents`));
  for (const h of await rest.list('agentHomes')) {
    if (!agentIds.has(h.id) && h.data?.workspaceId !== wid) continue;
    paths.push(`agentHomes/${h.id}`);
    counts.agentHomes++;
  }
  for (const e of await rest.list(`${ws}/events`)) {
    if (!isProjectEvent(e.data)) continue;
    paths.push(`${ws}/events/${e.id}`);
    counts.projectEvents++;
  }
  return { counts, paths };
}

/** The collections whose counts differ: [{ name, exported, live }]. */
export function mismatches(exported, live) {
  return COUNTED.filter((k) => exported[k] !== live[k]).map((name) => ({
    name,
    exported: exported[name],
    live: live[name],
  }));
}

/** The table the script prints: one row per collection. */
export function countsTable(exported, live) {
  const rows = COUNTED.map((k) => [k, String(exported[k]), String(live[k])]);
  const w = [16, 9, 6];
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join(' ');
  return [line(['collection', 'exported', 'live']), ...rows.map(line)].join('\n');
}

/** Deletes `paths` in commits of DELETE_PAGE, in order. Returns how many went. */
export async function deletePaths(rest, paths, log = () => {}) {
  let n = 0;
  for (let i = 0; i < paths.length; i += DELETE_PAGE) {
    const page = paths.slice(i, i + DELETE_PAGE);
    await rest.commit(page.map((p) => ({ delete: rest.docName(p) })));
    n += page.length;
    log(`${n} of ${paths.length} deleted`);
  }
  return n;
}

/** A small Firestore REST client with admin rights (a service-account token, or "owner" on the emulator). */
export function restClient({
  project,
  token,
  base = 'https://firestore.googleapis.com',
  fetchFn = fetch,
}) {
  const dbPath = `projects/${project}/databases/(default)`;
  const root = `${base}/v1/${dbPath}/documents`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
  const idOf = (name) => name.slice(name.lastIndexOf('/') + 1);
  const pathOf = (name) => name.replace(/^.*?\/documents\//, '');
  async function call(url, init) {
    const res = await fetchFn(url, { headers, ...init });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Firestore ${res.status} for ${url.replace(root, '')}: ${body.slice(0, 300)}`,
      );
    }
    return res.json();
  }
  async function pages(colPath, fields) {
    const out = [];
    let pageToken;
    for (;;) {
      const qs = new URLSearchParams({ pageSize: String(PAGE), showMissing: 'true' });
      if (fields) for (const f of fields) qs.append('mask.fieldPaths', f);
      if (pageToken) qs.set('pageToken', pageToken);
      const body = await call(`${root}/${enc(colPath)}?${qs}`);
      out.push(...(body?.documents ?? []));
      pageToken = body?.nextPageToken;
      if (!pageToken) return out;
    }
  }
  const plain = (v) =>
    v == null || 'nullValue' in v
      ? null
      : (v.stringValue ?? v.integerValue ?? v.booleanValue ?? true);
  return {
    docName: (path) => `${dbPath}/documents/${path}`,
    // showMissing lists documents that only have children (a parent deleted before them), so
    // their children are still found and deleted.
    async listIds(colPath) {
      return (await pages(colPath, ['zzNoSuchField'])).map((d) => idOf(d.name));
    },
    async list(colPath) {
      return (await pages(colPath, ['projectId', 'itemId', 'runId', 'workspaceId'])).map((d) => ({
        id: idOf(d.name),
        data: Object.fromEntries(Object.entries(d.fields ?? {}).map(([k, v]) => [k, plain(v)])),
      }));
    },
    async busyOf(wid) {
      const out = [];
      let after = null;
      for (;;) {
        const structuredQuery = {
          from: [{ collectionId: 'busy', allDescendants: true }],
          select: { fields: [{ fieldPath: 'workspaceId' }] },
          orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
          limit: PAGE,
        };
        if (after) structuredQuery.startAt = { values: [{ referenceValue: after }], before: false };
        const rows = await call(`${root}:runQuery`, {
          method: 'POST',
          body: JSON.stringify({ structuredQuery }),
        });
        const docs = (rows ?? []).map((r) => r.document).filter(Boolean);
        for (const d of docs) {
          after = d.name;
          if (plain(d.fields?.workspaceId) === wid) out.push(pathOf(d.name));
        }
        if (docs.length < PAGE) return out;
      }
    },
    async commit(writes) {
      await call(`${root}:commit`, { method: 'POST', body: JSON.stringify({ writes }) });
    },
  };
}
