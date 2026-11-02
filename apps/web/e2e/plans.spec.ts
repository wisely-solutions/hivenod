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
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  settle,
  UNDO_WAIT,
} from './helpers';
import { at, seedDevPlans, seedInbox, type Seed } from './inboxSeed';

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
      // Every step is read-only; Edit opens step 1 as a single proposal: Approve step, Edit and
      // Ask for changes.
      await plan.getByRole('button', { name: 'Edit step 1' }).click({ timeout: 20_000 });
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

/** A thread with a replaced plan (v1, proposed) and a 4-step Development plan (v2). */
async function seedPlanView(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const d = await seedDevPlans(s);
  return { s, ...d };
}

test.describe('plan view 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('every step open with its spec; the plan page shows the diff; a replaced plan is inert', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, tid, old, dev } = await seedPlanView(page);
    try {
      // Needs you: the thread once, with the newer plan; the replaced plan is not counted.
      await page.goto('/');
      await page
        .getByRole('button', { name: /Plan · 4 steps to approve/ })
        .click({ timeout: 20_000 });
      await expect(page.locator(`[data-plan-card][data-plan="${dev.planId}"]`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator(`[data-plan-card][data-plan="${old.planId}"]`)).toHaveCount(0);

      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const plan = panel(page).locator(`[data-plan="${dev.planId}"]`);
      await expect(plan).toContainText('Desk agent proposes a plan', { timeout: 20_000 });
      await expect(plan.locator('[data-plan-version]')).toHaveText('v2');
      const rows = plan.locator('li[data-step]');
      await expect(rows).toHaveCount(4);
      // Real titles, never truncated.
      await expect(rows.nth(0)).toContainText(
        'Shape: Dark mode for the board that follows the system theme, with a toggle in Settings.',
      );
      await expect(rows.nth(1)).toContainText('Build: One theme token set');
      await expect(rows.nth(1)).toContainText('follow the person across devices?');
      await expect(rows.nth(2)).toContainText('Keep green: PR rebased and green');
      await expect(rows.nth(3)).toContainText('Release + live check');
      // Every step is open: who, its fields, what it produces.
      await expect(plan.locator('[data-step-spec]')).toHaveCount(4);
      await expect(rows.nth(0).locator('[data-spec-who]')).toHaveText('Agent · Shape');
      await expect(rows.nth(0)).toContainText('Idea');
      await expect(rows.nth(0)).toContainText('Produces: a proposal with a size for your OK');
      await expect(rows.nth(1)).toContainText('Produces: an open pull request, checks green');
      await expect(rows.nth(2)).toContainText('Produces: the PR kept current with main');
      await expect(rows.nth(3)).toContainText('Produces: the change live and checked');
      // The open question is highlighted.
      await expect(plan.locator('[data-open-question]')).toHaveCount(1);
      await expect(plan.locator('[data-open-question]')).toContainText('Open: should the choice');
      // A step can still be collapsed.
      await rows
        .nth(2)
        .getByRole('button', { name: /^Step 3:/ })
        .click();
      await expect(rows.nth(2).locator('[data-step-spec]')).toHaveCount(0);
      await rows
        .nth(2)
        .getByRole('button', { name: /^Step 3:/ })
        .click();
      await expect(rows.nth(2).locator('[data-step-spec]')).toHaveCount(1);
      // The editor is behind Edit (one editor at a time).
      await expect(plan.locator('[data-approve-step], [data-gate-approve]')).toHaveCount(0);
      await plan.getByRole('button', { name: 'Edit step 1' }).click();
      await expect(rows.nth(0).getByRole('button', { name: /^Approve step/ })).toBeVisible();
      await page.keyboard.press('Escape');
      await look(page, 'planview-1440');

      // The replaced plan: Replaced by v2, no actions.
      await page.getByRole('button', { name: /Everything/ }).click();
      const oldPanel = page.locator(`[data-plan="${old.planId}"]`);
      await expect(oldPanel).toContainText('Replaced by v2');
      await expect(oldPanel.locator('[data-plan-version]')).toHaveText('v1');
      await expect(
        oldPanel.getByRole('button', { name: /Approve|Reject|Add an approval/ }),
      ).toHaveCount(0);
      await expect(oldPanel.getByRole('button', { name: 'Plan actions' })).toHaveCount(0);

      // The plan page.
      await plan.getByRole('link', { name: 'Open plan' }).click();
      await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/${tid}/plan/${dev.planId}$`));
      const pg = page.locator(`[data-plan-page="${dev.planId}"]`);
      await expect(pg).toContainText('Plan · v2 of 2', { timeout: 20_000 });
      await expect(pg.locator('[data-step-spec]')).toHaveCount(4);
      const changes = pg.locator('[data-plan-changes]');
      await expect(changes).toContainText('What changed since v1');
      await expect(changes).toContainText('Step 1 · Changed: Reply → Shape');
      await expect(changes).toContainText('Step 3 · Added: Keep green');
      await expect(changes.locator('[data-change="added"]')).toHaveCount(2);
      const older = pg.locator('[data-older-version="1"]');
      await expect(older).toContainText('Proposed (replaced)');
      await expect(older).toContainText('First idea: answer, then your OK.');
      await look(page, 'planpage-1440');

      // v1: replaced, no diff.
      await older.getByRole('link', { name: 'v1' }).click();
      const pg1 = page.locator(`[data-plan-page="${old.planId}"]`);
      await expect(pg1).toContainText('Replaced by v2', { timeout: 20_000 });
      await expect(pg1.locator('[data-plan-changes]')).toHaveCount(0);
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

  test('the plan view at 390: every step open, the plan page', async ({ page }) => {
    test.setTimeout(120_000);
    const { s, tid, dev } = await seedPlanView(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      await page.getByRole('button', { name: /^Plan/ }).click({ timeout: 20_000 });
      const plan = panel(page).locator(`[data-plan="${dev.planId}"]`);
      await expect(plan.locator('[data-step-spec]')).toHaveCount(4);
      await expect(plan.locator('li[data-step]').nth(2)).toContainText(
        'Keep green: PR rebased and green',
      );
      await look(page, 'planview-390');
      await plan.getByRole('link', { name: 'Open plan' }).click();
      const pg = page.locator(`[data-plan-page="${dev.planId}"]`);
      await expect(pg).toContainText('What changed since v1', { timeout: 20_000 });
      await look(page, 'planpage-390');
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
