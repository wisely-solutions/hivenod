/**
 * Bulk Re-check (item "Inbox: Waiting view with bulk Re-check"): the Inbox's "Waiting · N" view
 * lists the member's waiting threads (on them, someone else, the agent, a date, the work; two
 * organizations); select 3 → "Re-check 3" with Undo → 3 requests, rows "re-checking…"; "Re-check
 * all" then asks only the 2 not already pending; after the agents answer and write their
 * summaries the rows say "updated just now · v1". Phone: the bulk action sits in the list header.
 * 1440 and 390, light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  settle,
  UNDO_WAIT,
} from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) {
      // A phone: the viewport from the tabs down (a full-page shot repeats the sticky top bar).
      const phone = (page.viewportSize()?.width ?? 1440) < 640;
      if (phone)
        await page
          .getByRole('tablist', { name: 'View' })
          .evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 72));
      await page.screenshot({
        path: `${shots}/bulkrecheck-${name}-${scheme}.png`,
        fullPage: !phone,
      });
      // Back to the top: a chip under the sticky bar would fail axe's target size on the next pass.
      if (phone) await page.evaluate(() => window.scrollTo(0, 0));
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const recheckOf = async (wid: string, tid: string) => {
  const f = (await adminDoc(`workspaces/${wid}/inboxThreads/${tid}`))!.fields.recheck?.mapValue
    ?.fields;
  return f
    ? { state: f.state?.stringValue ?? null, requestedAt: f.requestedAt?.timestampValue ?? null }
    : null;
};
const stateOf = async (wid: string, tid: string) => (await recheckOf(wid, tid))?.state ?? null;

/** Five waiting threads, one of each kind, one of them in the other organization. */
async function waitingSeed(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const t = s.threads;
  const wait = (wid: string, tid: string, on: string, until: Date | null = null) =>
    adminUpdate(`workspaces/${wid}/inboxThreads/${tid}`, {
      state: 'waiting',
      waiting: { on, until },
    });
  await wait(s.wid, t.price, 'them');
  await wait(s.wid, t.review, 'thirdParty');
  await wait(s.wid, t.visit, 'agent');
  await wait(s.wid, t.omar, 'date', at(7, 9));
  await wait(s.client, t.steer, 'item');
  const rows = [
    { wid: s.wid, tid: t.price },
    { wid: s.wid, tid: t.review },
    { wid: s.wid, tid: t.visit },
    { wid: s.wid, tid: t.omar },
    { wid: s.client, tid: t.steer },
  ];
  return { s, rows };
}

async function openWaiting(page: Page) {
  await page.goto('/inbox');
  const tab = page.getByRole('tab', { name: /Waiting/ });
  await expect(tab).toContainText('5', { timeout: 20_000 });
  await tab.click();
  await expect(page).toHaveURL(/view=waiting/);
  await expect(page.locator('[data-group="waiting-view"] li[data-thread]')).toHaveCount(5);
}

/** The agent answers (thread_recheck_done) and writes the thread's next summary. */
async function answer(s: Seed, wid: string, tid: string) {
  const agent = wid === s.wid ? s.agent : s.other;
  await agent.recheck(tid, 'still_good', 'Nothing new.');
  return agent.summary(tid, {
    headline: 'Still waiting on their reply',
    ask: null,
    answer: 'Checked again: nothing new since the last message.',
    recommendation: null,
    confidence: 'high',
    bullets: [{ text: 'No new message since the request.' }],
    noVisualWhy: 'Nothing to show.',
  });
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('select 3 → Re-check 3 with Undo; Re-check all skips pending; rows update to v1', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, rows } = await waitingSeed(page);
    try {
      await openWaiting(page);
      const view = page.locator('[data-group="waiting-view"]');
      const row = (tid: string) => view.locator(`li[data-thread="${tid}"]`);
      await expect(row(s.threads.price)).toContainText('Waiting on them');
      await expect(row(s.threads.review)).toContainText('Waiting on someone else');
      await expect(row(s.threads.steer)).toContainText('Waiting on the work');
      await expect(view.locator('[data-recheck-all]')).toHaveAccessibleName('Re-check all 5');

      const three = rows.slice(0, 3);
      for (const r of three) await row(r.tid).locator('[data-select]').check();
      await expect(view.locator('[data-bulk-bar]')).toContainText('3 selected');
      const selected = view.locator('[data-recheck-selected]');
      await expect(selected).toHaveText(/Re-check 3/);

      // Undo takes it back: nothing is written.
      await selected.click();
      await expect(view.locator('button[data-undo]')).toBeVisible();
      await view.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      for (const r of rows) expect(await stateOf(r.wid, r.tid)).toBe(null);

      await selected.click();
      for (const r of three)
        await expect
          .poll(() => stateOf(r.wid, r.tid), { timeout: UNDO_WAIT + 8000 })
          .toBe('pending');
      expect(await stateOf(s.wid, s.threads.omar)).toBe(null);
      expect(await stateOf(s.client, s.threads.steer)).toBe(null);
      for (const r of three)
        await expect(row(r.tid).locator('[data-row-status]')).toHaveAttribute(
          'data-row-status',
          'rechecking',
        );
      await expect(row(s.threads.price)).toContainText('re-checking…');
      const asked = await Promise.all(three.map((r) => recheckOf(r.wid, r.tid)));
      await look(page, 'rechecking-1440');

      // Re-check all: only the 2 not already pending are asked.
      const all = view.locator('[data-recheck-all]');
      await expect(all).toHaveAccessibleName('Re-check all 2');
      await all.click();
      for (const r of rows.slice(3))
        await expect
          .poll(() => stateOf(r.wid, r.tid), { timeout: UNDO_WAIT + 8000 })
          .toBe('pending');
      expect(await Promise.all(three.map((r) => recheckOf(r.wid, r.tid)))).toEqual(asked);
      await expect(all).toBeDisabled();

      // The agents answer: each row says "updated just now · v1".
      for (const r of rows) expect(await answer(s, r.wid, r.tid)).toBe(1);
      for (const r of rows) {
        const st = row(r.tid).locator('[data-row-status]');
        await expect(st).toHaveAttribute('data-row-status', 'updated');
        await expect(st).toHaveText('updated just now · v1');
      }
      await expect(all).toHaveAccessibleName('Re-check all 5');
      await look(page, 'updated-1440');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');

  test('the bulk action sits in the list header; Re-check all', async ({ page }) => {
    test.setTimeout(180_000);
    const { s, rows } = await waitingSeed(page);
    try {
      await openWaiting(page);
      const view = page.locator('[data-group="waiting-view"]');
      const bar = view.locator('[data-bulk-bar]');
      const box = await bar.boundingBox();
      const first = await view.locator('li[data-thread]').first().boundingBox();
      expect(box!.y).toBeLessThan(first!.y);
      await view.locator(`li[data-thread="${s.threads.price}"] [data-select]`).check();
      await expect(bar.locator('[data-recheck-selected]')).toHaveText(/Re-check 1/);
      await look(page, 'selected-390');
      await bar.locator('[data-select-all]').check();
      await expect(bar).toContainText('5 selected');
      await bar.locator('[data-recheck-all]').click();
      for (const r of rows)
        await expect
          .poll(() => stateOf(r.wid, r.tid), { timeout: UNDO_WAIT + 8000 })
          .toBe('pending');
      await expect(view.locator('[data-row-status="rechecking"]')).toHaveCount(5);
      await look(page, 'rechecking-390');
    } finally {
      await s.stop();
    }
  });
});
