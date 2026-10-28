import { describe, expect, it } from 'vitest';
import { ERASE_BATCH, eraseItemHistory, type ItemEraseStore } from './eraseItem';

/** An in-memory tree: the set of document paths. */
function memStore(docs: Set<string>, opts: { failAfter?: number } = {}) {
  let removes = 0;
  const maxBatch = { n: 0 };
  const store: ItemEraseStore = {
    async list(col, max) {
      const out: string[] = [];
      for (const p of docs) {
        if (p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/'))
          out.push(p.slice(col.length + 1));
        if (out.length >= max) break;
      }
      return out;
    },
    async listRuns(max) {
      const out: string[] = [];
      for (const p of docs) {
        const m = /^workspaces\/w\/runs\/([^/]+)$/.exec(p);
        if (m && p.endsWith(m[1]!) && runItem.get(m[1]!) === 'i1') out.push(m[1]!);
        if (out.length >= max) break;
      }
      return out;
    },
    async remove(ps) {
      if (opts.failAfter !== undefined && removes >= opts.failAfter) throw new Error('offline');
      removes++;
      maxBatch.n = Math.max(maxBatch.n, ps.length);
      for (const p of ps) docs.delete(p);
    },
  };
  return { store, maxBatch };
}
const runItem = new Map<string, string>();

function seed(): Set<string> {
  const docs = new Set<string>();
  runItem.clear();
  for (const r of ['r1', 'r2']) {
    docs.add(`workspaces/w/runs/${r}`);
    runItem.set(r, 'i1');
    for (let n = 0; n < 500; n++) docs.add(`workspaces/w/runs/${r}/log/${n}`);
  }
  docs.add('workspaces/w/runs/other');
  runItem.set('other', 'i2');
  docs.add('workspaces/w/runs/other/log/0');
  const base = 'workspaces/w/projects/p/items/i1';
  for (let n = 0; n < 5; n++) docs.add(`${base}/messages/m${n}`);
  docs.add(`${base}/attachments/a1`);
  return docs;
}

describe('eraseItemHistory', () => {
  it('leaves nothing under the item (1000 log lines), in batches within the limit', async () => {
    const docs = seed();
    const { store, maxBatch } = memStore(docs);
    const n = await eraseItemHistory(store, 'w', 'p', 'i1');
    expect(n).toBe(1000 + 2 + 5 + 1);
    expect([...docs].sort()).toEqual(['workspaces/w/runs/other', 'workspaces/w/runs/other/log/0']);
    expect(maxBatch.n).toBeLessThanOrEqual(ERASE_BATCH);
  });

  it('resumes after an interruption and is harmless to run twice', async () => {
    const docs = seed();
    await expect(
      eraseItemHistory(memStore(docs, { failAfter: 2 }).store, 'w', 'p', 'i1'),
    ).rejects.toThrow();
    expect(docs.size).toBeGreaterThan(2);
    await eraseItemHistory(memStore(docs).store, 'w', 'p', 'i1');
    await eraseItemHistory(memStore(docs).store, 'w', 'p', 'i1');
    expect(docs.size).toBe(2);
  });
});
