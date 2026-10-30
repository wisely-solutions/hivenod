import { describe, expect, it } from 'vitest';
import { decodeFields, exportOrganization } from './export-org-lib.mjs';

const P = 'projects/p/databases/(default)/documents';
const str = (s) => ({ stringValue: s });
const doc = (path, fields) => ({ name: `${P}/${path}`, fields });

/** A tiny Firestore REST: documents.list with paging and runQuery on the collection group busy. */
function fakeRest(docs) {
  return async (url, init = {}) => {
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    const u = new URL(url);
    if (u.pathname.endsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery;
      const all = docs.filter((d) => /\/busy\/[^/]+$/.test(d.name));
      const start = q.startAt?.values[0].referenceValue;
      const rest = start ? all.slice(all.findIndex((d) => d.name === start) + 1) : all;
      return ok(rest.slice(0, q.limit).map((document) => ({ document })));
    }
    const path = decodeURIComponent(u.pathname.split('/documents/')[1]);
    const exact = docs.find((d) => d.name === `${P}/${path}`);
    const kids = docs
      .filter((d) => {
        const rel = d.name.slice(P.length + 1);
        return rel.startsWith(`${path}/`) && !rel.slice(path.length + 1).includes('/');
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (exact && !path.endsWith('s') && !/\/(log|calendar|agentHomes)$/.test(path))
      return ok(exact);
    if (
      !exact &&
      kids.length === 0 &&
      !/^[a-zA-Z]+$/.test(path) &&
      path.split('/').length % 2 === 0
    )
      return { ok: false, status: 404, json: async () => ({}) };
    const size = Number(u.searchParams.get('pageSize'));
    const from = Number(u.searchParams.get('pageToken') ?? 0);
    const page = kids.slice(from, from + size);
    return ok({
      documents: page,
      nextPageToken: from + size < kids.length ? String(from + size) : undefined,
    });
  };
}

describe('decodeFields', () => {
  it('decodes REST values', () => {
    expect(
      decodeFields({
        a: str('x'),
        n: { integerValue: '3' },
        t: { timestampValue: '2026-10-30T10:00:00Z' },
        l: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } },
        m: { mapValue: { fields: { k: { doubleValue: 1.5 } } } },
        r: { referenceValue: `${P}/workspaces/w1` },
      }),
    ).toEqual({
      a: 'x',
      n: 3,
      t: { $timestamp: '2026-10-30T10:00:00.000Z' },
      l: [true, null],
      m: { k: 1.5 },
      r: { $ref: 'workspaces/w1' },
    });
  });
});

describe('exportOrganization', () => {
  const docs = [
    doc('workspaces/w1', { name: str('Org') }),
    doc('workspaces/w1/agents/ag1', { name: str('Hive') }),
    doc('workspaces/w1/projects/p1', { name: str('Hive') }),
    doc('workspaces/w1/projects/p1/items/i1', { title: str('A') }),
    doc('workspaces/w1/projects/p1/items/i1/attachments/a1', { content: str('<p>x</p>') }),
    doc('workspaces/w1/projects/p1/decisions/d1', { outcome: str('approved') }),
    doc('workspaces/w1/runs/r1', { status: str('done') }),
    doc('workspaces/w1/runs/r1/log/0', { text: str('hi') }),
    doc('workspaces/w1/calendar/u1_google_e1', { title: str('Call') }),
    doc('users/u1/busy/w1_u1_google_e1', { workspaceId: str('w1') }),
    doc('users/u1/busy/w2_u1_google_e9', { workspaceId: str('w2') }),
    doc('agentHomes/ag1', { workspaceId: str('w1') }),
    doc('agentHomes/other', { workspaceId: str('w2') }),
    ...Array.from({ length: 650 }, (_, i) =>
      doc(`workspaces/w1/events/e${String(i).padStart(4, '0')}`, { type: str('x') }),
    ),
  ];

  it('writes the whole organization, paged, with the same shape as the web export', async () => {
    let text = '';
    const r = await exportOrganization({
      project: 'p',
      token: 'owner',
      wid: 'w1',
      write: (s) => void (text += s),
      fetchFn: fakeRest(docs),
      now: new Date('2026-10-30T10:00:00Z'),
    });
    const j = JSON.parse(text);
    expect(j).toMatchObject({
      format: 'hivenod-org-export',
      version: 1,
      source: 'script',
      workspaceId: 'w1',
      workspace: { name: 'Org' },
    });
    expect(j.events).toHaveLength(650);
    expect(j.projects[0].items[0].attachments[0].data.content).toBe('<p>x</p>');
    expect(j.projects[0].decisions[0].data.outcome).toBe('approved');
    expect(j.runs[0].log[0].data.text).toBe('hi');
    expect(j.calendar[0].id).toBe('u1_google_e1');
    expect(j.busy.map((b) => b.path)).toEqual(['users/u1/busy/w1_u1_google_e1']);
    expect(j.agentHomes.map((h) => h.id)).toEqual(['ag1']);
    expect(j.counts).toEqual(r.counts);
    expect(j.counts).toMatchObject({ events: 650, projects: 1, items: 1, attachments: 1, busy: 1 });
  });

  it('fails for a missing organization', async () => {
    await expect(
      exportOrganization({
        project: 'p',
        token: 't',
        wid: 'nope',
        write: () => {},
        fetchFn: fakeRest(docs),
      }),
    ).rejects.toThrow('not found');
  });
});
