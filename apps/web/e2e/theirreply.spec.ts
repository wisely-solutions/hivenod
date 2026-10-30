/**
 * Their reply (packages/shared/src/theirreply.ts): a plan step that waits on someone outside
 * Hivenod. The agent drafts the ask, the member approves it (nothing is sent before), the step
 * waits on them with a purple "waiting on Ana · 2 d" pill, their reply is quoted with the
 * agent's follow-up to approve, and the member can mark the step done anyway.
 * THEIRREPLY_SHOTS=<dir> saves the plan at 1440 and 390 (built-1440.png, built-390.png).
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminDoc, adminUpdate, fastTimers, freezeClock, NOW, settle, UNDO_WAIT } from './helpers';
import { at, seedInbox } from './inboxSeed';

const shots = process.env.THEIRREPLY_SHOTS;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await settle(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

async function flow(page: Page, phone: boolean) {
  test.setTimeout(150_000);
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
  const oid = stepIds[0]!;
  const step = async () => (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${oid}`))?.fields;
  const plan = page.locator(`[data-decision-page] [data-plan="${planId}"]`).first();
  const row = plan.locator(`[data-outcome="${oid}"]`);

  await page.goto(`/inbox/${s.wid}/t/${tid}`);
  if (phone) {
    // The top card holds the plan's main button; the plan itself is a fold.
    await page
      .getByRole('region', { name: 'Decision' })
      .locator('[data-approve-plan]')
      .click({ timeout: 20_000 });
  } else await plan.locator('[data-approve-plan]').click({ timeout: 20_000 });
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(async () => (await step())?.state).toEqual({ stringValue: 'approved' });
  if (phone) await page.getByRole('button', { name: /^Plan/ }).click();

  // Its turn: the agent drafts the ask; it waits for the member, nothing is sent.
  await s.agent.theirReply(planId, {
    ask: 'ask',
    text: 'Hi Ana, could you confirm clauses 4 and 7 of the Acme contract are OK for you?',
  });
  await expect(row).toHaveAttribute('data-step-ui', 'waitingForYou', { timeout: 20_000 });
  const approve = row.locator('[data-their-approve]');
  if (!(await approve.isVisible())) await row.getByRole('button', { name: /^Step 1:/ }).click();
  await expect(row.locator('[data-their-ask]')).toContainText('clauses 4 and 7');
  await approve.click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(async () => JSON.stringify((await step())?.ext)).toContain('"approved"');

  // The agent sends it: the step waits on Ana (sent two days ago, for the picture).
  await s.agent.theirReply(planId, { sent: true });
  const sentAt = new Date(NOW - 2 * 86_400_000);
  const sent = (await s.agent.outcome(oid)).ext!;
  await adminUpdate(`workspaces/${s.wid}/inboxOutcomes/${oid}`, {
    ext: {
      ask: { ...sent.ask!, at: sentAt },
      outAt: sentAt,
      sent: sent.sent,
      reply: sent.reply,
    },
  });
  await expect(row.getByTestId('pill-waiting-on')).toContainText(
    phone ? 'Ana · 2 d' : 'waiting on Ana · 2 d',
    {
      timeout: 20_000,
    },
  );

  await shot(page, phone ? 'built-390-waiting' : 'built-1440-waiting');

  // Ana replies: a partial yes. The agent quotes it and drafts a follow-up.
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
  await expect(row).toHaveAttribute('data-step-ui', 'waitingForYou', { timeout: 20_000 });
  if (!(await row.locator('[data-their-approve]').isVisible()))
    await row.getByRole('button', { name: /^Step 1:/ }).click();
  await expect(row.locator('[data-their-quote-full]')).toContainText('30-day notice');
  await expect(row.locator('[data-their-approve]')).toHaveText(/Approve follow-up/);
  await expect(row.locator('[data-their-done]')).toBeVisible();
  await shot(page, phone ? 'built-390' : 'built-1440');

  // Mark done anyway: the plan moves on.
  await row.locator('[data-their-done]').click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(async () => (await step())?.state).toEqual({ stringValue: 'done' });
  await expect
    .poll(async () => (await adminDoc(`workspaces/${s.wid}/inboxPlans/${planId}`))?.fields.cursor)
    .toEqual({ integerValue: '1' });
  await s.stop();
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');
  test('their reply: draft, approve, waiting on them, reply quoted, mark done', async ({
    page,
  }) => {
    await flow(page, false);
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });
  test('their reply on the phone: the pill, the quote and the buttons', async ({ page }) => {
    await flow(page, true);
  });
});
