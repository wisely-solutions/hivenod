import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  NOW,
  ago,
  freezeClock,
  adminDoc,
  adminPatch,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const SHOTS = process.env.SHOTS_DIR;

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!.width <= 500 ? '375' : '1440';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png`, fullPage: false });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

const item = (uid: string, over: Record<string, unknown>) => ({
  title: 'Seeded',
  type: 'task',
  stepId: 'draft',
  status: 'queued',
  summary: 'Seed',
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: null,
  triage: null,
  sendBackCount: 0,
  costEur: 0,
  order: 1,
  updatedAt: new Date(NOW),
  lastEventId: 'seed',
  ...over,
});

const runDoc = (over: Record<string, unknown>) => ({
  agentUid: 'scout',
  projectId: 'blog',
  itemId: 'i1',
  stepId: 'draft',
  startedAt: ago(40),
  heartbeatAt: ago(30),
  heartbeatEventAt: ago(40),
  endedAt: ago(30),
  status: 'done',
  costEur: 0,
  tokensIn: 0,
  tokensOut: 0,
  model: null,
  summary: null,
  lastEventId: 'seed',
  ...over,
});

const eventDoc = (
  type: string,
  minutes: number,
  over: Record<string, unknown> = {},
  actor = { type: 'agent', id: 'scout', name: 'Scout' },
) => ({
  actor,
  projectId: 'blog',
  itemId: 'i1',
  runId: null,
  type,
  data: {},
  at: ago(minutes),
  ...over,
});

async function seed(page: Page) {
  const owner = person('Ana Admin');
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`${base}/agents/scout`, {
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
  const human = { type: 'human', id: uid, name: 'Ana Admin' };

  // i1: run r1 done and approved. i2: run r2 done and sent back. i3: live run. i4: stalled run.
  await adminSet(
    `${base}/projects/blog/items/i1`,
    item(uid, {
      title: 'Market analysis',
      stepId: 'review',
      status: 'waiting',
      gate: { stepId: 'review', approvals: {}, rejections: {} },
    }),
  );
  await adminSet(
    `${base}/projects/blog/items/i2`,
    item(uid, { title: 'Launch post', sendBackCount: 1 }),
  );
  await adminSet(
    `${base}/projects/blog/items/i3`,
    item(uid, {
      title: 'Pricing page',
      status: 'working',
      claim: { runId: 'r3', agentUid: 'scout', heartbeatAt: ago(1) },
    }),
  );
  await adminSet(
    `${base}/projects/blog/items/i4`,
    item(uid, {
      title: 'Old FAQ',
      status: 'working',
      claim: { runId: 'r4', agentUid: 'scout', heartbeatAt: ago(30) },
    }),
  );

  await adminSet(
    `${base}/runs/r1`,
    runDoc({
      itemId: 'i1',
      startedAt: ago(40),
      endedAt: ago(30),
      heartbeatAt: ago(30),
      costEur: 0.5,
      summary: 'Wrote the analysis.',
    }),
  );
  await adminSet(
    `${base}/runs/r2`,
    runDoc({
      itemId: 'i2',
      startedAt: ago(25),
      endedAt: ago(20),
      heartbeatAt: ago(20),
      costEur: 0.25,
    }),
  );
  await adminSet(
    `${base}/runs/r3`,
    runDoc({
      itemId: 'i3',
      startedAt: ago(5),
      endedAt: null,
      heartbeatAt: ago(1),
      status: 'running',
    }),
  );
  await adminSet(
    `${base}/runs/r4`,
    runDoc({
      itemId: 'i4',
      startedAt: ago(60),
      endedAt: null,
      heartbeatAt: ago(30),
      status: 'running',
      heartbeatEventAt: ago(60),
    }),
  );
  for (const [n, text] of [
    'Reading the brief',
    'Drafting section 2',
    'Done, attaching',
  ].entries()) {
    await adminSet(`${base}/runs/r1/log/${n}`, { at: ago(39 - n), level: 'info', text });
  }
  await adminSet(`${base}/runs/r1/log/10`, {
    at: ago(31),
    level: 'warn',
    text: 'Tenth line sorts after the ninth',
  });
  await adminSet(`${base}/projects/blog/items/i1/attachments/f1`, {
    kind: 'text',
    name: 'report.txt',
    content: 'hello',
    url: null,
    bytes: 5,
    runId: 'r1',
    by: { type: 'agent', id: 'scout' },
    at: ago(31),
    lastEventId: 'seed',
  });

  const decision = (id: string, itemId: string, outcome: string, m: number, extra = {}) =>
    adminSet(`${base}/projects/blog/decisions/${id}`, {
      workspaceId: wid,
      projectId: 'blog',
      itemId,
      itemTitle: 'T',
      stepId: 'review',
      outcome,
      toStepId: null,
      byUid: uid,
      rationale: '',
      tags: [],
      at: ago(m),
      lastEventId: id,
      ...extra,
    });
  await decision('d1', 'i1', 'approved', 29, { rationale: 'Great work' });
  await decision('d2', 'i2', 'sentBack', 19, {
    rationale: 'Too long, cut it down',
    tags: ['Too long'],
  });

  // Events: a story for i1 plus 120 older ones for paging.
  await adminSet(`${base}/events/e1`, eventDoc('item.claimed', 40, { runId: 'r1' }));
  await adminSet(
    `${base}/events/e2`,
    eventDoc('attachment.added', 31, { runId: 'r1', data: { name: 'report.html', kind: 'html' } }),
  );
  await adminSet(`${base}/events/e3`, eventDoc('item.completed', 30, { runId: 'r1' }));
  await adminSet(`${base}/events/e4`, eventDoc('decision.approved', 29, {}, human));
  await adminSet(`${base}/events/e5`, eventDoc('run.started', 5, { itemId: 'i3', runId: 'r3' }));
  for (let i = 0; i < 120; i++) {
    await adminSet(
      `${base}/events/old${String(i).padStart(3, '0')}`,
      eventDoc('item.updated', 120 + i, { itemId: 'i2' }),
    );
  }
  return { owner, wid, uid, base };
}

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
});

// The Activity page reads thread events since slice 9 (threadactivity.spec.ts).

test('Agent profile: status, KPIs that add up, runs with logs, release of a stalled run', async ({
  page,
}) => {
  const { base } = await seed(page);
  await page.goto('/agents');
  await page.getByRole('link', { name: 'Scout' }).click();
  await expect(page).toHaveURL(/\/agents\/scout$/);
  await expect(page.getByRole('heading', { name: 'Scout', level: 1 })).toBeVisible();
  await expect(page.getByText(/Working on “Pricing page”/)).toBeVisible();
  await expect(page.getByTestId('elapsed')).toHaveText(/^\d+:\d\d$/);

  // Today: 4 runs, 2 completed, EUR 0.75, 1 of 2 approved first time, 1 sent back (Too long).
  await expect(page.getByTestId('kpi-runs')).toHaveText('4');
  await expect(page.getByTestId('kpi-completed')).toHaveText('2');
  await expect(page.getByTestId('kpi-cost')).toHaveText('€0.75');
  await expect(page.getByTestId('kpi-rate')).toHaveText('50%');
  await expect(page.getByText('1 of 2 judged')).toBeVisible();
  await expect(page.getByTestId('kpi-sendbacks')).toHaveText('1');
  await expect(page.getByText('Too long')).toBeVisible();
  await expect(page.getByTestId('kpi-time')).toHaveText(/^(4\d|5\d) min$/);
  await page.getByRole('tab', { name: '30 days' }).click();
  await expect(page.getByTestId('kpi-runs')).toHaveText('4');
  await expectNoHorizontalScroll(page);
  await shot(page, 'agent');

  // Runs table: expand r1 for its log (numeric order), attachment and the decision.
  const runs = page.getByRole('list', { name: 'Runs' });
  await expect(runs.getByText('Stalled')).toBeVisible();
  await expect(runs.getByText('Running', { exact: true })).toBeVisible();
  await runs.getByRole('button', { name: /Market analysis/ }).click();
  const log = page.getByRole('log', { name: 'Run log' });
  await expect(log).toContainText('Reading the brief');
  const text = await log.innerText();
  expect(text.indexOf('Done, attaching')).toBeLessThan(text.indexOf('Tenth line'));
  await expect(page.getByRole('link', { name: 'report.txt' })).toBeVisible();
  await expect(page.getByText('Approved: Great work')).toBeVisible();
  await shot(page, 'agent-run');

  // Stalled: the owner releases it. The claim is cleared, the run ends, and an event is written.
  await runs.getByRole('button', { name: /Old FAQ/ }).click();
  await expect(page.getByText(/Stalled: Scout has not reported/)).toBeVisible();
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByRole('dialog')).toContainText('the item goes back in the queue');
  await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click();
  await expect(page.getByText('Released. The item is back in the queue.')).toBeVisible();
  await expect(runs.getByText('Released')).toBeVisible();
  await expect
    .poll(
      async () => (await adminDoc(`${base}/projects/blog/items/i4`))?.fields.status?.stringValue,
    )
    .toBe('queued');
  expect((await adminDoc(`${base}/projects/blog/items/i4`))?.fields.claim?.nullValue).toBeNull();
  // Activity shows thread events since slice 9; the release is checked on the item above.
  await axe(page);
});

test('Releasing a stalled run whose item it no longer holds says the item stays where it is', async ({
  page,
}) => {
  const { base } = await seed(page);
  // The item moved on without this run (e.g. released elsewhere): only the run is ended.
  await adminPatch(`${base}/projects/blog/items/i4`, { claim: null });
  await page.goto('/agents/scout');
  const runs = page.getByRole('list', { name: 'Runs' });
  await runs.getByRole('button', { name: /Old FAQ/ }).click();
  await page.getByRole('button', { name: 'Release' }).click();
  await expect(page.getByRole('dialog')).toContainText('the item stays where it is');
  await page.getByRole('dialog').getByRole('button', { name: 'Release' }).click();
  await expect(page.getByText(/Released\. The run is ended; .* stays where it is\./)).toBeVisible();
  await expect(page.getByText('Released. The item is back in the queue.')).toBeHidden();
  await expect(runs.getByText('Released')).toBeVisible();
});

test('Item detail has a Timeline of its events', async ({ page }) => {
  await seed(page);
  await page.goto('/p/blog?item=i1');
  const detail = page.getByRole('article', { name: /Market analysis/ });
  await expect(detail).toBeVisible();
  await detail.getByRole('tab', { name: 'History' }).click();
  const tl = detail.getByLabel('History');
  await expect(tl.getByText('Scout picked up “Market analysis”')).toBeVisible();
  await expect(tl.getByText('Scout attached report.html to “Market analysis”')).toBeVisible();
  await expect(tl.getByText('Ana Admin approved “Market analysis”')).toBeVisible();
  await expect(tl.getByText('Scout started a run on “Pricing page”')).toBeHidden();
  await shot(page, 'timeline');
});

test('Item detail run log keeps the Extra arguments line on one line and scrolls sideways', async ({
  page,
}) => {
  const { base } = await seed(page);
  await adminSet(`${base}/runs/r1/log/20`, {
    at: ago(30),
    level: 'info',
    text: 'Extra Claude arguments: --dangerously-skip-permissions --model claude-sonnet-5-5 --effort high --max-turns 200 --append-system-prompt-file /home/agent/prompts/very-long-name.md',
  });
  await page.goto('/p/blog?item=i1');
  const detail = page.getByRole('article', { name: /Market analysis/ });
  await detail.getByRole('button', { name: 'Show log' }).first().click();
  const log = detail.getByLabel('Run log');
  const line = log.getByText(/^Extra Claude arguments:/);
  await expect(line).toBeVisible();
  const m = await log.evaluate((el) => {
    const l = [...el.children].find((c) => c.textContent?.startsWith('Extra Claude'))!;
    const lh = parseFloat(getComputedStyle(l).lineHeight);
    return {
      ws: getComputedStyle(el).whiteSpace,
      ox: getComputedStyle(el).overflowX,
      scrolls: el.scrollWidth > el.clientWidth,
      height: l.getBoundingClientRect().height,
      lh,
    };
  });
  expect(m.ws).toBe('pre');
  expect(['auto', 'scroll']).toContain(m.ox);
  expect(m.scrolls).toBe(true);
  expect(m.height).toBeLessThan(m.lh * 1.5);
  await expectNoHorizontalScroll(page);
  await shot(page, 'item-run-log');
});

test('The shell footer counts working agents and spend from runs', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the footer text shows on wide screens');
  await seed(page);
  await page.goto('/');
  const side = page.getByRole('complementary', { name: 'Main' });
  await expect(side.getByText('1 agent working · 0 idle')).toBeVisible();
  await expect(side.getByText(/^Spend this month €0\.75$/)).toBeVisible();
  // The project header shows the same spend, with no budget beside it.
  await page.goto('/p/blog');
  const main = page.getByRole('main');
  await expect(main.getByText(/^Spend this month\s*€0\.75$/)).toBeVisible();
  await expect(main.getByText(/budget/i)).toHaveCount(0);
});

test('An agent working on several items at once says "working N items" (card cGSENsRF)', async ({
  page,
}, info) => {
  const { base, uid } = await seed(page);
  // A second live run of Scout (a channel session with max_items): two items in work at once.
  await adminSet(
    `${base}/projects/blog/items/i5`,
    item(uid, {
      title: 'Second page',
      status: 'working',
      claim: { runId: 'r5', agentUid: 'scout', heartbeatAt: ago(1) },
    }),
  );
  await adminSet(
    `${base}/runs/r5`,
    runDoc({
      itemId: 'i5',
      startedAt: ago(3),
      endedAt: null,
      heartbeatAt: ago(1),
      status: 'running',
    }),
  );
  await page.goto('/agents');
  await expect(page.getByText('Online · working 2 items')).toBeVisible();
  await page.getByRole('link', { name: 'Scout' }).click();
  await expect(page.getByTestId('working-items')).toHaveText('Working 2 items');
  if (info.project.name === 'desktop-1440') {
    const side = page.getByRole('complementary', { name: 'Main' });
    await expect(side.getByText('1 agent working on 2 items · 0 idle')).toBeVisible();
  }
  await shot(page, 'agent-working-items');
});

test('A decision made from Telegram says so in Activity and in the item decisions (card ct6uvl3b)', async ({
  page,
}) => {
  const { base, uid } = await seed(page);
  const human = { type: 'human', id: uid, name: 'Ana Admin' };
  await adminSet(
    `${base}/events/tg1`,
    eventDoc('decision.sentBack', 1, { itemId: 'i2', data: { via: 'telegram' } }, human),
  );
  await adminSet(`${base}/projects/blog/decisions/tg1`, {
    workspaceId: base.split('/')[1],
    projectId: 'blog',
    itemId: 'i2',
    itemTitle: 'Launch post',
    stepId: 'draft',
    outcome: 'sentBack',
    toStepId: 'draft',
    byUid: uid,
    rationale: 'Needs a sharper intro.',
    tags: [],
    via: 'telegram',
    at: ago(1),
    lastEventId: 'tg1',
  });
  await page.goto('/p/blog?item=i2');
  const detail = page.getByRole('article', { name: /Launch post/ });
  await expect(detail.getByText(/· via Telegram/)).toBeVisible();
  await detail.getByText(/· via Telegram/).scrollIntoViewIfNeeded();
  await shot(page, 'telegram-decision');
});
