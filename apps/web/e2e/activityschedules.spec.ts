/**
 * Scheduled tasks, slice 8: schedule, run and Off events in Activity, with the "Schedules"
 * filter. Events as the actions and the scheduler write them (scheduleActions.ts,
 * schedulerStore.ts). 1440 and 390; axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminSet, expectNoHorizontalScroll, freezeClock, NOW, settle } from './helpers';
import { seedInbox, type Seed } from './inboxSeed';

const MIN = 60_000;

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
  await page.screenshot({ path: `${dir}/s8-${name}-${size}.png`, fullPage: true });
}

async function seedEvents(s: Seed) {
  const agent = { type: 'agent', id: s.agent.aid, name: 'Desk agent' };
  const me = { type: 'human', id: s.uid, name: s.me.name };
  const sys = { type: 'system', id: 'scheduler', name: 'Hivenod scheduler' };
  let n = 0;
  const put = (
    type: string,
    data: Record<string, unknown>,
    msAgo: number,
    actor: Record<string, unknown>,
    threadId: string | null = null,
  ) => {
    n += 1;
    return adminSet(`workspaces/${s.wid}/inboxEvents/s8e${n}`, {
      actor,
      memberUid: s.uid,
      threadId,
      subjectId: null,
      type,
      data,
      at: new Date(NOW - msAgo),
    });
  };
  await adminSet(`workspaces/${s.wid}/schedules/weekly`, {
    title: 'Weekly report',
    memberUid: s.uid,
  });
  await put(
    'outcome.proposed',
    {
      outcomeId: 'o1',
      type: 'schedule',
      scheduleId: 'weekly',
      fields: { scheduleId: 'weekly', sentence: 'Every Monday at 08:00' },
    },
    90 * MIN,
    agent,
    s.threads.price,
  );
  await put(
    'outcome.approved',
    { outcomeId: 'o1', type: 'schedule', scheduleId: 'weekly', edited: false },
    80 * MIN,
    me,
    s.threads.price,
  );
  await put(
    'run.fired',
    { runId: 'weekly_k1', scheduleId: 'weekly', state: 'fired' },
    60 * MIN,
    sys,
    s.threads.price,
  );
  await put(
    'run.cantRun',
    { runId: 'weekly_k2', scheduleId: 'weekly', state: 'cantRun', why: 'offline' },
    50 * MIN,
    sys,
  );
  await put(
    'run.decided',
    { runId: 'weekly_k2', scheduleId: 'weekly', choice: 'later' },
    45 * MIN,
    me,
  );
  await put('schedule.paused', { scheduleId: 'weekly' }, 40 * MIN, me);
  await put('schedule.resumed', { scheduleId: 'weekly' }, 35 * MIN, me);
  await put('schedule.updated', { scheduleId: 'weekly', ruleChanged: true }, 30 * MIN, me);
  await put('agents.off', { all: true, agents: [] }, 20 * MIN, me);
  await put('agents.on', { all: false, agents: [] }, 10 * MIN, me);
  await put('schedule.deleted', { scheduleId: 'gone', title: 'Old chore' }, 5 * MIN, me);
  // A thread event for contrast, and another member's schedule event (never shown).
  await put('summary.written', { version: 2 }, 70 * MIN, agent, s.threads.price);
  n += 1;
  await adminSet(`workspaces/${s.wid}/inboxEvents/s8e${n}`, {
    actor: { type: 'human', id: 'zoe', name: 'Zoe' },
    memberUid: 'zoe',
    threadId: null,
    subjectId: null,
    type: 'schedule.paused',
    data: { scheduleId: 'zoes' },
    at: new Date(NOW - 3 * MIN),
  });
}

test('Activity: schedule, run and Off events, and the Schedules filter', async ({ page }) => {
  test.setTimeout(150_000);
  await freezeClock(page);
  const s = await seedInbox(page);
  try {
    await seedEvents(s);
    await page.goto('/activity');
    const feed = page.getByTestId('thread-feed');
    await expect(feed.locator('li[data-type="schedule.deleted"]')).toBeVisible({
      timeout: 20_000,
    });
    // All view: both chunks merged, the thread event next to the schedule ones.
    await expect(feed.locator('li[data-type="summary.written"]')).toBeVisible();
    await expect(feed.locator('li[data-type="agents.off"]')).toContainText('turned all agents Off');
    await expect(feed.locator('li[data-type="agents.on"]')).toContainText('turned agents back On');
    await expect(feed.locator('li[data-type="schedule.deleted"]')).toContainText(
      'deleted the schedule Old chore',
    );
    await expect(feed.locator('li[data-type="schedule.paused"]')).toHaveCount(1);

    const filters = page.getByRole('group', { name: 'Filters' });
    await filters.getByRole('button', { name: 'Schedules' }).click();
    await expect(feed.locator('li[data-type="outcome.proposed"]')).toContainText(
      'proposed the schedule Weekly report · Every Monday at 08:00',
    );
    await expect(feed.locator('li[data-type="outcome.approved"]')).toContainText(
      'approved the schedule Weekly report',
    );
    await expect(feed.locator('li[data-type="run.fired"]')).toContainText(
      'started the scheduled run',
    );
    await expect(feed.locator('li[data-type="run.fired"]')).toContainText('· Weekly report');
    await expect(feed.locator('li[data-type="run.cantRun"]')).toContainText(
      'could not run Weekly report: the agent was offline · asked what to do',
    );
    await expect(feed.locator('li[data-type="run.decided"]')).toContainText(
      'chose “Try later” for Weekly report',
    );
    await expect(feed.locator('li[data-type="schedule.updated"]')).toContainText(
      'edited the schedule Weekly report · new times',
    );
    await expect(feed.locator('li[data-type="schedule.paused"]')).toHaveCount(1);
    await expect(feed.locator('li[data-type="schedule.resumed"]')).toHaveCount(1);
    await expect(feed.locator('li[data-group]:not([data-group="schedules"])')).toHaveCount(0);
    await expect(feed.locator('li[data-type="summary.written"]')).toHaveCount(0);
    await check(page, 'activity');

    // The other groups do not show the schedule outcome rows.
    await filters.getByRole('button', { name: 'Decisions' }).click();
    await expect(feed.getByText(/Nothing here yet/)).toBeVisible();

    // Links: the schedule opens the Schedules page, a run opens its thread.
    await filters.getByRole('button', { name: 'Schedules' }).click();
    await feed.locator('li[data-type="run.fired"]').getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${s.threads.price}`));
    await page.goBack();
    await filters.getByRole('button', { name: 'Schedules' }).click();
    await feed.locator('li[data-type="schedule.paused"]').getByRole('link').click();
    await expect(page).toHaveURL(/\/schedules\?s=weekly/);
  } finally {
    await s.stop();
  }
});
