/**
 * The calendar with the Inbox in it (item kt3E7u9EliL3q2veDDI0, slice 4): organization colours
 * and the legend, free time in working hours, the due strip, proposed bookings dashed with the
 * banner (Review, Confirm with Undo on the button), the header totals; the phone's week strip
 * and agenda. 1440 and 390, light and dark.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  settle,
  UNDO_WAIT,
} from './helpers';
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
  await page.goto('/calendar');
  await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  return s;
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('colours, free time, the due strip and a proposed booking confirmed from the banner', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const grid = page.getByRole('region', { name: 'Time grid' });
      await expect(grid.getByRole('group', { name: /^Team standup, / }).first()).toBeVisible({
        timeout: 15_000,
      });
      // The header totals.
      await expect(
        page.getByText(
          /^This week · .+ · \d+ h( \d+)? booked · \d+ h( \d+)? free in working hours$/,
        ),
      ).toBeVisible();

      // Two organizations, two colours; the legend matches.
      const colorOf = (name: RegExp) =>
        grid
          .getByRole('group', { name })
          .first()
          .evaluate((el) => getComputedStyle(el).borderLeftColor);
      const mine = await colorOf(/^Team standup, /);
      const theirs = await colorOf(/^Northwind steering, /);
      expect(mine).not.toBe(theirs);
      const legend = page.getByRole('list', { name: 'Legend' });
      const dotOf = (wid: string) =>
        legend
          .locator(`[data-legend-org="${wid}"] span`)
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(await dotOf(s.wid)).toBe(mine);
      expect(await dotOf(s.client)).toBe(theirs);
      await expect(legend).toContainText('Proposed');
      await expect(legend).toContainText('Free');

      // Free time inside 09-18 is shaded; a block of an hour or more is labelled.
      await expect(grid.locator('[data-free]').first()).toBeAttached();
      await expect(grid.getByText(/^\d+ h( \d+)? free$/).first()).toBeAttached();

      // The due strip carries the urgent thread's deadline on its day.
      await expect(page.locator('[data-due-strip]')).toContainText(
        'Sign off the Q4 price list by Wednesday due 12:00',
      );

      // Titles wrap to two lines in tall blocks, never cut to one word.
      await expect(
        grid
          .getByRole('group', { name: /^Hiring panel: ops lead, / })
          .locator('span')
          .first(),
      ).toHaveClass(/line-clamp-2/);

      // The proposed booking: dashed in its slot, and the banner.
      const dashed = grid.getByRole('button', {
        name: /^Meeting with Sam Okafor · proposed, 10:00/,
      });
      await expect(dashed).toBeVisible();
      const banner = page.getByRole('region', { name: 'Proposed bookings' });
      await expect(banner).toContainText('1 booking proposed');
      await expect(banner).toContainText('Sends 1 reply and books 1 meeting');
      await look(page, 'calendar-1440');

      // Confirm, Undo, Confirm again: the booking becomes a real event in the same slot.
      await banner.getByRole('button', { name: 'Confirm' }).click();
      await expect(banner.locator('button[data-undo]')).toBeVisible();
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await banner.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      expect(
        (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`))?.fields.state
          ?.stringValue,
      ).toBe('proposed');
      await banner.getByRole('button', { name: 'Confirm' }).click();
      await expect(
        grid.getByRole('group', { name: /^Meeting with Sam Okafor, 10:00/ }),
      ).toBeVisible({
        timeout: UNDO_WAIT + 8000,
      });
      await expect(dashed).toHaveCount(0);
      await expect(banner).toHaveCount(0);
    } finally {
      await s.stop();
    }
  });

  test('Review opens the booking in briefing mode; a dashed block opens its thread', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const banner = page.getByRole('region', { name: 'Proposed bookings' });
      await banner.getByRole('button', { name: 'Review' }).click();
      await expect(page).toHaveURL(
        new RegExp(`/inbox/${s.wid}/t/${s.threads.review}\\?from=calendar`),
      );
      const bar = page.getByRole('navigation', { name: 'Briefing' });
      await expect(bar.locator('[data-position]')).toHaveText('1 of 1');
      await bar.getByRole('link', { name: 'Calendar' }).click();
      await page
        .getByRole('region', { name: 'Time grid' })
        .getByRole('button', { name: /· proposed/ })
        .click();
      await expect(page).toHaveURL(new RegExp(`/t/${s.threads.review}\\?from=calendar`));
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('a week strip and a readable agenda, the proposed booking dashed; axe-clean', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const agenda = page.getByRole('region', { name: 'Agenda' });
      await expect(agenda.getByRole('group', { name: /^Team standup, / })).toBeVisible({
        timeout: 15_000,
      });
      await expect(agenda.locator('[data-free]').first()).toBeVisible();
      await expect(page.getByRole('region', { name: 'Time grid' })).toHaveCount(0);
      await expect(page.getByRole('region', { name: 'Proposed bookings' })).toContainText(
        '1 booking proposed',
      );
      await look(page, 'calendar-390');
      // Tuesday: the proposed booking, dashed.
      const strip = page.getByRole('group', { name: 'Week' });
      await strip.getByRole('button', { name: /^Tuesday/ }).click();
      await expect(
        agenda.getByRole('button', { name: /^Meeting with Sam Okafor · proposed/ }),
      ).toBeVisible();
      // Wednesday: the deadline.
      await strip.getByRole('button', { name: /^Wednesday/ }).click();
      await expect(agenda.locator('[data-due-strip]')).toContainText('due 12:00');
      await look(page, 'calendar-390-wed');
    } finally {
      await s.stop();
    }
  });
});
