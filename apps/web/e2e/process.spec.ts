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

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page, name = 'João') {
  const owner = person(name);
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
  const pid = `proc${rand()}`;
  // A project with Draft (agent), Review (gate) and Publish (agent), and a group of three.
  const base = projectFields('Blog', uid);
  const fields = {
    ...base,
    steps: [
      base.steps[0]!,
      base.steps[1]!,
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  };
  await adminSet(`workspaces/${wid}/projects/${pid}`, fields);
  await adminSet(`workspaces/${wid}/groups/g${pid}`, {
    name: 'Product',
    memberUids: [uid, `x1${pid}`, `x2${pid}`],
    lastEventId: 'seed',
  });
  return { owner, wid, uid, pid };
}

async function addItems(wid: string, pid: string, uid: string, stepId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await adminSet(`workspaces/${wid}/projects/${pid}/items/it${stepId}${i}`, {
      title: `Item ${i}`,
      type: 'idea',
      stepId,
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
      order: i,
      updatedAt: new Date(),
      lastEventId: 'seed',
    });
  }
}

const stepIds = async (wid: string, pid: string) => {
  const d = await adminDoc(`workspaces/${wid}/projects/${pid}`);
  return (
    d!.fields.steps!.arrayValue.values as Array<{
      mapValue: { fields: Record<string, { stringValue: string }> };
    }>
  ).map((v) => v.mapValue.fields.id!.stringValue as string);
};

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** On phones the editor is a sheet: close it so the page behind is reachable again. */
async function closeSheet(page: Page) {
  const done = page.getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible()) await done.click();
  await expect(done).toHaveCount(0);
}

async function openStep(page: Page, name: string) {
  await page.getByRole('button', { name: `Edit ${name}` }).click();
}

test('Who decides: "2 of Product, João must be one" reads like the design, and saves', async ({
  page,
}) => {
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  await expect(page.getByRole('heading', { name: 'Process' })).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.getByRole('tab', { name: 'Who decides' }).click();
  const points = page.getByRole('list', { name: 'Decision points' });
  await expect(points).toContainText('Review');
  await expect(points).toContainText('João decides.');
  await points.getByRole('button', { name: /Review/ }).click();

  await page.getByRole('button', { name: 'Add person or group' }).click();
  const picker = page.getByRole('dialog', { name: 'Who can decide' });
  await picker.getByRole('checkbox', { name: 'Product' }).click();
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toHaveCount(0);

  await page.getByRole('radio', { name: /At least/ }).click();
  const more = page.getByRole('button', { name: 'More approvals' });
  await more.click();
  await page.getByRole('switch', { name: 'João must be one of them' }).click();

  const words = page.getByTestId('plain-words');
  await expect(words).toHaveText(
    /^At least 2 of Product \(3 people\) must approve, and João must be one of them\. One rejection sends it back\./,
  );
  await closeSheet(page);
  // The overview list follows live.
  await expect(points).toContainText(
    'At least 2 of Product (3 people) must approve, and João must be one of them.',
  );

  await points.getByRole('button', { name: /Review/ }).click();
  await page.getByRole('radio', { name: /Only if most reject/ }).click();
  await expect(words).toContainText('It goes back only if most of them reject.');
  await expect(words).not.toContainText('One rejection');
  await closeSheet(page);
  await expect(points).toContainText('It goes back only if most of them reject.');

  await axe(page);
  await page.getByRole('button', { name: 'Save process' }).click();
  await expect(page.getByText('Process saved.')).toBeVisible();

  const saved = await adminDoc(`workspaces/${wid}/projects/${pid}`);
  const text = JSON.stringify(saved!.fields.steps);
  expect(text).toContain('atLeast');
  expect(text).toContain('majority');
  // A reload shows the same sentence from the stored data.
  await page.reload();
  await page.getByRole('tab', { name: 'Who decides' }).click();
  await expect(page.getByRole('list', { name: 'Decision points' })).toContainText(
    'At least 2 of Product (3 people) must approve, and João must be one of them.',
  );
});

test('a gate without deciders cannot be saved', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  await openStep(page, 'Review');
  await page.getByRole('button', { name: /^Remove João/ }).click();
  await expect(page.getByTestId('plain-words')).toHaveText(/Nobody is chosen yet/);
  await closeSheet(page);
  const bar = page.getByRole('region', { name: 'Unsaved changes' });
  await expect(bar).toContainText('Review needs someone to decide.');
  // At tablet width the bar starts right of the left rail (the rail stays clickable).
  const vp = page.viewportSize();
  const rail = await page.locator('aside, nav').first().boundingBox();
  const b0 = await bar.boundingBox();
  if (vp && vp.width >= 640 && rail && b0)
    expect(b0.x).toBeGreaterThanOrEqual(rail.x + rail.width - 1);
  const spacer = await page.getByTestId('save-bar-spacer').boundingBox();
  const barBox = await bar.boundingBox();
  expect(spacer && barBox && spacer.height).toBeGreaterThan(barBox?.height ?? Infinity);
  await expect(bar.getByRole('button', { name: 'Save process' })).toBeDisabled();
  await bar.getByRole('button', { name: 'Discard' }).click();
  await expect(bar).toHaveCount(0);
});

test('reorder with the keyboard, add a step, and save', async ({ page }) => {
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  const list = page.getByRole('list', { name: 'Steps' });
  await expect(list.getByRole('listitem')).toHaveCount(3);

  const handle = page.getByRole('button', { name: /^Reorder Draft/ });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(250);
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(
    /step \d, \w.* is over step \d/,
  );
  await page.keyboard.press('Space');
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(/Dropped step \d, Draft/);
  await expect(page.locator('[id^="DndLiveRegion"]')).not.toContainText(/droppable|Draggable/);
  await expect(list.getByRole('listitem').nth(1)).toContainText('Draft');
  await expect(list.getByRole('listitem').nth(1).getByText('You decide')).toHaveCount(0);
  await expect(list.getByRole('listitem').nth(0)).toContainText('You decide');

  await page.getByRole('button', { name: 'Add agent step' }).click();
  const name = page.getByLabel('Name');
  await name.fill('Proofread');
  await page.getByLabel('Description').fill('Checks the spelling');
  await page.getByRole('button', { name: 'HTML' }).click();
  await page.getByRole('tab', { name: 'preview' }).click();
  await expect(page.getByLabel('Instructions preview')).toContainText('Nothing to preview yet.');
  await axe(page);
  await closeSheet(page);

  await page.getByRole('button', { name: 'Save process' }).click();
  await expect(page.getByText('Process saved.')).toBeVisible();
  const ids = await stepIds(wid, pid);
  expect(ids.slice(0, 3)).toEqual(['review', 'draft', 'publish']);
  expect(ids).toHaveLength(4);
  await expect(list.getByRole('listitem').nth(3)).toContainText('Proofread');
});

test('a step that still holds items cannot be deleted without moving them', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await addItems(wid, pid, uid, 'publish', 3);
  await page.goto(`/p/${pid}/process`);
  await openStep(page, 'Publish');
  await page.getByRole('button', { name: 'Delete step' }).click();

  const dialog = page.getByRole('dialog', { name: 'Move 3 items to…' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Move to').selectOption({ label: 'Draft' });
  await dialog.getByRole('button', { name: 'Move 3 and delete step' }).click();
  await expect(page.getByRole('region', { name: 'Removed steps' })).toContainText(
    '3 items move to Draft',
  );
  await page.getByRole('button', { name: 'Save process' }).click();
  await expect(page.getByText('Process saved.')).toBeVisible();

  expect(await stepIds(wid, pid)).toEqual(['draft', 'review']);
  for (let i = 0; i < 3; i++) {
    const it = await adminDoc(`workspaces/${wid}/projects/${pid}/items/itpublish${i}`);
    expect(it!.fields.stepId!.stringValue).toBe('draft');
  }
  // The save is on record, with a diff.
  const events = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/events?pageSize=200`,
    { headers: { Authorization: 'Bearer owner' } },
  ).then(
    (r) =>
      r.json() as Promise<{
        documents: Array<{ fields: Record<string, { stringValue?: string }> }>;
      }>,
  );
  const changed = events.documents.filter(
    (d) =>
      d.fields.type?.stringValue === 'project.processChanged' && JSON.stringify(d).includes('diff'),
  );
  expect(changed.length).toBeGreaterThan(0);
  expect(events.documents.filter((d) => d.fields.type?.stringValue === 'item.moved')).toHaveLength(
    3,
  );
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { wid, uid, pid } = await seed(page, 'João');
  await addItems(wid, pid, uid, 'draft', 2);
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const width = info.project.use.viewport?.width ?? 375;
  const size = width >= 1000 ? '1440' : '375';
  if (size === '1440') await page.setViewportSize({ width: 1440, height: 1700 });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${pid}/process`);
    await page.waitForTimeout(500);
    if (size === '1440') await openStep(page, 'Draft');
    await page.screenshot({ path: `${dir}/steps-${size}-${theme}.png`, fullPage: size === '375' });
    await page.getByRole('tab', { name: 'Who decides' }).click();
    await page.getByRole('list', { name: 'Decision points' }).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Add person or group' }).click();
    const picker = page.getByRole('dialog', { name: 'Who can decide' });
    await picker.getByRole('checkbox', { name: 'Product' }).click();
    await picker.getByRole('button', { name: 'Done' }).click();
    await page.getByRole('radio', { name: /At least/ }).click();
    await page.getByRole('button', { name: 'More approvals' }).click();
    await page.getByRole('switch', { name: 'João must be one of them' }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${dir}/who-decides-${size}-${theme}.png` });
    await page.getByTestId('plain-words').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${dir}/who-decides-${size}-${theme}-plain-words.png` });
  }
});

test('a plain member sees "Who decides" read-only and cannot change it', async ({ page }, info) => {
  const { owner, wid, uid, pid } = await seed(page);
  // Make this person a plain member of an organization whose project someone else created.
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
    `workspaces/${wid}/projects/${pid}`,
    projectFields('Blog', 'somebody-else', ['somebody-else', uid]),
  );
  await page.goto(`/p/${pid}/process`);
  await expect(page.getByRole('heading', { name: 'Process' })).toBeVisible();
  void owner;

  await page.getByRole('tab', { name: 'Who decides' }).click();
  await page.getByRole('list', { name: 'Decision points' }).getByRole('button').first().click();
  await expect(page.getByRole('note')).toContainText('Only an admin, the project creator');
  await expect(page.getByRole('button', { name: 'Add person or group' })).toBeDisabled();
  const dir = process.env.SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: `${dir}/member-locked-${info.project.name}.png` });
  }
});

test('typing into an empty Instructions box and clearing it leaves no unsaved changes (card Oa98iQch)', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  await expect(page.getByRole('heading', { name: 'Process' })).toBeVisible();
  await page
    .getByRole('list', { name: 'Steps' })
    .getByRole('button', { name: 'Edit Publish' })
    .click();
  const box = page.getByLabel('Instructions', { exact: true });
  await box.fill('Ship it on Friday');
  await expect(page.getByText('You have unsaved changes to this process.')).toBeVisible();
  await box.fill('');
  await expect(page.getByText('You have unsaved changes to this process.')).toHaveCount(0);
});

test('arrow keys move between the Process tabs (roving tabindex, ARIA tabs pattern; card 1wVfp4Nz)', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  const steps = page.getByRole('tab', { name: 'Steps' });
  const gates = page.getByRole('tab', { name: 'Who decides' });
  await expect(steps).toHaveAttribute('tabindex', '0');
  await expect(gates).toHaveAttribute('tabindex', '-1');
  await steps.focus();
  await page.keyboard.press('ArrowRight');
  await expect(gates).toBeFocused();
  await expect(gates).toHaveAttribute('aria-selected', 'true');
  await expect(gates).toHaveAttribute('tabindex', '0');
  await expect(steps).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Home');
  await expect(steps).toBeFocused();
  await expect(steps).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(gates).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(steps).toBeFocused();
});
