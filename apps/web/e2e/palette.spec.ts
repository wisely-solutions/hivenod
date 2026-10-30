import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminSet, person, settle, signIn, uidOf, workspaceOf } from './helpers';

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
  // Enter picks the first row: wait until the row for this query is the one shown (the palette's
  // items and agents arrive from live listeners; under load Enter could run an empty list).
  await expect(page.getByRole('option').first()).toContainText(new RegExp(query, 'i'));
  await page.keyboard.press('Enter');
}

test('New thread and Connect an agent open their real screens; no project commands', async ({
  page,
}) => {
  mkdirSync(SHOTS, { recursive: true });
  await enter(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
    await runCommand(page, 'new thread');
    const dlg = page.getByRole('dialog', { name: 'New thread' });
    await expect(dlg).toBeVisible();
    await settle(page);
    await page.screenshot({
      path: `${SHOTS}/palette-thread-${test.info().project.name}-${theme}.png`,
    });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(page).toHaveURL(/\/inbox$/);
    // Projects were removed (OE8Fm slice 10): the palette offers nothing about them.
    if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
    else await page.keyboard.press('Control+K');
    await page.getByPlaceholder(/Jump to/).fill('project');
    await expect(page.getByRole('option')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
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
    await expect(page).toHaveURL(/\/inbox$/);
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
    await expect(sheet.getByRole('listitem').filter({ hasText: 'New thread' })).toContainText('C');
    await expect(sheet.getByRole('listitem').filter({ hasText: 'Next item' })).toContainText('J');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/palette-sheet-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  }
});

// Card WGERdupU: palette follow-ups.
test('an agent row highlights the agent, Back never reopens a dialog', async ({ page }) => {
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
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Good \w+, Pat/ })).toBeVisible();

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
  for (const k of ['e', 'a', 'e', 'a']) {
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
