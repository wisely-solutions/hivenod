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

const REPO = 'https://github.com/wisely-solutions/hivenod';
const INSTALL = 'curl -fsSL https://hivenod.com/install.sh | sh';

for (const theme of ['light', 'dark'] as const) {
  test(`product page at /, ${theme}: sections, GitHub links, no sideways scroll, accessible`, async ({
    page,
  }) => {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /Agents do the work\.\s*You make the calls\./,
      }),
    ).toBeVisible();
    await expect(
      page.getByText('Open source · Apache-2.0 · Hive builds Hivenod on Hivenod'),
    ).toBeVisible();
    await expect(page.getByText(INSTALL)).toBeVisible();
    // Real screenshots, both with a text alternative.
    await expect(page.getByRole('img', { name: /The Website project.s board/ })).toBeAttached();
    await expect(
      page.getByRole('img', { name: /On a phone: the Pricing page rewrite/ }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: /Agents take the steps\.\s*People hold the gates\./ }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Connect in one line' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Built in the open\./ })).toBeVisible();
    // Only true claims: a self-host guide, not a promise about minutes.
    await expect(page.getByText(/in 10 minutes/)).toHaveCount(0);
    // The glowing nav pill and the open-source band both lead to the public repository.
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: /^Star on GitHub/ })).toHaveAttribute('href', REPO);
    await expect(nav.getByRole('link', { name: /^Star on GitHub/ })).toBeVisible();
    const band = page.getByRole('region', { name: /Built in the open/ });
    await expect(band.getByRole('link', { name: 'Star on GitHub' })).toHaveAttribute('href', REPO);
    await expect(band.getByRole('link', { name: 'Self-host guide' })).toHaveAttribute(
      'href',
      `${REPO}/blob/main/docs/SELF-HOST.md`,
    );
    const footer = page.getByRole('contentinfo');
    await expect(footer.getByRole('link', { name: 'Privacy', exact: true })).toBeVisible();
    await expect(footer.getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', REPO);
    await expect(footer.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      `${REPO}#readme`,
    );
    for (const href of await page
      .locator('a[href^="http"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      expect(href!.startsWith(REPO) || href!.startsWith('https://hivenod.com')).toBe(true);
    await expectNoHorizontalScroll(page);
    await page.screenshot({
      path: `${process.env.SHOTS ?? 'test-results'}/landing-${theme}-${page.viewportSize()!.width}.png`,
      fullPage: true,
    });
    await settle(page);
    await axe(page);
  });
}

test('phones at 390: stacked, no sideways scroll, accessible in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['dark', 'light'] as const) {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Star on GitHub/ }),
    ).toBeVisible();
    // The phone screenshot leads the stage on phones.
    const phone = await page.getByRole('img', { name: /On a phone/ }).boundingBox();
    const desk = await page.getByRole('img', { name: /The Website project.s board/ }).boundingBox();
    expect(phone!.y).toBeLessThan(desk!.y);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
  }
});

test('Copy puts the install line on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const copy = page.getByRole('button', { name: 'Copy' });
  await copy.click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  await expect(
    page.getByRole('status').filter({ hasText: 'Install command copied' }),
  ).toBeAttached();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(INSTALL);
  await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible({ timeout: 4000 });
});

test('the star count from stars.json shows from 50 up, and never below', async ({ page }) => {
  let stars: unknown = 1234;
  await page.route('**/stars.json', (r) => r.fulfill({ json: { stars } }));
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Star on GitHub 1.2k stars' })).toBeVisible();
  await expect(page.getByRole('region', { name: /Built in the open/ })).toContainText('1.2k');
  stars = 49;
  await page.reload();
  await expect(nav.getByRole('link', { name: 'Star on GitHub', exact: true })).toBeVisible();
  await expect(page.getByText(/★\s*49/)).toHaveCount(0);
  stars = null;
  await page.reload();
  await expect(nav.getByRole('link', { name: 'Star on GitHub', exact: true })).toBeVisible();
});

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
  await page.getByRole('contentinfo').getByRole('link', { name: 'Privacy', exact: true }).click();
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

test('signed-out visitors load the landing page without the signed-in code', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => {
    if (r.resourceType() === 'script') scripts.push(new URL(r.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await settle(page);
  expect(scripts.some((s) => /\/LandingPage-/.test(s))).toBe(true);
  // Firebase and Needs you load only for a browser that may be signed in.
  expect(scripts.filter((s) => /\/(db|app|SignedIn|InboxPage)-/.test(s))).toEqual([]);
});
