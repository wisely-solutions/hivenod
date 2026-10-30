import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

async function enter(page: Page, name: string) {
  const who = person(name);
  await page.goto('/');
  await signIn(page, who);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  return { who, wid: await workspaceOf(who.email), uid: await uidOf(who.email) };
}

async function axe(page: Page) {
  // Not only "no animation running": a tab's data and its buttons (enabled once a live config
  // arrives) still fade colours in under load, and axe then reads a half-way colour.
  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

test('old Me and Settings addresses forward to the matching Account or Organization tab', async ({
  page,
}) => {
  await enter(page, 'Rita Redirect');
  for (const [from, to, label] of [
    ['/me', '/account/profile', 'Profile'],
    ['/me/members', '/settings/members', 'Members'],
    ['/me/groups', '/settings/groups', 'Groups'],
    ['/me/notifications', '/account/notifications', 'Notifications'],
    ['/settings', '/account/profile', 'Profile'],
    ['/settings/profile', '/account/profile', 'Profile'],
    ['/settings/notifications', '/account/notifications', 'Notifications'],
    ['/settings/nonsense', '/account/profile', 'Profile'],
    ['/account', '/account/profile', 'Profile'],
    ['/account/members', '/settings/members', 'Members'],
    // The Projects tab was removed (OE8Fm slice 10): its old address opens Organization.
    ['/settings/projects', '/settings/organization', 'Rita’s organization'],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`${to}$`));
    await expect(tab(page, label)).toHaveAttribute('aria-selected', 'true');
  }
});

test('every tab opens, is axe clean and fits the screen', async ({ page }) => {
  test.setTimeout(90_000);
  const { who } = await enter(page, 'Tabi Tabs');
  // Account: yours, in every organization (item icVly).
  await page.goto('/account/profile');
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Account' }).getByRole('tab')).toHaveCount(2);
  for (const label of ['Profile', 'Notifications'] as const) {
    await tab(page, label).click();
    await expect(page).toHaveURL(new RegExp(`/account/${label.toLowerCase()}$`));
    await expect(
      page.getByRole('heading', { name: label, level: 2, exact: true }).first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await axe(page);
  }
  // Organization settings: the organization's name on the page and on its first tab.
  await page.goto('/settings/organization');
  await expect(
    page.getByRole('heading', { name: 'Organization settings', level: 1 }),
  ).toBeVisible();
  const org = `${who.name.split(' ')[0]}’s organization`;
  await expect(page.locator('[data-org-scope]')).toContainText(org);
  const tabs = page.getByRole('tablist', { name: 'Organization settings' }).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(tab(page, 'Projects')).toHaveCount(0);
  await expect(tabs.first()).toHaveText(org);
  for (const [label, path, heading] of [
    [org, 'organization', 'Organization'],
    ['Members', 'members', 'Members'],
    ['Groups', 'groups', 'Groups'],
    ['Inbox labels', 'labels', 'Inbox labels'],
  ] as const) {
    await tab(page, label).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${path}$`));
    await expect(
      page.getByRole('heading', { name: heading, level: 2, exact: true }).first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await axe(page);
  }
});

test('phone and desktop: the avatar opens Account', async ({ page }) => {
  await enter(page, 'Nav Person');
  const entry = page.getByRole('link', { name: /(^|, )Account$/ }).first();
  await entry.click();
  await expect(page).toHaveURL(/\/account\/profile$/);
  await expect(page.getByRole('link', { name: 'Me', exact: true })).toHaveCount(0);
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  test.skip(info.project.name !== 'desktop-1440', 'sizes are set here');
  test.setTimeout(180_000);
  const dir = process.env.SHOTS_DIR!;
  await enter(page, 'Shot Person');
  const sizes = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } };
  for (const [name, vp] of Object.entries(sizes)) {
    await page.setViewportSize(vp);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const t of ['profile', 'organization', 'members', 'groups', 'notifications']) {
        await page.goto(`/settings/${t}`);
        await expect(page.getByRole('tab', { name: new RegExp(t, 'i') })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${dir}/${t}-${name}-${theme}.png`, fullPage: true });
      }
    }
  }
});

test('an admin exports the organization as one JSON file', async ({ page }) => {
  test.setTimeout(90_000);
  const { who, wid, uid } = await enter(page, 'Eva Export');
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/p1`, projectFields('Export me', uid));
  await adminSet(`${base}/projects/p1/items/i1`, { title: 'An item', status: 'queued' });
  await adminSet(`${base}/projects/p1/items/i1/attachments/a1`, {
    kind: 'html',
    name: 'plan.html',
    content: '<p>inline</p>',
  });
  await adminSet(`${base}/projects/p1/decisions/d1`, { outcome: 'approved' });
  await adminSet(`${base}/runs/r1`, { projectId: 'p1', status: 'done' });
  await adminSet(`${base}/runs/r1/log/0`, { text: 'a line' });
  await adminSet(`${base}/calendar/${uid}_ev1`, { memberUid: uid, title: 'Standup' });

  await page.goto('/settings/organization');
  const button = page.getByRole('button', { name: 'Export organization data (JSON)' });
  await expect(button).toBeVisible();
  await axe(page);
  const download = page.waitForEvent('download');
  await button.click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^.+-export-\d{4}-\d{2}-\d{2}\.json$/);
  const stream = await file.createReadStream();
  let text = '';
  for await (const chunk of stream) text += chunk;
  const json = JSON.parse(text);
  expect(json).toMatchObject({ format: 'hivenod-org-export', version: 1, workspaceId: wid });
  expect(json.projects.map((p: { id: string }) => p.id)).toContain('p1');
  const project = json.projects.find((p: { id: string }) => p.id === 'p1');
  expect(project.data.name).toBe('Export me');
  expect(project.items[0].attachments[0].data.content).toBe('<p>inline</p>');
  expect(project.decisions[0].data.outcome).toBe('approved');
  expect(json.runs[0].log[0].data.text).toBe('a line');
  expect(json.calendar[0].data.title).toBe('Standup');
  expect(json.counts.projects).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: /^Done: \d+ documents/ })).toBeVisible();
  if (process.env.EXPORT_SHOT && test.info().project.name.startsWith('desktop')) {
    await page.screenshot({ path: process.env.EXPORT_SHOT });
  }
  void who;
});
