/**
 * Card rHjaDFEK: Archive and Delete… from the card menu, the List row menu and the item panel.
 * Archive leaves the board at once with an Undo, survives a reload and restores from List >
 * Archived. Delete… asks first, erases the item with its notes, files and runs, and Activity keeps
 * one line. A working item must be stopped first; other members see neither. The rules side is in
 * packages/shared/rules/erase.test.ts.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  fastTimers,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  UNDO_WAIT,
} from './helpers';

// PHONE=1 runs the whole file at 390 wide (for the 390 screenshots).
if (process.env.PHONE) test.use({ viewport: { width: 390, height: 844 } });
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!.width <= 500 ? '390' : '1440';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png` });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

const item = (uid: string, title: string, over: Record<string, unknown> = {}) => ({
  title,
  type: 'task',
  stepId: 'draft',
  status: 'queued',
  summary: '',
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: null,
  triage: null,
  sendBackCount: 0,
  costEur: 0,
  order: 1,
  updatedAt: new Date(),
  lastEventId: 'seed',
  ...over,
});

async function seed(page: Page, name = 'Ana Admin') {
  const owner = person(name);
  await fastTimers(page);
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
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: new Date(),
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, item(uid, 'Plan the launch', { order: 1 }));
  await adminSet(`${base}/projects/blog/items/i2`, item(uid, 'Write the FAQ', { order: 2 }));
  await adminSet(
    `${base}/projects/blog/items/i3`,
    item(uid, 'Scout is on this', {
      order: 3,
      status: 'working',
      claim: { runId: 'r3', agentUid: 'scout', heartbeatAt: new Date() },
    }),
  );
  // History of i2: a note, a file and two runs, to be erased with it.
  await adminSet(`${base}/projects/blog/items/i2/messages/m1`, {
    workspaceId: wid,
    projectId: 'blog',
    itemId: 'i2',
    by: { type: 'human', id: uid },
    kind: 'note',
    text: 'Keep it short',
    at: new Date(),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i2/attachments/a1`, {
    kind: 'text',
    name: 'faq.txt',
    content: 'Q and A',
    url: null,
    bytes: 7,
    runId: null,
    by: { type: 'human', id: uid },
    at: new Date(),
    lastEventId: 'seed',
  });
  for (const [rid, itemId] of [
    ['r2', 'i2'],
    ['r2b', 'i2'],
    ['r1', 'i1'],
  ] as const)
    await adminSet(`${base}/runs/${rid}`, {
      agentUid: 'scout',
      projectId: 'blog',
      itemId,
      stepId: 'draft',
      startedAt: new Date(Date.now() - 600_000),
      heartbeatAt: new Date(Date.now() - 500_000),
      heartbeatEventAt: new Date(Date.now() - 600_000),
      endedAt: new Date(Date.now() - 500_000),
      status: 'done',
      costEur: 0.1,
      tokensIn: 1,
      tokensOut: 1,
      model: null,
      summary: null,
      lastEventId: 'seed',
    });
  return { wid, uid, base };
}

const card = (page: Page, title: string) => page.locator('h3', { hasText: title }).first();
const menuOf = (page: Page, title: string) =>
  page.getByRole('menu', { name: `Actions for ${title}` });
async function openCardMenu(page: Page, title: string) {
  if (page.viewportSize()!.width <= 500) {
    // A long press (the "..." button is for pointers).
    await card(page, title).dispatchEvent('pointerdown', {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 300,
    });
    await page.waitForTimeout(1000);
    await card(page, title).dispatchEvent('pointerup', {
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
    });
  } else {
    await page
      .getByRole('button', { name: `Actions for ${title}` })
      .first()
      .click();
  }
  await expect(menuOf(page, title)).toBeVisible();
}

test('Archive from the card menu: gone at once, Undo brings it back, survives a reload, restores from the list', async ({
  page,
}) => {
  const { base } = await seed(page);
  await page.goto('/p/blog');
  await expect(card(page, 'Plan the launch')).toBeVisible({ timeout: 15_000 });

  await openCardMenu(page, 'Plan the launch');
  await expect(menuOf(page, 'Plan the launch').getByRole('menuitem')).toHaveText([
    'Archive',
    'Delete…',
  ]);
  await shot(page, 'itemactions-card-menu');
  await menuOf(page, 'Plan the launch').getByRole('menuitem', { name: 'Archive' }).click();
  await expect(card(page, 'Plan the launch')).toHaveCount(0);
  await expect(page.getByText('Plan the launch archived.')).toBeVisible();
  await shot(page, 'itemactions-archived-toast');

  // Undo: it is back and nothing was written.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(card(page, 'Plan the launch')).toBeVisible();
  await page.waitForTimeout(UNDO_WAIT);
  expect((await adminDoc(`${base}/projects/blog/items/i1`))?.fields.status?.stringValue).toBe(
    'queued',
  );

  // Archive and reload at once: the write is replayed on load.
  await openCardMenu(page, 'Plan the launch');
  await menuOf(page, 'Plan the launch').getByRole('menuitem', { name: 'Archive' }).click();
  await page.reload();
  await expect
    .poll(
      async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.status?.stringValue,
      {
        timeout: 15_000,
      },
    )
    .toBe('stopped');
  await expect(card(page, 'Plan the launch')).toHaveCount(0);
});

test('Archived list: the row menu restores or deletes', async ({ page }) => {
  const { base, uid } = await seed(page);
  await adminSet(
    `${base}/projects/blog/items/i1`,
    item(uid, 'Plan the launch', { status: 'stopped', archivedAt: new Date() }),
  );
  await page.goto('/p/blog?view=list');
  if (page.viewportSize()!.width <= 500) await page.getByRole('button', { name: /Filter/ }).click();
  await page.getByLabel('Show', { exact: true }).selectOption('archived');
  const row = page.getByRole('row', { name: /Plan the launch/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await shot(page, 'itemactions-archived-list');
  await row.getByRole('button', { name: 'Actions for Plan the launch' }).click();
  await expect(menuOf(page, 'Plan the launch').getByRole('menuitem')).toHaveText([
    'Restore',
    'Delete…',
  ]);
  await menuOf(page, 'Plan the launch').getByRole('menuitem', { name: 'Restore' }).click();
  await expect
    .poll(
      async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.status?.stringValue,
      {
        timeout: 15_000,
      },
    )
    .toBe('queued');
});

test('Delete…: confirm, erases the item with its notes, files and runs, one Activity line stays', async ({
  page,
}) => {
  const { base, wid } = await seed(page);
  await page.goto('/p/blog');
  await expect(card(page, 'Write the FAQ')).toBeVisible({ timeout: 15_000 });
  await openCardMenu(page, 'Write the FAQ');
  await menuOf(page, 'Write the FAQ').getByRole('menuitem', { name: 'Delete…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Delete this item?' });
  await expect(dialog).toContainText('Delete “Write the FAQ” and its history for good?');
  await shot(page, 'itemactions-confirm');
  expect(await new AxeBuilder({ page }).include('[role=dialog]').analyze()).toMatchObject({
    violations: [],
  });
  // Keep it: nothing happens.
  await dialog.getByRole('button', { name: 'Keep it' }).click();
  await expect(dialog).toBeHidden();
  expect(await adminDoc(`${base}/projects/blog/items/i2`)).not.toBeNull();

  await openCardMenu(page, 'Write the FAQ');
  await menuOf(page, 'Write the FAQ').getByRole('menuitem', { name: 'Delete…' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card(page, 'Write the FAQ')).toHaveCount(0);
  await expect.poll(() => adminDoc(`${base}/projects/blog/items/i2`)).toBeNull();
  expect(await adminDoc(`${base}/projects/blog/items/i2/messages/m1`)).toBeNull();
  expect(await adminDoc(`${base}/projects/blog/items/i2/attachments/a1`)).toBeNull();
  expect(await adminDoc(`${base}/runs/r2`)).toBeNull();
  expect(await adminDoc(`${base}/runs/r2b`)).toBeNull();
  // The other item's run stays.
  expect(await adminDoc(`${base}/runs/r1`)).not.toBeNull();
  const tomb = await adminDoc(`workspaces/${wid}/events/del-items-i2`);
  expect(tomb?.fields.type?.stringValue).toBe('item.deleted');

  await page.goto('/activity');
  const line = page.getByText('deleted “Write the FAQ”');
  await expect(line).toBeVisible({ timeout: 15_000 });
  await shot(page, 'itemactions-activity');
});

test('an item an agent is working on must be stopped first', async ({ page }) => {
  const { base } = await seed(page);
  await page.goto('/p/blog');
  await openCardMenu(page, 'Scout is on this');
  const menu = menuOf(page, 'Scout is on this');
  await expect(menu.getByRole('menuitem', { name: 'Archive' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByText(/Stop work first/)).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Delete this item?' })).toHaveCount(0);
  expect(await adminDoc(`${base}/projects/blog/items/i3`)).not.toBeNull();
});

test('the item panel has the same Archive and Delete…', async ({ page }) => {
  test.skip(page.viewportSize()!.width <= 500, 'the panel is full screen on phones: same menu');
  const { base } = await seed(page);
  await page.goto('/p/blog?item=i1');
  const panel = page.locator('[aria-label="Item detail"]:visible');
  await panel.getByRole('button', { name: 'Actions for Plan the launch' }).click();
  await shot(page, 'itemactions-panel-menu');
  await menuOf(page, 'Plan the launch').getByRole('menuitem', { name: 'Archive' }).click();
  await expect(page.getByText('Plan the launch archived.')).toBeVisible();
  await expect
    .poll(
      async () => (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.status?.stringValue,
      {
        timeout: 15_000,
      },
    )
    .toBe('stopped');
});

test('phone width: the menu and the confirm fit, no horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  await page.goto('/p/blog?view=list');
  await expect(page.getByRole('row', { name: /Write the FAQ/ })).toBeVisible({ timeout: 15_000 });
  await shot(page, 'itemactions-list');
  await page
    .getByRole('row', { name: /Write the FAQ/ })
    .getByRole('button', { name: 'Actions for Write the FAQ' })
    .click();
  await shot(page, 'itemactions-list-menu');
  await menuOf(page, 'Write the FAQ').getByRole('menuitem', { name: 'Delete…' }).click();
  await expect(page.getByRole('dialog', { name: 'Delete this item?' })).toBeVisible();
  await shot(page, 'itemactions-confirm');
  expect(await new AxeBuilder({ page }).include('[role=dialog]').analyze()).toMatchObject({
    violations: [],
  });
  await expectNoHorizontalScroll(page);
});

test('a member who did not create the item sees no Archive or Delete…', async ({ page }) => {
  const { wid, uid } = await seed(page, 'Mo Member');
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
  await adminSet(
    `workspaces/${wid}/projects/blog/items/i1`,
    item('somebody-else', 'Plan the launch'),
  );
  await page.goto('/p/blog');
  await expect(card(page, 'Plan the launch')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Actions for Plan the launch' })).toHaveCount(0);
});
