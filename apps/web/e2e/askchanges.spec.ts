/**
 * Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the member asks the agent to change a proposed
 * reply, the card shows "revising" in the same slot (nothing rejected), the agent's v2 comes
 * with an inline diff and "v2 of 2", the member goes back to v1 and forward again, and approves
 * the version shown. Sending v1 while the agent revises refuses its late v2. An edit sent at once
 * is the text sent. Today card at 1440, the thread page's bottom sheet at 390; light and dark,
 * axe-clean, no sideways scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  settle,
  UNDO_WAIT,
} from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

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
      await page.screenshot({ path: `${shots}/ask-${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const V1 = 'Tuesday works. I booked 10:00-11:00 and sent the invite. See you then.';
const V2 = 'Tuesday 10:00 works, invite sent. 14:00 is free too if that suits you better.';

const outcomeDoc = async (s: Seed) =>
  (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`))!.fields;
const threadState = async (s: Seed) =>
  (await adminDoc(`workspaces/${s.wid}/inboxThreads/${s.threads.review}`))?.fields.state
    ?.stringValue;

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  return seedInbox(page);
}

/** Today at 1440: the payments-review decision card (second in the stack). */
async function todayCard(page: Page) {
  const card = page.locator('[data-decision-card]');
  await expect(card).toBeVisible({ timeout: 20_000 });
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('j');
  await expect(card).toHaveAttribute('aria-label', /Move the payments review/);
  return card;
}

async function askFor(where: Locator) {
  await where.getByRole('button', { name: /Ask for changes|Changes/ }).click();
  const box = where.getByRole('form', { name: 'Ask for changes' });
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Shorter' }).click();
  await box.getByRole('button', { name: 'Add my availability' }).click();
  await expect(box.getByRole('button', { name: 'Shorter' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await box.getByLabel('What should change?').fill('Mention 14:00 as a backup');
  await expect(box).toContainText('25 / 500');
  return box;
}

const v2Fields = () => ({
  text: V2,
  start: at(1, 10).toISOString(),
  end: at(1, 11).toISOString(),
  with: 'Sam Okafor',
});

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the full loop: ask, revising, v2 with the diff, back to v1, approve v2', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const card = await todayCard(page);
      const box = await askFor(card);
      await look(page, 'box-1440');
      await box.getByRole('button', { name: /Ask agent/ }).click();

      // Revising: same slot, nothing rejected, the thread stays in Your call.
      const out = card.locator(`[data-outcome="${s.outcomes.book}"]`);
      await expect(out).toHaveAttribute('data-outcome-state', 'revising');
      await expect(card.locator('[data-revising]')).toContainText(
        'Desk agent is revising · Shorter, Add my availability · “Mention 14:00 as a backup”',
      );
      await expect(card.getByRole('button', { name: /Send and book v1/ })).toBeVisible();
      await expect(
        card.getByRole('button', { name: 'Revising, cancel the request' }),
      ).toBeVisible();
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: 15_000 })
        .toBe('revising');
      const o = await outcomeDoc(s);
      expect(o.decision!.nullValue).toBe(null);
      expect(await threadState(s)).toBe('yourCall');
      await look(page, 'revising-1440');

      // The agent's v2: the diff, "v2 of 2", what was asked.
      expect(
        await s.agent.revise(s.outcomes.book, v2Fields(), 'Shorter, with 14:00 as a backup.'),
      ).toBe(2);
      await expect(out).toHaveAttribute('data-outcome-state', 'proposed');
      await expect(card.locator('[data-versions]')).toContainText('v2 of 2');
      await expect(card.locator('[data-diff="ins"]').first()).toBeVisible();
      await expect(card.locator('[data-diff="del"]').first()).toBeVisible();
      await expect(card.locator('[data-asked]')).toHaveText(
        'You asked: Shorter, Add my availability · “Mention 14:00 as a backup”',
      );
      await expect(card.locator('[data-reason]')).toContainText('Shorter, with 14:00 as a backup.');
      await look(page, 'v2-1440');
      await card.getByRole('button', { name: 'Hide changes' }).click();
      await expect(card.locator('[data-diff]')).toHaveCount(0);
      await expect(card.locator('[data-sentence]')).toContainText(V2);
      await card.getByRole('button', { name: 'Show changes' }).click();

      // Back to v1 ([ and the ‹ button), then forward again.
      await page.keyboard.press('[');
      await expect(card.locator('[data-versions]')).toContainText('v1 of 2');
      await expect(card.locator('[data-sentence]')).toContainText(V1);
      await expect(card.locator('[data-diff]')).toHaveCount(0);
      await expect(card.getByRole('button', { name: /Send and book v1/ })).toBeVisible();
      await card.getByRole('button', { name: 'Next version' }).click();
      await expect(card.locator('[data-versions]')).toContainText('v2 of 2');
      await card.getByRole('button', { name: 'Previous version' }).click();
      await expect(card.locator('[data-versions]')).toContainText('v1 of 2');
      await page.keyboard.press(']');
      await expect(card.locator('[data-versions]')).toContainText('v2 of 2');

      // Approve v2: Undo on the button, no toast; the window commits v2's fields.
      await card.getByRole('button', { name: /Send and book v2/ }).click();
      await expect(card.locator('button[data-undo]')).toBeVisible();
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: UNDO_WAIT + 8000 })
        .toBe('approved');
      const done = await outcomeDoc(s);
      expect(done.fields!.mapValue!.fields!.text!.stringValue).toBe(V2);
      expect(done.decision!.mapValue!.fields!.version!.integerValue).toBe('2');
      expect(done.decision!.mapValue!.fields!.edited!.booleanValue).toBe(false);
      expect(done.versions!.arrayValue!.values).toHaveLength(2);
    } finally {
      await s.stop();
    }
  });

  test('send v1 while revising: approved, the late v2 is refused; Cancel goes back', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const s = await open(page);
    try {
      const card = await todayCard(page);
      // Cancel first: back to proposed, no request left.
      let box = await askFor(card);
      await box.getByRole('button', { name: /Ask agent/ }).click();
      await expect(card.locator('[data-revising]')).toBeVisible();
      await card.getByRole('button', { name: 'Revising, cancel the request' }).click();
      await expect(card.locator(`[data-outcome="${s.outcomes.book}"]`)).toHaveAttribute(
        'data-outcome-state',
        'proposed',
      );
      expect((await outcomeDoc(s)).revise!.nullValue).toBe(null);

      // Ask again (key C), then send v1 while the agent works on it.
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('c');
      box = card.getByRole('form', { name: 'Ask for changes' });
      await box.getByRole('button', { name: 'Warmer' }).click();
      await box.getByLabel('What should change?').press('Control+Enter');
      await expect(card.locator('[data-revising]')).toContainText('Warmer');
      await expect
        .poll(async () => (await s.agent.outcome(s.outcomes.book)).state, { timeout: 15_000 })
        .toBe('revising');
      const stale = await s.agent.outcome(s.outcomes.book);
      await card.getByRole('button', { name: /Send and book v1/ }).click();
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: UNDO_WAIT + 8000 })
        .toBe('approved');
      await expect(s.agent.revise(s.outcomes.book, v2Fields(), '', stale)).rejects.toThrow();
      const o = await outcomeDoc(s);
      expect(o.fields!.mapValue!.fields!.text!.stringValue).toBe(V1);
      expect(o.revise!.nullValue).toBe(null);
      expect(o.versions).toBeUndefined();
    } finally {
      await s.stop();
    }
  });

  test('an edit sent at once is exactly the text sent', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      const card = await todayCard(page);
      await card.getByRole('button', { name: /^Edit/ }).click();
      await card.getByLabel('Reply', { exact: true }).fill('Tuesday 10:00 works, Sam.');
      await card.getByRole('button', { name: /Send and book/ }).click();
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: UNDO_WAIT + 8000 })
        .toBe('approved');
      const o = await outcomeDoc(s);
      expect(o.fields!.mapValue!.fields!.text!.stringValue).toBe('Tuesday 10:00 works, Sam.');
      expect(o.decision!.mapValue!.fields!.edited!.booleanValue).toBe(true);
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bottom sheet: ask, revising, v2 with the diff, back to v1, approve v2', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const sheet = page.locator('[data-agent-panel]');
      await expect(sheet).toHaveAttribute('data-sheet', 'collapsed', { timeout: 20_000 });
      const box = await askFor(sheet);
      await look(page, 'box-390');
      await box.getByRole('button', { name: /Ask agent/ }).click();
      await expect(sheet.locator('[data-revising]')).toContainText('Desk agent is revising');
      await expect(sheet.getByRole('button', { name: /Send and book v1/ })).toBeVisible();
      expect(await threadState(s)).toBe('yourCall');
      await look(page, 'revising-390');

      await s.agent.revise(s.outcomes.book, v2Fields(), 'Shorter.');
      await expect(sheet.locator('[data-versions]')).toContainText('v2 of 2');
      await expect(sheet.locator('[data-diff="ins"]').first()).toBeVisible();
      await expect(sheet.getByRole('button', { name: /Send and book v2/ })).toBeInViewport();
      await look(page, 'v2-390');
      await sheet.getByRole('button', { name: 'Previous version' }).click();
      await expect(sheet.locator('[data-versions]')).toContainText('v1 of 2');
      await expect(sheet.getByRole('button', { name: /Send and book v1/ })).toBeVisible();
      await sheet.getByRole('button', { name: 'Next version' }).click();
      await sheet.getByRole('button', { name: /Send and book v2/ }).click();
      await expect(sheet.locator('button[data-undo]')).toBeVisible();
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: UNDO_WAIT + 8000 })
        .toBe('approved');
      const o = await outcomeDoc(s);
      expect(o.fields!.mapValue!.fields!.text!.stringValue).toBe(V2);
      expect(o.decision!.mapValue!.fields!.version!.integerValue).toBe('2');
    } finally {
      await s.stop();
    }
  });

  test('an edit in the sheet sent at once is exactly the text sent', async ({ page }) => {
    test.setTimeout(120_000);
    const s = await open(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const sheet = page.locator('[data-agent-panel]');
      await expect(sheet).toHaveAttribute('data-sheet', 'collapsed', { timeout: 20_000 });
      await sheet.getByRole('button', { name: /^Edit/ }).click();
      await sheet.getByLabel('Reply', { exact: true }).fill('Tuesday 10:00 works, Sam.');
      await sheet.getByRole('button', { name: /Send and book/ }).click();
      await expect
        .poll(async () => (await outcomeDoc(s)).state!.stringValue, { timeout: UNDO_WAIT + 8000 })
        .toBe('approved');
      expect((await outcomeDoc(s)).fields!.mapValue!.fields!.text!.stringValue).toBe(
        'Tuesday 10:00 works, Sam.',
      );
    } finally {
      await s.stop();
    }
  });
});
