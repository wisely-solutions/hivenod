/**
 * Card BrK0r2FE: Stop work from the UI. On a working item an admin (or a decider of any gate of
 * the project) presses Stop work, picks Go back or Cancel completely, adds an optional reason:
 * the run ends as stopped, the item is on hold (Resume) or cancelled, and Activity shows it.
 * A member who decides nowhere sees no Stop work button. The rules side is in
 * packages/shared/rules/stopwork.test.ts; the CLI side in packages/agent (runner + integration).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
const SHOTS = process.env.SHOTS_DIR;
/** The open item (a side panel on desktop, full screen on phones). */
const detail = (page: Page) => page.locator('[aria-label="Item detail"]:visible');

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!.width <= 500 ? '375' : '1440';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

async function seed(page: Page, name = 'Ana Admin', creator?: string) {
  const owner = person(name);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`${base}/agents/scout`, {
    name: 'Scout',
    color: 'agent-3',
    projectIds: '*',
    createdBy: uid,
    createdAt: ago(1000),
    revokedAt: null,
    lastSeenAt: ago(0),
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  // Scout works on "Draft the launch email" right now.
  await adminSet(`${base}/runs/r1`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago(4),
    heartbeatAt: ago(0),
    heartbeatEventAt: ago(4),
    endedAt: null,
    status: 'running',
    costEur: 0.12,
    tokensIn: 12_000,
    tokensOut: 800,
    model: 'claude-opus-5-5',
    summary: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, {
    title: 'Draft the launch email',
    type: 'task',
    stepId: 'draft',
    status: 'working',
    summary: '',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: creator ?? uid },
    parentItemId: null,
    sourceRunId: null,
    claim: { runId: 'r1', agentUid: 'scout', heartbeatAt: new Date() },
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });
  return { wid, uid, base };
}

test('Stop work, Go back: run stopped, item on hold with the reason, Resume releases it', async ({
  page,
}) => {
  const { base } = await seed(page);
  await page.goto('/p/blog?item=i1');
  const stop = detail(page).getByRole('button', { name: 'Stop work' });
  await expect(stop).toBeVisible({ timeout: 15_000 });
  await shot(page, 'stopwork-panel');
  await stop.click();

  const dialog = page.getByRole('dialog', { name: 'Stop this work?' });
  await expect(dialog).toContainText('Scout is working on “Draft the launch email”');
  await expect(dialog.getByRole('radio', { name: /Go back/ })).toBeChecked();
  await dialog
    .getByLabel('Reason (optional, shown on the item)')
    .fill('Wrong brief, I will rewrite it first');
  await shot(page, 'stopwork-dialog');
  expect(await new AxeBuilder({ page }).include('[role=dialog]').analyze()).toMatchObject({
    violations: [],
  });
  await expectNoHorizontalScroll(page);
  await dialog.getByRole('button', { name: 'Stop work' }).click();
  await expect(dialog).toBeHidden();

  const banner = detail(page).getByTestId('onhold-banner');
  await expect(banner).toContainText('On hold: stopped by Ana Admin.');
  await expect(banner).toContainText('Wrong brief, I will rewrite it first');
  await expect(detail(page).getByRole('button', { name: 'Stop work' })).toHaveCount(0);
  await expect(detail(page).getByText('stopped by Ana Admin', { exact: true })).toBeVisible();
  await shot(page, 'stopwork-onhold');

  await expect
    .poll(async () => (await adminDoc(`${base}/runs/r1`))?.fields.status?.stringValue)
    .toBe('stopped');
  const run = await adminDoc(`${base}/runs/r1`);
  expect(run?.fields.endedAt?.timestampValue).toBeTruthy();
  const item = await adminDoc(`${base}/projects/blog/items/i1`);
  expect(item?.fields.claim?.nullValue).toBeNull();
  expect(item?.fields.status?.stringValue).toBe('queued');
  expect(item?.fields.workStopped?.mapValue.fields.mode.stringValue).toBe('back');
  // The agent's failure streak is untouched.
  expect((await adminDoc(`${base}/agents/scout`))?.fields.failStreak).toBeUndefined();

  // Activity, in the Agent runs group.
  await page.goto('/activity');
  await page
    .getByRole('group', { name: 'Filters' })
    .getByLabel('Type', { exact: true })
    .selectOption({ label: 'Agent runs' });
  await expect(
    page.getByText(
      'Ana Admin stopped the work on “Draft the launch email” and put it on hold: “Wrong brief, I will rewrite it first”',
    ),
  ).toBeVisible();

  // The board card says it is on hold.
  await page.goto('/p/blog');
  await expect(page.getByText('On hold', { exact: true }).first()).toBeVisible();

  await page.goto('/p/blog?item=i1');
  await detail(page).getByTestId('onhold-banner').getByRole('button', { name: 'Resume' }).click();
  await expect(detail(page).getByTestId('onhold-banner')).toHaveCount(0);
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.workStopped)
    .toEqual({ nullValue: null });
  await page.goto('/activity');
  await expect(
    page.getByText('Ana Admin resumed “Draft the launch email”', { exact: false }),
  ).toBeVisible();
});

test('Stop work, Cancel completely: the item is stopped for good', async ({ page }) => {
  const { base } = await seed(page);
  await page.goto('/p/blog?item=i1');
  await detail(page).getByRole('button', { name: 'Stop work' }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop this work?' });
  await dialog.getByRole('radio', { name: /Cancel completely/ }).click();
  await dialog.getByRole('button', { name: 'Stop work' }).click();
  await expect(detail(page).getByTestId('cancelled-banner')).toContainText(
    'Cancelled: work stopped by Ana Admin.',
  );
  await shot(page, 'stopwork-cancelled');
  await expect
    .poll(
      async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.status?.stringValue,
    )
    .toBe('stopped');
  expect((await adminDoc(`${base}/runs/r1`))?.fields.status?.stringValue).toBe('stopped');
});

test('a member who decides nowhere sees no Stop work; one who decides at a gate does', async ({
  page,
}) => {
  const { wid, uid } = await seed(page, 'Mo Member', 'somebody-else');
  // Make this person a plain member, on a project someone else created and decides on.
  const res = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}?updateMask.fieldPaths=memberRoles.%60${uid}%60`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: { memberRoles: { mapValue: { fields: { [uid]: { stringValue: 'member' } } } } },
      }),
    },
  );
  expect(res.ok, await res.text()).toBe(true);
  await adminSet(
    `workspaces/${wid}/projects/blog`,
    projectFields('Blog', 'somebody-else', ['somebody-else', uid]),
  );
  await page.goto('/p/blog?item=i1');
  await expect(detail(page).getByRole('heading', { name: 'Draft the launch email' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(detail(page).getByText('working now')).toBeVisible();
  await expect(detail(page).getByRole('button', { name: 'Stop work' })).toHaveCount(0);

  // Now they decide at the Review gate (any gate of the project counts, João Q23).
  const p = projectFields('Blog', 'somebody-else', ['somebody-else', uid]);
  p.steps[1]!.gate!.deciderUids = [uid];
  await adminSet(`workspaces/${wid}/projects/blog`, p);
  await expect(detail(page).getByRole('button', { name: 'Stop work' })).toBeVisible({
    timeout: 10_000,
  });
});

/**
 * Card Tfvq6A6g: the quick menu on a board card. A "..." button on desktop, a long press on
 * phones; the same Stop work dialog and rules as the item panel.
 */
test('board card quick menu: Stop work then Resume without opening the item', async ({ page }) => {
  const { base } = await seed(page);
  await page.goto('/p/blog');
  const phone = (page.viewportSize()?.width ?? 1440) < 640;
  const card = page.locator('button', {
    has: page.locator('h3', { hasText: 'Draft the launch email' }),
  });
  await expect(card).toBeVisible({ timeout: 15_000 });
  const menu = page.getByRole('menu', { name: 'Actions for Draft the launch email' });

  if (phone) {
    await expect(page.getByTestId('card-menu')).toHaveCount(0);
    // A tap still opens the item, a long press opens the menu instead.
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 300,
    });
    await page.waitForTimeout(1000);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, button: 0 });
  } else {
    const trigger = page.getByTestId('card-menu');
    await expect(trigger).toHaveAccessibleName('Actions for Draft the launch email');
    // Keyboard: focus the button, Enter opens, arrows move, Escape closes and returns focus.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(menu).toBeVisible();
    // Ask for status (item AzveC), Stop work, and Delete… (the admin made it): never Archive
    // while an agent holds it.
    await expect(menu.getByRole('menuitem')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
  }
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Resume' })).toHaveCount(0);
  await shot(page, 'cardmenu-open');
  expect(await new AxeBuilder({ page }).include('[role=menu]').analyze()).toMatchObject({
    violations: [],
  });
  await menu.getByRole('menuitem', { name: 'Stop work' }).click();

  const dialog = page.getByRole('dialog', { name: 'Stop this work?' });
  await expect(dialog).toContainText('Scout is working on “Draft the launch email”');
  await dialog.getByLabel('Reason (optional, shown on the item)').fill('From the board');
  await dialog.getByRole('button', { name: 'Stop work' }).click();
  await expect(dialog).toBeHidden();
  // The item panel was never opened.
  await expect(page).not.toHaveURL(/item=/);
  await expect(page.getByText('On hold', { exact: true }).first()).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${base}/runs/r1`))?.fields.status?.stringValue)
    .toBe('stopped');
  expect(
    (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.workStopped?.mapValue.fields.mode
      .stringValue,
  ).toBe('back');

  // On hold: the menu now offers Resume (and no Stop work).
  if (phone) {
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 300,
    });
    await page.waitForTimeout(1000);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, button: 0 });
  } else {
    await page.getByTestId('card-menu').click();
  }
  await expect(menu.getByRole('menuitem', { name: 'Stop work' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Resume' }).click();
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.workStopped)
    .toEqual({ nullValue: null });
  await expect(page.getByText('On hold', { exact: true })).toHaveCount(0);
});

test('board card quick menu: a member who decides nowhere gets only Ask for status', async ({
  page,
}) => {
  const { wid, uid } = await seed(page, 'Mo Member', 'somebody-else');
  await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}?updateMask.fieldPaths=memberRoles.%60${uid}%60`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: { memberRoles: { mapValue: { fields: { [uid]: { stringValue: 'member' } } } } },
      }),
    },
  );
  await adminSet(
    `workspaces/${wid}/projects/blog`,
    projectFields('Blog', 'somebody-else', ['somebody-else', uid]),
  );
  await page.goto('/p/blog');
  await expect(page.locator('h3', { hasText: 'Draft the launch email' }).first()).toBeVisible({
    timeout: 15_000,
  });
  // Any member may ask the agent for a status (item AzveC); Stop work stays with the deciders.
  const phone = (page.viewportSize()?.width ?? 1440) < 640;
  const card = page.locator('button', {
    has: page.locator('h3', { hasText: 'Draft the launch email' }),
  });
  if (phone) {
    await card.dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 300,
    });
    await page.waitForTimeout(1000);
    await card.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true, button: 0 });
  } else {
    await page.getByTestId('card-menu').click();
  }
  const menu = page.getByRole('menu', { name: 'Actions for Draft the launch email' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(1);
  await expect(menu.getByRole('menuitem', { name: 'Ask for status' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Stop work' })).toHaveCount(0);
});
