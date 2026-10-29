import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminSet, person, projectFields, settle, signIn, uidOf, workspaceOf } from './helpers';

// Card 2GAckUFf: every command in the palette does what it says; the sheet writes chords plainly.

const isPhone = () => test.info().project.name !== 'desktop-1440';
const SHOTS = process.env.SHOT_DIR ?? '/tmp';

async function enter(page: Page) {
  await page.goto('/');
  await signIn(page, person('Pat Palette'));
  await expect(page.getByRole('heading', { name: /^Good \w+, Pat/ })).toBeVisible({
    timeout: 20_000,
  });
}

async function runCommand(page: Page, query: string) {
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  const input = page.getByPlaceholder(/Jump to/);
  await expect(input).toBeVisible();
  await input.fill(query);
  await page.keyboard.press('Enter');
}

test('New project and Connect an agent open their real screens', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  await enter(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await runCommand(page, 'new project');
    await expect(page).toHaveURL(/\/projects/);
    const dlg = page.getByRole('dialog', { name: /New project/ });
    await expect(dlg).toBeVisible();
    await expect(page.getByText(/arrives with Build/)).toHaveCount(0);
    await settle(page);
    await page.screenshot({
      path: `${SHOTS}/palette-project-${test.info().project.name}-${theme}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).toHaveURL(/\/projects$/);
    await settle(page);

    await runCommand(page, 'connect an agent');
    await expect(page).toHaveURL(/\/agents\/connect$/);
    const connect = page.getByRole('main');
    await expect(connect.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
    await expect(connect).toBeVisible();
    await expect(connect.getByText(/Install the Hivenod CLI/)).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: `${SHOTS}/palette-agent-${test.info().project.name}-${theme}.png`,
    });
    await page.goBack();
    await expect(page).toHaveURL(/\/projects$/);
    await settle(page);
  }
});

test('the shortcut sheet lists C and writes the palette chord with a plus', async ({ page }) => {
  test.skip(isPhone(), 'needs a keyboard');
  mkdirSync(SHOTS, { recursive: true });
  await enter(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.keyboard.press('?');
    const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('⌘/Ctrl + K')).toBeVisible();
    await expect(sheet.getByText('then K')).toHaveCount(0);
    await expect(sheet.getByRole('listitem').filter({ hasText: 'Add an item' })).toContainText('C');
    await expect(sheet.getByRole('listitem').filter({ hasText: 'Next item' })).toContainText('J');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/palette-sheet-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
});

// Card WGERdupU: palette follow-ups.
test('an item row opens the item, an agent row highlights the agent, Back never reopens a dialog', async ({
  page,
}) => {
  const owner = person('Pat Palette');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Good \w+, Pat/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`${base}/agents/scout`, {
    name: 'Scoutbot',
    color: 'agent-3',
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(Date.now() - 1e6),
    revokedAt: null,
    lastSeenAt: new Date(),
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, {
    title: 'Palette target item',
    type: 'task',
    stepId: 'draft',
    status: 'queued',
    summary: 'Opened from the palette.',
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
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good \w+, Pat/ })).toBeVisible();
  await page.waitForTimeout(500);

  await runCommand(page, 'Palette target');
  await expect(page).toHaveURL(/\/p\/blog\?item=i1/);
  await expect(page.getByRole('article', { name: /Palette target item/ })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good \w+, Pat/ })).toBeVisible();
  await page.waitForTimeout(500);

  await runCommand(page, 'Scoutbot');
  await expect(page).toHaveURL(/\/agents\?agent=scout/);
  await expect(page.getByRole('listitem', { name: 'Scoutbot' })).toHaveAttribute(
    'aria-current',
    'true',
  );

  // Connect is a page now: Back from it lands on the page before it, with no dialog.
  await runCommand(page, 'connect an agent');
  await expect(page).toHaveURL(/\/agents\/connect$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(page).not.toHaveURL(/connect/);
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('no uncaught transition error while navigating fast, and Esc reads the same everywhere', async ({
  page,
}) => {
  test.skip(isPhone(), 'needs a keyboard');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await enter(page);
  for (const k of ['p', 'a', 'p', 'a']) {
    await page.keyboard.press('g');
    await page.keyboard.press(k);
  }
  await page.keyboard.press('Control+K');
  await page.keyboard.press('Escape');
  await page.goto('/inbox');
  await page.waitForTimeout(2000);
  await page.keyboard.press('?');
  const sheet = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Escape', { exact: true })).toHaveCount(0);
  expect(errors.filter((m) => /Transition was skipped/.test(m))).toEqual([]);
});
