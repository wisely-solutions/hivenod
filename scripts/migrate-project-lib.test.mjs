import { describe, expect, it } from 'vitest';
import {
  buildItemMigration,
  DEV_LABELS,
  findRefs,
  findingRefs,
  formatTable,
  itemText,
  mapItem,
  mappingLabel,
  subjectIdFor,
  threadIdFor,
  Ts,
} from './migrate-project-lib.mjs';

const NOW = new Date('2026-10-30T12:00:00Z');
const ts = (iso) => new Ts(Date.parse(iso));
const STEPS = [
  { id: 'shape', name: 'Shape', kind: 'agent' },
  { id: 'approve', name: 'Approve', kind: 'human' },
  { id: 'build', name: 'Build', kind: 'agent' },
  { id: 'release', name: 'Release', kind: 'agent' },
  { id: 'test', name: 'Test', kind: 'agent' },
  { id: 'accept', name: 'Accept', kind: 'human' },
  { id: 'review', name: 'Legal review', kind: 'human' },
];
const item = (over = {}) => ({
  title: 'Dark mode',
  type: 'idea',
  stepId: 'approve',
  status: 'waiting',
  summary: 'Add a dark theme.',
  updatedAt: ts('2026-10-29T10:00:00Z'),
  createdBy: { type: 'human', id: 'joao' },
  ...over,
});

describe('mapItem', () => {
  it('maps people steps to the Development gates', () => {
    expect(mapItem(item(), STEPS, NOW)).toEqual({ kind: 'thread', cursor: 1 });
    expect(mapItem(item({ stepId: 'accept' }), STEPS, NOW)).toEqual({ kind: 'thread', cursor: 6 });
    expect(mappingLabel({ kind: 'thread', cursor: 1 })).toBe('2 Approve idea (of 7)');
    expect(mappingLabel({ kind: 'thread', cursor: 6 })).toBe('7 Accept on live (of 7)');
  });
  it('never migrates agent steps mid-flight', () => {
    for (const stepId of ['shape', 'build', 'release', 'test'])
      expect(mapItem(item({ stepId, status: 'queued' }), STEPS, NOW).kind).toBe('skip');
    expect(mapItem(item({ stepId: 'build' }), STEPS, NOW).why).toMatch(/agent step Build/);
  });
  it('skips closed, archived, unknown and unmapped items', () => {
    expect(mapItem(item({ status: 'done' }), STEPS, NOW)).toEqual({ kind: 'skip', why: 'done' });
    expect(mapItem(item({ status: 'stopped' }), STEPS, NOW).kind).toBe('skip');
    expect(mapItem(item({ archivedAt: ts('2026-10-01T00:00:00Z') }), STEPS, NOW).why).toBe(
      'archived',
    );
    expect(mapItem(item({ stepId: 'gone' }), STEPS, NOW).why).toMatch(/unknown step/);
    expect(mapItem(item({ stepId: 'review' }), STEPS, NOW).why).toMatch(/Legal review/);
  });
  it('takes findings of the last 30 days', () => {
    const f = (iso) =>
      mapItem(
        item({ status: 'suggested', type: 'finding', stepId: 'shape', updatedAt: ts(iso) }),
        STEPS,
        NOW,
      );
    expect(f('2026-10-20T00:00:00Z')).toEqual({ kind: 'finding' });
    expect(f('2026-09-01T00:00:00Z').why).toMatch(/older than 30 days/);
  });
});

describe('findRefs and itemText', () => {
  it('finds PRs, the release and the live commit', () => {
    expect(
      findRefs([
        'PR https://github.com/wisely-solutions/hivenod/pull/86 ready',
        'Released release-175, live commit a979dda; again https://github.com/wisely-solutions/hivenod/pull/86',
      ]),
    ).toEqual({
      prs: ['https://github.com/wisely-solutions/hivenod/pull/86'],
      release: 175,
      commit: 'a979dda',
    });
  });
  it('keeps the newest notes within the message limit', () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      by: { type: 'agent', id: 'hive' },
      kind: 'note',
      text: `note ${i} ${'x'.repeat(3000)}`,
      at: ts(`2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`),
    }));
    const t = itemText({
      item: item(),
      itemId: 'i1',
      url: 'https://hivenod.com/p/p1?item=i1',
      stepName: 'Approve',
      messages,
      decisions: [
        {
          byUid: 'joao',
          outcome: 'approved',
          stepId: 'approve',
          rationale: 'ok',
          at: ts('2026-10-02T00:00:00Z'),
        },
      ],
      nameOf: (by) => (by.type === 'agent' ? 'Hive' : 'João'),
    });
    expect(t.length).toBeLessThanOrEqual(50_000);
    expect(t).toContain('Add a dark theme.');
    expect(t).toContain('https://hivenod.com/p/p1?item=i1');
    expect(t).toContain('note 29');
    expect(t).not.toContain('note 0 ');
    expect(t).toMatch(/the \d+ oldest are in the export/);
    expect(t).toContain('João approved at approve: ok');
  });
});

const base = (mapping, over = {}) => ({
  wid: 'w1',
  pid: 'p1',
  itemId: 'i1',
  item: item(),
  mapping,
  member: { uid: 'joao', name: 'João' },
  agent: { uid: 'hive', name: 'Hive' },
  subject: {
    id: subjectIdFor('w1', 'joao', 'Hivenod development'),
    name: 'Hivenod development',
    exists: false,
  },
  text: 'Add a dark theme.\n\n---\nMigrated…',
  url: 'https://hivenod.com/p/p1?item=i1',
  refs: { prs: ['https://github.com/o/r/pull/9'], release: 12, commit: 'abcdef1' },
  attachments: [],
  now: NOW,
  ...over,
});
const docs = (b, col) =>
  [...b.store.docs].filter(([p]) => p.split('/').at(-2) === col).map(([, d]) => d);
const stepStates = (b) =>
  b.store
    .get(`workspaces/w1/inboxPlans/${b.planId}`)
    .steps.map((id) => b.store.get(`workspaces/w1/inboxOutcomes/${id}`).state);

describe('buildItemMigration', () => {
  it('parks an Approve item at Approve idea, Shape done', () => {
    const b = buildItemMigration(base({ kind: 'thread', cursor: 1 }));
    expect(b.threadId).toBe(threadIdFor('w1', 'p1', 'i1'));
    expect(b.cursor).toBe(1);
    expect(b.state).toBe('yourCall');
    expect(stepStates(b)).toEqual([
      'done',
      'proposed',
      'approved',
      'approved',
      'proposed',
      'approved',
      'proposed',
    ]);
    const [thread] = docs(b, 'inboxThreads');
    expect(thread).toMatchObject({
      memberUid: 'joao',
      fetchedBy: 'hive',
      title: 'Dark mode',
      subjectId: subjectIdFor('w1', 'joao', 'Hivenod development'),
    });
    const [msg] = docs(b, 'inboxMessages');
    expect(msg.permalink).toBe('https://hivenod.com/p/p1?item=i1');
    expect(docs(b, 'inboxSubjects')[0].name).toBe('Hivenod development');
    expect(docs(b, 'inboxEvents').map((e) => e.type)).toEqual([
      'thread.created',
      'thread.filed',
      'outcome.done',
    ]);
  });

  it('parks an Accept item at Accept on live with steps 1-6 done', () => {
    const b = buildItemMigration(
      base(
        { kind: 'thread', cursor: 6 },
        { subject: { id: 'sjX', name: 'Hivenod development', exists: true } },
      ),
    );
    expect(b.cursor).toBe(6);
    expect(b.state).toBe('yourCall');
    expect(stepStates(b)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'proposed']);
    const plan = b.store.get(`workspaces/w1/inboxPlans/${b.planId}`);
    const build = b.store.get(`workspaces/w1/inboxOutcomes/${plan.steps[2]}`);
    expect(build.result.permalink).toBe('https://github.com/o/r/pull/9');
    const green = b.store.get(`workspaces/w1/inboxOutcomes/${plan.steps[3]}`);
    expect(green.result.text).toBe('Kept green in the Hive project.');
    const rel = b.store.get(`workspaces/w1/inboxOutcomes/${plan.steps[5]}`);
    expect(rel.result.text).toContain('release 12, live commit abcdef1');
    const gate = b.store.get(`workspaces/w1/inboxOutcomes/${plan.steps[1]}`);
    expect(gate.decision.byUid).toBe('joao');
    expect(docs(b, 'inboxSubjects')).toEqual([]);
    expect(docs(b, 'inboxThreads')[0].subjectId).toBe('sjX');
  });

  it('turns a finding into a thread with a proposed Development plan', () => {
    const b = buildItemMigration(
      base(
        { kind: 'finding' },
        {
          item: item({ status: 'suggested', type: 'finding' }),
          raisedBy: 'Hive',
          subject: { id: 'sjF', name: 'Hive findings', exists: true },
        },
      ),
    );
    expect(b.threadId).toBe(findingRefs('joao', 'i1').threadId);
    expect(b.state).toBe('yourCall');
    const plan = b.store.get(`workspaces/w1/inboxPlans/${b.planId}`);
    expect(plan).toMatchObject({
      state: 'proposed',
      cursor: 0,
      templateId: 'dev',
      proposedBy: 'hive',
    });
    expect(stepStates(b).every((s) => s === 'proposed')).toBe(true);
    expect(docs(b, 'inboxMessages')[0]).toMatchObject({
      source: 'finding',
      permalink: 'https://hivenod.com/p/p1?item=i1',
    });
  });

  it('copies attachments that fit and warns about the others', () => {
    const at = ts('2026-10-29T00:00:00Z');
    const b = buildItemMigration(
      base(
        { kind: 'thread', cursor: 6 },
        {
          attachments: [
            {
              id: 'a1',
              data: {
                kind: 'image',
                name: 'after.png',
                content: 'data:image/png;base64,iVBORw0KGgo=',
                url: null,
                bytes: 30,
                at,
              },
            },
            {
              id: 'a2',
              data: {
                kind: 'html',
                name: 'plan.html',
                content: '<p>plan</p>',
                url: null,
                bytes: 11,
                at,
              },
            },
            {
              id: 'a3',
              data: {
                kind: 'link',
                name: 'PR',
                content: null,
                url: 'https://github.com/o/r/pull/9',
                bytes: 0,
                at,
              },
            },
            {
              id: 'a4',
              data: {
                kind: 'image',
                name: 'logo.svg',
                content: 'data:image/svg+xml;base64,PHN2Zz4=',
                url: null,
                bytes: 20,
                at,
              },
            },
          ],
        },
      ),
    );
    expect(
      docs(b, 'inboxAttachments')
        .map((a) => a.name)
        .sort(),
    ).toEqual(['PR', 'after.png', 'plan.html']);
    expect(b.groups.filter((g) => g.kind === 'attachment')).toHaveLength(3);
    expect(b.warnings).toEqual([expect.stringContaining('logo.svg')]);
  });

  it('is deterministic (a rerun builds the same ids)', () => {
    const a = buildItemMigration(base({ kind: 'thread', cursor: 6 }));
    const b = buildItemMigration(base({ kind: 'thread', cursor: 6 }));
    expect([...a.store.docs.keys()]).toEqual([...b.store.docs.keys()]);
  });
});

it('formatTable lists every row and warnings', () => {
  const t = formatTable([
    {
      itemId: 'abcdefghij',
      title: 'Dark mode',
      from: 'Approve · waiting',
      to: DEV_LABELS[1],
      attachments: '1/1',
      notes: '3',
      action: 'create',
      threadId: 'mg1',
      warnings: ['w'],
    },
  ]);
  expect(t).toContain('abcdefgh');
  expect(t).toContain('Approve idea');
  expect(t).toContain('! abcdefghij: w');
});
