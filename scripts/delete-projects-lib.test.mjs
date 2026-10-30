import { describe, expect, it } from 'vitest';
import {
  COUNTED,
  DELETE_PAGE,
  deletePaths,
  inventory,
  mismatches,
  readExport,
} from './delete-projects-lib.mjs';

const W = 'workspaces/w1';
/** An in-memory store: doc paths with their data. */
function fake(docs) {
  const all = new Map(Object.entries(docs));
  const commits = [];
  const kids = (col) =>
    [...all.keys()]
      .filter((p) => p.startsWith(`${col}/`) && !p.slice(col.length + 1).includes('/'))
      .map((p) => p.slice(col.length + 1));
  return {
    all,
    commits,
    rest: {
      docName: (p) => `db/documents/${p}`,
      listIds: async (col) => kids(col),
      list: async (col) => kids(col).map((id) => ({ id, data: all.get(`${col}/${id}`) })),
      busyOf: async (wid) =>
        [...all.keys()].filter(
          (p) => /^users\/[^/]+\/busy\//.test(p) && all.get(p).workspaceId === wid,
        ),
      commit: async (writes) => {
        commits.push(writes.length);
        for (const w of writes) all.delete(w.delete.replace('db/documents/', ''));
      },
    },
  };
}

const DOCS = {
  [W]: { name: 'Org' },
  [`${W}/agents/a1`]: {},
  [`${W}/members/u1`]: {},
  [`${W}/inboxThreads/t1`]: {},
  [`${W}/runs/r1`]: { projectId: 'p1' },
  [`${W}/runs/r1/log/0`]: {},
  [`${W}/projects/p1`]: {},
  [`${W}/projects/p1/items/i1`]: {},
  [`${W}/projects/p1/items/i1/attachments/x`]: {},
  [`${W}/projects/p1/items/i1/messages/m`]: {},
  [`${W}/projects/p1/decisions/d`]: {},
  [`${W}/projects/p1/stepProposals/s`]: {},
  [`${W}/calendar/c1`]: {},
  [`${W}/events/e1`]: { projectId: 'p1' },
  [`${W}/events/e2`]: { projectId: null, itemId: null, runId: null },
  'users/u1/busy/w1_c1': { workspaceId: 'w1' },
  'users/u1/busy/w2_c9': { workspaceId: 'w2' },
  'agentHomes/a1': {},
  'agentHomes/other': { workspaceId: 'w2' },
};
const LIVE = {
  runs: 1,
  log: 1,
  projects: 1,
  items: 1,
  attachments: 1,
  messages: 1,
  decisions: 1,
  stepProposals: 1,
  calendar: 1,
  busy: 1,
  agentHomes: 1,
  projectEvents: 1,
};

const exportText = (over = {}) =>
  JSON.stringify({
    format: 'hivenod-org-export',
    version: 1,
    source: 'script',
    workspaceId: 'w1',
    events: [
      { id: 'e1', data: { projectId: 'p1' } },
      { id: 'e2', data: { projectId: null } },
    ],
    busy: [],
    agentHomes: [],
    counts: { ...LIVE, projectEvents: undefined, events: 2, workspace: 1 },
    ...over,
  });

describe('readExport', () => {
  it('reads the counts, project events counted from the file', () => {
    expect(readExport(exportText(), 'w1')).toEqual(LIVE);
  });
  it('refuses another organization, the in-app export, bad JSON or no counts', () => {
    expect(() => readExport(exportText(), 'w2')).toThrow(/organization w1, not w2/);
    expect(() => readExport(exportText({ source: 'web', busy: null }), 'w1')).toThrow(
      /export-org\.mjs/,
    );
    expect(() => readExport('{', 'w1')).toThrow(/not valid JSON/);
    expect(() => readExport(exportText({ format: 'x' }), 'w1')).toThrow(/Not a Hivenod/);
    expect(() => readExport(exportText({ counts: null }), 'w1')).toThrow(/no counts/);
  });
});

describe('inventory and deletion', () => {
  it('counts only the removed data of this organization, children before parents', async () => {
    const f = fake(DOCS);
    const inv = await inventory(f.rest, 'w1');
    expect(inv.counts).toEqual(LIVE);
    const at = (p) => inv.paths.indexOf(p);
    expect(at(`${W}/runs/r1/log/0`)).toBeLessThan(at(`${W}/runs/r1`));
    expect(at(`${W}/projects/p1/items/i1/messages/m`)).toBeLessThan(
      at(`${W}/projects/p1/items/i1`),
    );
    expect(at(`${W}/projects/p1/items/i1`)).toBeLessThan(at(`${W}/projects/p1`));
    expect(inv.paths).not.toContain('users/u1/busy/w2_c9');
    expect(inv.paths).not.toContain('agentHomes/other');
    expect(inv.paths).not.toContain(`${W}/events/e2`);
  });
  it('deletes exactly those, leaving the Inbox, members, agents and workspace events', async () => {
    const f = fake(DOCS);
    const inv = await inventory(f.rest, 'w1');
    expect(await deletePaths(f.rest, inv.paths)).toBe(12);
    expect([...f.all.keys()].sort()).toEqual(
      [
        W,
        `${W}/agents/a1`,
        `${W}/members/u1`,
        `${W}/inboxThreads/t1`,
        `${W}/events/e2`,
        'users/u1/busy/w2_c9',
        'agentHomes/other',
      ].sort(),
    );
    expect((await inventory(f.rest, 'w1')).counts).toEqual(
      Object.fromEntries(COUNTED.map((k) => [k, 0])),
    );
  });
  it('commits in pages', async () => {
    const many = Object.fromEntries(
      Array.from({ length: DELETE_PAGE + 10 }, (_, i) => [`${W}/calendar/c${i}`, {}]),
    );
    const f = fake(many);
    const inv = await inventory(f.rest, 'w1');
    await deletePaths(f.rest, inv.paths);
    expect(f.commits).toEqual([DELETE_PAGE, 10]);
  });
  it('a count that differs from the export is a mismatch', () => {
    expect(mismatches(LIVE, LIVE)).toEqual([]);
    expect(mismatches(LIVE, { ...LIVE, items: 2 })).toEqual([
      { name: 'items', exported: 1, live: 2 },
    ]);
  });
});
