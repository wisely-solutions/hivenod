import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  fastTimers,
  person,
  projectFields,
  signIn,
  UNDO_WAIT,
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
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

test('old Me addresses forward to the matching Settings tab', async ({ page }) => {
  await enter(page, 'Rita Redirect');
  for (const [from, to] of [
    ['/me', 'profile'],
    ['/me/members', 'members'],
    ['/me/groups', 'groups'],
    ['/me/notifications', 'notifications'],
    ['/settings', 'profile'],
    ['/settings/nonsense', 'profile'],
  ] as const) {
    await page.goto(from);
    await expect(page).toHaveURL(new RegExp(`/settings/${to}$`));
    await expect(tab(page, to[0]!.toUpperCase() + to.slice(1))).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
});

test('every tab opens, is axe clean and fits the screen', async ({ page }) => {
  test.setTimeout(90_000);
  await enter(page, 'Tabi Tabs');
  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('tablist', { name: 'Settings' }).getByRole('tab')).toHaveCount(6);
  for (const [label, heading] of [
    ['Profile', 'Profile'],
    ['Organization', 'Organization'],
    ['Members', 'Members'],
    ['Groups', 'Groups'],
    ['Projects', 'Projects'],
    ['Notifications', 'Notifications'],
  ] as const) {
    await tab(page, label).click();
    await expect(page).toHaveURL(new RegExp(`/settings/${label.toLowerCase()}$`));
    await expect(
      page.getByRole('heading', { name: heading, level: 2, exact: true }).first(),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);
    await axe(page);
  }
});

test('Projects tab: edit, archive with Undo, restore; Open process; no delete', async ({
  page,
}) => {
  test.setTimeout(90_000);
  await fastTimers(page);
  const { wid, uid } = await enter(page, 'Penny Projects');
  await adminSet(`workspaces/${wid}/projects/a1`, projectFields('Alpha project', uid));
  await adminSet(`workspaces/${wid}/projects/b1`, projectFields('Beta project', uid));
  await page.goto('/settings/projects');
  const list = page.getByRole('list', { name: 'Projects' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(0);

  // Edit: name, emoji and description are saved.
  await list.getByRole('button', { name: 'Edit Alpha project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Alpha project' });
  await dialog.getByLabel('Name').fill('Alpha renamed');
  await dialog.getByLabel('Description').fill('The first one');
  await dialog.getByRole('radio', { name: 'Emoji 🚀' }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(list.getByRole('listitem', { name: 'Alpha renamed' })).toContainText(
    'The first one',
  );
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/a1`))?.fields.description?.stringValue,
    )
    .toBe('The first one');
  expect((await adminDoc(`workspaces/${wid}/projects/a1`))?.fields.emoji?.stringValue).toBe('🚀');

  // Archive, Undo: nothing is written.
  await list.getByRole('button', { name: 'Archive Beta project' }).click();
  // The row stays and shows Archived at once (no blink), with Restore that cancels the archive.
  await expect(list.getByRole('listitem', { name: 'Beta project' })).toContainText('Archived');
  await list.getByRole('button', { name: 'Restore Beta project' }).click();
  await expect(list.getByRole('listitem', { name: 'Beta project' })).not.toContainText('Archived');
  await page.waitForTimeout(UNDO_WAIT);
  expect(
    (await adminDoc(`workspaces/${wid}/projects/b1`))?.fields.archivedAt?.nullValue,
  ).toBeDefined();

  // Archive for real: it stays listed, marked Archived, with Restore.
  await list.getByRole('button', { name: 'Archive Beta project' }).click();
  await expect(page.getByText('Beta project archived.')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/b1`))?.fields.archivedAt?.timestampValue,
    )
    .toBeTruthy();
  const beta = list.getByRole('listitem', { name: 'Beta project' });
  await expect(beta).toContainText('Archived');
  await beta.getByRole('button', { name: 'Restore Beta project' }).click();
  await expect(beta).not.toContainText('Archived');
  await expect
    .poll(
      async () => (await adminDoc(`workspaces/${wid}/projects/b1`))?.fields.archivedAt?.nullValue,
    )
    .toBeDefined();

  // Open process goes to the editor.
  await list.getByRole('link', { name: /Open process of Alpha renamed/ }).click();
  await expect(page).toHaveURL(/\/p\/a1\/process$/);
});

test('phone and desktop: the Settings entry replaces Me', async ({ page }) => {
  await enter(page, 'Nav Person');
  const entry = page.getByRole('link', { name: /(^|, )Settings$/ }).first();
  await entry.click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
  await expect(page.getByRole('link', { name: 'Me', exact: true })).toHaveCount(0);
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  test.skip(info.project.name !== 'desktop-1440', 'sizes are set here');
  test.setTimeout(180_000);
  const dir = process.env.SHOTS_DIR!;
  const { wid, uid } = await enter(page, 'Shot Person');
  await adminSet(`workspaces/${wid}/projects/a1`, projectFields('Alpha project', uid));
  await adminSet(`workspaces/${wid}/projects/b1`, {
    ...projectFields('Beta project', uid),
    archivedAt: new Date(),
    description: 'Finished last quarter',
  });
  const sizes = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } };
  for (const [name, vp] of Object.entries(sizes)) {
    await page.setViewportSize(vp);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const t of [
        'profile',
        'organization',
        'members',
        'groups',
        'projects',
        'notifications',
      ]) {
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
