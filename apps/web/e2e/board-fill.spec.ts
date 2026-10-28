import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { login, seedSteps } from './boardSeed';

const scrolls = (page: Page) =>
  page.evaluate(() => ({
    page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    board: (() => {
      const b = document.querySelector('[data-testid="board"]')!;
      return b.scrollWidth > b.clientWidth;
    })(),
  }));

const WIDTHS = [1280, 1366, 1440, 1920, 2560];

test('the board fills the screen without sideways scroll', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  test.setTimeout(400_000);
  const shots = process.env.SHOT_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  const who = await login(page);
  for (const n of [3, 5, 6]) {
    const pid = await seedSteps(page, who, n);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto(`/p/${pid}`);
      await expect(page.getByText('Item 2').first()).toBeVisible();
      if (shots && [1280, 1440, 1920].includes(w))
        await page.screenshot({ path: `${shots}/steps${n}-${w}.png` });
      expect.soft(await scrolls(page), `${n} steps at ${w}`).toEqual({ page: false, board: false });
    }
  }
});

test('many steps in columns scroll only the board area', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  const pid = await seedSteps(page, await login(page), 14);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}`);
  await expect(page.getByText('Item 2').first()).toBeVisible();
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  const s = await scrolls(page);
  expect(s.page).toBe(false);
  expect(s.board).toBe(true);
});

test('opening the detail panel does not move the columns', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  const pid = await seedSteps(page, await login(page), 6);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}`);
  const cols = page.locator('[data-testid="board"] > [data-step]');
  await expect(page.getByText('Item 2').first()).toBeVisible();
  const before = await cols.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x));
  await page.getByText('Item 2').first().click();
  await expect(page.getByRole('region', { name: 'Item detail' })).toBeVisible();
  expect.soft(await scrolls(page)).toEqual({ page: false, board: false });
  expect
    .soft(await cols.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().x)))
    .toEqual(before);
  if (process.env.SHOT_DIR) {
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${process.env.SHOT_DIR}/panel-1440.png` });
  }
});
