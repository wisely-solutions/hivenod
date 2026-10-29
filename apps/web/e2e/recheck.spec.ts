/**
 * Re-check (item bmNoIvvqKCdAorLSShE9): "May be out of date" on a proposal for each reason (2 days
 * old, a newer message, the slot passed), Re-check from the chip, the Today card's Other menu, the
 * plan panel and the phone sheet, with Undo on the button; "Checking again…", then "Checked
 * again · still good" (checkedAt stamped) or the agent's v2 with its diff. On a running plan only
 * the steps that have not run are checked. 1440 and 390, light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminPatch,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  settle,
  UNDO_WAIT,
} from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

const H = 3_600_000;

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots)
      await page.screenshot({ path: `${shots}/recheck-${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const doc = async (s: Seed, coll: string, id: string) =>
  (await adminDoc(`workspaces/${s.wid}/${coll}/${id}`))!.fields;
const recheckState = async (s: Seed, tid: string) =>
  (await doc(s, 'inboxThreads', tid)).recheck?.mapValue?.fields?.state?.stringValue ?? null;

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  return seedInbox(page);
}

/** The server stamps real times; set them against the page's frozen clock. */
async function written(s: Seed, tid: string, oid: string, createdH: number, messageH: number) {
  await adminPatch(`workspaces/${s.wid}/inboxOutcomes/${oid}`, {
    createdAt: new Date(NOW - createdH * H),
  });
  await adminPatch(`workspaces/${s.wid}/inboxThreads/${tid}`, {
    lastMessageAt: new Date(NOW - messageH * H),
  });
}

const V1 = 'Tuesday works. I booked 10:00-11:00 and sent the invite. See you then.';
const V2 = 'Tuesday 14:00 works now, invite sent. The morning got booked since.';
const v2Fields = () => ({
  text: V2,
  start: at(1, 14).toISOString(),
  end: at(1, 15).toISOString(),
  with: 'Sam Okafor',
});

/** Today at 1440: the decision card whose title matches. */
async function todayCard(page: Page, title: RegExp) {
  const card = page.locator('[data-decision-card]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 8; i++) {
    if (title.test((await card.getAttribute('aria-label')) ?? '')) break;
    await page.keyboard.press('j');
    await page.waitForTimeout(150);
  }
  await expect(card).toHaveAttribute('aria-label', title);
  return card;
}

async function recheckFromMenu(where: Locator, page: Page) {
  await where.getByRole('button', { name: 'Other actions' }).click();
  await page.getByRole('menuitem', { name: 'Re-check' }).click();
  await expect(where.locator('button[data-undo]')).toBeVisible();
  await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the stale flag for each reason; Re-check from the chip, then still good', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const panel = page.locator('[data-agent-panel]');
      // The slot has passed (the reply_book's start is before now).
      await adminUpdate(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`, {
        fields: {
          text: V1,
          start: at(0, 9).toISOString(),
          end: at(0, 10).toISOString(),
          with: 'Sam Okafor',
        },
      });
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      await expect(panel.locator('[data-stale="slot"]')).toBeVisible({ timeout: 20_000 });
      await expect(panel.locator('[data-stale-chip]')).toHaveAttribute(
        'title',
        'Its time slot has passed',
      );

      // Two days old, then a newer message.
      await written(s, s.threads.price, s.outcomes.price, 50, 51);
      await page.goto(`/inbox/${s.wid}/t/${s.threads.price}`);
      const chip = panel.locator('[data-stale]');
      await expect(chip).toHaveAttribute('data-stale', 'old', { timeout: 20_000 });
      await chip.locator('[data-stale-chip]').click();
      await expect(chip.locator('[data-stale-why]')).toBeVisible();
      await expect(chip.locator('[data-stale-why]')).toHaveText('2 days old');
      await expect(chip.locator('[data-stale-chip]')).toContainText('May be out of date');
      await look(page, 'stale-1440');
      await written(s, s.threads.price, s.outcomes.price, 3, 1);
      await expect(chip).toHaveAttribute('data-stale', 'message');
      await expect(chip.locator('[data-stale-chip]')).toHaveAttribute(
        'title',
        'A newer message came in',
      );

      // Re-check from the chip: Undo on the button, then written.
      await chip.getByRole('button', { name: 'Re-check' }).click();
      await expect(chip.locator('button[data-undo]')).toBeVisible();
      expect(await recheckState(s, s.threads.price)).toBe(null);
      await expect
        .poll(() => recheckState(s, s.threads.price), { timeout: UNDO_WAIT + 8000 })
        .toBe('pending');
      await expect(panel.locator('[data-rechecking]')).toContainText('Checking again…');
      await expect(panel.locator('[data-stale]')).toHaveCount(0);
      await look(page, 'checking-1440');

      // The agent finds it still good: the result line, checkedAt stamped, no flag.
      expect(
        await s.agent.recheck(s.threads.price, 'still_good', 'Nothing new since Monday.'),
      ).toEqual([s.outcomes.price]);
      const result = panel.locator('[data-recheck-result="still_good"]');
      await expect(result).toContainText(/Checked again \d\d:\d\d · still good/);
      await expect(result).toContainText('Nothing new since Monday.');
      await expect(panel.locator('[data-stale]')).toHaveCount(0);
      await expect(panel.locator('[data-rechecking]')).toHaveCount(0);
      expect(
        (await doc(s, 'inboxOutcomes', s.outcomes.price)).checkedAt?.timestampValue,
      ).toBeTruthy();
      await look(page, 'still-good-1440');
    } finally {
      await s.stop();
    }
  });

  test('Today card: Other › Re-check with Undo; the agent writes v2 with the diff', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const card = await todayCard(page, /Move the payments review/);
      // Undo takes it back: nothing is written.
      await recheckFromMenu(card, page);
      await card.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      expect(await recheckState(s, s.threads.review)).toBe(null);

      await recheckFromMenu(card, page);
      await expect
        .poll(() => recheckState(s, s.threads.review), { timeout: UNDO_WAIT + 8000 })
        .toBe('pending');
      await expect(card.locator('[data-rechecking]')).toBeVisible();
      // While it is pending the menu has no Re-check.
      await card.getByRole('button', { name: 'Other actions' }).click();
      await expect(page.getByRole('menuitem', { name: 'Ignore thread' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Re-check' })).toHaveCount(0);
      await page.keyboard.press('Escape');

      // The morning got booked: the agent writes v2 unasked, then answers.
      expect(await s.agent.revise(s.outcomes.book, v2Fields(), 'The morning got booked.')).toBe(2);
      await s.agent.recheck(s.threads.review, 'revised', 'Moved to 14:00.');
      await expect(card.locator('[data-versions]')).toContainText('v2 of 2');
      await expect(card.locator('[data-asked="recheck"]')).toHaveText('After a re-check');
      await expect(card.locator('[data-diff="ins"]').first()).toBeVisible();
      await expect(card.locator('[data-recheck-result="revised"]')).toContainText(
        'new version below',
      );
      await expect(card.getByRole('button', { name: /Send and book v2/ })).toBeVisible();
      await look(page, 'v2-1440');
    } finally {
      await s.stop();
    }
  });

  test('a running plan: only the steps that have not run are checked again', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const tid = await s.agent.add(s.uid, {
        source: 'teams',
        from: 'Sam Okafor',
        text: 'Finance signed off. Can you confirm and tell the team?',
        ref: 'recheck-plan',
        id: 'm1',
        at: at(0, 7),
      });
      const { planId, stepIds } = await s.agent.plan(
        tid,
        [
          { type: 'reply', fields: { text: 'On it, Sam.' } },
          { type: 'nudge', fields: { text: 'Anything else on the prices?' } },
          { type: 'handover', fields: { to: 'Maria (website)' } },
        ],
        'Confirm, then follow up.',
      );
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const plan = page.locator(`[data-agent-panel] [data-plan="${planId}"]`);
      await plan.locator('[data-approve-plan]').click({ timeout: 20_000 });
      await page.waitForTimeout(UNDO_WAIT);
      await expect
        .poll(async () => (await doc(s, 'inboxOutcomes', stepIds[0]!)).state?.stringValue)
        .toBe('approved');

      const box = plan.locator('[data-plan-recheck]');
      await box.getByRole('button', { name: 'Re-check the steps not run' }).click();
      await expect(box.locator('button[data-undo]')).toBeVisible();
      await expect.poll(() => recheckState(s, tid), { timeout: UNDO_WAIT + 8000 }).toBe('pending');
      await expect(box.locator('[data-rechecking]')).toBeVisible();
      await look(page, 'plan-checking-1440');

      expect(await s.agent.recheck(tid, 'still_good')).toEqual([stepIds[1], stepIds[2]].sort());
      await expect(box.locator('[data-recheck-result="still_good"]')).toBeVisible();
      expect((await doc(s, 'inboxOutcomes', stepIds[0]!)).checkedAt).toBeUndefined();
      expect((await doc(s, 'inboxOutcomes', stepIds[1]!)).checkedAt?.timestampValue).toBeTruthy();
      expect((await doc(s, 'inboxOutcomes', stepIds[2]!)).checkedAt?.timestampValue).toBeTruthy();
      await look(page, 'plan-checked-1440');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bottom sheet: Re-check, checking again, v2 with the diff', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      await written(s, s.threads.review, s.outcomes.book, 50, 51);
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const sheet = page.locator('[data-agent-panel]');
      await expect(sheet).toHaveAttribute('data-sheet', 'collapsed', { timeout: 20_000 });
      await recheckFromMenu(sheet, page);
      await expect
        .poll(() => recheckState(s, s.threads.review), { timeout: UNDO_WAIT + 8000 })
        .toBe('pending');
      await expect(sheet.locator('[data-rechecking]')).toBeVisible();
      await look(page, 'checking-390');
      await s.agent.revise(s.outcomes.book, v2Fields(), 'The morning got booked.');
      await s.agent.recheck(s.threads.review, 'revised', 'Moved to 14:00.');
      await expect(sheet.locator('[data-versions]')).toContainText('v2 of 2');
      await expect(sheet.locator('[data-recheck-result="revised"]')).toBeVisible();
      await expect(sheet.getByRole('button', { name: /Send and book v2/ })).toBeInViewport();
      await look(page, 'v2-390');
      // Opened: the stale flag of the thread page (2 days old) is gone with the new version.
      await sheet.getByRole('button', { name: /Notes, outcomes and related/ }).click();
      await expect(sheet.locator('[data-stale]')).toHaveCount(0);
    } finally {
      await s.stop();
    }
  });
});
