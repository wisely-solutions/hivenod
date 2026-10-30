/**
 * The project-to-threads migration (slice 8) against the Firestore emulator: seeds a project with
 * items at Shape, Approve, Build and Accept, findings and closed items, runs the migration (dry run,
 * run, rerun, a resume after a half-written item) and checks the threads, plans and that nothing is
 * duplicated. Runs in `pnpm test:rules` (inside the emulators); skipped without
 * FIRESTORE_EMULATOR_HOST, so `pnpm test:scripts` passes over it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  encodeFields,
  findingRefs,
  migrateProject,
  restClient,
  threadIdFor,
  Ts,
} from './migrate-project-lib.mjs';

const host = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = 'demo-migrate';
const W = `wm${Date.now().toString(36)}`;
const PID = 'hiveproj';
const NOW = new Date();
const ago = (days) => new Ts(NOW.getTime() - days * 86_400_000);
const rest = host ? restClient({ project: PROJECT, token: 'owner', base: `http://${host}` }) : null;

const STEPS = [
  ['shape', 'Shape', 'agent'],
  ['approve', 'Approve', 'human'],
  ['build', 'Build', 'agent'],
  ['release', 'Release', 'agent'],
  ['test', 'Test', 'agent'],
  ['accept', 'Accept', 'human'],
].map(([id, name, kind]) => ({
  id,
  name,
  kind,
  description: '',
  ...(kind === 'human' ? { gate: { mode: 'any', approvers: ['joao'] } } : {}),
}));

const item = (title, stepId, status, over = {}) => ({
  title,
  type: 'idea',
  stepId,
  status,
  summary: `${title}: what it is about.`,
  source: { kind: 'manual', label: 'web' },
  createdBy: { type: 'human', id: 'joao' },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: null,
  triage: null,
  sendBackCount: 0,
  costEur: 0,
  order: 1,
  updatedAt: ago(1),
  lastEventId: 'e0',
  ...over,
});
const ITEMS = {
  iShape: item('Shaping thing', 'shape', 'queued'),
  iApprove: item('Approve me', 'approve', 'waiting'),
  iBuild: item('Building thing', 'build', 'working'),
  iAccept: item('Accept me', 'accept', 'waiting'),
  iDone: item('Old done', 'accept', 'done'),
  fNew: item('Flaky test found', 'shape', 'suggested', {
    type: 'finding',
    createdBy: { type: 'agent', id: 'hive' },
  }),
  fOld: item('Ancient finding', 'shape', 'suggested', { type: 'finding', updatedAt: ago(45) }),
};

async function seed() {
  const docs = {
    [`workspaces/${W}`]: {
      name: 'Migrate test',
      ownerUid: 'joao',
      memberRoles: { joao: 'admin' },
      adminUids: ['joao'],
      createdAt: ago(100),
      lastEventId: 'e0',
    },
    [`workspaces/${W}/members/joao`]: {
      name: 'João',
      email: 'j@example.com',
      photoURL: null,
      color: '#000',
    },
    [`workspaces/${W}/agents/hive`]: {
      name: 'Hive',
      color: '#f80',
      projectIds: '*',
      createdBy: 'joao',
      createdAt: ago(100),
      revokedAt: null,
      lastSeenAt: null,
    },
    [`workspaces/${W}/agents/old`]: {
      name: 'Old',
      color: '#888',
      projectIds: '*',
      createdBy: 'joao',
      createdAt: ago(100),
      revokedAt: ago(10),
      lastSeenAt: null,
    },
    [`workspaces/${W}/projects/${PID}`]: {
      name: 'Hive',
      emoji: '🐝',
      color: 'amber',
      templateId: 'custom',
      steps: STEPS,
      stepIndex: Object.fromEntries(STEPS.map((s, i) => [s.id, i])),
      memberUids: [],
      stepAgents: {},
      createdBy: 'joao',
      createdAt: ago(100),
      archivedAt: null,
      lastEventId: 'e0',
    },
  };
  for (const [id, data] of Object.entries(ITEMS))
    docs[`workspaces/${W}/projects/${PID}/items/${id}`] = data;
  const I = (id) => `workspaces/${W}/projects/${PID}/items/${id}`;
  const msg = (itemId, n, text, by = { type: 'agent', id: 'hive' }) => ({
    workspaceId: W,
    projectId: PID,
    itemId,
    by,
    kind: 'note',
    text,
    at: ago(3 - n),
    answered: false,
    replyTo: null,
    lastEventId: `m${n}`,
  });
  docs[`${I('iApprove')}/messages/m1`] = msg(
    'iApprove',
    1,
    'Proposal: do it in two steps. Size M.',
  );
  docs[`${I('iAccept')}/messages/m1`] = msg(
    'iAccept',
    1,
    'PR https://github.com/o/r/pull/77 is green.',
  );
  docs[`${I('iAccept')}/messages/m2`] = msg(
    'iAccept',
    2,
    'Released release-180, live commit 1a2b3c4.',
  );
  const att = (kind, name, content, url) => ({
    kind,
    name,
    content,
    url,
    bytes: content ? content.length : 0,
    runId: null,
    by: { type: 'agent', id: 'hive' },
    at: ago(1),
    lastEventId: 'a',
  });
  docs[`${I('iAccept')}/attachments/a1`] = att(
    'image',
    'after.png',
    'data:image/png;base64,iVBORw0KGgo=',
    null,
  );
  docs[`${I('iAccept')}/attachments/a2`] = att('html', 'report.html', '<h1>Report</h1>', null);
  docs[`workspaces/${W}/projects/${PID}/decisions/d1`] = {
    workspaceId: W,
    projectId: PID,
    itemId: 'iAccept',
    itemTitle: 'Accept me',
    stepId: 'approve',
    outcome: 'approved',
    toStepId: 'build',
    byUid: 'joao',
    rationale: 'Go.',
    tags: [],
    at: ago(5),
    lastEventId: 'd1',
  };
  await rest.commit(
    Object.entries(docs).map(([p, d]) => ({
      update: { name: rest.docName(p), fields: encodeFields(d) },
    })),
  );
}

const run = (dryRun) =>
  migrateProject({ rest, wid: W, pid: PID, memberUid: 'joao', agentUid: 'hive', dryRun, now: NOW });
const col = async (name) => rest.where(`workspaces/${W}`, name, 'memberUid', 'joao');
const rowOf = (r, id) => r.rows.find((x) => x.itemId === id);

describe.skipIf(!host)('migrate-project-to-threads on the emulator', () => {
  beforeAll(seed);

  it('refuses a revoked agent, a non-member and a missing project', async () => {
    const base = { rest, wid: W, pid: PID, memberUid: 'joao', agentUid: 'hive', dryRun: true };
    await expect(migrateProject({ ...base, agentUid: 'old' })).rejects.toThrow(/revoked/);
    await expect(migrateProject({ ...base, memberUid: 'eve' })).rejects.toThrow(/not a member/);
    await expect(migrateProject({ ...base, pid: 'nope' })).rejects.toThrow(/not found/);
  });

  it('a dry run prints the mapping and writes nothing', async () => {
    const r = await run(true);
    expect(rowOf(r, 'iApprove')).toMatchObject({ to: '2 Approve idea (of 6)', action: 'create' });
    expect(rowOf(r, 'iAccept')).toMatchObject({
      to: '6 Accept on live (of 6)',
      action: 'create',
      attachments: '2/2',
    });
    expect(rowOf(r, 'fNew')).toMatchObject({ to: 'finding: dev plan proposed', action: 'create' });
    for (const id of ['iShape', 'iBuild', 'iDone', 'fOld'])
      expect(rowOf(r, id).action).toBe('skip');
    expect(rowOf(r, 'iBuild').to).toMatch(/agent step Build/);
    expect(r.writes).toBe(0);
    expect(await col('inboxThreads')).toEqual([]);
  });

  it('the command prints the table (dry run)', () => {
    const out = execFileSync(
      process.execPath,
      [
        join(import.meta.dirname, 'migrate-project-to-threads.mjs'),
        ...['--org', W, '--project', PID, '--member', 'joao', '--agent', 'hive', '--dry-run'],
        ...['--emulator', host, '--firebase-project', PROJECT],
      ],
      { encoding: 'utf8' },
    );
    // MIGRATE_TABLE_OUT=<file>: keep the printed table (a sample for the dry run shown to the owner).
    if (process.env.MIGRATE_TABLE_OUT) writeFileSync(process.env.MIGRATE_TABLE_OUT, out);
    expect(out).toContain('DRY RUN');
    expect(out).toMatch(/iAccept\s+Accept me/);
    expect(out).toMatch(/iAccept.*create/);
    expect(out).toContain('3 to create');
  });

  it('a run creates the threads and plans at the mapped steps', async () => {
    const r = await run(false);
    expect(r.writes).toBeGreaterThan(0);
    const threads = await col('inboxThreads');
    expect(threads.map((t) => t.id).sort()).toEqual(
      [
        threadIdFor(W, PID, 'iApprove'),
        threadIdFor(W, PID, 'iAccept'),
        findingRefs('joao', 'fNew').threadId,
      ].sort(),
    );
    for (const t of threads) expect(t.data).toMatchObject({ state: 'yourCall', fetchedBy: 'hive' });
    const subjects = await col('inboxSubjects');
    expect(subjects.map((s) => s.data.name).sort()).toEqual([
      'Hive findings',
      'Hivenod development',
    ]);
    const dev = subjects.find((s) => s.data.name === 'Hivenod development').id;
    expect(threads.find((t) => t.id === threadIdFor(W, PID, 'iAccept')).data.subjectId).toBe(dev);
    const plans = await col('inboxPlans');
    const planOf = (tid) => plans.find((p) => p.data.threadId === tid).data;
    expect(planOf(threadIdFor(W, PID, 'iApprove'))).toMatchObject({
      cursor: 1,
      state: 'active',
      templateId: 'dev',
    });
    expect(planOf(threadIdFor(W, PID, 'iAccept'))).toMatchObject({ cursor: 5, state: 'active' });
    expect(planOf(findingRefs('joao', 'fNew').threadId)).toMatchObject({
      cursor: 0,
      state: 'proposed',
    });
    const outcomes = await col('inboxOutcomes');
    const acc = planOf(threadIdFor(W, PID, 'iAccept'));
    const build = outcomes.find((o) => o.id === acc.steps[2]).data;
    expect(build).toMatchObject({ state: 'done', type: 'build' });
    expect(build.result.permalink).toBe('https://github.com/o/r/pull/77');
    const msgs = await col('inboxMessages');
    const first = msgs.find((m) => m.data.threadId === threadIdFor(W, PID, 'iAccept')).data;
    expect(first.text).toContain('Accept me: what it is about.');
    expect(first.text).toContain('Released release-180');
    expect(first.text).toContain('João approved at approve: Go.');
    expect(first.permalink).toBe(`https://hivenod.com/p/${PID}?item=iAccept`);
    const atts = await col('inboxAttachments');
    expect(atts.map((a) => a.data.name).sort()).toEqual(['after.png', 'report.html']);
    const marked = await rest.get(`workspaces/${W}/projects/${PID}/items/iAccept`);
    expect(marked.migratedTo.threadId).toBe(threadIdFor(W, PID, 'iAccept'));
    expect(marked.title).toBe('Accept me');
    expect(
      (await rest.get(`workspaces/${W}/projects/${PID}/items/iBuild`)).migratedTo,
    ).toBeUndefined();
  });

  it('a rerun duplicates nothing', async () => {
    const counts = async () =>
      Object.fromEntries(
        await Promise.all(
          [
            'inboxThreads',
            'inboxMessages',
            'inboxPlans',
            'inboxOutcomes',
            'inboxEvents',
            'inboxAttachments',
            'inboxSubjects',
          ].map(async (c) => [c, (await col(c)).length]),
        ),
      );
    const before = await counts();
    const r = await run(false);
    expect(r.writes).toBe(0);
    expect(rowOf(r, 'iAccept').action).toBe('already migrated');
    expect(await counts()).toEqual(before);
  });

  it('finishes a half-written item (thread there, marker and an attachment missing)', async () => {
    const I = `workspaces/${W}/projects/${PID}/items/iAccept`;
    const atts = await col('inboxAttachments');
    const gone = atts.find((a) => a.data.name === 'report.html');
    await rest.commit([
      { delete: rest.docName(`workspaces/${W}/inboxAttachments/${gone.id}`) },
      { update: { name: rest.docName(I), fields: {} }, updateMask: { fieldPaths: ['migratedTo'] } },
    ]);
    const r = await run(false);
    expect(rowOf(r, 'iAccept').action).toBe('resume');
    expect((await col('inboxAttachments')).length).toBe(atts.length);
    expect((await rest.get(I)).migratedTo.threadId).toBe(threadIdFor(W, PID, 'iAccept'));
    expect((await col('inboxThreads')).length).toBe(3);
  });
});
