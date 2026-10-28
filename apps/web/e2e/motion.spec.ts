import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf, fastTimers } from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

/** Draft (agent) -> Review (the final gate). Two items wait at Review. */
async function seed(page: Page) {
  const owner = person('João');
  await fastTimers(page);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `mo${rand()}`;
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Blog', uid));
  const item = (id: string, title: string, order: number) =>
    adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, {
      title,
      type: 'idea',
      stepId: 'review',
      status: 'waiting',
      summary: 'A seeded summary.',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      triage: null,
      sendBackCount: 0,
      costEur: 0.42,
      order,
      updatedAt: new Date(),
      lastEventId: 'seed',
    });
  await item('i1', 'Launch post', 1);
  await item('i2', 'Pricing page', 2);
  return { pid };
}

test('final approval: Released toast, Done state with next waiting, hex burst', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Launch post/ });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Approve' }).click();
  // During the Undo window it is not released yet.
  await expect(page.getByText('Releasing “Launch post”…')).toBeVisible();
  await expect(page.getByText('Released. “Launch post” is done.')).toHaveCount(0);
  // The approval is written when the 5 s Undo window ends; the Done state and Released follow.
  const done = detail.getByTestId('done-panel');
  await expect(done).toContainText('Done', { timeout: 15_000 });
  await expect(page.getByText('Released. “Launch post” is done.')).toBeVisible();
  await expect(done).toContainText('0 runs');
  await expect(done).toContainText('€0.42');
  await expect(done.getByTestId('hex-burst')).toBeAttached();
  await done.getByRole('button', { name: 'Open next waiting' }).click();
  await expect(page.getByRole('article', { name: /Pricing page/ })).toBeVisible();
});

test('reduced motion: no burst', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Launch post/ });
  await detail.getByRole('button', { name: 'Approve' }).click();
  const done = detail.getByTestId('done-panel');
  await expect(done).toBeVisible({ timeout: 15_000 });
  await expect(done.getByTestId('hex-burst')).toBeHidden();
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '390';
  const theme = (process.env.SHOTS_THEME ?? 'light') as 'light' | 'dark';
  await page.emulateMedia({ colorScheme: theme });
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Launch post/ });
  await expect(detail).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/before-${size}-${theme}.png` });
  await detail.getByRole('button', { name: 'Approve' }).click();
  for (const [n, ms] of [
    [1, 60],
    [2, 90],
    [3, 120],
  ] as const) {
    await page.waitForTimeout(ms);
    await page.screenshot({ path: `${dir}/burst-${n}-${size}-${theme}.png` });
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/done-${size}-${theme}.png` });
});

test('detail path segments stay on one row (no layout shift)', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Launch post/ });
  await expect(detail).toBeVisible();
  // The process breadcrumb became the path strip (card st5INNZj): one segment per step.
  const tops = await detail
    .getByTestId('path-strip')
    .locator(':scope > div > span')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(tops.length).toBeGreaterThan(1);
  expect(new Set(tops).size).toBe(1);
});

/** The toast's first inline style, captured the moment it is inserted (before it animates in). */
async function firstToastStyle(page: Page, reduced = false) {
  if (reduced) await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const w = window as unknown as { __toastStyle?: string };
    const scan = () => {
      const el = document.querySelector('[data-toast-region] [role="status"]');
      const st = el?.getAttribute('style') ?? '';
      if (!w.__toastStyle && st.includes('transform')) w.__toastStyle = st;
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });
  });
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  await page
    .getByRole('article', { name: /Launch post/ })
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(page.getByText('Releasing “Launch post”…')).toBeVisible();
  return page.evaluate(() => (window as unknown as { __toastStyle: string }).__toastStyle);
}

test('toast enters from the right on desktop (top-right)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const style = await firstToastStyle(page);
  expect(style).toMatch(/translateX\(24px\)/);
  expect(style).not.toMatch(/translateY\(24px\)/);
});

test('toast slides up on phones (bottom)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const style = await firstToastStyle(page);
  expect(style).toMatch(/translateY\(24px\)/);
  expect(style).not.toMatch(/translateX\(24px\)/);
});

test('reduced motion: toast does not slide', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const style = await firstToastStyle(page, true);
  expect(style).not.toMatch(/translate[XY]\(24px\)/);
});
