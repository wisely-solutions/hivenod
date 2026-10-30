import { paths } from '@hive/shared';
import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  Timestamp,
  type DocumentData,
} from 'firebase/firestore';
import { db } from '../lib/db';

/**
 * Export of one organization as a single JSON file (Inbox item OE8Fm, slice 7), built in the
 * admin's browser from what the rules let an admin read, so the Projects and Calendar data can be
 * kept before it is deleted (slices 10-11). `scripts/export-org.mjs` writes the same format with the
 * Admin SDK and also covers what no browser may read (busy blocks, agentHomes).
 *
 * Streaming: the file is written document by document into a list of text parts (never one big
 * string), collections are read in pages, and the page reports progress.
 */

export const EXPORT_FORMAT = 'hivenod-org-export';
export const EXPORT_VERSION = 1;
export const PAGE = 400;

/** What the walk needs from storage, so it can be tested without Firestore. */
export interface ExportStore {
  /** Up to `max` documents of the collection after `afterId`, ordered by id, already JSON-safe. */
  list(
    collectionPath: string,
    afterId: string | null,
    max: number,
  ): Promise<{ id: string; data: unknown }[]>;
  /** One document, or null. */
  get(docPath: string): Promise<unknown | null>;
}

/** A collection and what hangs below each of its documents. */
interface Node {
  name: string;
  children: Node[];
}
const leaf = (name: string): Node => ({ name, children: [] });

/** The tree, in the order the file lists it. Mirrored by scripts/export-org.mjs. */
export const EXPORT_TREE: Node[] = [
  leaf('members'),
  leaf('groups'),
  leaf('agents'),
  leaf('events'),
  { name: 'runs', children: [leaf('log')] },
  {
    name: 'projects',
    children: [
      { name: 'items', children: [leaf('attachments'), leaf('messages')] },
      leaf('decisions'),
      leaf('stepProposals'),
    ],
  },
  leaf('calendar'),
];

export interface ExportProgress {
  docs: number;
  collection: string;
}

export interface ExportResult {
  parts: string[];
  counts: Record<string, number>;
  total: number;
}

/** Walks the organization and returns the file as text parts plus the document counts. */
export async function exportOrg(
  store: ExportStore,
  wid: string,
  opts: {
    now?: Date;
    onProgress?: (p: ExportProgress) => void;
    shouldStop?: () => boolean;
  } = {},
): Promise<ExportResult> {
  const base = paths.workspace(wid);
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  let total = 0;
  const w = (s: string) => void parts.push(s);

  function seen(name: string) {
    counts[name] = (counts[name] ?? 0) + 1;
    total++;
  }

  async function walk(colPath: string, name: string, children: Node[]) {
    w('[');
    let after: string | null = null;
    let first = true;
    for (;;) {
      if (opts.shouldStop?.()) throw new Error('Export stopped');
      const docs = await store.list(colPath, after, PAGE);
      for (const d of docs) {
        seen(name);
        w(`${first ? '' : ','}{"id":${JSON.stringify(d.id)},"data":${JSON.stringify(d.data)}`);
        first = false;
        for (const c of children) {
          w(`,${JSON.stringify(c.name)}:`);
          await walk(`${colPath}/${d.id}/${c.name}`, c.name, c.children);
        }
        w('}');
      }
      opts.onProgress?.({ docs: total, collection: name });
      if (docs.length < PAGE) break;
      after = docs[docs.length - 1]!.id;
    }
    w(']');
  }

  const ws = await store.get(base);
  if (ws === null) throw new Error('Organization not found');
  seen('workspace');
  w(
    `{"format":${JSON.stringify(EXPORT_FORMAT)},"version":${EXPORT_VERSION},` +
      `"source":"web","exportedAt":${JSON.stringify((opts.now ?? new Date()).toISOString())},` +
      `"workspaceId":${JSON.stringify(wid)},"workspace":${JSON.stringify(ws)}`,
  );
  for (const n of EXPORT_TREE) {
    w(`,${JSON.stringify(n.name)}:`);
    await walk(`${base}/${n.name}`, n.name, n.children);
  }
  // Not readable in a browser: the operator script covers them.
  w(',"busy":null,"agentHomes":null');
  w(
    `,"notes":["busy blocks and agentHomes are not readable by a browser; scripts/export-org.mjs exports them"]`,
  );
  w(`,"counts":${JSON.stringify(counts)}}`);
  return { parts, counts, total };
}

/** Firestore values as JSON: a Timestamp is {"$timestamp": ISO}; the rest is plain JSON already. */
export function jsonSafe(v: unknown): unknown {
  if (v instanceof Timestamp) return { $timestamp: v.toDate().toISOString() };
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as DocumentData)) o[k] = jsonSafe(x);
    return o;
  }
  return v;
}

export const firestoreExportStore: ExportStore = {
  async list(col, afterId, max) {
    const base = collection(db, col);
    const q = afterId
      ? query(base, orderBy(documentId()), startAfter(afterId), limit(max))
      : query(base, orderBy(documentId()), limit(max));
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, data: jsonSafe(d.data()) }));
  },
  async get(docPath) {
    const { doc, getDoc } = await import('firebase/firestore');
    const snap = await getDoc(doc(db, docPath));
    return snap.exists() ? jsonSafe(snap.data()) : null;
  },
};

/** Saves the parts as a file in the browser. */
export function downloadParts(parts: string[], filename: string) {
  const blob = new Blob(parts, { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function exportFilename(name: string, wid: string, now = new Date()) {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || wid;
  return `${slug}-export-${now.toISOString().slice(0, 10)}.json`;
}
