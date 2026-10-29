/**
 * The Inbox list regrouped (item kt3E7u9EliL3q2veDDI0, slice 5): Needs you first with the urgent
 * subject on top, then Agents working; rows with the organization's colour, who asked what last
 * and a state chip; Find plus Filters (a popover, a sheet on a phone) with the Area filter. 1440
 * and 390, light and dark.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { expectNoHorizontalScroll, fastTimers, freezeClock, settle } from './helpers';
import { seedInbox } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  await page.goto('/inbox');
  await expect(page.locator('[data-group="needs"]')).toBeVisible({ timeout: 20_000 });
  return s;
}

const groupsOrder = (page: Page) =>
  page.locator('[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('grouped by the most pressing thread; Filters fold away, with the Area filter', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      expect(await groupsOrder(page)).toEqual(['needs', 'working', 'unfiled']);
      const needs = page.locator('[data-group="needs"] [data-subject]');
      // The urgent subject first.
      await expect(needs.first()).toHaveAttribute('data-subject', s.subjects.price);
      const price = page.locator(`[data-subject="${s.subjects.price}"]`);
      await expect(price).toContainText('Ava: Sign off the Q4 price list by Wednesday');
      await expect(price).toContainText('1 for you');
      await expect(price).toContainText('Sales');
      // Two organizations: the segmented picker is on the first screen.
      const orgs = page.getByRole('group', { name: 'Organization' });
      await expect(orgs.getByRole('button', { name: 'Northwind' })).toBeVisible();
      await look(page, 'inboxlist-1440');

      await page.getByRole('button', { name: /^Filters/ }).click();
      await page
        .getByRole('group', { name: 'Area' })
        .getByRole('button', { name: 'Finance · 1' })
        .click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeVisible();
      await expect(page.locator('[data-subject]')).toHaveCount(1);
      await expect(page.locator(`[data-subject="${s.subjects.review}"]`)).toContainText(
        '2 for you',
      );

      await orgs.getByRole('button', { name: 'Northwind' }).click();
      await expect(page).toHaveURL(new RegExp(`org=${s.client}`));
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the same groups, the filters in a sheet; axe-clean', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await expect(page.locator('[data-group="needs"] [data-subject]').first()).toHaveAttribute(
        'data-subject',
        s.subjects.price,
      );
      await look(page, 'inboxlist-390');
      await page.getByRole('button', { name: /^Filters/ }).click();
      const sheet = page.getByRole('dialog', { name: 'Filters' });
      await expect(sheet.getByRole('group', { name: 'Area' })).toBeVisible();
      await expect(sheet.getByRole('button', { name: 'Waiting for me' })).toBeVisible();
    } finally {
      await s.stop();
    }
  });
});
