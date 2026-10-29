import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectNoHorizontalScroll, person, signIn, settle } from './helpers';

const isPhone = () => test.info().project.name !== 'desktop-1440';

async function enter(page: Page) {
  await page.goto('/');
  await signIn(page, person('Shelly Shell'));
  await expect(page.getByRole('heading', { name: /^Good \w+, Shelly/ })).toBeVisible();
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('the shell frames the app and has no accessibility violations', async ({ page }) => {
  await enter(page);
  await expectNoHorizontalScroll(page);
  if (isPhone()) {
    const tabs = page.getByRole('navigation', { name: 'Tabs' });
    await expect(tabs).toBeVisible();
    await expect(tabs.getByRole('link')).toHaveCount(4);
    await expect(tabs.getByRole('link').or(tabs.getByRole('button'))).toHaveText([
      /^Today/,
      /^Inbox/,
      '',
      /^All projects/,
      /^Settings/,
    ]);
    await expect(tabs.getByRole('link', { name: 'Activity' })).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Main' })).toBeHidden();
    for (const l of await tabs.getByRole('link').all()) {
      expect((await l.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // The + in the middle is the quick-capture button (card M3ipmzNY).
    const add = tabs.getByRole('button', { name: 'Add an item' });
    await expect(add).toBeVisible();
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  } else {
    const side = page.getByRole('complementary', { name: 'Main' });
    await expect(side).toBeVisible();
    for (const name of ['Today', 'All projects', 'Decision insights', 'Activity', 'Agents']) {
      await expect(side.getByRole('link', { name })).toBeVisible();
    }
    await expect(side.getByText('0 agents working · 0 idle')).toBeVisible();
    await expect(side.getByText(/^Spend this month €0$/)).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeHidden();
  }
  await settle(page);
  await axe(page);
});

test('the sidebar collapses to icons below 1280 px', async ({ page }) => {
  test.skip(isPhone(), 'sidebar is desktop and tablet only');
  await page.setViewportSize({ width: 1100, height: 800 });
  await enter(page);
  const side = page.getByRole('complementary', { name: 'Main' });
  expect((await side.boundingBox())!.width).toBeLessThan(80);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await side.boundingBox())!.width).toBeGreaterThan(200);
});

test('every screen route renders inside the shell', async ({ page }) => {
  await enter(page);
  for (const [path, heading] of [
    ['/projects', 'All projects'],
    ['/insights', 'Decision insights'],
    ['/activity', 'Activity'],
    ['/agents', 'Agents'],
    ['/settings/profile', 'Settings'],
  ] as const) {
    await page.evaluate((p) => window.history.pushState({}, '', p), path);
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('the command palette jumps to a screen and runs actions', async ({ page }) => {
  await enter(page);
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  const input = page.getByPlaceholder(/Jump to/);
  await expect(input).toBeVisible();
  await input.fill('agents');
  await page.getByRole('option', { name: /^Agents/ }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await settle(page);

  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Jump to/).fill('new item');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
  if (isPhone()) await page.getByRole('button', { name: 'Close' }).first().click();
  else await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // Toggle theme from the palette.
  const before = await page.locator('html').getAttribute('data-theme');
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Jump to/).fill('toggle theme');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '');
});

test('keyboard shortcuts navigate and "?" shows the sheet', async ({ page }) => {
  test.skip(isPhone(), 'keyboard shortcuts need a keyboard');
  await enter(page);
  await page.keyboard.press('g');
  await page.keyboard.press('p');
  await expect(page).toHaveURL(/\/projects$/);
  await settle(page);
  await page.keyboard.press('?');
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Go to Activity')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('an offline banner appears and goes away again', async ({ page, context }) => {
  await enter(page);
  await context.setOffline(true);
  await expect(
    page.getByRole('status').filter({ hasText: "You're offline. Changes will sync." }),
  ).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByText("You're offline. Changes will sync.")).toBeHidden();
});

test('the tab bar hides on scroll down and returns on scroll up', async ({ page }) => {
  test.skip(!isPhone(), 'tab bar is phone only');
  await enter(page);
  await page.evaluate(() => {
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    document.getElementById('content')!.appendChild(spacer);
  });
  const tabs = page.getByRole('navigation', { name: 'Tabs' });
  const top = async () => (await tabs.boundingBox())!.y;
  const vh = page.viewportSize()!.height;
  await page.mouse.wheel(0, 600);
  await expect.poll(top).toBeGreaterThanOrEqual(vh - 2);
  await page.mouse.wheel(0, -200);
  await expect.poll(top).toBeLessThan(vh - 40);
});

test('the app is installable: manifest, icons and a service worker', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await request.get(href!)).json();
  expect(manifest.display).toBe('standalone');
  const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
  expect(purposes).toContain('maskable');
  for (const icon of manifest.icons) {
    expect((await request.get(icon.src)).ok()).toBe(true);
  }
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveCount(1);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);
  const registered = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    return Boolean(reg.active);
  });
  expect(registered).toBe(true);
});

test('the install hint shows from the second visit and can be dismissed', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('hive-visits', '1');
    localStorage.setItem('hive-hint-delay-ms', '300');
    const fire = () => {
      const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void> };
      e.prompt = async () => undefined;
      window.dispatchEvent(e);
    };
    setInterval(fire, 250);
  });
  await enter(page);
  const hint = page.getByRole('region', { name: 'Install Hivenod' });
  await expect(hint).toBeVisible();
  await hint.getByRole('button', { name: 'Dismiss install hint' }).click();
  await expect(hint).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^Good \w+, Shelly/ })).toBeVisible();
  await expect(hint).toBeHidden();
});

test('the palette gives focus back to what opened it, by button and by shortcut', async ({
  page,
}) => {
  await enter(page);
  // Enter on Needs you means "open item" (a shortcut), so use a screen without that.
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
  const search = page.getByRole('button', { name: 'Search' }).first();
  const input = page.getByPlaceholder(/Jump to/);
  const active = () =>
    page.evaluate(() => {
      const a = document.activeElement;
      return a ? `${a.tagName}:${a.getAttribute('aria-label') ?? ''}` : 'none';
    });
  // Keyboard on the button, then Escape.
  await search.focus();
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  // Focus must never drop to BODY while the palette fades out, so watch every frame.
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const tick = () => {
      w.__seen.push(document.activeElement?.tagName ?? 'none');
      requestAnimationFrame(tick);
    };
    tick();
  });
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  expect(await active()).toMatch(/^BUTTON:Search/);
  expect(
    await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen),
  ).not.toContain('BODY');
  // Click on the button, then click away.
  await search.click();
  await expect(input).toBeVisible();
  await settle(page);
  await page.mouse.click(40, 500);
  await expect(input).toBeHidden();
  expect(await active()).toMatch(/^BUTTON:Search/);
  // The Ctrl+K shortcut with the Search button focused, then Escape.
  if (!isPhone()) {
    await search.focus();
    await page.keyboard.press('Control+K');
    await expect(input).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
    expect(await active()).toMatch(/^BUTTON:Search/);
  }
});

test('Enter activates a focused button on Needs you, and arriving there moves focus to the content', async ({
  page,
}) => {
  await enter(page);
  // The session starts on Needs you; that must not stop focus moving when coming back to it.
  await expect(page.getByRole('heading', { name: /^Good \w+, Shelly/ })).toBeVisible();
  const link = (href: string) => page.locator(`nav a[href="${href}"]:visible`).first();
  await link('/inbox').click();
  await expect(page).toHaveURL(/\/inbox/);
  await link('/').click();
  await expect(page.getByRole('heading', { name: /^Good \w+, Shelly/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('content');
  // Enter on a focused button is the button's, not the inbox "open item" shortcut.
  const search = page.getByRole('button', { name: 'Search' }).first();
  const input = page.getByPlaceholder(/Jump to/);
  await search.focus();
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
});
