/**
 * Scheduled tasks, slice 5 (design 9.2, propose.png): an agent proposes a schedule on the member's
 * thread ("every 1st at 9, prepare the invoices and ask me before sending"). The decision page
 * shows the proposal card: the rule in words with its zone, the next 3 runs, each run's thread,
 * the plan of each run and what happens when a run can't happen. Ask for changes sends the
 * agent a revise (the outcome waits as revising); its version 2 shows the new time; Set up
 * schedule activates the schedule in the same batch. 1440 and 390, light and dark, axe-clean,
 * no sideways scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  person,
  settle,
  signIn,
  uidOf,
  UNDO_WAIT,
  workspaceOf,
} from './helpers';
import { agentOf } from './inboxSeed';

const INVOICES = {
  title: 'Send invoices',
  what: 'Prepare the invoices from the hours log, show the totals and send them after approval.',
  rule: { freq: 'monthly' as const, at: '09:00', tz: 'Europe/Lisbon', monthDay: 1 },
  runTitle: 'Send invoices · {month} {year}',
  steps: [
    { type: 'reply', fields: { text: 'Invoice totals for {period} are ready.' } },
    { type: 'approval', fields: { what: 'Send the invoices for {period}' } },
  ],
};

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
    if (shots) await page.screenshot({ path: `${shots}/s5-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A new member with an agent "Books" that proposed the invoices schedule on her thread. */
async function proposed(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const me = person('Cara Lindqvist');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const books = await agentOf(wid, uid, 'Books');
  const tid = await books.add(uid, {
    source: 'teams',
    from: 'Cara Lindqvist',
    text: 'Every 1st at 9, prepare the invoices and ask me before sending.',
    ref: 'invoices',
    id: 'm1',
    at: new Date(NOW - 3_600_000),
  });
  const { scheduleId, outcomeId } = await books.schedule(tid, {
    ...INVOICES,
    note: 'Same steps as I did by hand on 1 Jun.',
    confidence: 'high',
    checks: ['Ran it by hand on 1 Jun'],
  });
  await page.goto(`/inbox/${wid}/t/${tid}`);
  return { wid, tid, books, scheduleId, outcomeId };
}

const field = async (path: string, name: string) =>
  (await adminDoc(path))?.fields[name]?.stringValue;

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the proposal card; Ask for changes, version 2, Set up schedule activates it', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await proposed(page);
    try {
      const top = page.getByRole('region', { name: 'Decision' });
      const card = top.locator('[data-schedule-card]');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(top.locator('[data-kicker]')).toHaveText('Your approval · new schedule');
      await expect(top.locator('[data-headline]')).toHaveText(
        'Set up “Send invoices” every month?',
      );
      await expect(card.locator('[data-schedule-sentence]')).toHaveText(
        'Monthly · day 1 · 09:00 (Lisbon)',
      );
      // NOW is Mon 15 Jun 2026 12:00 UTC: the next three 1sts.
      await expect(card.locator('[data-schedule-runs] li')).toHaveText([
        'Wed 1 Jul 2026 · 09:00',
        'Sat 1 Aug 2026 · 09:00',
        'Tue 1 Sep 2026 · 09:00',
      ]);
      await expect(card.locator('[data-schedule-run-title]')).toHaveText(
        'New thread “Send invoices · Jul 2026”',
      );
      await expect(card.locator('[data-schedule-plan] li')).toHaveText([
        /1\.Reply: “Invoice totals for Jul 2026 are ready.”\s?Books/,
        /2\.Send the invoices for Jul 2026\s?You/,
      ]);
      await expect(card.locator('[data-schedule-cant-run]')).toContainText('at once (high)');
      await expect(card.getByRole('button', { name: 'Set up schedule' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();
      await look(page, 'card-1440');

      // Ask for changes: no wording chips, the request reaches the agent as a revise.
      await card.getByRole('button', { name: 'Ask for changes' }).click();
      const box = card.getByRole('form', { name: 'Ask for changes' });
      await expect(box.getByRole('group', { name: 'Quick changes' })).toBeHidden();
      await box.getByRole('textbox').fill('At 08:30, and on a weekend move it to Monday');
      await box.getByRole('button', { name: /Ask agent/ }).click();
      await expect(card.locator('[data-revising]')).toContainText('Books is revising');
      await expect
        .poll(() => field(`workspaces/${s.wid}/inboxOutcomes/${s.outcomeId}`, 'state'))
        .toBe('revising');

      // The agent's version 2 (schedule_propose revises): the card follows the schedule doc.
      await s.books.reviseSchedule(s.outcomeId, {
        ...INVOICES,
        rule: { ...INVOICES.rule, at: '08:30', weekend: 'after' },
        note: 'At 08:30; a 1st on a weekend moves to Monday.',
      });
      await expect(card.locator('[data-schedule-sentence]')).toHaveText(
        'Monthly · day 1 · 08:30 · Mon if weekend (Lisbon)',
      );
      await expect(card.locator('[data-schedule-runs] li')).toHaveText([
        'Wed 1 Jul 2026 · 08:30',
        'Mon 3 Aug 2026 · 08:30',
        'Tue 1 Sep 2026 · 08:30',
      ]);
      await expect(card.locator('[data-revising]')).toBeHidden();

      // Set up schedule: active in the same batch, after the undo window.
      await card.getByRole('button', { name: 'Set up schedule' }).click();
      await expect
        .poll(() => field(`workspaces/${s.wid}/schedules/${s.scheduleId}`, 'state'), {
          timeout: UNDO_WAIT + 8000,
        })
        .toBe('active');
      expect(await field(`workspaces/${s.wid}/inboxOutcomes/${s.outcomeId}`, 'state')).toBe('done');
    } finally {
      await s.books.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the proposal card fits the phone and sets the schedule up', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await proposed(page);
    try {
      const card = page.locator('[data-schedule-card]').first();
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card.locator('[data-schedule-runs] li')).toHaveCount(3);
      await card.scrollIntoViewIfNeeded();
      await look(page, 'card-390');
      await card.getByRole('button', { name: 'Set up schedule' }).click();
      await expect
        .poll(() => field(`workspaces/${s.wid}/schedules/${s.scheduleId}`, 'state'), {
          timeout: UNDO_WAIT + 8000,
        })
        .toBe('active');
    } finally {
      await s.books.stop();
    }
  });
});
