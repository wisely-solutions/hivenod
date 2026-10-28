import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { settle } from './helpers';

// A modal dialog hides the rest of the page from assistive technology (Radix sets aria-hidden on
// siblings). A notification that appears over it must still be announced: its live region and
// every ancestor must be free of aria-hidden and inert.
for (const theme of ['light', 'dark'] as const) {
  test(`a notification shown over a dialog or sheet is announced (${theme})`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/kit');
    await expect(page.getByRole('heading', { name: 'Design system' })).toBeVisible();
    const overlays = page.locator('#overlays');
    await overlays.scrollIntoViewIfNeeded();
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
      // Found through the accessibility tree: it is there only if nothing above it hides it.
      const toast = page.getByRole('status').filter({ hasText: 'A notification over the dialog' });
      await expect(toast).toBeVisible();
      await expect(page.getByRole('region', { name: 'Notifications' })).toBeVisible();

      const hidden = await region.evaluate((el) => {
        const bad: string[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) {
          if (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert'))
            bad.push(n.tagName + (n.id ? '#' + n.id : ''));
        }
        return bad;
      });
      expect(hidden).toEqual([]);
      const live = await toast.evaluate(
        (el) => el.getAttribute('role') === 'status' || !!el.closest('[aria-live]'),
      );
      expect(live).toBe(true);

      // The toast fades in: axe composites a half-faded toast over the dimmed page and reports a
      // contrast that is not the resting one. Wait for it to rest, as every other axe spec does.
      await settle(page, { loading: false });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(violations.map((v) => v.id)).toEqual([]);

      await toast.locator('button[aria-label="Dismiss"]').click();
      await page.getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    }
  });
}
