/**
 * The thread page, the subject page and briefing mode (item kt3E7u9EliL3q2veDDI0, slice 3; the
 * decision page since item OE8FmrTaIxFVGcaeGG3N): 1440 and 390, light and dark.
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
import { seedInbox, type Seed } from './inboxSeed';

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

const panel = (page: Page) => page.locator('[data-decision-page]');
const fold = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });
const threadState = async (s: Seed, tid: string) =>
  (await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`))?.fields.state?.stringValue;

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  return seedInbox(page);
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the decision page: checks, the proposal with what happens next, related; axe-clean', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      await expect(
        page.getByRole('heading', { name: 'Move the payments review to Tuesday', level: 1 }),
      ).toBeVisible({ timeout: 20_000 });
      // The decision page (item OE8FmrTaIxFVGcaeGG3N): no summary yet, so the app's own top line.
      const top = page.getByRole('region', { name: 'Decision' });
      await expect(top.locator('[data-kicker]')).toHaveText('Your approval');
      await expect(top.getByRole('heading', { level: 2 })).toHaveText(
        'Desk agent proposes: Reply and book',
      );
      // Everything: the conversation, with the agent's note inline.
      await fold(page, 'Everything').click();
      const talk = page.getByRole('region', { name: 'Conversation' });
      await expect(talk.locator('[data-message]')).toHaveCount(1);
      await expect(talk).toContainText('Desk agent noted');
      const p = panel(page);
      await fold(page, 'More detail').click();
      await expect(p.locator('[data-confidence="high"]').first()).toContainText('Sure');
      await expect(
        p.getByRole('list', { name: 'What the agent checked' }).getByRole('listitem'),
      ).toHaveText(['Your calendar: Tue 10:00-11:00 free', 'Asked Rita by mail: either works']);
      await expect(p.locator('[data-reason]')).toContainText('Rita agreed');
      const effects = p.locator('[data-effects]');
      await expect(effects).toContainText('When you approve, Desk agent will:');
      await expect(effects).toContainText(/Book Tue 16 Jun 10:00–11:00 in your calendar/);
      await expect(p.getByRole('button', { name: /Send and book/ })).toBeVisible();
      await expect(p.getByRole('region', { name: 'Related subjects' })).toBeVisible();
      // The ⋯ menu holds the other actions.
      await page.getByRole('button', { name: 'Thread actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Set a due date…' })).toBeVisible();
      await page.keyboard.press('Escape');
      await look(page, 'thread-1440');

      // The question thread: two chips; one tap answers it.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.room}`);
      const asks = page.getByRole('region', { name: 'Decision' });
      await expect(asks.getByRole('group', { name: 'Answers' }).getByRole('button')).toHaveText([
        'Small room',
        'Afternoon',
      ]);
      await asks.getByRole('button', { name: 'Afternoon' }).click();
      await expect.poll(() => threadState(s, s.threads.room)).toBe('investigating');
      await expect(page.getByText('You answered: “Afternoon”')).toBeVisible();

      // The subject page: threads on the left, related on the right, admin in ⋯.
      await page.goto(`/inbox/${s.wid}/s/${s.subjects.review}`);
      await expect(page.locator(`[data-thread="${s.threads.review}"]`)).toContainText(
        'Sam Okafor:',
      );
      await expect(page.getByRole('complementary', { name: 'About this subject' })).toContainText(
        'Finance',
      );
      await page.getByRole('button', { name: 'Subject actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Merge…' })).toBeVisible();
      await page.keyboard.press('Escape');
      await look(page, 'subject-1440');
    } finally {
      await s.stop();
    }
  });

  test('briefing mode: Enter from Today shows n of N, a decision moves to the next one', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await page.goto('/');
      await expect(page.locator('[data-decision-card]')).toBeVisible({ timeout: 20_000 });
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('j');
      await expect(page.locator('[data-decision-card]')).toHaveAttribute(
        'aria-label',
        /Move the payments review/,
      );
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(
        new RegExp(`/inbox/${s.wid}/t/${s.threads.review}\\?from=today`),
      );
      const bar = page.getByRole('navigation', { name: 'Briefing' });
      await expect(bar.locator('[data-position]')).toHaveText('2 of 4');
      await expect(bar).toContainText('Next: Which room for the payments review?');
      await panel(page)
        .getByRole('button', { name: /Send and book/ })
        .click();
      await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${s.threads.room}\\?from=today`), {
        timeout: UNDO_WAIT + 8000,
      });
      await expect(bar.locator('[data-position]')).toHaveText(/of 3/);
      expect(
        (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`))?.fields.state
          ?.stringValue,
      ).toBe('approved');
      await bar.getByRole('link', { name: 'Today' }).click();
      await expect(page.locator('#today-greeting')).toBeVisible();
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the decision page stacked: Approve in reach, the rest in folds', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const approve = panel(page).getByRole('button', { name: /Send and book/ });
      await expect(approve).toBeInViewport({ timeout: 20_000 });
      await look(page, 'thread-390');
      await fold(page, 'More detail').click();
      await expect(
        page.getByRole('list', { name: 'What the agent checked' }).getByRole('listitem'),
      ).toHaveCount(2);
      await expect(panel(page).locator('[data-effects]')).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      await look(page, 'thread-390-open');
      await page.goto(`/inbox/${s.wid}/s/${s.subjects.review}`);
      await expect(page.locator(`[data-thread="${s.threads.room}"]`)).toBeVisible();
      await look(page, 'subject-390');
    } finally {
      await s.stop();
    }
  });
});
