/**
 * Today (item kt3E7u9EliL3q2veDDI0, slice 2): the brief, the ranked decision stack with the
 * decision card, the tidy-ups card and the rail; keyboard and one-tap approve with Undo on the
 * button (no toast); Approve all; an old booking read-only (Calendar removed, OE8Fm slice 5). 1440
 * and 390, light and dark.
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
import { makeOldBooking, seedInbox, type Seed } from './inboxSeed';

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** Light and dark: axe-clean, no sideways scroll, a screenshot of each when SHOTS_DIR is set. */
async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots)
      await page.screenshot({ path: `${shots}/today-${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const stack = (page: Page) => page.getByRole('list', { name: 'Needs you' });
const card = (page: Page) => page.locator('[data-decision-card]');
const outcomeState = async (s: Seed, oid: string, wid = s.wid) =>
  (await adminDoc(`workspaces/${wid}/inboxOutcomes/${oid}`))?.fields.state?.stringValue;
const threadState = async (s: Seed, tid: string, wid = s.wid) =>
  (await adminDoc(`workspaces/${wid}/inboxThreads/${tid}`))?.fields.state?.stringValue;

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  await page.goto('/');
  await expect(card(page)).toBeVisible({ timeout: 20_000 });
  return s;
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('brief, rank, tidy-ups and the rail; axe-clean in light and dark', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const brief = page.locator('[data-brief-text]');
      await expect(
        page.getByRole('heading', { name: /^Good (morning|afternoon|evening), Cara$/ }),
      ).toBeVisible();
      await expect(brief).toContainText('In the last 24 hours 6 messages came in from 4 places.');
      await expect(brief).toContainText(
        'Your agents drafted 3 proposals and asked 1 question: 4 need you, plus 3 tidy-ups.',
      );
      await expect(brief).toContainText(
        'Most pressing: Sign off the Q4 price list by Wednesday (urgent, due Wed).',
      );
      await expect(page.locator('[data-segment]')).toHaveCount(4);
      await expect(page.locator('[data-segment="red"]')).toHaveCount(1);

      // The urgent thread with a due date is the first decision card.
      await expect(card(page)).toHaveAttribute('aria-label', /Sign off the Q4 price list/);
      await expect(card(page).locator('[data-rank="1"]')).toHaveText('Urgent · due Wed');
      await expect(card(page).locator('[data-sentence]')).toHaveText(
        'Create the item “Review and sign off the Q4 price list”',
      );
      await expect(card(page).locator('[data-confidence="high"]')).toContainText('Sure');
      await expect(card(page).locator('[data-reason]')).toContainText('A real review');
      await expect(card(page).getByRole('button', { name: /Create item/ })).toBeVisible();
      await expect(stack(page).locator('[data-thread-row]')).toHaveCount(3);
      await expect(stack(page)).toContainText('Move the payments review to Tuesday');

      // The 3 tidy-ups are not in the stack but in their card.
      const tidy = page.locator('[data-tidy-ups]');
      await expect(tidy).toContainText('3 tidy-ups');
      await expect(stack(page)).not.toContainText('OPS-221');
      await expect(tidy.getByRole('button', { name: 'Approve all 3' })).toBeVisible();

      // The rail: what agents are on (no agenda: Calendar was removed, OE8Fm slice 5).
      const rail = page.locator('[data-today-rail]');
      await expect(rail.getByRole('region', { name: "Today's agenda" })).toHaveCount(0);
      await expect(rail.getByRole('region', { name: 'Agents working' })).toContainText(
        'Supplier visit next week',
      );
      await look(page, 'main-1440');
    } finally {
      await s.stop();
    }
  });

  test('keyboard: J/K move, E edits, A approves with Undo on the button, Z undoes, Enter opens', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('j');
      await expect(card(page)).toHaveAttribute('aria-label', /Move the payments review/);
      await page.keyboard.press('k');
      await expect(card(page)).toHaveAttribute('aria-label', /Sign off the Q4 price list/);
      await page.keyboard.press('j');
      await expect(card(page)).toHaveAttribute('aria-label', /Move the payments review/);
      await page.keyboard.press('e');
      await expect(card(page).getByLabel('Reply', { exact: true })).toBeVisible();
      await page.keyboard.press('e');
      await expect(card(page).locator('[data-sentence]')).toBeVisible();

      await page.keyboard.press('a');
      const undo = card(page).locator('button[data-undo]');
      await expect(undo).toContainText(/Undo · \d/);
      // No toast: the toast region stays empty.
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await page.keyboard.press('z');
      await expect(card(page).getByRole('button', { name: /^Send/ })).toBeVisible();
      await page.waitForTimeout(UNDO_WAIT);
      expect(await outcomeState(s, s.outcomes.book)).toBe('proposed');

      await page.keyboard.press('a');
      await expect(stack(page).locator('[data-done-row]')).toContainText('Sent · Reply · Sam', {
        timeout: UNDO_WAIT + 5000,
      });
      expect(await outcomeState(s, s.outcomes.book)).toBe('approved');
      // The focus moved on to the next decision, the question.
      await expect(card(page)).toHaveAttribute('aria-label', /Which room/);
      await expect(page.locator('[data-segment="green"]')).toHaveCount(1);

      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${s.threads.room}\\?from=today`));
    } finally {
      await s.stop();
    }
  });

  test('one tap: Approve becomes Undo on the same button, no toast; the window commits it', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const approve = card(page).getByRole('button', { name: /Create item/ });
      await approve.click();
      await expect(card(page).locator('button[data-undo]')).toContainText(/Undo · \d/);
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await card(page).locator('button[data-undo]').click();
      await expect(approve).toBeVisible();
      await page.waitForTimeout(UNDO_WAIT);
      expect(await outcomeState(s, s.outcomes.price)).toBe('proposed');
      await approve.click();
      await expect(stack(page).locator('[data-done-row]')).toContainText(
        'Approved · Make it work',
        { timeout: UNDO_WAIT + 5000 },
      );
      expect(await outcomeState(s, s.outcomes.price)).toBe('approved');
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
    } finally {
      await s.stop();
    }
  });

  test('tidy-ups: Keep for me moves one into the stack; Approve all counts down once', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const tidy = page.locator('[data-tidy-ups]');
      await tidy.getByRole('button', { name: 'Review' }).click();
      await tidy.locator(`[data-tidy="t:${s.wid}:${s.threads.news}"]`).getByRole('switch').click();
      await expect(tidy).toContainText('2 tidy-ups');
      await expect(stack(page)).toContainText('This week in design');
      await tidy.getByRole('button', { name: 'Approve all 2' }).click();
      await expect(tidy.locator('button[data-undo]')).toHaveCount(1);
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await expect
        .poll(() => threadState(s, s.threads.ops), { timeout: UNDO_WAIT + 8000 })
        .toBe('ignored');
      await expect.poll(() => threadState(s, s.threads.omar)).toBe('waiting');
      expect(await outcomeState(s, s.outcomes.news)).toBe('proposed');
      // Nothing that sends changed state.
      expect(await outcomeState(s, s.outcomes.book)).toBe('proposed');
      expect(await outcomeState(s, s.outcomes.steer, s.client)).toBe('proposed');
    } finally {
      await s.stop();
    }
  });

  test('an old booking shows read-only: no slot strip, Approve and Edit off', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await makeOldBooking(s);
      await stack(page)
        .getByRole('button', { name: /Move the payments review/ })
        .click();
      await expect(card(page)).toHaveAttribute('aria-label', /Move the payments review/);
      await expect(card(page).locator('[data-sentence]')).toContainText('Booking (retired)');
      await expect(card(page).locator('[data-retired]')).toContainText(
        'Bookings were removed with Calendar',
      );
      await expect(card(page).getByRole('group', { name: 'Pick a time' })).toHaveCount(0);
      await expect(card(page).getByRole('button', { name: /^Retired/ })).toBeDisabled();
      await expect(card(page).getByRole('button', { name: /^Edit/ })).toBeDisabled();
      expect(await outcomeState(s, s.outcomes.book)).toBe('proposed');
    } finally {
      await s.stop();
    }
  });

  test('a question card answers with one tap on a chip', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await stack(page)
        .getByRole('button', { name: /Which room/ })
        .click();
      await expect(card(page)).toHaveAttribute('aria-label', /Which room/);
      const chips = card(page).getByRole('group', { name: 'Answers' }).getByRole('button');
      await expect(chips).toHaveText(['Small room', 'Afternoon']);
      await chips.first().click();
      await expect.poll(() => threadState(s, s.threads.room)).toBe('investigating');
      await expect(stack(page).locator('[data-done-row]')).toContainText('Answered');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the brief folds to three lines, the card comes first; axe-clean in light and dark', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await expect(card(page)).toHaveAttribute('aria-label', /Sign off the Q4 price list/);
      await expect(page.getByRole('button', { name: 'more' })).toBeVisible();
      await expect(page.locator('[data-tidy-ups]')).toContainText('3 tidy-ups');
      await look(page, 'main-390');
      await page.getByRole('button', { name: 'more' }).click();
      await expect(page.getByRole('button', { name: 'less' })).toBeVisible();
    } finally {
      await s.stop();
    }
  });

  test('the card swipes: left skips, right approves with Undo on the button', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const swipe = async (dx: number) => {
        // Let the stack settle (the card that took the focus may still be moving into place).
        await page.waitForTimeout(500);
        await card(page).scrollIntoViewIfNeeded();
        const box = (await card(page).boundingBox())!;
        const y = box.y + 60;
        const x = box.x + box.width / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let i = 1; i <= 8; i++) await page.mouse.move(x + (dx * i) / 8, y);
        await page.mouse.up();
      };
      await expect(card(page)).toHaveAttribute('aria-label', /Sign off the Q4 price list/);
      await swipe(-180);
      await expect(card(page)).toHaveAttribute('aria-label', /Move the payments review/);
      await swipe(180);
      await expect(card(page).locator('button[data-undo]')).toBeVisible();
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await expect(stack(page).locator('[data-done-row]')).toContainText('Sent · Reply', {
        timeout: UNDO_WAIT + 5000,
      });
      expect(await outcomeState(s, s.outcomes.book)).toBe('approved');
    } finally {
      await s.stop();
    }
  });
});
