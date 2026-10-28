import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, settle } from './helpers';

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`product page at /, ${theme}: sections, no sideways scroll, accessible`, async ({
    page,
  }) => {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /Agents do the work\.\s*You make the decisions\./,
      }),
    ).toBeVisible();
    await expect(page.getByText('Free and open source')).toBeVisible();
    await expect(page.getByRole('img', { name: /A board with four columns/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'How it works' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Open source' })).toBeVisible();
    await expect(page.getByText('Apache-2.0')).toBeVisible();
    await expect(
      page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }),
    ).toBeVisible();
    // The repository is public: every GitHub link points to it.
    const repo = 'https://github.com/wisely-solutions/hivenod';
    await expect(page.getByRole('link', { name: 'View on GitHub' })).toHaveAttribute('href', repo);
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', repo);
    await expect(footer.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      `${repo}#readme`,
    );
    for (const href of await page
      .locator('a[href*="github.com"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      expect(href?.startsWith(repo)).toBe(true);
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: `${process.env.SHOTS ?? 'test-results'}/landing-${theme}-${page.viewportSize()!.width}.png`,
      fullPage: true,
    });
    await settle(page);
    await axe(page);
  });
}

test('Get started opens Create account, Sign in opens Sign in; Privacy is reachable', async ({
  page,
}) => {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Get started' })
    .click();
  await expect(page).toHaveURL(/\/signin\?mode=create$/);
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await settle(page);
  await page.screenshot({
    path: `${process.env.SHOTS ?? 'test-results'}/sign-in-panel-${page.viewportSize()!.width}.png`,
  });
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  await page.goBack();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Sign in' })
    .click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy' })).toBeVisible();
  await expect(page.getByText('privacy@hivenod.com').first()).toBeVisible();
  await expectNoHorizontalScroll(page);
  await settle(page);
  await page.screenshot({
    path: `${process.env.SHOTS ?? 'test-results'}/privacy-${page.viewportSize()!.width}.png`,
    fullPage: true,
  });
  await axe(page);
});
