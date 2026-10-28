import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { login, seedSteps } from './boardSeed';

const noSideScroll = (page: Page) =>
  page.evaluate(() => {
    const b = document.querySelector('[data-testid="board"]')!;
    return {
      page: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      board: b.scrollWidth > b.clientWidth,
    };
  });

const rowsBtn = (page: Page) => page.getByRole('button', { name: 'Rows', exact: true });
const colsBtn = (page: Page) => page.getByRole('button', { name: 'Columns', exact: true });

/** Rows stack top to bottom; columns sit side by side. */
const stacked = (page: Page) =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-testid="board"] > [data-step]')];
    const r = els.map((e) => e.getBoundingClientRect());
    return r.length > 1 && r[1]!.top > r[0]!.top && Math.abs(r[1]!.left - r[0]!.left) < 2;
  });

test('5 steps open as columns, 6 as rows, at every width', async ({ page }) => {
  test.setTimeout(240_000);
  const who = await login(page);
  const five = await seedSteps(page, who, 5);
  const six = await seedSteps(page, who, 6);
  for (const [w, h] of [
    [390, 844],
    [1280, 900],
    [1440, 900],
    [1920, 1000],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    if (w < 640) {
      // A phone has no Columns/Rows choice: it always swipes between columns (card weB6bMnf).
      for (const id of [five, six]) {
        await page.goto(`/p/${id}`);
        await expect(page.getByTestId('board')).toBeVisible();
        await expect(colsBtn(page)).toHaveCount(0);
        expect(await stacked(page), `phone at ${w}`).toBe(false);
      }
      continue;
    }
    await page.goto(`/p/${five}`);
    await expect(colsBtn(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await stacked(page), `5 steps at ${w}`).toBe(false);
    await page.goto(`/p/${six}`);
    await expect(rowsBtn(page)).toHaveAttribute('aria-pressed', 'true');
    expect(await stacked(page), `6 steps at ${w}`).toBe(true);
  }
});

test('the toggle switches at once and the choice is remembered per project', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  const who = await login(page);
  const six = await seedSteps(page, who, 6);
  const other = await seedSteps(page, who, 6);
  await page.goto(`/p/${six}`);
  await expect(rowsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  await colsBtn(page).click();
  await expect(colsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await stacked(page)).toBe(false);
  await page.reload();
  await expect(colsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await stacked(page)).toBe(false);
  // Another project keeps its own default.
  await page.goto(`/p/${other}`);
  await expect(rowsBtn(page)).toHaveAttribute('aria-pressed', 'true');
  // And back again.
  await page.goto(`/p/${six}`);
  await rowsBtn(page).click();
  await page.reload();
  await expect(rowsBtn(page)).toHaveAttribute('aria-pressed', 'true');
});

test('12 steps in rows: no sideways scroll, empty steps are thin rows', async ({ page }) => {
  test.setTimeout(240_000);
  const shots = process.env.SHOT_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  const pid = await seedSteps(page, await login(page), 12, [], [2, 3]);
  // Rows are for tablets and desktops; the phone swipes columns (card weB6bMnf).
  for (const [w, h] of [
    [1280, 900],
    [1440, 900],
    [1920, 1000],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`/p/${pid}`);
    await expect(page.getByText('Item 2').first()).toBeVisible();
    expect
      .soft(await noSideScroll(page), `12 steps at ${w}`)
      .toEqual({ page: false, board: false });
    if (shots) await page.screenshot({ path: `${shots}/rows12-${w}.png`, fullPage: true });
  }
  // A step with no items stays a thin, named, collapsed row.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}`);
  const empty = page.getByRole('button', { name: /^0\s*Step 3/ });
  await expect(empty).toHaveAttribute('aria-expanded', 'false');
  expect((await empty.boundingBox())!.height).toBeLessThan(60);
  // An empty decision row is as thin as an empty agent row and not highlighted; one with
  // something waiting is. A row that holds items opens by itself.
  const emptyGate = page.locator('[data-step="s3"]');
  const waitingGate = page.locator('[data-step="s1"]');
  await expect(emptyGate).toHaveAttribute('data-waiting', 'false');
  await expect(waitingGate).toHaveAttribute('data-waiting', 'true');
  expect(Math.round((await emptyGate.boundingBox())!.height)).toBe(
    Math.round((await page.locator('[data-step="s2"]').boundingBox())!.height),
  );
  await expect(page.getByRole('button', { name: /^1\s*Step 5/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});

test('rows layout: keyboard drag reorders inside the first row, with announcements', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  const pid = await seedSteps(page, await login(page), 6, ['Extra B', 'Extra C']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}`);
  const titles = () =>
    page
      .getByText(/^(Item 1|Extra B|Extra C)$/)
      .evaluateAll((els) => els.map((e) => e.textContent));
  await expect.poll(titles).toEqual(['Item 1', 'Extra B', 'Extra C']);
  await page.getByRole('button', { name: /^Reorder Item 1\./ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('Picked up item Item 1.');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('Item 1 is over item Extra B');
  await page.keyboard.press('Space');
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(
    'Dropped item Item 1 on item Extra B.',
  );
  await expect.poll(titles).toEqual(['Extra B', 'Item 1', 'Extra C']);
  await page.reload();
  await expect.poll(titles).toEqual(['Extra B', 'Item 1', 'Extra C']);
});

test('rows layout: dragging an item into another row is refused like in columns (items change step only by agent work or a decision)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'desktop layout');
  const pid = await seedSteps(page, await login(page), 6, ['Extra B', 'Extra C']);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}`);
  const titles = () =>
    page
      .getByText(/^(Item 1|Extra B|Extra C)$/)
      .evaluateAll((els) => els.map((e) => e.textContent));
  await expect.poll(titles).toEqual(['Item 1', 'Extra B', 'Extra C']);
  const hb = (await page.getByRole('button', { name: /^Reorder Extra C\./ }).boundingBox())!;
  const target = (await page.locator('[data-step="s3"]').boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + 20, hb.y + 10, { steps: 5 });
  await page.mouse.move(hb.x + 20, target.y + target.height / 2, { steps: 20 });
  await expect(page.getByText('Items can only be reordered inside this step.')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText(
    'Items change step only through agent work or a decision.',
  );
  await page.reload();
  await expect.poll(titles).toEqual(['Item 1', 'Extra B', 'Extra C']);
});
