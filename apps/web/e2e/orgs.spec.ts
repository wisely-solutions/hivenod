import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  newPerson,
  person,
  projectFields,
  signIn,
  userTheme,
  uidOf,
  workspaceOf,
  settle,
} from './helpers';

/** Modals fade in: axe on a half-transparent surface reports a bogus color-contrast failure. */
async function settled(page: Page) {
  await page.waitForFunction(() => {
    if (document.getAnimations().some((a) => a.playState === 'running')) return false;
    return [...document.querySelectorAll('[role="dialog"]')].every((d) => {
      for (let el: Element | null = d; el; el = el.parentElement)
        if (Number(getComputedStyle(el).opacity) < 1) return false;
      return true;
    });
  });
}

async function axe(page: Page) {
  await settled(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

const switcher = (page: Page) => page.getByRole('button', { name: /, switch organization$/ });

test('an admin adds a member to a project; the member sees nothing until then', async ({
  page,
  browser,
}) => {
  const admin = person('Ada Admin');
  const member = person('Max Member');

  // The admin starts an organization with two projects, one the member will never be given.
  await page.goto('/');
  await signIn(page, admin);
  await expect(page.getByRole('heading', { name: 'Hi Ada' })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(admin.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(admin.email);
  const adminUid = await uidOf(admin.email);
  await adminSet(`workspaces/${wid}/projects/sec`, projectFields('Secret plans', adminUid));
  await adminSet(`workspaces/${wid}/projects/open`, projectFields('Open blog', adminUid));

  // Invite Max as a plain member.
  await page.goto('/me/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(member.email);
  await page.getByRole('radio', { name: /Member/ }).check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Done' }).click();

  const maxSide = await newPerson(browser);
  const mp = maxSide.page;
  await mp.goto(link);
  await signIn(mp, member);
  await mp.getByRole('button', { name: 'Join organization' }).click();
  await expect(mp.getByRole('heading', { name: 'Hi Max' })).toBeVisible();

  // Max sees no projects at all, and says so.
  await mp.goto('/projects');
  await expect(mp.getByRole('heading', { name: 'You are not on any project yet' })).toBeVisible();
  await expect(mp.getByText('Secret plans')).toHaveCount(0);
  await expect(mp.getByText('Open blog')).toHaveCount(0);
  await expectNoHorizontalScroll(mp);
  await axe(mp);
  // The admin sees both, and can open the people list.
  await page.goto('/projects');
  await expect(page.getByRole('heading', { name: 'Secret plans' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Open blog' })).toBeVisible();

  // The admin adds Max to the open project only.
  await page.getByRole('button', { name: 'People on Open blog' }).click();
  const dialog = page.getByRole('dialog', { name: 'People on Open blog' });
  await expect(dialog.getByRole('checkbox', { name: 'Ada Admin' })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Ada Admin' })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: 'Max Member' }).click();
  await axe(page);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('People on Open blog saved.')).toBeVisible();
  await expect(dialog).toBeHidden();

  // It shows up for Max, live. The secret one stays hidden.
  await expect(mp.getByRole('heading', { name: 'Open blog' })).toBeVisible();
  await expect(mp.getByText('Secret plans')).toHaveCount(0);
  await expect(mp.getByRole('button', { name: /^People on / })).toHaveCount(0);
  await settle(mp);
  await expectNoHorizontalScroll(mp);

  // Taking him off hides it again.
  await page.getByRole('button', { name: 'People on Open blog' }).click();
  const again = page.getByRole('dialog', { name: 'People on Open blog' });
  await expect(again.getByRole('checkbox', { name: 'Max Member' })).toBeChecked();
  await again.getByRole('checkbox', { name: 'Max Member' }).click();
  await expect(again.getByRole('checkbox', { name: 'Max Member' })).not.toBeChecked();
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(again).toBeHidden();
  // (The Firestore emulator does not push a "left the result set" change to a listener, so Max
  // reloads here; the rules, not the screen, are what hide the project.)
  await mp.reload();
  await expect(mp.getByRole('heading', { name: 'You are not on any project yet' })).toBeVisible();

  // The data really is stored that way (not only hidden by the screen).
  const stored = await adminDoc(`workspaces/${wid}/projects/open`);
  expect(stored!.fields.memberUids!.arrayValue.values ?? []).toEqual([]);
  await maxSide.ctx.close();
});

test('the last admin cannot be demoted or removed; promoting a second admin frees them', async ({
  page,
  browser,
}) => {
  const admin = person('Ada Admin');
  const member = person('Max Member');
  await page.goto('/');
  await signIn(page, admin);
  await expect(page.getByRole('heading', { name: 'Hi Ada' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/me/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(member.email);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Done' }).click();
  const maxSide = await newPerson(browser);
  await maxSide.page.goto(link);
  await signIn(maxSide.page, member);
  await maxSide.page.getByRole('button', { name: 'Join organization' }).click();
  await expect(maxSide.page.getByRole('heading', { name: 'Hi Max' })).toBeVisible();

  // Alone as admin: her role and her remove button are locked.
  await expect(page.getByText('Max Member', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Role for Ada Admin' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove Ada Admin' })).toBeDisabled();
  await expectNoHorizontalScroll(page);
  await axe(page);

  // Promote Max: he gets the admin screens at once, and Ada can now step down.
  await maxSide.page.goto('/me/members');
  await page.getByRole('combobox', { name: 'Role for Max Member' }).selectOption('admin');
  await expect(maxSide.page.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Role for Ada Admin' })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Role for Ada Admin' }).selectOption('member');
  await expect(page.getByRole('combobox')).toHaveCount(0); // Ada is a member now: no controls

  // Max is the only admin now and is locked in turn.
  await maxSide.page.goto('/me/members');
  await expect(maxSide.page.getByRole('combobox', { name: 'Role for Max Member' })).toBeDisabled();
  await maxSide.ctx.close();
});

test('a member can leave the organization; the only admin cannot', async ({ page, browser }) => {
  const admin = person('Ada Admin');
  const member = person('Max Member');
  await page.goto('/');
  await signIn(page, admin);
  await expect(page.getByRole('heading', { name: 'Hi Ada' })).toBeVisible({ timeout: 20_000 });

  await page.goto('/me/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(member.email);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Done' }).click();
  const maxSide = await newPerson(browser);
  const mp = maxSide.page;
  await mp.goto(link);
  await signIn(mp, member);
  await mp.getByRole('button', { name: 'Join organization' }).click();
  await expect(mp.getByRole('heading', { name: 'Hi Max' })).toBeVisible();

  // Ada is the only admin: she cannot leave.
  await page.goto('/settings/organization');
  await expect(page.getByRole('button', { name: 'Leave organization' })).toBeDisabled();
  await expect(page.getByText('You are the only admin.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Leave organization' }),
  ).toHaveAccessibleDescription(/only admin/);

  // Max leaves, after a confirmation.
  await mp.goto('/settings/organization');
  await mp.getByRole('button', { name: 'Leave organization' }).click();
  const dialog = mp.getByRole('dialog', { name: /^Leave / });
  await axe(mp);
  await dialog.getByRole('button', { name: 'Leave', exact: true }).click();
  await expect(
    mp.getByRole('heading', { name: 'You are no longer in this organization' }),
  ).toBeVisible();

  // Ada sees him gone, and the log says he left.
  await page.goto('/me/members');
  await expect(page.getByText('Max Member', { exact: true })).toHaveCount(0);
  await maxSide.ctx.close();
});

test('one person, several organizations: create, switch, and keep their projects apart', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const who = person('Sam Several');
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: 'Hi Sam' })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const first = await workspaceOf(who.email);
  const uid = await uidOf(who.email);
  await adminSet(`workspaces/${first}/projects/a1`, projectFields('Alpha project', uid));

  // A second organization, from Settings.
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New organization' });
  await dialog.getByLabel('Name').fill('Second Co');
  await axe(page);
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Second Co is ready.')).toBeVisible();
  await expect.poll(() => workspaceOf(who.email)).not.toBe(first);
  await expect(switcher(page)).toHaveAccessibleName('Second Co, switch organization');
  // The link banner must not appear after creating an org (card fBvI3nno: it used to stick).
  await page.waitForTimeout(8000);
  await expect(page.getByTestId('reconnecting')).toHaveCount(0);

  // It starts empty, with its own projects.
  await page.goto('/projects');
  await expect(
    page.getByRole('heading', { name: 'Agents do the work. You make the decisions.' }),
  ).toBeVisible();
  await expect(page.getByText('Alpha project')).toHaveCount(0);

  // Switch back with the switcher: both are listed, the old data is back.
  await switcher(page).click();
  const list = page.getByRole('list', { name: 'Your organizations' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  await axe(page);
  await list.getByRole('button', { name: /Sam’s organization/ }).click();
  await expect(switcher(page)).toHaveAccessibleName('Sam’s organization, switch organization');
  await expect(page.getByRole('heading', { name: 'Alpha project' })).toBeVisible();

  // The choice sticks across a reload.
  await page.reload();
  await expect(switcher(page)).toHaveAccessibleName('Sam’s organization, switch organization');
});

test('the chosen organization stays through reloads, a second tab and profile writes (card gypyWz1I)', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const who = person('Kim Keeper');
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: 'Hi Kim' })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const first = await workspaceOf(who.email);

  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  await page.getByRole('dialog', { name: 'New organization' }).getByLabel('Name').fill('Chosen Co');
  await page
    .getByRole('dialog', { name: 'New organization' })
    .getByRole('button', { name: 'Create organization' })
    .click();
  await expect(switcher(page)).toHaveAccessibleName('Chosen Co, switch organization');
  await expect.poll(() => workspaceOf(who.email)).not.toBe(first);
  const chosen = await workspaceOf(who.email);

  // A second tab of the same browser opens, loads, and reloads: nothing moves.
  const tab2 = await context.newPage();
  await tab2.goto('/');
  await expect(switcher(tab2)).toHaveAccessibleName('Chosen Co, switch organization');
  await tab2.reload();
  await expect(switcher(tab2)).toHaveAccessibleName('Chosen Co, switch organization');
  await page.reload();
  await expect(switcher(page)).toHaveAccessibleName('Chosen Co, switch organization');

  // The other tab changes the theme (a profile write): the active organization is untouched.
  await tab2.goto('/me');
  await tab2.getByRole('button', { name: 'Dark' }).click();
  await expect.poll(() => userTheme(who.email)).toBe('dark');
  await expect(switcher(page)).toHaveAccessibleName('Chosen Co, switch organization');
  expect(await workspaceOf(who.email)).toBe(chosen);
  await tab2.close();
});
