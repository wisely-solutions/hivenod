import { describe, expect, it } from 'vitest';
import { cutoffIso, sweepPairings } from './pairing-sweep-lib.mjs';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const P = 'projects/p/databases/(default)/documents';

function fakeFetch(docs) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body && JSON.parse(init.body) });
    if (url.endsWith(':runQuery')) {
      return {
        ok: true,
        status: 200,
        json: async () => docs.map((name) => ({ document: { name } })).concat([{}]),
      };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { fn, calls };
}

describe('sweepPairings', () => {
  it('queries pairings older than 15 minutes and deletes them', async () => {
    const { fn, calls } = fakeFetch([`${P}/pairings/K7QX29PD`, `${P}/pairings/AAAABBBB`]);
    const r = await sweepPairings({ project: 'p', token: 't', now: NOW, fetchFn: fn });
    expect(r).toEqual({ found: 2, deleted: 2 });
    const q = calls[0].body.structuredQuery;
    expect(q.from).toEqual([{ collectionId: 'pairings' }]);
    expect(q.where.fieldFilter.value.timestampValue).toBe('2026-10-28T11:45:00.000Z');
    expect(cutoffIso(NOW)).toBe('2026-10-28T11:45:00.000Z');
    expect(calls.slice(1).map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });
  it('dry run deletes nothing', async () => {
    const { fn, calls } = fakeFetch([`${P}/pairings/K7QX29PD`]);
    const r = await sweepPairings({
      project: 'p',
      token: 't',
      now: NOW,
      dryRun: true,
      fetchFn: fn,
    });
    expect(r).toEqual({ found: 1, deleted: 0 });
    expect(calls).toHaveLength(1);
  });
  it('never deletes a doc outside pairings', async () => {
    const { fn, calls } = fakeFetch([`${P}/workspaces/W1`, `${P}/pairings/K7QX29PD/x/y`]);
    const r = await sweepPairings({ project: 'p', token: 't', now: NOW, fetchFn: fn });
    expect(r).toEqual({ found: 0, deleted: 0 });
    expect(calls).toHaveLength(1);
  });
  it('throws when the query fails', async () => {
    const fn = async () => ({ ok: false, status: 403 });
    await expect(sweepPairings({ project: 'p', token: 't', fetchFn: fn })).rejects.toThrow('403');
  });
});
