import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminDoc, adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

// Card O2Ehb9CG: find and act on many (palette ranking, list filters, selection, bulk bar).

const SHOTS = process.env.SHOT_DIR ?? '/tmp';
const rand = () => Math.random().toString(36).slice(2, 8);
const isPhone = () => test.info().project.name !== 'desktop-1440';

async function seed(page: Page) {
  const owner = person('Bea Bulk');
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `bk${rand()}`;
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Customer portal', uid));
  const base = {
    type: 'idea',
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
    updatedAt: new Date(),
    lastEventId: 'seed',
  };
  const gate = { stepId: 'review', approvals: {}, rejections: {} };
  const items: Array<[string, Record<string, unknown>]> = [
    [
      'a',
      { title: 'Ticket assignment rules', stepId: 'review', status: 'waiting', gate, order: 1 },
    ],
    ['b', { title: 'Ticket sync', stepId: 'review', status: 'waiting', gate, order: 2 }],
    [
      'c',
      {
        title: 'Faster search',
        stepId: 'draft',
        status: 'queued',
        summary: 'Index every ticket body',
        type: 'bug',
        order: 3,
      },
    ],
    ['d', { title: 'Forge', stepId: 'draft', status: 'queued', order: 4 }],
  ];
  for (const [id, f] of items)
    await adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, { ...base, ...f });
  return { wid, pid };
}

async function palette(page: Page, q: string) {
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  const input = page.getByPlaceholder(/Jump to/);
  await expect(input).toBeVisible();
  await input.fill(q);
  return input;
}

test('the palette ranks exact and prefix first, matches descriptions, and opens the item', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible();
  await palette(page, 'faster');
  const opts = page.getByRole('option');
  await expect(opts).toHaveCount(1);
  await expect(opts.first()).toContainText('Faster search');
  await page.getByPlaceholder(/Jump to/).fill('body');
  await expect(opts).toHaveCount(1); // found by its description
  await expect(opts.first()).toContainText('Faster search');
  await page.getByPlaceholder(/Jump to/).fill('waiting on me');
  await expect(opts).toHaveCount(2);
  await page.getByPlaceholder(/Jump to/).fill('bug');
  await expect(opts.first()).toContainText('Faster search');
  await page.getByPlaceholder(/Jump to/).fill('ticket sync');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?.*item=b`));
});

test('filter, select, and act on several items at once', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}?view=list`);
  const rows = page.getByRole('row');
  await expect(page.getByText('4 of 4')).toBeVisible();
  // On a phone the filters sit behind one Filter button.
  if ((page.viewportSize()?.width ?? 1440) < 640)
    await page.getByRole('button', { name: 'Filter' }).click();

  // chips and description search
  await page.getByRole('button', { name: 'Waiting on me' }).click();
  await expect(page.getByText('2 of 4')).toBeVisible();
  await page.getByRole('button', { name: 'Waiting on me' }).click();
  await page.getByLabel('Find').fill('ticket body');
  await expect(page.getByText('1 of 4')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Type').selectOption('bug');
  await expect(page.getByText('1 of 4')).toBeVisible();
  await page.getByLabel('Type').selectOption('');

  if (!isPhone()) {
    // keyboard: x selects, Shift+x a range, Escape clears
    await page.getByRole('row', { name: /Ticket assignment/ }).hover();
    await page.keyboard.press('x');
    await expect(page.getByText('1 selected')).toBeVisible();
    await page.getByRole('row', { name: /Faster search/ }).hover();
    await page.keyboard.press('Shift+X');
    await expect(page.getByText('3 selected')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('toolbar')).toBeHidden();
  }

  // checkbox + Shift-click range
  await page.getByLabel('Select Ticket assignment rules').click();
  await page.getByLabel('Select Ticket sync').click({ modifiers: ['Shift'] });
  await expect(page.getByText('2 selected')).toBeVisible();
  await page.getByLabel('Select Faster search').click();
  await expect(page.getByText('3 selected')).toBeVisible();
  const bar = page.getByRole('toolbar');
  await expect(bar.getByRole('button', { name: 'Approve 2' })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({
      path: `${SHOTS}/bulk-list-${test.info().project.name}-${theme}.png`,
    });
  }

  // Approve (only where I decide): both gate items move on; Undo is offered first
  await bar.getByRole('button', { name: 'Approve 2' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}/items/a`))?.fields.status?.stringValue,
      { timeout: 15_000 },
    )
    .toBe('done');
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}/items/b`))?.fields.status?.stringValue,
    )
    .toBe('done');
  // the one not waiting on me was skipped, not changed
  expect(
    (await adminDoc(`workspaces/${wid}/projects/${pid}/items/c`))?.fields.stepId?.stringValue,
  ).toBe('draft');

  // Change type then Archive, with Undo cancelling the first archive
  await page.getByLabel('Select Forge').click();
  await bar.getByRole('button', { name: 'Change type' }).click();
  await page.getByRole('menuitem', { name: 'task' }).click();
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}/items/d`))?.fields.type?.stringValue,
      { timeout: 15_000 },
    )
    .toBe('task');
  await page.getByLabel('Select Forge').click();
  await bar.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(100);
  expect(
    (await adminDoc(`workspaces/${wid}/projects/${pid}/items/d`))?.fields.status?.stringValue,
  ).toBe('queued');
  await page.getByLabel('Select Forge').click();
  await bar.getByRole('button', { name: 'Archive' }).click();
  await expect(rows.filter({ hasText: 'Forge' })).toHaveCount(0, { timeout: 15_000 });
  expect(
    (await adminDoc(`workspaces/${wid}/projects/${pid}/items/d`))?.fields.status?.stringValue,
  ).toBe('stopped');
});

test('the all-items list spans projects and links from All projects', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto('/projects');
  await page.getByRole('link', { name: 'List all items' }).click();
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByRole('heading', { name: 'All items' })).toBeVisible();
  await expect(page.getByText('4 of 4')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Customer portal/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Ticket sync', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?.*item=b`));
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/items');
    await expect(page.getByText('4 of 4')).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/bulk-all-${test.info().project.name}-${theme}.png` });
  }
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible();
  await palette(page, 'faster');
  await page.screenshot({ path: `${SHOTS}/bulk-palette-${test.info().project.name}.png` });
});
