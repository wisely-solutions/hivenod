/**
 * Today shows a Their reply draft (the agent's message to someone outside Hivenod, waiting for
 * the member's approval) as a decision card: the purple tag, "Send to Ana (Acme legal)?", the
 * draft and Approve & send / Edit / Open; a follow-up quotes what they said and offers Mark done.
 * 1440 and 390, light and dark, axe-clean. TODAYTHEIR_SHOTS=<dir> saves the pictures.
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

const shots = process.env.TODAYTHEIR_SHOTS;
async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}
async function look(page: Page, name: string) {
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots && scheme === 'light')
      await page
        .locator('[data-decision-card]')
        .filter({ has: page.locator('[data-their-card]') })
        .screenshot({ path: `${shots}/${name}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The stack holds the seeded threads too: focus ours (its row), unless it is the card already. */
async function focus(page: Page, s: Seed, tid: string) {
  const row = page.locator(`[data-thread-row="t:${s.wid}:${tid}"]`);
  await expect(row.or(page.locator('[data-decision-card]')).first()).toBeVisible({
    timeout: 20_000,
  });
  if (await row.isVisible()) await row.click();
}

const tag = (page: Page) => page.locator('[data-their-tag]');

/** A thread with a plan (Their reply, then a reply to Sam) whose first step is approved and running. */
async function seed(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const ref = 'contract-ana';
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Sam Okafor',
    text: 'Can we sign the Acme contract this week? Their legal team has to OK the clauses first.',
    ref,
    id: 'm1',
    at: at(0, 7),
  });
  await s.agent.file(tid, { newName: 'Acme contract', area: 'Sales' });
  const { planId, stepIds } = await s.agent.plan(
    tid,
    [
      {
        type: 'their_reply',
        fields: {
          who: 'Ana',
          org: 'Acme legal',
          channel: 'mail',
          address: 'ana@acme.example',
          need: 'Her OK on clauses 4 and 7',
        },
      },
      { type: 'reply', fields: { text: 'Sam, Acme legal is fine with the clauses: we can sign.' } },
    ],
    'Get Ana’s OK on the clauses, then tell Sam.',
  );
  await page.goto('/');
  await focus(page, s, tid);
  await page.locator('[data-approve-plan]').first().click({ timeout: 20_000 });
  await page.waitForTimeout(UNDO_WAIT);
  const oid = stepIds[0]!;
  await expect
    .poll(async () => (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${oid}`))?.fields.state)
    .toEqual({ stringValue: 'approved' });
  return { s, tid, planId, oid, ref };
}

const step = async (s: Seed, oid: string) =>
  (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${oid}`))?.fields;

async function askFlow(page: Page, phone: boolean) {
  test.setTimeout(150_000);
  const { s, tid, planId, oid } = await seed(page);
  await s.agent.theirReply(planId, {
    ask: 'ask',
    text: 'Hi Ana, could you confirm clauses 4 and 7 of the Acme contract are OK for you?',
  });
  await page.goto('/');
  await focus(page, s, tid);
  await expect(tag(page)).toHaveText(/Their reply · step 1 of 2/, { timeout: 20_000 });
  const card = page.locator('[data-their-card]');
  await expect(card).toContainText('Send to Ana (Acme legal)?');
  await expect(card).toContainText('Her OK on clauses 4 and 7 · by mail');
  await expect(card.locator('[data-their-ask]')).toContainText('clauses 4 and 7');
  await expect(card.locator('[data-their-approve]')).toHaveText(/Approve & send/);
  await expect(card.locator('[data-their-done]')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Open' })).toBeVisible();
  // It counts in the stack: the count of what waits for you includes it.
  await expect(page.getByText(/\d+ waiting for you/).first()).toBeVisible();
  await look(page, phone ? 'built-390' : 'built-1440');

  // Edit, then Approve & send: the edited text is what is approved.
  await card.locator('[data-their-edit]').click();
  const box = card.getByRole('textbox', { name: /Message to Ana/ });
  await box.fill('Hi Ana, are clauses 4 and 7 OK for Acme legal?');
  await card.locator('[data-their-approve]').click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(async () => JSON.stringify((await step(s, oid))?.ext)).toContain('"approved"');
  expect(JSON.stringify((await step(s, oid))?.ext)).toContain('are clauses 4 and 7 OK');
  await s.stop();
}

async function followUpFlow(page: Page, phone: boolean) {
  test.setTimeout(150_000);
  const { s, planId, oid, ref, tid } = await seed(page);
  await s.agent.theirReply(planId, { ask: 'ask', text: 'Hi Ana, are clauses 4 and 7 OK?' });
  const p = `workspaces/${s.wid}/inboxOutcomes/${oid}`;
  const cur = (await s.agent.outcome(oid)).ext!;
  await adminUpdate(p, { ext: { ...cur, ask: { ...cur.ask!, state: 'approved' } } });
  await s.agent.theirReply(planId, { sent: true });
  await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Ana Ruiz',
    text: 'Clause 4 is fine, but 7 needs a 30-day notice period.',
    ref,
    id: 'm2',
    at: at(0, 9),
  });
  const mid = s.agent.messageDocId(s.uid, 'mail', ref, 'm2');
  await s.agent.theirReply(planId, {
    ask: 'follow_up',
    text: 'Thanks Ana. If we add a 30-day notice to clause 7, is the contract OK for you?',
    reply: { messageDocId: mid, quote: 'Clause 4 is fine, but 7 needs a 30-day notice period.' },
  });
  await page.goto('/');
  await focus(page, s, tid);
  await expect(tag(page)).toHaveText(/Their reply · follow-up/, { timeout: 20_000 });
  const card = page.locator('[data-their-card]');
  await expect(card).toContainText('Follow up with Ana?');
  await expect(card).toContainText('Ana said: “Clause 4 is fine, but 7 needs a 30-day notice');
  await expect(card.locator('[data-their-approve]')).toBeVisible();
  await expect(card.locator('[data-their-edit]')).toBeVisible();
  await look(page, phone ? 'built-390-followup' : 'built-1440-followup');

  // Mark done: the step is done and the plan moves on.
  await card.locator('[data-their-done]').click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(async () => (await step(s, oid))?.state).toEqual({ stringValue: 'done' });
  await expect
    .poll(async () => (await adminDoc(`workspaces/${s.wid}/inboxPlans/${planId}`))?.fields.cursor)
    .toEqual({ integerValue: '1' });
  await s.stop();
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');
  test('the draft ask is a card on Today: Edit, Approve & send', async ({ page }) => {
    await askFlow(page, false);
  });
  test('a follow-up quotes their reply: Mark done', async ({ page }) => {
    await followUpFlow(page, false);
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });
  test('the draft ask on the phone', async ({ page }) => {
    await askFlow(page, true);
  });
  test('the follow-up on the phone', async ({ page }) => {
    await followUpFlow(page, true);
  });
});
