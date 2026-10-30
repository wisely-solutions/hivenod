/**
 * An approved agent step the agent has yet to carry out is the agent's turn, never the member's
 * call (item OE8FmrTaIxFVGcaeGG3N, João 2026-10-30): the thread waits on the agent on the
 * decision page, Today (Agents working, not in the stack) and the Inbox list.
 * STATEFIX_SHOTS=<dir> saves the Today page and the thread page there.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminDoc, fastTimers, freezeClock, settle, UNDO_WAIT } from './helpers';
import { at, seedInbox } from './inboxSeed';

const shots = process.env.STATEFIX_SHOTS;
async function shot(page: Page, name: string) {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await settle(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('an approved step at its turn waits on the agent everywhere, not Your call', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await fastTimers(page);
    await freezeClock(page);
    const s = await seedInbox(page);
    try {
      const tid = await s.agent.add(s.uid, {
        source: 'teams',
        from: 'Sam Okafor',
        text: 'Finance signed off the new prices. Can the price list be updated before the review?',
        ref: 'prices-waiting',
        id: 'm1',
        at: at(0, 7),
      });
      const subject = await s.agent.file(tid, { newName: 'Price list update', area: 'Sales' });
      const { planId, stepIds } = await s.agent.plan(
        tid,
        [
          {
            type: 'reply',
            fields: { text: 'On it, Sam: I will confirm once the prices are live.' },
          },
          { type: 'approval', fields: { what: 'New price list' } },
          { type: 'nudge', fields: { text: 'The new prices are live: anything else?' } },
        ],
        'Confirm, get your OK, then tell Sam.',
      );
      const threadPath = `workspaces/${s.wid}/inboxThreads/${tid}`;
      const threadField = async (name: string) => (await adminDoc(threadPath))?.fields[name];

      // The member approves the plan (its agent steps): step 1 is the agent's turn, the gate
      // waits later.
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const plan = page.locator(`[data-decision-page] [data-plan="${planId}"]`);
      await plan.locator('[data-approve-plan]').click({ timeout: 20_000 });
      await page.waitForTimeout(UNDO_WAIT);
      await expect
        .poll(
          async () =>
            (await adminDoc(`workspaces/${s.wid}/inboxOutcomes/${stepIds[0]}`))?.fields.state,
        )
        .toEqual({ stringValue: 'approved' });
      await page.waitForTimeout(500);
      await shot(page, 'thread');

      // Stored: waiting on the agent.
      expect((await threadField('state')) as unknown).toEqual({ stringValue: 'waiting' });
      expect(
        ((await threadField('waiting')) as { mapValue: { fields: { on: unknown } } }).mapValue
          .fields.on,
      ).toEqual({ stringValue: 'agent' });

      // The decision page: the chip and the top card say the agent is on it.
      const chip = page.locator('span[data-state]').first();
      await expect(chip).toHaveAttribute('data-state', 'waiting');
      await expect(chip).toHaveText('Waiting on Desk agent');
      await expect(page.locator('[data-decision-page]')).toContainText(
        'Desk agent is working · step 1 of 3',
      );
      await expect(page.getByText('Your call', { exact: true })).toHaveCount(0);

      // Today: not in the stack; listed under Agents working.
      const key = `t:${s.wid}:${tid}`;
      await page.goto('/');
      const rail = page.locator('[data-today-rail]');
      await expect(rail.getByRole('region', { name: 'Agents working' })).toContainText(
        'Finance signed off the new prices',
        { timeout: 20_000 },
      );
      await shot(page, 'today');
      await expect(
        page.locator(`[data-thread-row="${key}"], [data-card-row="${key}"]`),
      ).toHaveCount(0);
      await expect(
        rail
          .getByRole('region', { name: 'Waiting on others' })
          .getByText('Finance signed off the new prices'),
      ).toHaveCount(0);

      // The Inbox list: under Agents working, with the Working chip (not N for you).
      await page.goto('/inbox');
      const row = page.locator(`[data-group="working"] [data-subject="${subject}"]`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row.locator('span[data-state]')).toHaveText('Working');
      await shot(page, 'inbox');
    } finally {
      await s.stop();
    }
  });
});
