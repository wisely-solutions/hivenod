/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): the "Ask the agent…" box on a thread, the chips
 * shown only in context (a meeting booked → Prepare; stale → Re-check; waiting 3 days → Follow
 * up; the agent's own suggestions first), Undo on the button (nothing written), "Asked · <agent>
 * is on it", the agent's answer (a proposal that waits for approval, or a note) under the
 * request and on the timeline; the Today card's Other › Ask the agent…; the phone panel.
 * 1440 and 390, light and dark, axe-clean.
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
import { makeOldBooking, seedInbox, type Seed } from './inboxSeed';

const H = 3_600_000;

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function look(page: Page, name: string, full = true) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots)
      await page.screenshot({ path: `${shots}/askagent-${name}-${scheme}.png`, fullPage: full });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

type F = Record<string, { stringValue?: string; mapValue?: { fields: F } }>;
const threadDoc = async (s: Seed, tid: string) =>
  ((await adminDoc(`workspaces/${s.wid}/inboxThreads/${tid}`))?.fields ?? {}) as F;
/** The latest instruction's id and state, or null. */
async function instructOf(s: Seed, tid: string) {
  const f = (await threadDoc(s, tid)).instruct?.mapValue?.fields;
  return f ? { id: f.id!.stringValue!, state: f.state!.stringValue! } : null;
}
async function instructionOf(s: Seed, tid: string, id: string) {
  const f = (await threadDoc(s, tid)).instructions?.mapValue?.fields?.[id]?.mapValue?.fields;
  return f
    ? {
        text: f.text?.stringValue ?? null,
        chip: f.chip?.stringValue ?? null,
        state: f.state?.stringValue,
      }
    : null;
}

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  return seedInbox(page);
}

const box = (where: Locator | Page) => where.locator('[data-ask-agent]');

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

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('free text with ⌘↵ and Undo; the agent answers with a proposal that waits', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      // The supplier visit: still investigating, nothing proposed, the last message is theirs.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.visit}`);
      const ask = box(page.locator('[data-decision-page]'));
      await expect(ask).toBeVisible({ timeout: 20_000 });
      await expect(ask.locator('[data-ask-chip]')).toHaveCount(1);
      await expect(ask.locator('[data-ask-chip="draft_reply"]')).toHaveText('Draft a reply');
      await look(page, 'box-1440');

      // A chip, then Undo on the chip: nothing is written.
      await ask.locator('[data-ask-chip="draft_reply"]').click();
      await expect(ask.locator('button[data-undo]')).toBeVisible();
      await expect(page.locator('[data-toast-region] > *')).toHaveCount(0);
      await ask.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      expect(await instructOf(s, s.threads.visit)).toBe(null);

      // Free text, sent with ⌘↵ (Ctrl+↵): Undo sits on the Ask button, then it is written.
      const text = ask.locator('[data-ask-box]');
      await text.fill('Tell Tom I am coming, and check the train times.');
      await expect(ask).toContainText('48 / 500');
      await text.press('ControlOrMeta+Enter');
      await expect(ask.locator('button[data-undo]')).toBeVisible();
      expect(await instructOf(s, s.threads.visit)).toBe(null);
      await expect
        .poll(() => instructOf(s, s.threads.visit), { timeout: UNDO_WAIT + 8000 })
        .toMatchObject({ state: 'pending' });
      const { id } = (await instructOf(s, s.threads.visit))!;
      expect(await instructionOf(s, s.threads.visit, id)).toEqual({
        text: 'Tell Tom I am coming, and check the train times.',
        chip: null,
        state: 'pending',
      });
      await expect(ask.locator('[data-instructing]')).toContainText('Asked · Desk agent is on it');
      await expect(ask.locator('[data-ask-box]')).toBeDisabled();
      await look(page, 'asked-1440');

      // The agent proposes a reply and answers with it: the proposal waits for approval.
      const oid = await s.agent.propose(
        s.threads.visit,
        'reply',
        { text: 'Yes Tom, I am coming. I take the 8:10 train.' },
        'You asked me to confirm.',
      );
      await s.agent.answer(s.threads.visit, id, 'outcome', oid, 'A reply for you to approve.');
      const answer = ask.locator('[data-instruct-answer="outcome"]');
      await expect(answer).toContainText('You asked: Tell Tom I am coming');
      await expect(answer).toContainText(/Desk agent answered \d\d:\d\d · A reply for you/);
      await expect(answer.locator('[data-answer-link]')).toHaveText('See the proposal (Reply)');
      await expect(page.locator(`[data-proposal="${oid}"]`)).toBeVisible();
      expect((await s.agent.outcome(oid)).state).toBe('proposed');
      // On the timeline: both.
      await page.getByRole('button', { name: /^Everything/ }).click();
      const convo = page.getByRole('region', { name: 'Conversation' });
      await expect(convo).toContainText('You asked: “Tell Tom I am coming');
      await expect(convo).toContainText('Desk agent answered with a proposal');
      await answer.locator('[data-answer-link]').click();
      await expect(page.locator('#proposed')).toBeInViewport();
      await look(page, 'answered-1440');
    } finally {
      await s.stop();
    }
  });

  test('chips only in context: a meeting booked, stale, waiting 3 days, the agent’s own', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const panel = page.locator('[data-decision-page]');
      const chips = box(panel).locator('[data-ask-chip]');

      // A meeting booked (an old reply_book approved before Calendar went, Tuesday 10:00):
      // Prepare for the meeting.
      await makeOldBooking(s, 'approved');
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      await expect(box(panel).locator('[data-ask-chip="prepare_meeting"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(box(panel).locator('[data-ask-chip="follow_up"]')).toHaveCount(0);
      await box(panel).locator('[data-ask-chip="prepare_meeting"]').click();
      await expect(box(panel).locator('button[data-undo]')).toBeVisible();
      await expect
        .poll(() => instructOf(s, s.threads.review), { timeout: UNDO_WAIT + 8000 })
        .toMatchObject({ state: 'pending' });
      const { id } = (await instructOf(s, s.threads.review))!;
      expect(await instructionOf(s, s.threads.review, id)).toMatchObject({
        text: null,
        chip: 'prepare_meeting',
      });
      await expect(panel.locator('[data-instructing]')).toContainText('Prepare for the meeting');
      await s.agent.answer(
        s.threads.review,
        id,
        'note',
        undefined,
        'Sam leads it; bring the Q3 payment numbers.',
      );
      await expect(panel.locator('[data-instruct-answer="note"]')).toContainText(
        'Sam leads it; bring the Q3 payment numbers.',
      );
      await expect(box(panel).locator('[data-ask-box]')).toBeEnabled();
      await look(page, 'prepare-1440');

      // A proposal two days old: Re-check (it asks for a Re-check, not an instruction).
      await adminPatch(`workspaces/${s.client}/inboxOutcomes/${s.outcomes.steer}`, {
        createdAt: new Date(NOW - 50 * H),
      });
      await adminPatch(`workspaces/${s.client}/inboxThreads/${s.threads.steer}`, {
        lastMessageAt: new Date(NOW - 51 * H),
      });
      await page.goto(`/inbox/${s.client}/t/${s.threads.steer}`);
      // A proposal waits: the box opens from "Ask Northwind agent…" under the top card.
      await page.getByRole('button', { name: 'Ask Northwind agent…' }).click({ timeout: 20_000 });
      await expect(box(panel).locator('[data-ask-chip="recheck"]')).toBeVisible({
        timeout: 20_000,
      });
      await expect(box(panel).locator('[data-ask-chip="prepare_meeting"]')).toHaveCount(0);
      await box(panel).locator('[data-ask-chip="recheck"]').click();
      await expect(box(panel).locator('button[data-undo]')).toBeVisible();
      await expect
        .poll(
          async () =>
            (await adminDoc(`workspaces/${s.client}/inboxThreads/${s.threads.steer}`))?.fields
              .recheck?.mapValue?.fields?.state?.stringValue,
          { timeout: UNDO_WAIT + 8000 },
        )
        .toBe('pending');
      expect(
        (await adminDoc(`workspaces/${s.client}/inboxThreads/${s.threads.steer}`))?.fields.instruct,
      ).toBeUndefined();

      // Waiting on them, no message for 4 days: Follow up; the agent's own chips come first.
      await adminUpdate(`workspaces/${s.wid}/inboxThreads/${s.threads.visit}`, {
        state: 'waiting',
        waiting: { on: 'them', until: null },
        lastMessageAt: new Date(NOW - 4 * 24 * H),
      });
      await page.goto(`/inbox/${s.wid}/t/${s.threads.visit}`);
      await expect(box(panel).locator('[data-ask-chip="follow_up"]')).toBeVisible({
        timeout: 20_000,
      });
      await s.agent.chips(s.threads.visit, ['summarize']);
      await expect(chips).toHaveCount(3);
      await expect(chips.nth(0)).toHaveAttribute('data-ask-chip', 'summarize');
      await expect(chips.nth(1)).toHaveAttribute('data-ask-chip', 'follow_up');
      await look(page, 'chips-1440');
    } finally {
      await s.stop();
    }
  });

  test('Today card: Other › Ask the agent… opens the box; asked, with Undo', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      const card = await todayCard(page, /Move the payments review/);
      await card.getByRole('button', { name: 'Other actions' }).click();
      await page.getByRole('menuitem', { name: 'Ask the agent…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Ask Desk agent' });
      await expect(dialog).toBeVisible();
      await expect(box(dialog)).toBeVisible();
      await look(page, 'today-dialog-1440', false);
      await box(dialog).locator('[data-ask-box]').fill('Is Rita joining?');
      await box(dialog).getByRole('button', { name: /Ask/ }).click();
      await expect(box(dialog).locator('button[data-undo]')).toBeVisible();
      await expect
        .poll(() => instructOf(s, s.threads.review), { timeout: UNDO_WAIT + 8000 })
        .toMatchObject({ state: 'pending' });
      await expect(dialog.locator('[data-instructing]')).toContainText(
        'Asked · Desk agent is on it',
      );
      await look(page, 'today-asked-1440', false);
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the panel: ask, Undo within the window, then the agent’s note', async ({ page }) => {
    test.setTimeout(180_000);
    const s = await open(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${s.threads.visit}`);
      const ask = box(page.locator('[data-decision-page]'));
      await expect(ask).toBeVisible({ timeout: 20_000 });
      await ask.locator('[data-ask-box]').fill('Summarize the visit plan.');
      await ask.getByRole('button', { name: /Ask/ }).click();
      await ask.locator('button[data-undo]').click();
      await page.waitForTimeout(UNDO_WAIT);
      expect(await instructOf(s, s.threads.visit)).toBe(null);
      await ask.locator('[data-ask-box]').fill('Summarize the visit plan.');
      await ask.getByRole('button', { name: /Ask/ }).click();
      await expect
        .poll(() => instructOf(s, s.threads.visit), { timeout: UNDO_WAIT + 8000 })
        .toMatchObject({ state: 'pending' });
      await expect(ask.locator('[data-instructing]')).toBeVisible();
      await look(page, 'asked-390');
      const { id } = (await instructOf(s, s.threads.visit))!;
      await s.agent.answer(s.threads.visit, id, 'note', undefined, 'Tue: train 8:10, visit 11:00.');
      await expect(ask.locator('[data-instruct-answer="note"]')).toContainText(
        'Tue: train 8:10, visit 11:00.',
      );
      await look(page, 'answered-390');

      // A thread with a decision: the box opens from "Ask Desk agent…" under the top card.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const sheet = page.locator('[data-decision-page]');
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      await expect(box(sheet)).toHaveCount(0);
      await sheet.getByRole('button', { name: 'Ask Desk agent…' }).click();
      await expect(box(sheet)).toBeVisible();
      await look(page, 'sheet-390');
    } finally {
      await s.stop();
    }
  });
});
