/**
 * Activity and Decision insights on threads (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7,
 * acceptance 16-17): the feed reads the member's own thread events; insights count the member's
 * decisions on threads. 1440 and 390; axe.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { adminSet, expectNoHorizontalScroll, freezeClock, NOW, settle } from './helpers';
import { seedInbox, type Seed } from './inboxSeed';

const MIN = 60_000;
const DAY = 86_400_000;

/** A KPI's value (CountUp shows an animated copy; the screen reader one is final). */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 640;
const kpi = (page: Page, id: string) => page.getByTestId(id).locator('.sr-only');

async function check(page: Page, name: string) {
  await settle(page);
  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const size = (page.viewportSize()?.width ?? 1440) < 640 ? '390' : '1440';
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${dir}/slice9-${name}-${size}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** Events as the actions write them (the facts on decisions), at explicit times. */
async function events(s: Seed) {
  const agent = { type: 'agent', id: s.agent.aid, name: 'Desk agent' };
  const me = { type: 'human', id: s.uid, name: s.me.name };
  const tid = s.threads.price;
  let n = 0;
  const put = (
    type: string,
    data: Record<string, unknown>,
    msAgo: number,
    actor = agent,
    over: Record<string, unknown> = {},
  ) => {
    n += 1;
    return adminSet(`workspaces/${s.wid}/inboxEvents/s9e${n}`, {
      actor,
      memberUid: s.uid,
      threadId: tid,
      subjectId: null,
      type,
      data,
      at: new Date(NOW - msAgo),
      ...over,
    });
  };
  const facts = (step: string, waited: number, rec: string | null) => ({
    stepLabel: step,
    templateId: 'dev',
    waitedMs: waited,
    recommended: rec,
    summaryVersion: 3,
  });
  await put(
    'outcome.done',
    { type: 'build', planId: 'p1', permalink: 'https://github.com/o/r/pull/86' },
    50 * MIN,
  );
  await put('summary.written', { version: 7 }, 45 * MIN);
  for (const m of [40, 39, 38])
    await put(
      'step.progress',
      { planId: 'p1', outcomeId: 'b1', line: 'Running checks', percent: 100 - m },
      m * MIN,
    );
  await put(
    'plan.sent_back',
    {
      planId: 'p1',
      outcomeId: 'b1',
      reason: 'Bigger button',
      toLabel: 'Build',
      ...facts('Ship it?', 20 * MIN, 'Approve'),
    },
    30 * MIN,
    me,
  );
  await put(
    'outcome.approved',
    {
      planId: 'p1',
      outcomeId: 'g2',
      type: 'approval',
      edited: false,
      ...facts('Ship it?', 40 * MIN, 'Approve'),
    },
    20 * MIN,
    me,
  );
  await put(
    'outcome.approved',
    {
      planId: 'p1',
      outcomeId: 'g1',
      type: 'approval',
      edited: false,
      ...facts('Approve idea', 10 * MIN, 'Approve'),
    },
    2 * DAY,
    me,
  );
  await put(
    'plan.sent_back',
    {
      planId: 'p2',
      outcomeId: 'b2',
      reason: 'Wrong copy',
      toLabel: 'Build',
      ...facts('Ship it?', 60 * MIN, null),
    },
    3 * DAY,
    me,
  );
  await put('plan.stopped', { planId: 'p3', ...facts('Build', 5 * MIN, null) }, 4 * DAY, me);
  // Old: out of the 30-day range.
  await put(
    'outcome.approved',
    { planId: 'p9', type: 'approval', edited: false, ...facts('Accept on live', MIN, null) },
    60 * DAY,
    me,
  );
  // Another member's thread: never shown.
  await put('summary.written', { version: 1 }, 10 * MIN, agent, {
    memberUid: 'zoe',
    threadId: 'zoeThread',
  });
}

test('Activity: my threads, groups, who, links; the agent page shows its own rows', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await freezeClock(page);
  const s = await seedInbox(page);
  try {
    await events(s);
    await page.goto('/activity');
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
    const feed = page.getByTestId('thread-feed');
    await expect(feed.getByText(/brought in a new thread/).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(feed.locator('li', { hasText: 'finished Build on' })).toContainText('PR #86');
    await expect(feed.locator('li', { hasText: 'wrote the summary of' }).first()).toContainText(
      '· v7',
    );
    // Three progress lines fold into one row.
    await expect(feed.locator('li[data-type="step.progress"]')).toHaveCount(1);
    await expect(feed.locator('li[data-type="step.progress"]')).toContainText('3 updates');
    await expect(
      feed.locator('li', { hasText: 'asked for changes at Ship it? on' }).first(),
    ).toContainText('→ back to Build');
    await expect(feed.locator('li', { hasText: 'v1' })).toHaveCount(0);
    await check(page, 'activity');

    // Groups.
    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Decisions' }).click();
    await expect(feed.locator('li[data-group="decisions"]').first()).toBeVisible();
    await expect(feed.locator('li[data-group]:not([data-group="decisions"])')).toHaveCount(0);
    await filters.getByRole('button', { name: 'Summaries' }).click();
    await expect(feed.locator('li[data-type="summary.written"]').first()).toBeVisible();
    await expect(feed.locator('li[data-type]:not([data-type="summary.written"])')).toHaveCount(0);
    await filters.getByRole('button', { name: 'All' }).click();
    // Who: agents only.
    await filters.getByLabel('Who', { exact: true }).selectOption({ label: 'All agents' });
    await expect(feed.getByText(/asked for changes at/)).toHaveCount(0);
    await expect(feed.locator('li', { hasText: 'finished Build on' })).toBeVisible();
    // A row opens its thread.
    await feed.locator('li', { hasText: 'finished Build on' }).getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${s.threads.price}`));

    // The agent's page: the same feed, only that agent.
    await page.goto(`/agents/${s.agent.aid}`);
    const mine = page.getByRole('region', { name: 'Activity on your threads' });
    await expect(mine.locator('li', { hasText: 'finished Build on' })).toBeVisible({
      timeout: 20_000,
    });
    await expect(mine.getByText(/asked for changes at/)).toHaveCount(0);
  } finally {
    await s.stop();
  }
});

test('Decision insights: KPIs, sent back by step, recommendation followed, CSV', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await freezeClock(page);
  const s = await seedInbox(page);
  try {
    await events(s);
    await page.goto('/insights?range=30');
    await expect(page.getByRole('heading', { name: 'Decision insights' })).toBeVisible();
    const kpis = page.getByRole('region', { name: 'Key numbers' });
    // 5 decisions in 30 days (the 60-day-old one is out).
    await expect(kpi(page, 'kpi-made')).toHaveText('5', { timeout: 20_000 });
    // First per thing: p1/Ship it? sent back, p1/Approve idea approved, p2 sent back, p3 stopped.
    await expect(kpi(page, 'kpi-first')).toHaveText('25%');
    await expect(kpi(page, 'kpi-sentback')).toHaveText('2');
    await expect(kpis).toContainText('2 at Ship it? → Build');
    // Median of 20, 40, 10, 60, 5 minutes.
    await expect(page.getByTestId('median-wait')).toHaveText('20 min');
    // Recommended Approve 3 times: approved twice, sent back once.
    await expect(kpi(page, 'kpi-followed')).toHaveText('67%');
    await expect(page.getByTestId('sent-back-to')).toContainText('Ship it? → Build');
    await expect(page.getByTestId(isPhone(page) ? 'by-step-cards' : 'by-step')).toContainText(
      'Approve idea',
    );
    await expect(page.getByTestId('decision-log').locator('> li')).toHaveCount(5);
    await check(page, 'insights');

    const dl = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const text = readFileSync((await (await dl).path())!, 'utf8');
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.trim().split('\r\n')).toHaveLength(6);
    expect(text).toContain('Sent back to Build');
    expect(text).toContain('Bigger button');

    await page.getByRole('button', { name: '7 days' }).click();
    await expect(page).toHaveURL(/range=7/);
    await expect(kpi(page, 'kpi-made')).toHaveText('5');
  } finally {
    await s.stop();
  }
});
