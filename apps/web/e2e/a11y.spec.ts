import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { seed } from './seed';

test('a new screen gets its own title and keyboard focus, and a dialog gives focus back', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the sidebar and keyboard flow are desktop');
  test.setTimeout(120_000);
  await seed(page);
  await page.goto('/');
  await expect(page).toHaveTitle(/Today · Hivenod$/);

  await page.getByRole('link', { name: 'All projects' }).click();
  await expect(page).toHaveTitle(/^(\(\d+\) )?All projects · Hivenod$/);
  await expect(page.locator('#content')).toBeFocused();

  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page).toHaveTitle(/^(\(\d+\) )?Activity · Hivenod$/);
  await expect(page.locator('#content')).toBeFocused();

  // Skip link is the first stop and works from the keyboard.
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');

  // A dialog opened from the keyboard traps focus, closes on Escape and returns focus.
  await page.goto('/p/blog');
  const trigger = page.getByRole('button', { name: 'New item' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

for (const theme of ['light', 'dark'] as const) {
  test(`sidebar controls keep their visible text in their accessible name (${theme})`, async ({
    page,
  }, info) => {
    test.skip(info.project.name !== 'desktop-1440', 'the labels only show at 1440');
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: theme });
    await seed(page);
    for (const path of ['/', '/agents']) {
      await page.goto(path);
      const side = page.getByRole('complementary', { name: 'Main' });
      await expect(side.getByRole('button', { name: /^Search/ })).toBeVisible();
      const { violations } = await new AxeBuilder({ page })
        .include('aside')
        .withRules(['label-content-name-mismatch'])
        .analyze();
      expect(
        violations.map((v) => v.nodes.map((n) => [n.target, n.any.map((a) => a.message)])),
      ).toEqual([]);
    }
  });
}
