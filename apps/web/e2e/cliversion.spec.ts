/**
 * Old CLI (item N9EEnCa1MzIw5UYfe70N): a "revise" request waiting on an agent whose CLI is too old
 * says so on the card (Today at 1440, the thread page's bottom sheet at 390), and the agent's page
 * shows "Update available" when a newer CLI is published. Light and dark, axe-clean, no sideways
 * scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminUpdate, expectNoHorizontalScroll, fastTimers, freezeClock, settle } from './helpers';
import { seedInbox, type Seed } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots)
      await page.screenshot({ path: `${shots}/cli-${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function open(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  return seedInbox(page);
}

const setVersion = (s: Seed, v: string | null) =>
  adminUpdate(`workspaces/${s.wid}/agents/${s.agent.aid}`, { cliVersion: v });

async function ask(where: Locator) {
  await where.getByRole('button', { name: /Ask for changes|Changes/ }).click();
  const box = where.getByRole('form', { name: 'Ask for changes' });
  await box.getByRole('button', { name: 'Shorter' }).click();
  await box.getByRole('button', { name: /Ask agent/ }).click();
  await expect(where.locator('[data-revising]')).toBeVisible();
}

async function latest(page: Page, version: string) {
  await page.route('**/cli/bin/latest.json*', (r) =>
    r.fulfill({ json: { version, commit: 'abc', cliProtocol: 2, files: {} } }),
  );
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('revise on an old CLI shows the hint; a new or unreported CLI does not', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const s = await open(page);
    try {
      await setVersion(s, '0.2.159');
      const card = page.locator('[data-decision-card]');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('j');
      await ask(card);
      const hint = card.locator('[data-cli-old]');
      await expect(hint).toContainText('Desk agent needs a Hivenod update to do this');
      await expect(hint).toContainText('0.2.159');
      await expect(hint).toContainText('hivenod update');
      await look(page, 'card-1440');

      await setVersion(s, '0.2.170');
      await expect(hint).toHaveCount(0);
      await setVersion(s, null);
      await expect(hint).toHaveCount(0);
      await expect(card.locator('[data-revising]')).toBeVisible();
    } finally {
      await s.stop();
    }
  });

  test('the agent page shows the version and Update available', async ({ page }) => {
    test.setTimeout(120_000);
    await latest(page, '0.2.200');
    const s = await open(page);
    try {
      await setVersion(s, '0.2.159');
      await page.goto(`/agents/${s.agent.aid}`);
      await expect(page.getByTestId('cli-version')).toContainText('Hivenod CLI 0.2.159');
      await expect(page.locator('[data-update-available]')).toHaveText(
        'Update available: 0.2.159 → 0.2.200',
      );
      await look(page, 'agent-1440');
      await setVersion(s, '0.2.200');
      await expect(page.locator('[data-update-available]')).toHaveCount(0);
      await expect(page.getByTestId('cli-version')).toContainText('Hivenod CLI 0.2.200');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bottom sheet shows the hint', async ({ page }) => {
    test.setTimeout(150_000);
    const s = await open(page);
    try {
      await setVersion(s, '0.2.159');
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      const sheet = page.locator('[data-agent-panel]');
      await expect(sheet).toHaveAttribute('data-sheet', 'collapsed', { timeout: 20_000 });
      await ask(sheet);
      await expect(sheet.locator('[data-cli-old]')).toContainText('needs a Hivenod update');
      await look(page, 'sheet-390');
    } finally {
      await s.stop();
    }
  });

  test('the agent page shows Update available', async ({ page }) => {
    test.setTimeout(120_000);
    await latest(page, '0.2.200');
    const s = await open(page);
    try {
      await setVersion(s, '0.2.159');
      await page.goto(`/agents/${s.agent.aid}`);
      await expect(page.locator('[data-update-available]')).toBeVisible();
      await look(page, 'agent-390');
    } finally {
      await s.stop();
    }
  });
});
