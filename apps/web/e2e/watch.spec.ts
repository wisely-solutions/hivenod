/**
 * Card EmDyZyfC: watch an agent work inside the item. A working item shows a Live block (who, how
 * long, cost, tokens, machine, progress and the current line, the last log lines, Full log, Stop),
 * the History reads as one story (source, reasons, run results, files), and the card ring says "3/6".
 * Screenshots: SHOTS_DIR=~/reports/EmDyZyfC-shots.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
const SHOTS = process.env.SHOTS_DIR;
const detail = (page: Page) => page.locator('[aria-label="Item detail"]:visible');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const w = page.viewportSize()!.width;
  const size = String(w);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

test('a working item shows its live run and one History story', async ({ page }) => {
  const owner = person('Marta Silva');
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
    lastSeenAt: ago(0),
    seenHost: 'marta-mbp',
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/runs/r1`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago(12),
    heartbeatAt: ago(0),
    heartbeatEventAt: ago(12),
    endedAt: null,
    status: 'running',
    costEur: 0.32,
    tokensIn: 44_000,
    tokensOut: 2_000,
    model: 'claude-opus-5-5',
    summary: null,
    lastEventId: 'seed',
  });
  // An earlier, finished run with a result and a file.
  await adminSet(`${base}/runs/r0`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago(300),
    heartbeatAt: ago(290),
    heartbeatEventAt: ago(300),
    endedAt: ago(290),
    status: 'done',
    costEur: 0.2,
    tokensIn: 20_000,
    tokensOut: 1_000,
    model: 'claude-opus-5-5',
    summary: 'Found 3 places that render project status',
    lastEventId: 'seed',
  });
  const lines = [
    'Searching the codebase for share links',
    'Found 3 places that render project status',
    'Reading the share-link rules',
    'Drafting the discovery report (HTML)',
  ];
  for (const [i, text] of lines.entries())
    await adminSet(`${base}/runs/r1/log/${i}`, { at: ago(4 - i), level: 'info', text });
  await adminSet(`${base}/projects/blog/items/i1/attachments/a1`, {
    kind: 'html',
    name: 'discovery.html',
    content: '<p>draft</p>',
    url: null,
    bytes: 12,
    runId: 'r1',
    by: { type: 'agent', id: 'scout' },
    at: ago(1),
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, {
    title: 'Show project status to clients without a login',
    type: 'idea',
    stepId: 'draft',
    status: 'working',
    summary: 'Read-only share link per project.',
    source: { kind: 'telegram', label: 'Telegram' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: { runId: 'r1', agentUid: 'scout', heartbeatAt: new Date() },
    progress: { done: 3, total: 6 },
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    attachmentCount: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });
  const human = { type: 'human', id: uid, name: 'Marta Silva' };
  const ev = (type: string, m: number, over: object = {}, actor: object = human) => ({
    actor,
    projectId: 'blog',
    itemId: 'i1',
    runId: null,
    type,
    data: {},
    at: ago(m),
    ...over,
  });
  const scout = { type: 'agent', id: 'scout', name: 'Scout' };
  await adminSet(`${base}/events/e1`, ev('item.created', 400, { data: { title: 'x' } }));
  await adminSet(`${base}/events/e2`, ev('decision.approved', 320));
  await adminSet(
    `${base}/events/e3`,
    ev('run.ended', 290, { runId: 'r0', data: { status: 'done' } }, scout),
  );
  await adminSet(`${base}/events/e4`, ev('item.claimed', 12, { runId: 'r1' }, scout));
  // Card CB1NbWdk: six progress calls on the finished run r0 fold into its row; a run stopped from
  // the web (r2) gets the same result row.
  for (let i = 1; i <= 6; i++)
    await adminSet(
      `${base}/events/pr${i}`,
      ev(
        'item.updated',
        300 - i * 2,
        { runId: 'r0', data: { progress: { done: i, total: 6 } } },
        scout,
      ),
    );
  await adminSet(`${base}/runs/r2`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago(100),
    heartbeatAt: ago(90),
    heartbeatEventAt: ago(100),
    endedAt: ago(90),
    status: 'stopped',
    stoppedBy: { uid, name: 'Marta Silva' },
    costEur: 0.07,
    tokensIn: 9_000,
    tokensOut: 400,
    model: 'claude-opus-5-5',
    summary: 'Stopped by Marta Silva in Hivenod: the item went back on hold.',
    lastEventId: 'seed',
  });
  await adminSet(
    `${base}/events/e5`,
    ev('item.workStopped', 90, { runId: 'r2', data: { mode: 'back', reason: '' } }),
  );
  await adminSet(`${base}/projects/blog/decisions/e2`, {
    workspaceId: wid,
    projectId: 'blog',
    itemId: 'i1',
    itemTitle: 'x',
    stepId: 'review',
    outcome: 'approved',
    toStepId: 'draft',
    byUid: uid,
    rationale: 'Top request from support.',
    tags: [],
    at: ago(320),
    lastEventId: 'e2',
  });

  await page.goto('/p/blog?item=i1');
  const live = detail(page).getByTestId('live-run');
  await expect(live).toContainText('Scout is working', { timeout: 15_000 });
  await expect(live).toContainText('€0.32');
  await expect(live).toContainText('46k tokens');
  await expect(live).toContainText('on marta-mbp');
  await expect(live).toContainText('3 of 6');
  await expect(live).toContainText('Drafting the discovery report (HTML)');
  const tail = live.getByRole('log', { name: 'Latest log lines' });
  await expect(tail.locator('p')).toHaveCount(3);
  await expect(tail).not.toContainText('Searching the codebase');
  await expect(live.getByRole('button', { name: 'discovery.html new' })).toBeVisible();
  await expect(live.getByRole('button', { name: 'Stop work' })).toHaveCount(1);
  await expectNoHorizontalScroll(page);

  // A new log line streams in without leaving the item.
  await adminSet(`${base}/runs/r1/log/4`, {
    at: new Date(),
    level: 'info',
    text: 'Writing the summary',
  });
  await expect(tail).toContainText('Writing the summary');
  await expect(tail).not.toContainText('Found 3 places that render project status');
  await shot(page, 'watch-live');

  await live.getByRole('button', { name: 'Full log' }).click();
  await expect(live.getByRole('log', { name: 'Run log' })).toContainText('Searching the codebase');
  expect(await new AxeBuilder({ page }).include('[data-testid=live-run]').analyze()).toMatchObject({
    violations: [],
  });
  await shot(page, 'watch-full-log');

  // History: one story.
  await detail(page).getByRole('tab', { name: 'History' }).click();
  const h = detail(page).getByRole('tabpanel', { name: 'History' });
  await expect(h).toContainText('from Telegram');
  await expect(h).toContainText('Top request from support.');
  await expect(h).toContainText('Found 3 places that render project status');
  await expect(h).toContainText('€0.20');
  // One run row with the progress folded; the stopped run has its result, cost and tokens.
  await expect(h).not.toContainText('updated “');
  await expect(h.getByRole('button', { name: /Progress 6 of 6 · 6 updates/ })).toBeVisible();
  await expect(h).toContainText('Stopped by Marta Silva in Hivenod');
  await expect(h).toContainText('€0.07 · 9.4k tokens');
  await h.getByRole('button', { name: /Progress 6 of 6/ }).click();
  await expect(h.getByRole('list', { name: 'Progress' })).toContainText('step 3 of 6');
  await shot(page, 'watch-history');

  // The card ring says 3/6, with a tooltip.
  await page.keyboard.press('Escape');
  await page.goto('/p/blog');
  const ring = page.getByRole('progressbar', { name: 'Progress', exact: true }).first();
  await expect(ring).toContainText('3/6');
  await expect(ring).toHaveAttribute('title', '3 of 6 steps done');
  await shot(page, 'watch-card-ring');
});
