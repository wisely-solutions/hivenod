/**
 * "N summaries may be out of date · Re-check N" (one tap): the bar on Today and at the top of the
 * Inbox. Four threads have an old summary (two in Your call, two Waiting), a fifth one already
 * waits on a re-check: the bar says 4, Undo writes nothing, Re-check asks the 4 (not the fifth),
 * the rows say "re-checking…", then "updated just now · v2" once the agents write their new
 * summaries, and the bar goes away. 1440 and 390, light and dark, axe-clean.
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
import { seedInbox, type Seed } from './inboxSeed';

const SHOTS = process.env.SHOTS_DIR;

async function look(page: Page, name: string) {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/stalebar-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const recheckState = async (wid: string, tid: string) =>
  (await adminDoc(`workspaces/${wid}/inboxThreads/${tid}`))!.fields.recheck?.mapValue?.fields?.state
    ?.stringValue ?? null;

const SUMMARY = {
  headline: 'Waiting on a reply',
  ask: null,
  answer: 'The last message is from two days ago.',
  recommendation: null,
  confidence: 'high',
  bullets: [{ text: 'Nothing new since the last summary.' }],
  noVisualWhy: 'Nothing to show.',
};

/** Four threads with an old summary, a fifth already waiting on its re-check. */
async function staleSeed(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const t = s.threads;
  const rows = [
    { wid: s.wid, tid: t.price },
    { wid: s.wid, tid: t.review },
    { wid: s.wid, tid: t.visit },
    { wid: s.client, tid: t.steer },
  ];
  const pendingRow = { wid: s.wid, tid: t.omar };
  const waiting = (wid: string, tid: string, on: string) =>
    adminUpdate(`workspaces/${wid}/inboxThreads/${tid}`, {
      state: 'waiting',
      waiting: { on, until: null },
    });
  await waiting(s.wid, t.visit, 'them');
  await waiting(s.client, t.steer, 'item');
  await waiting(s.wid, t.omar, 'them');
  for (const r of [...rows, pendingRow]) {
    await (r.wid === s.wid ? s.agent : s.other).summary(r.tid, SUMMARY);
    // The thread changed after its summary was written.
    await adminUpdate(`workspaces/${r.wid}/inboxThreads/${r.tid}`, {
      updatedAt: new Date(Date.now() + 3_600_000),
    });
  }
  await adminUpdate(`workspaces/${pendingRow.wid}/inboxThreads/${pendingRow.tid}`, {
    recheck: {
      state: 'pending',
      by: s.uid,
      requestedAt: new Date(Date.now() - 5 * 60_000),
      result: null,
      note: null,
      at: null,
    },
  });
  return { s, rows, pendingRow };
}

/** The agent answers (thread_recheck_done) and writes the next summary. */
async function answer(s: Seed, wid: string, tid: string) {
  const agent = wid === s.wid ? s.agent : s.other;
  await agent.recheck(tid, 'revised', 'Updated.');
  return agent.summary(tid, { ...SUMMARY, answer: 'Checked again: nothing new.' });
}

for (const [route, label] of [
  ['/', 'Today'],
  ['/inbox', 'Inbox'],
] as const) {
  test(`${label}: bar counts 4, Undo, Re-check asks 4, rows re-check then update`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const { s, rows, pendingRow } = await staleSeed(page);
    const phone = (page.viewportSize()?.width ?? 1440) < 640;
    const size = phone ? '390' : '1440';
    const name = label.toLowerCase();
    try {
      await page.goto(route);
      const bar = page.locator('[data-stale-bar]');
      await expect(bar).toContainText('4 summaries may be out of date', { timeout: 20_000 });
      const button = bar.locator('[data-recheck-stale]');
      await expect(button).toHaveText('Re-check 4');
      if (SHOTS && route === '/') {
        // What Today looked like before the bar: the same screen with it hidden.
        await page.addStyleTag({ content: '[data-stale-bar]{display:none!important}' });
        await page.screenshot({ path: `${SHOTS}/before-${size}.png` });
        await page.reload();
        await expect(bar).toBeVisible({ timeout: 20_000 });
      }
      await look(page, `${name}-bar-${size}`);

      // Undo takes it back: nothing is written.
      await button.click();
      await expect(bar.locator('button[data-undo]')).toBeVisible();
      await bar.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      for (const r of rows) expect(await recheckState(r.wid, r.tid)).toBe(null);
      await expect(button).toHaveText('Re-check 4');

      // One tap: one request per thread, the one already pending is not asked again.
      const before = await adminDoc(`workspaces/${pendingRow.wid}/inboxThreads/${pendingRow.tid}`);
      await button.click();
      for (const r of rows)
        await expect
          .poll(() => recheckState(r.wid, r.tid), { timeout: UNDO_WAIT + 8000 })
          .toBe('pending');
      const after = await adminDoc(`workspaces/${pendingRow.wid}/inboxThreads/${pendingRow.tid}`);
      expect(after!.fields.recheck).toEqual(before!.fields.recheck);
      await expect(bar).toHaveCount(0);

      // The rows say so while the agents work.
      if (route === '/') {
        await expect(page.locator('[data-summary-top] [data-row-status="rechecking"]')).toHaveCount(
          1,
        );
        await expect(page.locator('[data-summary-stale]')).toHaveCount(0);
      } else {
        await expect(
          page.locator('[data-recheck-line] [data-row-status="rechecking"]'),
        ).not.toHaveCount(0);
      }
      await look(page, `${name}-rechecking-${size}`);

      // The agents answer and write their summaries: v2, the label is gone.
      for (const r of rows) expect(await answer(s, r.wid, r.tid)).toBe(2);
      if (route === '/') {
        await expect(page.locator('[data-summary-top] [data-row-status]')).toHaveCount(0);
        await expect(page.locator('[data-summary-top] [data-updated]')).toContainText(
          'updated just now',
        );
      } else {
        // Only the thread that was already pending (nobody answered it) still says so.
        await expect(
          page.locator('[data-recheck-line] [data-row-status="rechecking"]'),
        ).toHaveCount(1);
        await expect(
          page.locator('[data-recheck-line] [data-row-status="updated"]').first(),
        ).toHaveText('updated just now · v2');
      }
      await expect(bar).toHaveCount(0);
      await look(page, `${name}-updated-${size}`);
    } finally {
      await s.stop();
    }
  });
}

test('a thread that is not out of date shows no bar', async ({ page }) => {
  test.setTimeout(120_000);
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  try {
    await page.goto('/inbox');
    await expect(page.getByRole('tab', { name: /Waiting/ })).toBeVisible({ timeout: 20_000 });
    await settle(page);
    await expect(page.locator('[data-stale-bar]')).toHaveCount(0);
  } finally {
    await s.stop();
  }
});
