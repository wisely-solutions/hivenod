import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminDoc, adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

// Card CmlSKW2w: list polish (Done and Archived views, Esc after a checkbox click, Restore,
// shortcut sheet, palette type match).

const SHOTS = process.env.SHOT_DIR ?? '/tmp';
const rand = () => Math.random().toString(36).slice(2, 8);
const isPhone = () => test.info().project.name !== 'desktop-1440';

async function seed(page: Page) {
  const owner = person('Pia Polish');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `lp${rand()}`;
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
  const items: Array<[string, Record<string, unknown>]> = [
    ['a', { title: 'Open one', stepId: 'draft', status: 'queued', order: 1 }],
    ['b', { title: 'Bug triage notes', stepId: 'draft', status: 'queued', type: 'task', order: 2 }],
    ['c', { title: 'Login broken', stepId: 'draft', status: 'queued', type: 'bug', order: 3 }],
    ['d', { title: 'Shipped thing', stepId: 'review', status: 'done', order: 4 }],
    ['e', { title: 'Shipped other', stepId: 'review', status: 'done', order: 5 }],
    [
      'f',
      { title: 'Old idea', stepId: 'draft', status: 'stopped', archivedAt: new Date(), order: 6 },
    ],
  ];
  for (const [id, f] of items)
    await adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, { ...base, ...f });
  return { wid, pid, uid };
}

test('Done and Archived views, Esc after a checkbox, Restore, help sheet, palette type', async ({
  page,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}?view=list`);
  await expect(page.getByText('3 of 3')).toBeVisible();
  // On a phone the filters sit behind one Filter button.
  if ((page.viewportSize()?.width ?? 1440) < 640)
    await page.getByRole('button', { name: 'Filter' }).click();

  await page.getByLabel('Show', { exact: true }).selectOption('done');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect(page.getByText('Shipped thing')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/done-${test.info().project.name}-light.png` });

  await page.getByLabel('Show', { exact: true }).selectOption('archived');
  await expect(page.getByText('1 of 1')).toBeVisible();

  // Esc clears with focus still on the checkbox
  await page.getByLabel('Select Old idea').click();
  await expect(page.getByText('1 selected')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar')).toBeHidden();

  await page.getByLabel('Select Old idea').click();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: `${SHOTS}/archived-${test.info().project.name}-${theme}.png` });
  }
  await page.getByRole('button', { name: 'Restore 1' }).click();
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}/items/f`))?.fields.status?.stringValue,
      { timeout: 15_000 },
    )
    .toBe('queued');

  // help sheet
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText('Select the highlighted row')).toBeVisible();
  await expect(sheet.getByText('Highlight the next row')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/sheet-${test.info().project.name}-dark.png` });
  await page.keyboard.press('Escape');

  // palette: type match first, with its reason
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Jump to/).fill('bug');
  const opts = page.getByRole('option');
  await expect(opts.first()).toContainText('Login broken');
  await expect(opts.first()).toContainText('type: bug');
  await expect(opts.nth(1)).toContainText('Bug triage notes');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${SHOTS}/palette-${test.info().project.name}-light.png` });
});

// Card lvPPSnV2: an item rejected at a gate ("Stop: archive") has no archive date, yet it is
// listed under Archived and can be restored from there.
test('rejected items are listed under Archived and restore', async ({ page }) => {
  const SHOT = process.env.SHOT_DIR ?? '/tmp';
  mkdirSync(SHOT, { recursive: true });
  const { wid, pid, uid } = await seed(page);
  await adminSet(`workspaces/${wid}/projects/${pid}/items/g`, {
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
    title: 'Rejected idea',
    stepId: 'draft',
    status: 'stopped',
    order: 7,
  });
  await page.goto(`/p/${pid}?view=list`);
  if ((page.viewportSize()?.width ?? 1440) < 640)
    await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByLabel('Show', { exact: true }).selectOption('archived');
  await expect(page.getByText('2 of 2')).toBeVisible();
  await expect(page.getByText('Rejected idea')).toBeVisible();
  await page.screenshot({ path: `${SHOT}/archived-rejected-${test.info().project.name}.png` });
  await page.getByLabel('Select Rejected idea').click();
  await page.getByRole('button', { name: 'Restore 1' }).click();
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}/items/g`))?.fields.status?.stringValue,
      { timeout: 15_000 },
    )
    .toBe('queued');
});

// Card 2hTONQHM: the bulk bar never covers the last row, the palette points at done/archived
// items, and clicking a checkbox moves the highlight.
test('last row clears the bulk bar, palette finds done items, checkbox moves highlight', async ({
  page,
}) => {
  const SHOT = process.env.SHOT_DIR ?? '/tmp';
  mkdirSync(SHOT, { recursive: true });
  const { wid, pid } = await seed(page);
  for (let i = 0; i < 16; i++)
    await adminSet(`workspaces/${wid}/projects/${pid}/items/z${i}`, {
      type: 'idea',
      summary: '',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: 'x' },
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
      title: `Filler ${String(i).padStart(2, '0')}`,
      stepId: 'draft',
      status: 'queued',
      order: 10 + i,
    });
  await page.goto(`/p/${pid}?view=list`);
  await expect(page.getByText('19 of 19')).toBeVisible();

  // clicking a checkbox moves the highlight to that row, and `x` acts on it
  const boxes = page.getByRole('checkbox', { name: /^Select (?!all)/ });
  await boxes.nth(4).click();
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(1);
  await expect(page.locator('tr.shadow-\\[inset_2px_0_0_var\\(--color-ink\\)\\]')).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');

  // last row stays visible above the bar at max scroll
  await boxes.last().scrollIntoViewIfNeeded();
  await boxes.last().click();
  await boxes.nth(0).click();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const bar = page.getByRole('toolbar');
  await expect(bar).toBeVisible();
  const last = await page.locator('tbody tr').last().boundingBox();
  const barBox = await bar.boundingBox();
  expect(last && barBox && last.y + last.height <= barBox.y + 1).toBe(true);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.screenshot({ path: `${SHOT}/bulkbar-${test.info().project.name}-${theme}.png` });
  }
  await page.keyboard.press('Escape');

  // palette: done / stopped / archived point at where those items live
  for (const q of ['done', 'stopped', 'archived']) {
    if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
    else await page.keyboard.press('Control+K');
    await page.getByPlaceholder(/Jump to/).fill(q);
    await expect(page.getByRole('option').first()).toContainText('Done, stopped and archived');
    if (q === 'done') {
      for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.screenshot({
          path: `${SHOT}/palette-done-${test.info().project.name}-${theme}.png`,
        });
      }
    }
    await page.keyboard.press('Escape');
  }
});
