import { expect, test, type Page } from '@playwright/test';
import { person, signIn } from './helpers';

// Hive is now Hivenod (card wQ7ZfmYr): no screen may still say "Hive", in its text, its tab title
// or its accessible names. scripts/rename-check.test.mjs checks the sources the same way.
const OLD = /\bHive\b|\bhive (?=[a-z<-])/;

async function oldNameOn(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src);
    const found: string[] = [];
    if (re.test(document.title)) found.push(`title: ${document.title}`);
    if (re.test(document.body.innerText)) {
      for (const line of document.body.innerText.split('\n'))
        if (re.test(line)) found.push(`text: ${line}`);
    }
    for (const el of document.querySelectorAll('[aria-label],[title],[placeholder],[alt]'))
      for (const a of ['aria-label', 'title', 'placeholder', 'alt']) {
        const v = el.getAttribute(a);
        if (v && re.test(v)) found.push(`${a}: ${v}`);
      }
    return found;
  }, OLD.source);
}

test('every main screen says Hivenod, never Hive', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/signin');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await expect(page).toHaveTitle(/Hivenod/);
  expect(await oldNameOn(page)).toEqual([]);

  await signIn(page, person('Rena Rename'));
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveTitle(/Today · Hivenod$/);
  expect(await oldNameOn(page)).toEqual([]);

  for (const [path, title] of [
    ['/projects', /^Projects · Hivenod$/],
    ['/activity', /^Activity · Hivenod$/],
    ['/insights', /· Hivenod$/],
    ['/agents', /· Hivenod$/],
    ['/settings/profile', /· Hivenod$/],
  ] as const) {
    await page.goto(path);
    await expect(page).toHaveTitle(title, { timeout: 20_000 });
    await expect(page.getByRole('main').first()).toBeVisible();
    await page.waitForTimeout(800); // let live data render
    expect(await oldNameOn(page), path).toEqual([]);
  }

  // The Connect page: install and run commands use hivenod.
  await page.goto('/agents');
  await page.getByRole('button', { name: 'New agent' }).first().click();
  const dialog = page.getByRole('main');
  // The guide shows one step at a time: Install, Pair, Plugin, Start.
  await expect(dialog.getByLabel('Install command', { exact: true })).toContainText(
    /curl -fsSL .*\/install\.sh \| sh/,
  );
  expect(await oldNameOn(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Next: Pair' }).click();
  await expect(dialog.getByText('hivenod pair', { exact: true }).first()).toBeVisible();
  expect(await oldNameOn(page)).toEqual([]);
});
