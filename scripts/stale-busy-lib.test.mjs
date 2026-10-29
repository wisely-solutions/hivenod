import { describe, expect, it } from 'vitest';
import { cleanStaleBusy } from './stale-busy-lib.mjs';

const P = 'projects/p/databases/(default)/documents';
const busy = (uid, id, wid) => ({
  name: `${P}/users/${uid}/busy/${id}`,
  fields: { workspaceId: { stringValue: wid } },
});
const ws = (...uids) => ({
  fields: {
    memberRoles: {
      mapValue: { fields: Object.fromEntries(uids.map((u) => [u, { stringValue: 'member' }])) },
    },
  },
});

function fake(docs, workspaces) {
  const deleted = [];
  const fn = async (url, init = {}) => {
    if (url.endsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery;
      const start = q.startAt?.values[0].referenceValue;
      const rest = start ? docs.slice(docs.findIndex((d) => d.name === start) + 1) : docs;
      return {
        ok: true,
        status: 200,
        json: async () => rest.slice(0, q.limit).map((document) => ({ document })),
      };
    }
    if (init.method === 'DELETE') {
      deleted.push(url.split('/documents/')[1]);
      return { ok: true, status: 200, json: async () => ({}) };
    }
    const wid = decodeURIComponent(url.split('/workspaces/')[1]);
    return workspaces[wid]
      ? { ok: true, status: 200, json: async () => workspaces[wid] }
      : { ok: false, status: 404, json: async () => ({}) };
  };
  return { fn, deleted };
}

const docs = [
  busy('alice', 'wA_1', 'wA'), // still a member
  busy('alice', 'wB_1', 'wB'), // removed
  busy('alice', 'wGone_1', 'wGone'), // organization deleted
  busy('bob', 'wB_1', 'wB'), // bob is in wB
];
const workspaces = { wA: ws('alice'), wB: ws('bob') };

describe('cleanStaleBusy', () => {
  it('dry run counts but deletes nothing', async () => {
    const { fn, deleted } = fake(docs, workspaces);
    const r = await cleanStaleBusy({ project: 'p', token: 't', fetchFn: fn });
    expect(r).toMatchObject({
      scanned: 4,
      stale: 2,
      deleted: 0,
      perOrg: { wB: 1, wGone: 1 },
      perUser: { alice: 2 },
    });
    expect(deleted).toEqual([]);
  });
  it('apply deletes only the stale blocks', async () => {
    const { fn, deleted } = fake(docs, workspaces);
    const r = await cleanStaleBusy({ project: 'p', token: 't', apply: true, fetchFn: fn });
    expect(r.deleted).toBe(2);
    expect(deleted.sort()).toEqual(['users/alice/busy/wB_1', 'users/alice/busy/wGone_1']);
  });
  it('pages through more than one page', async () => {
    const many = Array.from({ length: 650 }, (_, i) =>
      busy('alice', `wA_${String(i).padStart(4, '0')}`, 'wA'),
    );
    const { fn } = fake(many, workspaces);
    const r = await cleanStaleBusy({ project: 'p', token: 't', fetchFn: fn });
    expect(r).toMatchObject({ scanned: 650, stale: 0 });
  });
  it('never touches docs outside users/*/busy and stops on a read error', async () => {
    const odd = { name: `${P}/other/x/busy/y`, fields: { workspaceId: { stringValue: 'wGone' } } };
    const { fn } = fake([odd], workspaces);
    expect(
      (await cleanStaleBusy({ project: 'p', token: 't', apply: true, fetchFn: fn })).stale,
    ).toBe(0);
    const bad = async (url, init) =>
      url.includes('/workspaces/')
        ? { ok: false, status: 500 }
        : fake(docs, workspaces).fn(url, init);
    await expect(
      cleanStaleBusy({ project: 'p', token: 't', apply: true, fetchFn: bad }),
    ).rejects.toThrow();
  });
});
