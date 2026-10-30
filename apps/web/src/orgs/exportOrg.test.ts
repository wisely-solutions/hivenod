import { describe, expect, it } from 'vitest';
import { exportFilename, exportOrg, PAGE, type ExportStore } from './exportOrg';

function fakeStore(
  tree: Record<string, { id: string; data: unknown }[]>,
  ws: unknown,
): ExportStore {
  return {
    async get() {
      return ws;
    },
    async list(col, after, max) {
      const all = (tree[col] ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : 1));
      const from = after ? all.findIndex((d) => d.id === after) + 1 : 0;
      return all.slice(from, from + max);
    },
  };
}

describe('exportOrg', () => {
  const base = 'workspaces/w1';
  it('writes a valid JSON file with header, nested documents and counts', async () => {
    const store = fakeStore(
      {
        [`${base}/projects`]: [{ id: 'p1', data: { name: 'Hive' } }],
        [`${base}/projects/p1/items`]: [{ id: 'i1', data: { title: 'A' } }],
        [`${base}/projects/p1/items/i1/attachments`]: [
          { id: 'a1', data: { kind: 'html', content: '<p>x</p>' } },
        ],
        [`${base}/projects/p1/decisions`]: [{ id: 'd1', data: { outcome: 'approved' } }],
        [`${base}/runs`]: [{ id: 'r1', data: { status: 'done' } }],
        [`${base}/runs/r1/log`]: [{ id: '0', data: { text: 'hi' } }],
        [`${base}/calendar`]: [{ id: 'u_google_e1', data: { title: 'Call' } }],
      },
      { name: 'Org' },
    );
    const r = await exportOrg(store, 'w1', { now: new Date('2026-10-30T10:00:00Z') });
    const json = JSON.parse(r.parts.join(''));
    expect(json.format).toBe('hivenod-org-export');
    expect(json.version).toBe(1);
    expect(json.workspaceId).toBe('w1');
    expect(json.exportedAt).toBe('2026-10-30T10:00:00.000Z');
    expect(json.projects[0].items[0].attachments[0].data.content).toBe('<p>x</p>');
    expect(json.projects[0].decisions[0].id).toBe('d1');
    expect(json.runs[0].log[0].data.text).toBe('hi');
    expect(json.calendar).toHaveLength(1);
    expect(json.busy).toBeNull();
    expect(json.counts).toMatchObject({
      projects: 1,
      items: 1,
      attachments: 1,
      calendar: 1,
      log: 1,
    });
    expect(r.total).toBe(1 + 1 + 1 + 1 + 1 + 1 + 1 + 1 + 0);
  });

  it('pages through large collections and reports progress', async () => {
    const n = PAGE * 2 + 5;
    const evs = Array.from({ length: n }, (_, i) => ({
      id: String(i).padStart(6, '0'),
      data: { i },
    }));
    const progress: number[] = [];
    const r = await exportOrg(fakeStore({ [`${base}/events`]: evs }, {}), 'w1', {
      onProgress: (p) => progress.push(p.docs),
    });
    expect(JSON.parse(r.parts.join('')).events).toHaveLength(n);
    expect(r.counts.events).toBe(n);
    expect(progress.length).toBeGreaterThanOrEqual(3);
  });

  it('can be stopped and refuses a missing organization', async () => {
    await expect(exportOrg(fakeStore({}, null), 'w1')).rejects.toThrow('not found');
    await expect(exportOrg(fakeStore({}, {}), 'w1', { shouldStop: () => true })).rejects.toThrow(
      'stopped',
    );
  });

  it('names the file after the organization', () => {
    expect(exportFilename('Acme & Co!', 'w1', new Date('2026-10-30T00:00:00Z'))).toBe(
      'acme-co-export-2026-10-30.json',
    );
  });
});
