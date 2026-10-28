import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { settle } from './helpers';

async function open(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
  await page.goto('/kit');
  await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function axe(page: Page, include?: string) {
  const b = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21aa',
    'wcag22aa',
    'best-practice',
  ]);
  if (include) b.include(include);
  const { violations } = await b.analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`kit ${theme}`, () => {
    test('page has no axe violations and no horizontal scroll', async ({ page }) => {
      await open(page, theme);
      // Let count-ups and bars settle, and scroll everything into view.
      for (const id of ['feedback', 'signature'])
        await page.locator(`#${id}`).scrollIntoViewIfNeeded();
      await settle(page, { loading: false });
      await axe(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    });

    test('overlays have no axe violations', async ({ page }) => {
      await open(page, theme);
      const overlays = page.locator('#overlays');
      await overlays.scrollIntoViewIfNeeded();

      await overlays.getByRole('button', { name: 'Dialog' }).click();
      await expect(page.getByRole('dialog', { name: 'Stop this item?' })).toBeVisible();
      await settle(page, { loading: false });
      await axe(page);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await overlays.getByRole('button', { name: 'Sheet' }).click();
      await expect(page.getByRole('dialog', { name: 'Sheet' })).toBeVisible();
      await settle(page, { loading: false });
      await axe(page);
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await overlays.getByRole('button', { name: 'Popover' }).click();
      await expect(page.getByText('Research agent · 4 min')).toBeVisible();
      await axe(page);
      await page.keyboard.press('Escape');

      await overlays.getByRole('button', { name: 'Toast with undo' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Sent for review' })).toBeVisible();
      await settle(page, { loading: false });
      await axe(page);
    });

    test('a notification never closes a dialog or sheet, and closing it does not either', async ({
      page,
    }, info) => {
      await open(page, theme);
      const overlays = page.locator('#overlays');
      await overlays.scrollIntoViewIfNeeded();
      // A modal hides the rest of the page from the accessibility tree, so find it by its marker.
      const region = page.locator('[data-toast-region]');

      for (const [button, name] of [
        ['Dialog', 'Stop this item?'],
        ['Sheet', 'Sheet'],
      ] as const) {
        await overlays.getByRole('button', { name: button, exact: true }).click();
        const dlg = page.getByRole('dialog', { name });
        await expect(dlg).toBeVisible();
        await settle(page, { loading: false });
        await dlg.getByRole('button', { name: 'Show a notification' }).click();
        const toast = region
          .locator('[role=status]')
          .filter({ hasText: 'A notification over the dialog' });
        await expect(toast).toBeVisible();
        await settle(page, { loading: false });

        // Where it sits: top right on desktop, above the tab bar on a phone.
        const box = (await toast.boundingBox())!;
        const vp = page.viewportSize()!;
        if (info.project.name === 'desktop-1440') {
          expect(box.y).toBeLessThan(40);
          expect(box.x + box.width).toBeGreaterThan(vp.width - 40);
        } else {
          // Full width at the bottom, clear of the tab bar (--decision-bar-h lifts it further).
          expect(box.x).toBeLessThan(24);
          expect(box.x + box.width).toBeGreaterThan(vp.width - 24);
          expect(box.y + box.height).toBeLessThanOrEqual(vp.height - 56);
        }

        // Clicking the notification text, then its Dismiss button: the dialog stays.
        await toast.getByText('A notification over the dialog').click();
        await expect(dlg).toBeVisible();
        await toast.locator('button[aria-label="Dismiss"]').click();
        await expect(toast).toHaveCount(0);
        await expect(dlg).toBeVisible();
        await expect(region).toBeAttached();
        await page.getByRole('button', { name: 'Close' }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
    });

    test('command palette opens with the keyboard and passes axe', async ({ page }) => {
      await open(page, theme);
      await page.keyboard.press('Control+k');
      const input = page.getByPlaceholder('Jump to a project, item or agent');
      await expect(input).toBeFocused();
      await settle(page, { loading: false });
      await axe(page);
      await input.fill('research');
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('status').filter({ hasText: 'Opened Research agent' }),
      ).toBeVisible();
    });

    test('select and radio cards are keyboard operable', async ({ page }) => {
      await open(page, theme);
      await page.locator('#forms').scrollIntoViewIfNeeded();
      const select = page.getByRole('combobox', { name: 'Range' });
      await select.focus();
      await page.keyboard.press('ArrowDown');
      await expect(select).toHaveValue('month');
      await axe(page);

      const radios = page.getByRole('radiogroup', { name: 'Approval rule' });
      await radios.getByRole('radio', { name: /Any one/ }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(radios.getByRole('radio', { name: /Everyone/ })).toBeFocused();
      await page.keyboard.press('Space');
      await expect(radios.getByRole('radio', { name: /Everyone/ })).toBeChecked();
    });
  });
}

test.describe('focus and touch targets', () => {
  test('every tab stop shows a visible focus indicator', async ({ page }) => {
    await open(page, 'light');
    const bad: string[] = [];
    for (let i = 0; i < 120; i++) {
      await page.keyboard.press('Tab');
      const r = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const s = getComputedStyle(el);
        const visible = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
        const box = s.boxShadow !== 'none';
        return {
          ok: visible || box,
          label: `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 24)}`,
        };
      });
      if (r && !r.ok) bad.push(r.label);
    }
    expect(bad).toEqual([]);
  });

  test('interactive controls are at least 44px', async ({ page }) => {
    await open(page, 'light');
    await page.locator('#buttons').scrollIntoViewIfNeeded();
    const small = await page.evaluate(() => {
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>(
        'button, [role=tab], [role=radio], [role=switch], select, input:not([type=checkbox]), textarea, nav a',
      )) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (el.closest('[hidden]') || el.hasAttribute('data-force')) continue;
        if (r.height < 43.5 || r.width < 43.5)
          out.push(
            `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 24)} ${Math.round(r.width)}x${Math.round(r.height)}`,
          );
      }
      return out;
    });
    expect(small).toEqual([]);
  });

  test('inputs use 16px text', async ({ page }) => {
    await open(page, 'light');
    const sizes = await page.evaluate(() =>
      [...document.querySelectorAll('input:not([type=checkbox]), textarea')].map(
        (e) => getComputedStyle(e).fontSize,
      ),
    );
    expect(sizes.length).toBeGreaterThan(3);
    for (const s of sizes) expect(parseFloat(s)).toBeGreaterThanOrEqual(16);
  });
});

test.describe('signature interactions', () => {
  test('decide flow: approve, collapse, undo restores, commit saves', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-decide');
    await demo.scrollIntoViewIfNeeded();
    const items = demo.getByRole('listitem');
    await expect(items).toHaveCount(3);
    await demo.getByRole('button', { name: /Approve → Plan/ }).click();
    await expect(items).toHaveCount(2);
    const toast = page.getByRole('status').filter({ hasText: 'Approved' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(items).toHaveCount(3);

    await demo.getByRole('button', { name: /Approve → Plan/ }).click();
    await expect(items).toHaveCount(2);
    // A pointer resting on the toast pauses its countdown (by design); on phone layouts the tap
    // can land where the toast then appears, so move it away before waiting for the commit.
    await page.mouse.move(1, 1);
    await expect(demo.getByText(/^Saved: /)).toBeVisible({ timeout: 8000 });
  });

  test('decide flow queues writes while offline', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-decide');
    await demo.scrollIntoViewIfNeeded();
    await demo.getByLabel('Pretend I am offline').check();
    await demo.getByRole('button', { name: /Approve → Plan/ }).click();
    await expect(demo.getByText(/^Queued offline: /)).toBeVisible({ timeout: 8000 });
  });

  test('keyboard A approves the focused inbox item', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-decide');
    await demo.scrollIntoViewIfNeeded();
    await demo.getByRole('button', { name: 'Send back…' }).focus();
    await page.keyboard.press('a');
    await expect(demo.getByRole('listitem')).toHaveCount(2);
  });

  test('shared element: opens, Escape closes', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-shared');
    await demo.scrollIntoViewIfNeeded();
    await demo.getByRole('button').first().click();
    const dlg = page.getByRole('dialog');
    await expect(dlg).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(demo.getByRole('button')).toHaveCount(3);
  });

  test('folded columns expand and several stay open', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-folded');
    await demo.scrollIntoViewIfNeeded();
    const research = demo.getByRole('button', { name: /Research/ });
    const draft = demo.getByRole('button', { name: /Draft spec/ });
    await expect(research).toHaveAttribute('aria-expanded', 'false');
    await research.click();
    await draft.click();
    await expect(research).toHaveAttribute('aria-expanded', 'true');
    await expect(draft).toHaveAttribute('aria-expanded', 'true');
    await expect(demo.getByText('Compare three hosting options')).toBeVisible();
  });

  test('presence: a new item drops in and the badge ticks', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-presence');
    await demo.scrollIntoViewIfNeeded();
    await demo.getByRole('button', { name: 'Simulate a new item' }).click();
    await expect(demo.getByRole('list', { name: 'Live items' }).getByRole('listitem')).toHaveCount(
      3,
    );
    await expect(demo.locator('.drop-in-highlight')).toHaveCount(1);
  });

  test('send back stepper: target glows, path draws, confirm needs a reason', async ({ page }) => {
    await open(page, 'light');
    const demo = page.getByTestId('demo-sendback');
    await demo.scrollIntoViewIfNeeded();
    const group = demo.getByRole('radiogroup', { name: 'Send back to' });
    await expect(group.getByRole('radio', { name: /Approve spec/ })).toBeDisabled();
    await group.getByRole('radio', { name: /Draft spec/ }).click();
    await expect(group.getByRole('radio', { name: /Draft spec/ })).toBeChecked();
    await demo.getByRole('button', { name: 'Open as a sheet' }).click();
    const sheet = page.getByRole('dialog', { name: 'Send back' });
    await expect(sheet).toBeVisible();
    const confirm = sheet.getByRole('button', { name: /^Send back to/ });
    await expect(confirm).toBeDisabled();
    await sheet.getByLabel('Why?').fill('Wrong audience for this report.');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(page.getByRole('status').filter({ hasText: 'Sent back to' })).toBeVisible();
  });
});

test('reduced motion: nothing moves, content still appears', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await open(page, 'light');
  const demo = page.getByTestId('demo-decide');
  await demo.scrollIntoViewIfNeeded();
  await demo.getByRole('button', { name: /Approve → Plan/ }).click();
  await expect(demo.getByRole('listitem')).toHaveCount(2);
  const heartbeat = await page
    .locator('.animate-heartbeat')
    .first()
    .evaluate((e) => getComputedStyle(e).display);
  expect(heartbeat).toBe('none');
  await ctx.close();
});
