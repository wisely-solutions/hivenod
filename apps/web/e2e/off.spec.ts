/**
 * Scheduled tasks, slice 7 (design 9.4): the Off switch. A pill on every page says "Agents on";
 * its panel turns all agents (every organization) or one agent Off; then the pill turns amber
 * ("Agents off", "Off: Books") on every page and Today shows a banner. Turning on first lists what
 * will start (a step approved before Off) and nothing turns on by itself. 1440 and 390, light and
 * dark, axe-clean, no sideways scroll.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';
import { agentOf } from './inboxSeed';

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page, { loading: false });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots) await page.screenshot({ path: `${shots}/s7-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

/** A new member with an agent "Books" and a reply she approved (before any Off). */
async function member(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const me = person('Cara Lindqvist');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const books = await agentOf(wid, uid, 'Books');
  const tid = await books.add(uid, {
    source: 'teams',
    from: 'Sam Example',
    text: 'Can you confirm Thursday?',
    ref: 'thursday',
    id: 'm1',
    at: new Date(NOW - 3_600_000),
  });
  await adminUpdate(`workspaces/${wid}/inboxThreads/${tid}`, { title: 'Thursday meeting' });
  const oid = await books.propose(tid, 'reply', { text: 'Thursday works.' });
  await adminUpdate(`workspaces/${wid}/inboxOutcomes/${oid}`, {
    state: 'approved',
    decision: { byUid: uid, at: new Date(NOW - 60_000), edited: false, reason: null },
  });
  return { wid, uid, books };
}

const offDoc = async (wid: string, uid: string) =>
  (await adminDoc(`workspaces/${wid}/agentsOff/${uid}`))?.fields;

async function flow(page: Page, size: '1440' | '390') {
  const s = await member(page);
  try {
    const pill = page.locator('[data-off-pill]:visible').first();
    await expect(pill).toHaveText('Agents on', { timeout: 20_000 });
    await expect(page.locator('[data-off-banner]')).toHaveCount(0);
    await look(page, `pill-on-${size}`);

    // All agents Off.
    await pill.click();
    const dialog = page.getByRole('dialog', { name: 'Turn agents off' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('switch', { name: 'All agents' })).toBeChecked();
    await look(page, `panel-${size}`);
    await dialog.getByRole('button', { name: 'Turn off' }).click();
    await expect(dialog).toBeHidden();
    await expect(pill).toHaveText('Agents off');
    await expect.poll(async () => (await offDoc(s.wid, s.uid))?.all?.booleanValue).toBe(true);
    const banner = page.locator('[data-off-banner]');
    await expect(banner).toContainText('Agents are Off since');
    await expect(banner).toContainText('Nothing automated acts');
    await look(page, `banner-${size}`);

    // Turn on: what will start is listed first; nothing turns on before the member confirms.
    await page.locator('[data-off-banner]').getByRole('button', { name: 'Turn on…' }).click();
    const on = page.getByRole('dialog', { name: 'Turn agents on?' });
    await expect(on.locator('[data-off-will-start] li')).toHaveText(['Reply · Thursday meeting']);
    await look(page, `turnon-${size}`);
    await on.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('dialog', { name: /Agents off since/ })).toBeVisible();
    await page.keyboard.press('Escape');
    expect((await offDoc(s.wid, s.uid))?.all?.booleanValue).toBe(true);
    await page.locator('[data-off-banner]').getByRole('button', { name: 'Turn on…' }).click();
    await page
      .getByRole('dialog', { name: 'Turn agents on?' })
      .getByRole('button', { name: 'Turn on' })
      .click();
    await expect(page.locator('[data-off-pill]:visible').first()).toHaveText('Agents on');
    await expect(page.locator('[data-off-banner]')).toHaveCount(0);
    await expect
      .poll(async () => (await offDoc(s.wid, s.uid))?.since?.nullValue !== undefined)
      .toBe(true);

    // One agent Off.
    await page.locator('[data-off-pill]:visible').first().click();
    const d2 = page.getByRole('dialog', { name: 'Turn agents off' });
    await d2.getByRole('switch', { name: 'All agents' }).click();
    await d2.getByRole('switch', { name: 'Books' }).click();
    await d2.getByRole('button', { name: 'Turn off' }).click();
    await expect(page.locator('[data-off-pill]:visible').first()).toHaveText('Off: Books');
    await expect(page.locator('[data-off-banner]')).toContainText('Books is Off since');
    await expect
      .poll(async () => (await offDoc(s.wid, s.uid))?.agents?.arrayValue?.values?.[0]?.stringValue)
      .toBe(s.books.aid);
    await look(page, `one-${size}`);

    // On every page (an in-app move: the pill is the shell's).
    await page
      .getByRole(size === '1440' ? 'complementary' : 'navigation', {
        name: size === '1440' ? 'Main' : 'Tabs',
      })
      .getByRole('link', { name: /^Inbox/ })
      .first()
      .click();
    await expect(page).toHaveURL(/\/inbox/);
    await expect(page.locator('[data-off-pill]:visible').first()).toHaveText('Off: Books');
    await expect(page.locator('[data-off-banner]')).toHaveCount(0);
  } finally {
    await s.books.stop();
  }
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');
  test('the pill, the panel, the Today banner; turning on lists what starts', async ({ page }) => {
    test.setTimeout(180_000);
    await flow(page, '1440');
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test('the pill in the header, the panel, the banner', async ({ page }) => {
    test.setTimeout(180_000);
    await flow(page, '390');
  });
});
