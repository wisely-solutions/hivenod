import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  settle,
} from './helpers';

// Card M3ipmzNY: quick capture from anywhere. C, the palette and the phone's + open one box;
// Enter adds; the project and the type are chips; the toast has Open and Undo.

const rand = () => Math.random().toString(36).slice(2, 8);
const isPhone = () => test.info().project.name !== 'desktop-1440';
const SHOTS = process.env.SHOT_DIR ?? '/tmp';

async function seed(page: Page) {
  const owner = person('Capture Cathy');
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const mk = async (name: string, pid: string) => {
    const base = projectFields(name, uid);
    await adminSet(`workspaces/${wid}/projects/${pid}`, {
      ...base,
      steps: [base.steps[0]!, base.steps[1]!],
      stepIndex: { draft: 0, review: 1 },
    });
  };
  const blog = `blog${rand()}`;
  const site = `site${rand()}`;
  await mk('Blog', blog);
  await mk('Website', site);
  return { wid, uid, blog, site };
}

/** Opens the capture box the way this device does: C on a keyboard, + in the tab bar on a phone. */
async function openBox(page: Page) {
  if (isPhone()) await page.getByRole('button', { name: 'Add an item' }).click();
  else await page.keyboard.press('c');
  const box = page.getByRole('dialog', { name: 'New item' });
  await expect(box).toBeVisible();
  await expect(box.getByLabel('Title')).toBeFocused();
  return box;
}

type Fields = Record<string, { stringValue?: string; integerValue?: string }>;
/** The items of a project, read as the emulator's admin (skips rules). */
const itemsOf = async (wid: string, pid: string): Promise<Fields[]> => {
  const res = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/projects/${pid}/items`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const json = (await res.json()) as { documents?: Array<{ fields: Fields }> };
  return (json.documents ?? []).map((d) => d.fields);
};
const str = (f: Fields | undefined, k: string) => f?.[k]?.stringValue;

test('opens from any screen, guesses the type, adds with Enter, and Undo takes it back', async ({
  page,
}) => {
  const { wid, blog } = await seed(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const box = await openBox(page);

  // Defaults: the last/first project, and an idea until the text says otherwise.
  await expect(box.getByLabel('Type')).toHaveValue('idea');
  await page.keyboard.type('Bug: the footer overlaps the cookie banner');
  await expect(box.getByLabel('Type')).toHaveValue('bug');
  await expect(box.getByLabel('Type').locator('option:checked')).toHaveText('Bug · guessed');
  await box.getByLabel('Project').selectOption(blog);
  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: `${SHOTS}/capture-open-${test.info().project.name}.png` });
  await page.keyboard.press('Enter');
  await expect(box).toBeHidden();

  const toast = page.getByRole('status').filter({ hasText: 'Added to Blog.' });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect.poll(async () => (await itemsOf(wid, blog)).length).toBe(1);
  const saved = (await itemsOf(wid, blog))[0]!;
  expect(str(saved, 'type')).toBe('bug');
  expect(str(saved, 'title')).toBe('Bug: the footer overlaps the cookie banner');

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(async () => (await itemsOf(wid, blog)).length).toBe(0);
});

test('#name switches the project; Open goes to the card, highlighted', async ({ page }) => {
  const { wid, site } = await seed(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const box = await openBox(page);
  await page.keyboard.type('Fix the nav links #web');
  await expect(box.getByLabel('Project')).toHaveValue(site);
  await expect(box.getByLabel('Type')).toHaveValue('task');
  await page.keyboard.press('Enter');
  const toast = page.getByRole('status').filter({ hasText: 'Added to Website.' });
  await expect(toast).toBeVisible();
  await expect.poll(async () => (await itemsOf(wid, site)).length).toBe(1);
  expect(str((await itemsOf(wid, site))[0], 'title')).toBe('Fix the nav links');

  await toast.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${site}\\?item=`));
});

test('Cmd+Enter keeps the box open, Shift+Enter goes to the details, Escape keeps a draft', async ({
  page,
}) => {
  test.skip(isPhone(), 'keyboard shortcuts');
  const { wid, blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  await expect(box.getByLabel('Project')).toHaveValue(blog); // the project being looked at

  await page.keyboard.type('First thing');
  await page.keyboard.press('Shift+Enter');
  await expect(box.getByLabel('Details (optional)')).toBeFocused();
  await page.keyboard.type('Some context');
  await page.keyboard.press('Enter'); // a new line in the details, not an add
  await page.keyboard.type('second line');
  await page.keyboard.press('Control+Enter');
  await expect(box).toBeVisible();
  await expect(box.getByLabel('Title')).toHaveValue('');
  await expect(box.getByLabel('Title')).toBeFocused();
  await expect.poll(async () => (await itemsOf(wid, blog)).length).toBe(1);
  expect(str((await itemsOf(wid, blog))[0], 'summary')).toBe('Some context\nsecond line');

  await page.keyboard.type('Draft that is not sent');
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
  await openBox(page);
  await expect(page.getByRole('dialog').getByLabel('Title')).toHaveValue('Draft that is not sent');
  expect((await itemsOf(wid, blog)).length).toBe(1);
});

test('C is ignored while typing in a field', async ({ page }) => {
  test.skip(isPhone(), 'keyboard shortcuts');
  const { blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  const title = box.getByLabel('Title');
  await page.keyboard.type('cat');
  await expect(title).toHaveValue('cat');
  await expect(page.getByRole('dialog')).toHaveCount(1);
});

test('a pasted image is attached to the new item', async ({ page }) => {
  const { wid, blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  await page.keyboard.type('Screenshot of the broken layout');
  await box.getByLabel('Title').evaluate((el) => {
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(box.getByText('shot.png')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByText('1 attachment', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await itemsOf(wid, blog))[0]?.attachmentCount?.integerValue)
    .toBe('1');
});

test('the card just added is highlighted and in view on its board', async ({ page }) => {
  const { blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  await page.keyboard.type('Highlight me');
  await page.keyboard.press('Enter');
  await expect(box).toBeHidden();
  const card = page.locator('[data-just-added="true"]');
  await expect(card).toContainText('Highlight me');
  await expect(card).toBeInViewport();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/capture-added-${test.info().project.name}.png` });
});

test('the item is on screen within 100 ms of Enter', async ({ page }) => {
  test.skip(test.info().project.name !== 'desktop-1440', 'one profile is enough');
  const { blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  const quick = box.getByLabel('Title');
  await quick.fill('Timed item');
  // Time from the Enter key to the card being in the DOM, measured inside the page.
  await page.evaluate(() => {
    const w = window as unknown as { __ms?: number };
    const input = document.querySelector('[role="dialog"] textarea')!;
    let t0 = 0;
    input.addEventListener('keydown', () => (t0 = performance.now()), { capture: true });
    new MutationObserver((_m, obs) => {
      const seen = [...document.querySelectorAll('[data-item-id]')].some((n) =>
        n.textContent?.includes('Timed item'),
      );
      if (seen) {
        w.__ms = performance.now() - t0;
        obs.disconnect();
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await quick.press('Enter');
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ms?: number }).__ms ?? -1))
    .toBeGreaterThanOrEqual(0);
  const ms = await page.evaluate(() => (window as unknown as { __ms: number }).__ms);
  console.log(`item on screen ${Math.round(ms)} ms after Enter`);
  expect(ms).toBeLessThan(100);
});

test('the palette and the phone tab bar reach it too', async ({ page }) => {
  await seed(page);
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  if (isPhone()) await page.getByRole('button', { name: 'Search' }).click();
  else await page.keyboard.press('Control+K');
  await page.getByPlaceholder(/Jump to/).fill('new item');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Title')).toBeFocused();
  if (isPhone()) {
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.getByRole('dialog')).toBeHidden();
    await openBox(page);
  }
});

test('screens: light and dark', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { blog } = await seed(page);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${blog}`);
    await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
    await settle(page);
    const box = await openBox(page);
    await page.keyboard.type('Post: what clients ask in week one');
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/capture-${test.info().project.name}-${theme}.png` });
    await box.getByLabel('Project').focus();
    await page.keyboard.press('Escape');
    await expect(box).toBeHidden();
  }
});

// Card qcSzGfzn: capture polish.
test('C works right after the box closes, and an unsent draft survives a reload', async ({
  page,
}) => {
  test.skip(isPhone(), 'keyboard shortcuts');
  const { blog } = await seed(page);
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  await openBox(page);
  await page.keyboard.type('Survives a reload');
  await page.keyboard.press('Escape');
  await page.keyboard.press('c'); // immediately, while the box is still animating out
  await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  await openBox(page);
  await expect(page.getByRole('dialog').getByLabel('Title')).toHaveValue('Survives a reload');
});

test('the Added toast leaves the phone + tappable', async ({ page }) => {
  mkdirSync(SHOTS, { recursive: true });
  const { blog } = await seed(page);
  if (test.info().project.name === 'iphone-se')
    await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(400);
    await openBox(page);
    await page.keyboard.type(`Toast check ${theme}`);
    await page.keyboard.press('Enter');
    const toast = page.getByRole('region', { name: 'Notifications' });
    await expect(toast.getByText(/^Added to Blog/).first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/toast-${test.info().project.name}-${theme}.png` });
    if (isPhone()) {
      const plus = page.getByRole('button', { name: 'Add an item' });
      const box = (await plus.boundingBox())!;
      const hit = await page.evaluate(
        ([x, y]) =>
          document.elementFromPoint(x!, y!)?.closest('button')?.getAttribute('aria-label'),
        [box.x + box.width / 2, box.y + box.height / 2],
      );
      expect(hit).toBe('Add an item');
      await plus.click(); // a second item can be started while the toast shows
      await expect(page.getByRole('dialog', { name: 'New item' })).toBeVisible();
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(300);
  }
});

test('the Added toast never covers the open sheet fields', async ({ page }) => {
  test.skip(!isPhone(), 'the phone sheet');
  mkdirSync(SHOTS, { recursive: true });
  const { blog } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(400);
    const box = await openBox(page);
    await page.keyboard.type(`Cover check ${theme}`);
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('region', { name: 'Notifications' }).getByText(/^Added to Blog/),
    ).toBeVisible();
    await expect(box).toBeHidden();
    const again = await openBox(page); // while the toast may still be up
    const details = again.getByLabel(/Details/i);
    await expect(details).toBeVisible();
    await page.waitForTimeout(500);
    const r = (await details.boundingBox())!;
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.closest('[role=region]')?.ariaLabel ?? null,
      [r.x + r.width / 2, r.y + r.height / 2],
    );
    expect(hit).not.toBe('Notifications');
    await page.screenshot({ path: `${SHOTS}/sheet-390-${theme}.png` });
    await page.keyboard.press('Escape');
    await expect(again).toBeHidden({ timeout: 1500 });
    await page.waitForTimeout(300);
  }
});

test('a sheet closes in 300 ms or less on the phone (animation and transition)', async ({
  page,
}) => {
  test.skip(!isPhone(), 'the phone sheet');
  mkdirSync(SHOTS, { recursive: true });
  const { blog } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${blog}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  const box = await openBox(page);
  await page.waitForTimeout(700);
  // The computed durations of vaul's keyframes/transitions on the sheet and its overlay.
  const computed = await page.evaluate(() =>
    ['[data-vaul-drawer]', '[data-vaul-overlay]'].map((sel) => {
      const cs = getComputedStyle(document.querySelector(sel)!);
      return { sel, anim: cs.animationDuration, trans: cs.transitionDuration };
    }),
  );
  for (const c of computed)
    for (const d of [c.anim, c.trans].flatMap((v) => v.split(',')))
      expect(
        parseFloat(d) * (d.trim().endsWith('ms') ? 1 : 1000),
        JSON.stringify(c),
      ).toBeLessThanOrEqual(300);
  await page.evaluate(() => {
    (window as unknown as { __ends: number[] }).__ends = [];
    const obs = new MutationObserver(() => {
      for (const a of document.getAnimations())
        (window as unknown as { __ends: number[] }).__ends.push(
          Number(a.effect?.getComputedTiming().endTime ?? 0),
        );
    });
    obs.observe(document.body, { attributes: true, subtree: true, childList: true });
  });
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden({ timeout: 1500 });
  const ends = await page.evaluate(() => (window as unknown as { __ends: number[] }).__ends);
  const sheetAnims = ends.filter((e) => e > 0 && e < 5000);
  expect(Math.max(0, ...sheetAnims)).toBeLessThanOrEqual(300);
  await page.screenshot({ path: `${SHOTS}/sheet-close-390.png` });
});
