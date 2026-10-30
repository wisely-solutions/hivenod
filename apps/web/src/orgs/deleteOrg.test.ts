import { describe, expect, it } from 'vitest';
import { BATCH, purgeOrg, type TreeStore } from './deleteOrg';

/** An in-memory tree of document paths. */
function fake(docs: string[], failAfter = Infinity) {
  const all = new Set(docs);
  const removed: string[] = [];
  let calls = 0;
  const store: TreeStore = {
    async list(col, max) {
      const prefix = `${col}/`;
      return [...all]
        .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map((p) => p.slice(prefix.length))
        .slice(0, max);
    },
    async remove(paths) {
      if (calls++ >= failAfter) throw new Error('offline');
      expect(paths.length).toBeLessThanOrEqual(BATCH);
      for (const p of paths) {
        // Nothing may be deleted while documents still hang below it.
        expect(
          [...all].some((q) => q.startsWith(`${p}/`)),
          `${p} still has children`,
        ).toBe(false);
        all.delete(p);
        removed.push(p);
      }
    },
  };
  return { store, all, removed };
}

const W = 'workspaces/w1';
const tree = [
  W,
  `${W}/agents/a1`,
  `${W}/events/e1`,
  `${W}/groups/g`,
  `${W}/invites/c`,
  `${W}/notified/n`,
  `${W}/members/u`,
  'workspaces/w2',
  'workspaces/w2/events/keep',
];

describe('purgeOrg', () => {
  it('removes every document below the organization, children first, its own document last', async () => {
    const f = fake(tree);
    const n = await purgeOrg(f.store, 'w1');
    expect([...f.all].sort()).toEqual(['workspaces/w2', 'workspaces/w2/events/keep']);
    expect(f.removed.at(-1)).toBe(W);
    expect(n).toBe(tree.length - 2);
    // Agents (and so every token) go before anything else.
    expect(f.removed[0]).toBe(`${W}/agents/a1`);
  });
  it('works in batches for a big collection', async () => {
    const many = Array.from({ length: BATCH * 2 + 5 }, (_, i) => `${W}/events/e${i}`);
    const f = fake([W, ...many]);
    await purgeOrg(f.store, 'w1');
    expect(f.all.size).toBe(0);
  });
  it('resumes after a stop: a second run finishes what is left', async () => {
    const f = fake(tree, 4);
    await expect(purgeOrg(f.store, 'w1')).rejects.toThrow('offline');
    expect(f.all.has(W)).toBe(true);
    const again = fake([...f.all]);
    await purgeOrg(again.store, 'w1');
    expect([...again.all].sort()).toEqual(['workspaces/w2', 'workspaces/w2/events/keep']);
  });
  it('an organization that is already empty is just removed', async () => {
    const f = fake([W]);
    expect(await purgeOrg(f.store, 'w1')).toBe(1);
    expect(f.all.size).toBe(0);
  });
});
