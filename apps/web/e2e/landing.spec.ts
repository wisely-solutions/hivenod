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

const shots = process.env.SHOTS ?? 'test-results';

/** Scrolls through the page so its lazy screenshots load, then back to the top. */
async function loadAll(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 30));
    }
    window.scrollTo(0, 0);
  });
  await expect
    .poll(() =>
      page.evaluate(() => [...document.images].every((i) => i.complete || !i.offsetParent)),
    )
    .toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test(`product page at /, ${theme}: both usages, timeline, GitHub links, no sideways scroll, accessible`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: /Agents do the work\.\s*You make the calls\./,
      }),
    ).toBeVisible();
    await expect(page.getByText('Your inbox, run by your agents')).toBeVisible();
    await expect(page.getByText(INSTALL)).toBeVisible();
    // The two usages: Inbox first, with the real Today screens and the real sources.
    const tabs = page.getByRole('tablist', { name: 'Two ways to use Hivenod' });
    await expect(tabs.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
    const inbox = page.getByRole('tabpanel', { name: 'Inbox' });
    await expect(
      inbox.getByRole('heading', { name: 'Agents answer it. You OK it.' }),
    ).toBeVisible();
    await expect(inbox.getByRole('img', { name: /^Today: the morning brief/ })).toBeVisible();
    await expect(
      inbox.getByRole('list', { name: 'Sources your agents can bring in' }).getByRole('listitem'),
    ).toHaveText(['Mail', 'Teams', 'Slack', 'Jira', 'GitLab', 'GitHub', 'Telegram']);
    // Needs you for both, the day timeline, how it works, trust and open source.
    await expect(
      page.getByRole('heading', { name: /Every decision,\s*from every workspace\./ }),
    ).toBeVisible();
    const day = page.getByRole('region', { name: /Agents do the work all day/ });
    for (const t of ['08:30', '10:15', '13:00', '17:40'])
      await expect(day.getByText(t)).toBeVisible();
    for (const h of [
      'Your morning brief',
      'A plan waits at your gate',
      'A reply, drafted and checked',
      'Shipped, checked, live',
    ])
      await expect(day.getByRole('heading', { name: h })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Connect your agent in one line.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Your agents. Your calls. Your data.' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Nothing goes out without your OK' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: /Built in the open\./ })).toBeVisible();
    // Only true claims: a self-host guide, not a promise about minutes; no suggested holds.
    await expect(page.getByText(/in 10 minutes/)).toHaveCount(0);
    await expect(page.getByText(/pencil|tentative|hold/i)).toHaveCount(0);
    // The glowing nav pill, the open-source band and the footer pill lead to the public repository.
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
    await expect(footer.getByRole('link', { name: /^GitHub/ })).toHaveAttribute('href', REPO);
    await expect(footer.getByRole('link', { name: 'Docs' })).toHaveAttribute(
      'href',
      `${REPO}#readme`,
    );
    for (const href of await page
      .locator('a[href^="http"]')
      .evaluateAll((as) => as.map((a) => a.getAttribute('href'))))
      expect(href!.startsWith(REPO) || href!.startsWith('https://hivenod.com')).toBe(true);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
    await loadAll(page);
    await page.screenshot({
      path: `${shots}/landing-${theme}-${page.viewportSize()!.width}.png`,
      fullPage: true,
    });
    // The other tab: Plans, with the decision page screenshots.
    await tabs.getByRole('tab', { name: 'Plans' }).click();
    const plans = page.getByRole('tabpanel', { name: 'Plans' });
    await expect(
      plans.getByRole('heading', { name: 'Agents build it. You approve it.' }),
    ).toBeVisible();
    await expect(inbox).toBeHidden();
    await expect(
      plans.getByRole('img', { name: /^A decision page: Ship release 175/ }),
    ).toBeVisible();
    await expect(page.getByText(/calendar|your projects/i)).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
    await page.screenshot({
      path: `${shots}/landing-plans-${theme}-${page.viewportSize()!.width}.png`,
    });
  });
}

test('the usage tabs work from the keyboard: arrows, Home and End, one tab stop', async ({
  page,
}) => {
  await page.goto('/');
  const tabs = page.getByRole('tablist', { name: 'Two ways to use Hivenod' });
  const inbox = tabs.getByRole('tab', { name: 'Inbox' });
  const plans = tabs.getByRole('tab', { name: 'Plans' });
  await expect(inbox).toHaveAttribute('tabindex', '0');
  await expect(plans).toHaveAttribute('tabindex', '-1');
  await expect(inbox).toHaveAttribute('aria-controls', 'inbox');
  await inbox.focus();
  await page.keyboard.press('ArrowRight');
  await expect(plans).toBeFocused();
  await expect(plans).toHaveAttribute('aria-selected', 'true');
  await expect(inbox).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('tabpanel', { name: 'Plans' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(inbox).toBeFocused();
  await expect(page.getByRole('tabpanel', { name: 'Inbox' })).toBeVisible();
  await page.keyboard.press('End');
  await expect(plans).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(inbox).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(plans).toHaveAttribute('aria-selected', 'true');
  // Tab leaves the tab list for the panel's content.
  await page.keyboard.press('Tab');
  await expect(plans).not.toBeFocused();
  // A link to #plans opens on that tab; the nav's links switch it.
  await page.goto('/#plans');
  await expect(plans).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inbox' }).click();
  await expect(inbox).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#inbox$/);
});

test('without JavaScript both usages are readable', async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Agents do the work. You make the calls.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Inbox: agents answer it. You OK it.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Plans: agents build it. You approve it.' }),
  ).toBeVisible();
  await expect(page.locator('code')).toHaveText(INSTALL);
  await expect(
    page.getByRole('link', { name: /github\.com\/wisely-solutions\/hivenod/ }),
  ).toHaveAttribute('href', REPO);
  await expectNoHorizontalScroll(page);
  await ctx.close();
});

test('phones at 390: stacked, no sideways scroll, accessible in both themes and both tabs', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ['dark', 'light'] as const) {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Star on GitHub/ }),
    ).toBeVisible();
    // On phones the screenshots lead and the usage's text follows.
    const panel = page.getByRole('tabpanel', { name: 'Inbox' });
    const shot = await panel.getByRole('img', { name: /^Today: the morning brief/ }).boundingBox();
    const text = await panel.getByRole('heading', { name: /Agents answer it/ }).boundingBox();
    expect(shot!.y).toBeLessThan(text!.y);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
    await loadAll(page);
    await page.screenshot({ path: `${shots}/landing-${theme}-390.png`, fullPage: true });
    await page.getByRole('tab', { name: 'Plans' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Plans' })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
    await page.screenshot({ path: `${shots}/landing-plans-${theme}-390.png` });
  }
});

/** Bytes the page fetched (uncompressed), by kind, from the resource timing entries. */
async function weight(page: Page) {
  return page.evaluate(() => {
    const out = { total: 0, images: 0, imageNames: [] as string[] };
    for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
      const bytes = e.decodedBodySize || e.encodedBodySize || 0;
      out.total += bytes;
      if (/\.(webp|png|jpe?g|avif)(\?|$)/.test(e.name)) {
        out.images += bytes;
        out.imageNames.push(e.name.split('/').pop()!);
      }
    }
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
    out.total += nav?.decodedBodySize ?? 0;
    return out;
  });
}

test('page weight: the first load stays within budget; the hidden tab loads lazily', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await settle(page);
  await page.waitForLoadState('networkidle');
  const first = await weight(page);
  console.log(`landing first load at ${page.viewportSize()!.width}: ${JSON.stringify(first)}`);
  // The Plans tab's own phone screenshot waits until that tab is opened.
  expect(first.imageNames.filter((n) => /^decision-phone/.test(n))).toEqual([]);
  // Budgets (uncompressed; hosting gzips the text): everything fetched, and images alone.
  expect(first.images).toBeLessThan(450 * 1024);
  expect(first.total).toBeLessThan(1600 * 1024);
  // Scrolled to the end with both tabs seen: still bounded.
  await page.getByRole('tab', { name: 'Plans' }).click();
  for (let y = 0; y < 12; y++) await page.mouse.wheel(0, 900);
  await page.getByRole('contentinfo').scrollIntoViewIfNeeded();
  await page.waitForLoadState('networkidle');
  const all = await weight(page);
  console.log(`landing after scroll at ${page.viewportSize()!.width}: ${JSON.stringify(all)}`);
  expect(all.imageNames.some((n) => /^decision-phone/.test(n))).toBe(true);
  expect(all.images).toBeLessThan(1100 * 1024);
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
