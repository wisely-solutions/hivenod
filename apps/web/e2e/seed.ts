import { expect, type Page } from '@playwright/test';
import { adminSetAll, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
export const LONG =
  'A very long item title that keeps going and going so that every layout has to cope with it without breaking anything around it';

const item = (uid: string, over: Record<string, unknown>) => ({
  title: 'Seeded',
  type: 'task',
  stepId: 'draft',
  status: 'queued',
  summary: 'A short summary of the work.',
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: null,
  triage: null,
  sendBackCount: 0,
  costEur: 0.2,
  order: 1,
  updatedAt: ago(90),
  lastEventId: 'seed',
  ...over,
});

export async function seed(page: Page) {
  const owner = person('Ana Admin');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const base = `workspaces/${wid}`;
  // Everything goes in with one commit: one round trip, and the open page gets one snapshot.
  const docs: Array<[string, Record<string, unknown>]> = [];
  const put = (path: string, data: Record<string, unknown>) => docs.push([path, data]);
  put(`${base}/projects/blog`, {
    ...projectFields('Blog', uid),
    steps: [
      { id: 'draft', name: 'Draft', kind: 'agent', description: 'Write it' },
      projectFields('Blog', uid).steps[1]!,
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  put(`${base}/projects/empty`, projectFields('Empty one', uid));
  put(`${base}/agents/scout`, {
    name: 'Scout',
    color: 'agent-3',
    projectIds: '*',
    createdBy: uid,
    createdAt: ago(1000),
    revokedAt: null,
    lastSeenAt: ago(1),
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  const gate = { stepId: 'review', approvals: {}, rejections: {} };
  put(
    `${base}/projects/blog/items/i1`,
    item(uid, { title: LONG, stepId: 'review', status: 'waiting', gate, sendBackCount: 2 }),
  );
  put(
    `${base}/projects/blog/items/i2`,
    item(uid, { title: 'Launch post', stepId: 'review', status: 'waiting', gate, order: 2 }),
  );
  put(
    `${base}/projects/blog/items/i3`,
    item(uid, {
      title: 'Pricing page',
      status: 'working',
      claim: { runId: 'r3', agentUid: 'scout', heartbeatAt: ago(1) },
      progress: { done: 2, total: 5 },
      order: 3,
    }),
  );
  put(
    `${base}/projects/blog/items/i4`,
    item(uid, {
      title: 'Is this a bug?',
      type: 'finding',
      stepId: 'draft',
      status: 'suggested',
      source: { kind: 'finding', label: 'Scout on Pricing page' },
      createdBy: { type: 'agent', id: 'scout' },
      parentItemId: 'i3',
      order: 4,
    }),
  );
  for (let i = 0; i < Number(process.env.SEED_ITEMS ?? 60); i++) {
    put(
      `${base}/projects/blog/items/b${i}`,
      item(uid, { title: `Backlog idea ${i}`, order: 10 + i }),
    );
  }
  put(`${base}/runs/r3`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i3',
    stepId: 'draft',
    startedAt: ago(5),
    heartbeatAt: ago(1),
    heartbeatEventAt: ago(5),
    endedAt: null,
    status: 'running',
    costEur: 0.3,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    summary: null,
    lastEventId: 'seed',
  });
  put(`${base}/projects/blog/items/i1/attachments/a1`, {
    kind: 'markdown',
    name: 'report.md',
    content: '# Report\n\nSome **words** here.\n\n- one\n- two',
    url: null,
    bytes: 40,
    runId: null,
    by: { type: 'agent', id: 'scout' },
    at: ago(60),
    lastEventId: 'seed',
  });
  put(`${base}/projects/blog/items/i2/attachments/a2`, {
    kind: 'html',
    name: 'draft.html',
    content: '<h1>Draft</h1><p>Hello.</p>',
    url: null,
    bytes: 30,
    runId: null,
    by: { type: 'agent', id: 'scout' },
    at: ago(60),
    lastEventId: 'seed',
  });
  put(`${base}/projects/blog/items/i3/messages/q1`, {
    workspaceId: wid,
    projectId: 'blog',
    itemId: 'i3',
    by: { type: 'agent', id: 'scout' },
    kind: 'question',
    text: 'Which audience should the page target?',
    at: ago(30),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  for (const [n, [outcome, tags]] of [
    ['approved', []],
    ['sentBack', ['Too long']],
    ['sentBack', ['Wrong audience']],
    ['approved', []],
  ].entries() as Iterable<[number, [string, string[]]]>) {
    put(`${base}/projects/blog/decisions/d${n}`, {
      workspaceId: wid,
      projectId: 'blog',
      itemId: 'i2',
      itemTitle: 'Launch post',
      stepId: 'review',
      outcome,
      toStepId: outcome === 'sentBack' ? 'draft' : null,
      byUid: uid,
      rationale: outcome === 'sentBack' ? 'Needs another pass' : '',
      tags,
      at: ago(100 + n * 500),
      waitMs: 3_600_000,
      lastEventId: `d${n}`,
    });
  }
  for (let i = 0; i < 8; i++) {
    put(`${base}/events/e${i}`, {
      actor: { type: 'agent', id: 'scout', name: 'Scout' },
      projectId: 'blog',
      itemId: 'i3',
      runId: null,
      type: 'item.updated',
      data: {},
      at: ago(i * 7),
    });
  }
  await adminSetAll(docs);
  return { uid, wid };
}
