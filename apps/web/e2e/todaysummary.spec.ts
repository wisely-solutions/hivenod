/**
 * Today and the Inbox list show the summary's top line (item OE8FmrTaIxFVGcaeGG3N, slice 3;
 * design 3.4): the card carries the ask, the one-line answer, "<agent> recommends Approve ·
 * confidence high · updated …"; Inbox rows show it under the title. Not now (design 3.2) puts the
 * decision out of Today until 09:00 the next day (it stays on reload; the thread keeps its state
 * and its summary stays fresh); a new decision on the thread shows again. 1440 and 390, light and
 * dark, axe-clean.
 *
 * The clock is real here: Not now's time is checked by the rules against the server's time.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminDoc, expectNoHorizontalScroll, settle } from './helpers';
import { at, seedInbox } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    // The card (the rest of Today is checked by today.spec).
    const { violations } = await new AxeBuilder({ page })
      .include('[data-decision-card]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) {
      await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true });
      const card = page.locator('[data-decision-card]').first();
      if (await card.count())
        await card.screenshot({ path: `${shots}/${name}-card-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const summary = {
  headline: 'Sam asks to move the quarterly review',
  ask: 'Reply to Sam that Thursday 10:00 works?',
  answer: 'Thursday is free; Sam proposed it, the room is booked.',
  recommendation: { action: 'Approve', why: 'it is the slot Sam asked for' },
  confidence: 'high',
  bullets: [{ text: 'Sam asked for Thursday or Friday morning.' }],
  noVisualWhy: 'A one-line reply: nothing to chart.',
};

test('the summary top line on Today and Inbox; Not now', async ({ page, isMobile }) => {
  test.setTimeout(180_000);
  if (isMobile) await page.setViewportSize({ width: 390, height: 844 });
  const s = await seedInbox(page);
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Sam Rivera',
    text: 'Could we move the quarterly review to Thursday 10:00 or Friday morning?',
    ref: 'qr1',
    id: 'm1',
    at: at(0, 9),
  });
  await s.agent.file(tid, { newName: 'Quarterly review', area: 'Planning' });
  await s.agent.propose(
    tid,
    'reply',
    { text: 'Thursday 10:00 works, see you then.' },
    'Sam asked for Thursday.',
    { confidence: 'high' },
  );
  await s.agent.summary(tid, summary);

  await page.goto(`/?sel=t:${s.wid}:${tid}`);
  const card = page.locator('[data-decision-card]').first();
  await expect(card.locator('[data-headline]')).toHaveText(summary.ask, { timeout: 20_000 });
  await expect(card.locator('[data-answer]')).toHaveText(summary.answer);
  await expect(card.locator('[data-recommends]')).toHaveText(
    /^Desk agent recommends Approve · confidence high · updated /,
  );
  await expect(card.locator('[data-summary-stale]')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();
  await look(page, `slice3-today-${isMobile ? 390 : 1440}`);

  // The Inbox list: the top line under the subject's name.
  await page.goto('/inbox');
  const line = page.locator('[data-subject] [data-summary-line]', { hasText: summary.ask });
  await expect(line).toBeVisible({ timeout: 20_000 });

  // Not now: out of Today, still out after a reload; the thread keeps its state.
  await page.goto(`/?sel=t:${s.wid}:${tid}`);
  await expect(card.locator('[data-headline]')).toHaveText(summary.ask, { timeout: 20_000 });
  const before = await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`);
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('[data-headline]', { hasText: summary.ask })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => !!(await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`))?.fields.notNow,
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
  const after = (await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`))!.fields;
  expect(after.state!.stringValue).toBe('yourCall');
  expect(after.notNow!.mapValue!.fields!.key!.stringValue).toMatch(/^c\d+$/);
  // updatedAt untouched: the summary stays fresh.
  expect(after.updatedAt!.timestampValue).toBe(before!.fields.updatedAt!.timestampValue);
  const until = new Date(after.notNow!.mapValue!.fields!.until!.timestampValue!);
  expect(until.getTime()).toBeGreaterThan(Date.now());
  expect(until.getUTCHours()).toBe(9); // the browser runs in UTC
  await page.reload();
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  await expect(page.locator('[data-headline]', { hasText: summary.ask })).toHaveCount(0);

  // A new decision on the thread (the agent asks something) shows again.
  await s.agent.ask(tid, 'Should I also tell Ana?', ['Yes', 'No']);
  await expect(
    page.locator('[data-decision-card]', { hasText: 'Should I also tell Ana?' }),
  ).toHaveCount(1, { timeout: 20_000 });
  await s.stop();
});

test('the decision page: Not now beside Approve, and the N key', async ({ page, isMobile }) => {
  test.skip(isMobile, 'the same buttons stack on a phone (decisionpage.spec)');
  test.setTimeout(120_000);
  const s = await seedInbox(page);
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Sam Rivera',
    text: 'Can we move the review?',
    ref: 'qr2',
    id: 'm1',
    at: at(0, 9),
  });
  await s.agent.propose(tid, 'reply', { text: 'Thursday works.' }, 'Sam asked.');
  await s.agent.summary(tid, summary);
  await page.goto(`/inbox/${s.wid}/t/${tid}`);
  const top = page.getByRole('region', { name: 'Decision' });
  await expect(top.getByRole('button', { name: 'Not now' })).toBeVisible({ timeout: 20_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('n');
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`))?.fields.notNow?.mapValue?.fields
          ?.key?.stringValue ?? '',
      { timeout: 15_000 },
    )
    .toMatch(/^c\d+$/);
  await s.stop();
});
