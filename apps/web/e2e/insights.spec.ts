import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  settle,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);
const MIN = 60_000;

/** Draft (agent) -> Review (gate), with a month of decisions to read. */
async function seed(page: Page) {
  const owner = person('João');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `in${rand()}`;
  const base = projectFields('Blog', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [{ id: 'draft', name: 'Draft', kind: 'agent', description: 'Write it' }, base.steps[1]!],
    stepIndex: { draft: 0, review: 1 },
  });
  const day = 86_400_000;
  let n = 0;
  const dec = (over: Record<string, unknown>, daysAgo: number) => {
    n += 1;
    return adminSet(`workspaces/${wid}/projects/${pid}/decisions/d${n}`, {
      workspaceId: wid,
      projectId: pid,
      itemId: `i${n}`,
      itemTitle: `Post ${n}`,
      stepId: 'review',
      outcome: 'approved',
      toStepId: null,
      byUid: uid,
      rationale: '',
      tags: [],
      at: new Date(Date.now() - daysAgo * day - n * 1000),
      lastEventId: `d${n}`,
      ...over,
    });
  };
  await dec({ waitMs: 10 * MIN }, 1);
  await dec({ waitMs: 30 * MIN }, 2);
  await dec({ waitMs: 50 * MIN }, 3);
  await dec(
    {
      outcome: 'sentBack',
      toStepId: 'draft',
      tags: ['Wrong audience'],
      rationale: 'Wrong audience, café crowd',
      waitMs: 20 * MIN,
    },
    2,
  );
  await dec(
    {
      outcome: 'sentBack',
      toStepId: 'draft',
      tags: ['Wrong audience', 'Too long'],
      rationale: 'Too long, "quoted" and wrong audience',
    },
    4,
  );
  await dec(
    { outcome: 'stopped', tags: ['Not what I asked'], rationale: '=SUM(1,2) not wanted' },
    5,
  );
  await dec(
    {
      itemId: 'old',
      rationale: 'Ancient',
      outcome: 'sentBack',
      toStepId: 'draft',
      tags: ['Too long'],
    },
    60,
  );
  return { pid };
}

test('insights: KPIs, tag bars filter the log, search, CSV', async ({ page }, info) => {
  const { pid } = await seed(page);
  await page.goto('/insights?range=30');
  await expect(page.getByRole('heading', { name: 'Decision insights' })).toBeVisible();
  // 6 decisions in 30 days (the 60-day-old one is out). First time: 3 approvals + (sentBack, sentBack, stopped) -> distinct items all first: 3/6.
  await expect(page.getByText('Decisions made')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Key numbers' })).toContainText('3 approved');
  await expect(page.getByRole('region', { name: 'Key numbers' })).toContainText('2 to Draft');
  // median of 10,30,50,20 minutes = 25
  await expect(page.getByTestId('median-wait')).toHaveText('25 min');
  await expectNoHorizontalScroll(page);

  const isPhone = (info.project.use.viewport?.width ?? 1000) < 700;
  const rows = isPhone ? page.locator('[data-testid=log-cards] > li') : page.locator('tbody tr');
  await expect(rows).toHaveCount(6);

  // Send-back reasons exclude the tagged stop ("Not what I asked").
  await expect(page.getByRole('button', { name: /Not what I asked/ })).toHaveCount(0);
  await page.getByRole('button', { name: /Wrong audience/ }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows).toHaveCount(6);

  await page.getByLabel('Outcome').selectOption('stopped');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Outcome').selectOption('all');
  await page.getByLabel('Search reasons').fill('café');
  await expect(rows).toHaveCount(1);
  await page.getByLabel('Search reasons').fill('');

  // Seven days drops the 4- and 5-day ones? No: 7 days keeps all but the 60-day one.
  await page.getByRole('button', { name: '7 days' }).click();
  await expect(page).toHaveURL(/range=7/);

  await page.getByRole('button', { name: '30 days' }).click();
  const dl = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const file = await (await dl).path();
  const text = readFileSync(file, 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain('café');
  expect(text).toContain('"Too long, ""quoted"" and wrong audience"');
  expect(text).toContain('"\'=SUM(1,2) not wanted"');
  expect(text).toMatch(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/);

  // The project tab shows the same numbers.
  await page.goto(`/p/${pid}/insights`);
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  await expect(page.getByTestId('median-wait')).toHaveText('25 min');

  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => v.id + v.nodes.map((n) => n.html.slice(0, 160)).join('|'))).toEqual(
    [],
  );
});

test('insights: empty period', async ({ page }) => {
  await page.goto('/');
  const owner = person('Vazio');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await page.goto('/insights');
  await expect(page.getByText('No decisions yet in this period')).toBeVisible();
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  await seed(page);
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/insights?range=30');
    await expect(page.getByTestId('median-wait')).toBeVisible();
    for (let y = 0; y < 6000; y += 400) {
      await page.evaluate((v) => window.scrollTo(0, v), y);
      await page.waitForTimeout(80);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${dir}/insights-${size}-${theme}.png`, fullPage: true });
  }
});
