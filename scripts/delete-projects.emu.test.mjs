/**
 * The Projects data deletion (slice 11) against the Firestore emulator: seeds an organization with
 * projects, items, runs, calendar events, busy blocks, agentHomes, project events and Inbox data,
 * exports it with the operator export, then runs scripts/delete-projects-data.mjs: refused with a
 * stale or foreign export, a dry run deletes nothing, --yes deletes exactly the removed data.
 * Runs in `pnpm test:rules` (inside the emulators); skipped without FIRESTORE_EMULATOR_HOST.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportOrganization } from './export-org-lib.mjs';
import { restClient } from './delete-projects-lib.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-delete';
const W = `wd${Date.now().toString(36)}`;
const WS = `workspaces/${W}`;
const base = `http://${host}`;
const root = `${base}/v1/projects/${PROJECT}/databases/(default)/documents`;
const H = { authorization: 'Bearer owner', 'content-type': 'application/json' };

const enc = (v) =>
  v === null
    ? { nullValue: null }
    : typeof v === 'string'
      ? { stringValue: v }
      : typeof v === 'number'
        ? { integerValue: String(v) }
        : {
            mapValue: {
              fields: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, enc(x)])),
            },
          };

async function put(docs) {
  const writes = Object.entries(docs).map(([path, data]) => ({
    update: {
      name: `projects/${PROJECT}/databases/(default)/documents/${path}`,
      fields: Object.fromEntries(Object.entries(data).map(([k, x]) => [k, enc(x)])),
    },
  }));
  const res = await fetch(`${root}:commit`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ writes }),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
}
const exists = async (path) => (await fetch(`${root}/${path}`, { headers: H })).status === 200;

const REMOVED = [
  `${WS}/projects/p1`,
  `${WS}/projects/p1/items/i1`,
  `${WS}/projects/p1/items/i1/attachments/a1`,
  `${WS}/projects/p1/items/i1/messages/m1`,
  `${WS}/projects/p1/decisions/d1`,
  `${WS}/projects/p1/stepProposals/s1`,
  `${WS}/runs/r1`,
  `${WS}/runs/r1/log/0`,
  `${WS}/calendar/u1_c1`,
  `users/u1/busy/${W}_u1_c1`,
  `agentHomes/ag-${W}`,
  `${WS}/events/ev-item`,
];
const KEPT = [
  WS,
  `${WS}/members/u1`,
  `${WS}/agents/ag-${W}`,
  `${WS}/inboxThreads/t1`,
  `${WS}/events/ev-org`,
  `users/u1/busy/other_c2`,
];

const dir = mkdtempSync(join(tmpdir(), 'hive-delete-'));
const script = (...args) =>
  execFileSync(
    'node',
    [
      'scripts/delete-projects-data.mjs',
      '--org',
      W,
      '--emulator',
      host,
      '--project',
      PROJECT,
      ...args,
    ],
    { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
const fails = (...args) => {
  try {
    script(...args);
  } catch (e) {
    return `${e.stdout}${e.stderr}`;
  }
  throw new Error('expected the script to refuse');
};

async function exportTo(file) {
  let text = '';
  await exportOrganization({
    project: PROJECT,
    token: 'owner',
    base,
    wid: W,
    write: (s) => void (text += s),
  });
  writeFileSync(file, text);
}

describe.skipIf(!host)('delete-projects-data against the emulator', () => {
  beforeAll(async () => {
    const ev = (projectId) => ({
      actor: { type: 'human', id: 'u1', name: 'U' },
      projectId,
      itemId: null,
      runId: null,
      type: projectId ? 'item.created' : 'workspace.updated',
      data: {},
    });
    await put({
      [WS]: { name: 'Org', ownerUid: 'u1' },
      [`${WS}/members/u1`]: { name: 'U' },
      [`${WS}/agents/ag-${W}`]: { name: 'Hive' },
      [`${WS}/inboxThreads/t1`]: { memberUid: 'u1', title: 'Keep me' },
      [`${WS}/events/ev-org`]: ev(null),
      [`${WS}/events/ev-item`]: ev('p1'),
      [`${WS}/projects/p1`]: { name: 'Hive' },
      [`${WS}/projects/p1/items/i1`]: { title: 'Item' },
      [`${WS}/projects/p1/items/i1/attachments/a1`]: { kind: 'text', content: 'x' },
      [`${WS}/projects/p1/items/i1/messages/m1`]: { text: 'hello' },
      [`${WS}/projects/p1/decisions/d1`]: { outcome: 'approved' },
      [`${WS}/projects/p1/stepProposals/s1`]: { status: 'open' },
      [`${WS}/runs/r1`]: { projectId: 'p1', itemId: 'i1' },
      [`${WS}/runs/r1/log/0`]: { text: 'line' },
      [`${WS}/calendar/u1_c1`]: { title: 'Call' },
      [`users/u1/busy/${W}_u1_c1`]: { workspaceId: W },
      'users/u1/busy/other_c2': { workspaceId: 'other' },
      [`agentHomes/ag-${W}`]: { workspaceId: W },
    });
  });

  it('refuses a missing, foreign or in-app export, and a stale one', async () => {
    const file = join(dir, 'export.json');
    await exportTo(file);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(join(dir, 'foreign.json'), JSON.stringify({ ...j, workspaceId: 'other' }));
    expect(fails('--export', join(dir, 'foreign.json'))).toMatch(/not .*wd/);
    writeFileSync(join(dir, 'web.json'), JSON.stringify({ ...j, source: 'web', busy: null }));
    expect(fails('--export', join(dir, 'web.json'))).toMatch(/export-org\.mjs/);
    // Written after the export: the counts no longer match.
    await put({ [`${WS}/projects/p1/items/i2`]: { title: 'Late' } });
    expect(fails('--export', file)).toMatch(/Refused: .*items/);
  });

  it('a dry run deletes nothing; --yes deletes only the removed data', async () => {
    const file = join(dir, 'export2.json');
    await exportTo(file);
    expect(script('--export', file, '--dry-run', '--yes')).toMatch(/Dry run: 13 documents/);
    expect(script('--export', file)).toMatch(/Dry run/);
    for (const p of REMOVED) expect(await exists(p), p).toBe(true);
    expect(script('--export', file, '--yes')).toMatch(/Deleted 13 documents/);
    for (const p of [...REMOVED, `${WS}/projects/p1/items/i2`])
      expect(await exists(p), p).toBe(false);
    for (const p of KEPT) expect(await exists(p), p).toBe(true);
    // Nothing left: the inventory is empty.
    const rest = restClient({ project: PROJECT, token: 'owner', base });
    expect(await rest.listIds(`${WS}/projects`)).toEqual([]);
  });
});
