import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  ago,
  freezeClock,
  adminSet,
  expectNoHorizontalScroll,
  person,
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
  await adminSet(`workspaces/${wid}/agents/scout`, {
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
  return { wid, uid };
}

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
});

// The Activity page reads thread events since slice 9 (threadactivity.spec.ts). Agent runs, their
// KPIs and logs went with Projects (slice 11): the profile shows presence, settings and activity.

test('Agent profile: presence, settings and its activity on your threads, no runs', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/agents');
  await page.getByRole('link', { name: 'Scout' }).click();
  await expect(page).toHaveURL(/\/agents\/scout$/);
  await expect(page.getByRole('heading', { name: 'Scout', level: 1 })).toBeVisible();
  await expect(page.getByText('Online · waiting for work')).toBeVisible();
  await expect(page.getByText('Activity on your threads')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Runs' })).toHaveCount(0);
  await expect(page.getByTestId('kpi-runs')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await shot(page, 'agent');
  await axe(page);
});
