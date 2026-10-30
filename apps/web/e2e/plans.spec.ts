/**
 * Plans on the thread page (item qwFAWxZM5xkcE7PPjAzi, slice 4): the agent's steps as a numbered
 * checklist; Approve plan approves the agent steps only; an approval step waits for the member
 * at its turn; steps that have not started move, go and come; a blocked plan offers Retry, Skip
 * and Stop; Reject plan hands the thread back; Today sends the member to the plan. 1440 and 390,
 * light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  NOW,
  projectFields,
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
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const panel = (page: Page) => page.locator('[data-decision-page]');
const field = async (path: string, name: string) =>
  (await adminDoc(path))?.fields[name] as
    | {
        stringValue?: string;
        integerValue?: string;
        arrayValue?: { values?: { stringValue: string }[] };
      }
    | undefined;
const planOf = (s: Seed, pid: string) => `workspaces/${s.wid}/inboxPlans/${pid}`;
const stateOf = async (s: Seed, oid: string) =>
  (await field(`workspaces/${s.wid}/inboxOutcomes/${oid}`, 'state'))?.stringValue;
const planState = async (s: Seed, pid: string) =>
  (await field(planOf(s, pid), 'state'))?.stringValue;
const cursor = async (s: Seed, pid: string) =>
  Number((await field(planOf(s, pid), 'cursor'))?.integerValue ?? -1);
const steps = async (s: Seed, pid: string) =>
  ((await field(planOf(s, pid), 'steps'))?.arrayValue?.values ?? []).map((v) => v.stringValue);

/** A thread with a 4-step plan: reply, your approval, nudge, hand over. */
async function seedPlan(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const tid = await s.agent.add(s.uid, {
    source: 'teams',
    from: 'Sam Okafor',
    text: 'Finance signed off the new prices. Can the price list be updated before the review?',
    ref: 'prices-plan',
    id: 'm1',
    at: at(0, 7),
  });
  const p = await s.agent.plan(
    tid,
    [
      { type: 'reply', fields: { text: 'On it, Sam: I will confirm once the prices are live.' } },
      {
        type: 'approval',
        fields: { what: 'New price list', detail: 'Basic €29 → €32, Pro €59 → €64' },
      },
      { type: 'nudge', fields: { text: 'The new prices are live: anything else?' } },
      { type: 'handover', fields: { to: 'Maria (website)' } },
    ],
    'Confirm, get your OK on the prices, then tell Sam.',
  );
  return { s, tid, ...p };
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('approve the plan, pass the gate, edit steps, skip a failed one; axe-clean', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, tid, planId, stepIds } = await seedPlan(page);
    const [s1, s2, s3, s4] = stepIds;
    try {
      // Today sends the member to the plan.
      await page.goto('/');
      await page
        .getByRole('button', { name: /Plan · 4 steps to approve/ })
        .click({ timeout: 20_000 });
      const card = page.locator('[data-plan-card]');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.getByRole('button', { name: 'Open plan' }).click();
      await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${tid}`));

      const plan = panel(page).locator(`[data-plan="${planId}"]`);
      await expect(plan).toContainText('Desk agent proposes a plan', { timeout: 20_000 });
      await expect(plan).toContainText('Plan · 4 steps');
      const rows = plan.locator('li[data-step]');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0)).toHaveAttribute('data-step-ui', 'waitingForYou');
      await expect(rows.nth(1)).toContainText('You approve: New price list');
      await expect(rows.nth(3)).toContainText('Hand over to Maria (website)');
      // The plan's steps are not single proposals.
      await expect(panel(page).getByRole('region', { name: 'Proposed' })).toHaveCount(0);
      await look(page, 'plan-1440');

      // Move step 3 up (its menu), then add an approval step and remove it again.
      await page.getByRole('button', { name: 'Step 3 actions' }).click();
      await page.getByRole('menuitem', { name: 'Move up' }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => steps(s, planId)).toEqual([s1, s3, s2, s4]);
      await plan.getByRole('button', { name: 'Add an approval step' }).click();
      const dialog = page.getByRole('dialog', { name: 'Add an approval step' });
      await dialog.getByLabel('What you approve').fill('The wording of the final reply');
      await dialog.getByRole('button', { name: 'Add step' }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(async () => (await steps(s, planId)).length).toBe(5);
      await expect(rows).toHaveCount(5);
      await page.getByRole('button', { name: 'Step 5 actions' }).click();
      await page.getByRole('menuitem', { name: 'Remove step' }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(async () => (await steps(s, planId)).length).toBe(4);
      // Back in the agent's order.
      await page.getByRole('button', { name: 'Step 2 actions' }).click();
      await page.getByRole('menuitem', { name: 'Move down' }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => steps(s, planId)).toEqual([s1, s2, s3, s4]);

      // Approve plan: the agent steps only; the gate still waits.
      await plan.locator('[data-approve-plan]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, s1!)).toBe('approved');
      expect(await stateOf(s, s2!)).toBe('proposed');
      expect(await stateOf(s, s3!)).toBe('approved');
      expect(await stateOf(s, s4!)).toBe('approved');
      await expect.poll(() => planState(s, planId)).toBe('active');
      await expect(rows.nth(0)).toHaveAttribute('data-step-ui', 'running');

      // The agent sends the reply: the gate is at its turn and waits for the member.
      await s.agent.finishStep(planId, 'done');
      await expect(rows.nth(1)).toHaveAttribute('data-step-ui', 'waitingForYou');
      await expect(plan.locator('[data-gate-approve]')).toBeVisible();
      await look(page, 'plan-gate-1440');
      await plan.locator('[data-gate-approve]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, s2!)).toBe('done');
      await expect.poll(() => cursor(s, planId)).toBe(2);

      // The nudge fails: the plan is blocked; Skip moves on to the hand over.
      await s.agent.finishStep(planId, 'failed', { error: 'Teams said 403' });
      await expect(rows.nth(2)).toHaveAttribute('data-step-ui', 'blocked');
      await expect(plan).toContainText('Failed: Teams said 403');
      await plan.locator('[data-skip]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => cursor(s, planId)).toBe(3);
      await expect(rows.nth(2)).toHaveAttribute('data-step-ui', 'skipped');
      await s.agent.finishStep(planId, 'done');
      await expect.poll(() => planState(s, planId)).toBe('done');
      await expect(rows.nth(3)).toHaveAttribute('data-step-ui', 'done');
    } finally {
      await s.stop();
    }
  });

  test('approve one step; Reject plan hands the thread back to the agent', async ({ page }) => {
    test.setTimeout(120_000);
    const { s, tid, planId, stepIds } = await seedPlan(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const plan = panel(page).locator(`[data-plan="${planId}"]`);
      // Step 1 is open: Approve step, Edit and Ask for changes, as a single proposal.
      await expect(plan.getByRole('button', { name: /Approve step/ })).toBeVisible({
        timeout: 20_000,
      });
      await expect(plan.locator('[data-ask-changes]')).toBeVisible();
      await plan.getByRole('button', { name: /Approve step/ }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, stepIds[0]!)).toBe('approved');
      expect(await stateOf(s, stepIds[2]!)).toBe('proposed');
      // Reject plan is out of the way, in the plan's ⋯ menu (slice 6).
      await plan.getByRole('button', { name: 'Plan actions' }).click();
      await page.getByRole('menuitem', { name: 'Reject plan' }).click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => planState(s, planId)).toBe('stopped');
      await expect
        .poll(
          async () =>
            (await field(`workspaces/${s.wid}/inboxThreads/${tid}`, 'state'))?.stringValue,
        )
        .toBe('investigating');
      expect(await stateOf(s, stepIds[2]!)).toBe('rejected');
      await expect(plan).toHaveAttribute('data-plan-state', 'stopped');
    } finally {
      await s.stop();
    }
  });
});

test.describe('Build it 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the step shows the item it made; the plan goes on once the item is Done', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await fastTimers(page);
    await freezeClock(page);
    const s = await seedInbox(page);
    try {
      const base = `workspaces/${s.wid}`;
      await adminSet(`${base}/projects/web`, projectFields('Website', s.uid));
      const tid = await s.agent.add(s.uid, {
        source: 'teams',
        from: 'Sam Okafor',
        text: 'Can the price list be updated?',
        ref: 'prices-build',
        id: 'm1',
        at: at(0, 7),
      });
      const { planId, stepIds } = await s.agent.plan(tid, [
        { type: 'make_it_work', fields: { title: 'Update the price list', project: 'web' } },
        { type: 'reply', fields: { text: 'Done: the new prices are live.' } },
      ]);
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const plan = panel(page).locator(`[data-plan="${planId}"]`);
      await expect(plan.locator('li[data-step]').first()).toContainText(
        'Build it: Update the price list',
        { timeout: 20_000 },
      );
      await plan.locator('[data-approve-plan]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, stepIds[0]!)).toBe('approved');
      // The agent makes the item and reports the step started (the CLI fills in the link).
      await adminSet(`${base}/projects/web/items/b1`, {
        title: 'Update the price list',
        type: 'task',
        stepId: 'draft',
        status: 'working',
        summary: 'From the plan',
        source: { kind: 'agent', label: 'Desk agent' },
        createdBy: { type: 'agent', id: s.agent.aid },
        parentItemId: null,
        sourceRunId: null,
        claim: null,
        progress: null,
        gate: null,
        triage: null,
        sendBackCount: 0,
        costEur: 0,
        order: 1,
        updatedAt: new Date(NOW),
        lastEventId: 'seed',
      });
      await s.agent.finishStep(planId, 'started', {
        itemId: 'b1',
        permalink: 'https://hivenod.com/p/web?item=b1',
      });
      const row = plan.locator('li[data-step="1"]');
      await expect(row).toHaveAttribute('data-step-ui', 'running');
      const card = plan.locator('[data-build-item="b1"]');
      await expect(card).toContainText('Website');
      await expect(card).toContainText('Update the price list');
      await expect(card.locator('[data-build-state]')).toHaveText('At Draft');
      await expect(card.getByRole('link', { name: 'Open' })).toHaveAttribute(
        'href',
        /\/p\/web\?item=b1/,
      );
      await look(page, 'plan-buildit-1440');
      // The item is Done: the agent reports the step done; the reply's turn comes.
      await adminSet(`${base}/projects/web/items/b1`, {
        title: 'Update the price list',
        type: 'task',
        stepId: 'review',
        status: 'done',
        summary: 'From the plan',
        source: { kind: 'agent', label: 'Desk agent' },
        createdBy: { type: 'agent', id: s.agent.aid },
        parentItemId: null,
        sourceRunId: null,
        claim: null,
        progress: null,
        gate: null,
        triage: null,
        sendBackCount: 0,
        costEur: 0,
        order: 1,
        updatedAt: new Date(NOW),
        lastEventId: 'seed',
      });
      await expect(card.locator('[data-build-state]')).toHaveText(
        'Done: the agent reports it next',
      );
      await s.agent.finishStep(planId, 'done', { itemId: 'b1' });
      await expect(row).toHaveAttribute('data-step-ui', 'done');
      await expect.poll(() => cursor(s, planId)).toBe(1);
    } finally {
      await s.stop();
    }
  });
});

test.describe('Today 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('the card shows the step that waits: Approve plan, the gate, a blocked step', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, planId, stepIds } = await seedPlan(page);
    const [s1, s2] = stepIds;
    try {
      await page.goto('/');
      const row = (name: RegExp) => page.getByRole('button', { name });
      await row(/Plan · 4 steps to approve/).click({ timeout: 20_000 });
      const card = page.locator(`[data-plan-card][data-plan="${planId}"]`);
      await expect(card).toHaveAttribute('data-plan-main', 'approvePlan');
      await expect(card).toContainText('Plan · Step 1 of 4');
      await expect(card.locator('li[data-step]')).toHaveCount(4);
      await look(page, 'today-plan-1440');
      await card.locator('[data-approve-plan]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, s1!)).toBe('approved');

      // Step 1 done: the approval step waits; A approves it.
      await s.agent.finishStep(planId, 'done');
      await row(/Plan · step 2 of 4 waits for you/).click({ timeout: 20_000 });
      await expect(card).toHaveAttribute('data-plan-main', 'step');
      await expect(card).toContainText('Step 2 of 4 · Your approval');
      await expect(card).toContainText('Basic €29 → €32, Pro €59 → €64');
      await look(page, 'today-plan-gate-1440');
      await card.locator('[data-gate-approve]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, s2!)).toBe('done');

      // The nudge fails: Today shows the blocked plan; Skip step moves it on.
      await s.agent.finishStep(planId, 'failed', { error: 'Teams said 403' });
      await row(/Plan · step 3 of 4 failed/).click({ timeout: 20_000 });
      await expect(card).toHaveAttribute('data-plan-main', 'retry');
      await expect(card).toContainText('Teams said 403');
      await card.locator('[data-skip]').click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => cursor(s, planId)).toBe(3);
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('Today: the plan card at 390', async ({ page }) => {
    test.setTimeout(120_000);
    const { s, planId } = await seedPlan(page);
    try {
      await page.goto('/');
      await page
        .getByRole('button', { name: /Plan · 4 steps to approve/ })
        .click({ timeout: 20_000 });
      const card = page.locator(`[data-plan-card][data-plan="${planId}"]`);
      await expect(card).toHaveAttribute('data-plan-main', 'approvePlan');
      await expect(card.locator('[data-approve-plan]')).toBeVisible();
      await look(page, 'today-plan-390');
    } finally {
      await s.stop();
    }
  });

  test('the plan is a fold; the top card holds its main button, in reach', async ({ page }) => {
    test.setTimeout(120_000);
    const { s, tid, planId, stepIds } = await seedPlan(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const top = page.getByRole('region', { name: 'Decision' });
      const main = top.locator('[data-approve-plan]');
      await expect(main).toBeInViewport({ timeout: 20_000 });
      await page.getByRole('button', { name: /^Plan/ }).click();
      const plan = panel(page).locator(`[data-plan="${planId}"]`);
      await expect(plan.locator('li[data-step]')).toHaveCount(4);
      await page.evaluate(() => window.scrollTo(0, 0));
      await look(page, 'plan-390');
      await main.click();
      await page.waitForTimeout(UNDO_WAIT);
      await expect.poll(() => stateOf(s, stepIds[0]!)).toBe('approved');
      await s.agent.finishStep(planId, 'done');
      const gate = top.locator('[data-gate-approve]');
      await expect(gate).toBeInViewport();
      await look(page, 'plan-gate-390');
    } finally {
      await s.stop();
    }
  });
});
