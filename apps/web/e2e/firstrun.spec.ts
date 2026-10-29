import { expect, test } from '@playwright/test';
import { person, signIn } from './helpers';

test('first run: checklist, project opens its board, idea typed in place', async ({ page }) => {
  await page.goto('/');
  await signIn(page, person('Firstrun'));
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });

  const list = page.getByRole('region', { name: 'Get started' });
  await expect(list).toBeVisible();
  // No agents yet: the empty copy does not talk about idle agents.
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
  await expect(page.getByText(/Agents are idle/)).toHaveCount(0);

  // Step 1 asks what the agents will work on: a template makes the project with its process,
  // then Connect Claude Code opens (item EJ2Cxq4k).
  await expect(list.getByText('What will your agents work on?').first()).toBeVisible();
  await list.getByRole('radio', { name: /Content pipeline/ }).click();
  await list.getByLabel('Project name').fill('Launch');
  await list.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/connect$/);
  await expect(page.getByLabel('Connect command', { exact: true })).toHaveText(
    /^curl -fsSL https?:\/\/[^ ]+\/install\.sh \| sh$/,
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'Waiting for your terminal' }),
  ).toBeVisible();

  // The board says where ideas land and links to Connect a terminal.
  await page.goto('/projects');
  await page
    .getByRole('link', { name: /Launch/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/p\//);
  const empty = page.getByTestId('empty-board');
  await expect(empty).toBeVisible();
  await expect(empty.getByText(/Ideas you add land in/)).toBeVisible();
  await expect(empty.getByRole('link', { name: 'Connect a terminal' })).toBeVisible();

  await page.goto('/');
  const list2 = page.getByRole('region', { name: 'Get started' });
  await expect(list2.locator('li[data-done="true"]')).toHaveCount(1);
  await list2.getByLabel(/Idea for Launch/).fill('Write the pitch');
  await list2.getByRole('button', { name: 'Add idea' }).click();
  await expect(list2.locator('li[data-done="true"]')).toHaveCount(2);

  await list2.getByRole('button', { name: 'Dismiss the checklist' }).click();
  await expect(page.getByRole('region', { name: 'Get started' })).toHaveCount(0);
  // The dismissal is stored with the person, not in this browser: no local key is involved.
  await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => k.startsWith('hive.firstrun'))
      .forEach((k) => localStorage.removeItem(k)),
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: 'Get started' })).toHaveCount(0);

  // The Connect guide's install command wraps instead of scrolling sideways.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/agents/connect');
  const cmd = page.getByRole('main').locator('code[aria-label]').first();
  await expect(cmd).toBeVisible();
  expect(await cmd.evaluate((n) => n.scrollWidth <= n.clientWidth)).toBe(true);
});
