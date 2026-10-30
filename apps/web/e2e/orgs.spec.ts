import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminUpdate,
  adminSet,
  expectNoHorizontalScroll,
  newPerson,
  person,
  signIn,
  userTheme,
  uidOf,
  workspaceOf,
  settle,
  expectCurrentOrg,
  openSwitcher,
} from './helpers';
import { personalOrgPlan, SERVER_TIME } from '@hive/shared';

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

test('the last admin cannot be demoted or removed; promoting a second admin frees them', async ({
  page,
  browser,
}) => {
  test.setTimeout(60_000); // two signed-in people and a cold load of each, on a loaded machine
  const admin = person('Ada Admin');
  const member = person('Max Member');
  await page.goto('/');
  await signIn(page, admin);
  await expect(page.getByRole('heading', { name: /^Good \w+, Ada$/ })).toBeVisible({
    timeout: 20_000,
  });

  // The organization is created a moment after the greeting shows: inviting before that loses the
  // open dialog when the session switches to it (the invite is made, the link never appears).
  await expect
    .poll(() => workspaceOf(admin.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
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
  await expect(maxSide.page.getByRole('heading', { name: /^Good \w+, Max$/ })).toBeVisible();

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
  test.setTimeout(60_000); // two signed-in people and a cold load of each, on a loaded machine
  const admin = person('Ada Admin');
  const member = person('Max Member');
  await page.goto('/');
  await signIn(page, admin);
  await expect(page.getByRole('heading', { name: /^Good \w+, Ada$/ })).toBeVisible({
    timeout: 20_000,
  });

  // The organization is created a moment after the greeting shows: inviting before that loses the
  // open dialog when the session switches to it (the invite is made, the link never appears).
  await expect
    .poll(() => workspaceOf(admin.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
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
  await expect(mp.getByRole('heading', { name: /^Good \w+, Max$/ })).toBeVisible();

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

test('one person, several organizations: create, switch, and keep them apart', async ({ page }) => {
  test.setTimeout(90_000);
  const who = person('Sam Several');
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: /^Good \w+, Sam$/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const first = await workspaceOf(who.email);

  // A second organization, from Settings.
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New organization' });
  await dialog.getByLabel('Name').fill('Second Co');
  await axe(page);
  await dialog.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Second Co is ready.')).toBeVisible();
  await expect.poll(() => workspaceOf(who.email)).not.toBe(first);
  await expectCurrentOrg(page, 'Second Co');
  // The link banner must not appear after creating an org (card fBvI3nno: it used to stick).
  await page.waitForTimeout(8000);
  await expect(page.getByTestId('reconnecting')).toHaveCount(0);

  // Switch back with the switcher: both are listed, the old data is back.
  await openSwitcher(page);
  const list = page.getByRole('list', { name: 'Your organizations' });
  await expect(list.getByRole('button')).toHaveCount(2);
  await expectNoHorizontalScroll(page);
  await axe(page);
  await list.getByRole('button', { name: /Sam’s organization/ }).click();
  await expectCurrentOrg(page, 'Sam’s organization');

  // The choice sticks across a reload.
  await page.reload();
  await expectCurrentOrg(page, 'Sam’s organization');
});

test('the chosen organization stays through reloads, a second tab and profile writes (card gypyWz1I)', async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const who = person('Kim Keeper');
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: /^Good \w+, Kim$/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const first = await workspaceOf(who.email);

  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  await page.getByRole('dialog', { name: 'New organization' }).getByLabel('Name').fill('Chosen Co');
  await page
    .getByRole('dialog', { name: 'New organization' })
    .getByRole('button', { name: 'Create organization' })
    .click();
  await expectCurrentOrg(page, 'Chosen Co');
  await expect.poll(() => workspaceOf(who.email)).not.toBe(first);
  const chosen = await workspaceOf(who.email);

  // A second tab of the same browser opens, loads, and reloads: nothing moves.
  const tab2 = await context.newPage();
  await tab2.goto('/');
  await expectCurrentOrg(tab2, 'Chosen Co');
  await tab2.reload();
  await expectCurrentOrg(tab2, 'Chosen Co');
  await page.reload();
  await expectCurrentOrg(page, 'Chosen Co');

  // The other tab changes the theme (a profile write): the active organization is untouched.
  await tab2.goto('/me');
  await tab2.getByRole('button', { name: 'Dark' }).click();
  await expect.poll(() => userTheme(who.email)).toBe('dark');
  await expectCurrentOrg(page, 'Chosen Co');
  expect(await workspaceOf(who.email)).toBe(chosen);
  await tab2.close();
});

test('a Personal organization made by the operator command shows in the switcher, not switched to (item fJnu6)', async ({
  page,
}, info) => {
  const pat = person('Pia Personal');
  await page.goto('/');
  await signIn(page, pat);
  await expect(page.getByRole('heading', { name: /^Good \w+, Pia$/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => workspaceOf(pat.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(pat.email);
  const uid = await uidOf(pat.email);
  // The batch `notifier personal-org --apply` writes (packages/shared/src/personalOrg.ts),
  // committed here as the emulator's admin: server time becomes now, the switcher entry the list.
  const pid = `personal${Date.now()}`;
  const plan = personalOrgPlan(
    { workspaceId: pid, actor: { type: 'human', id: uid, name: 'Pia Personal' } },
    { profile: { name: 'Pia Personal', email: pat.email, photoURL: null, color: 'c1' } },
  );
  const now = new Date();
  const plain = (v: unknown): unknown =>
    v === SERVER_TIME
      ? now
      : Array.isArray(v)
        ? v.map(plain)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]))
          : v;
  for (const op of plan.ops.filter((o) => o.kind === 'set'))
    await adminSet(op.path, plain(op.data) as Record<string, unknown>);
  await adminUpdate(`users/${uid}`, { workspaceIds: [wid, pid] });

  await page.reload();
  await settle(page);
  // Still in their own organization; Personal is one tap away in the switcher.
  await expectCurrentOrg(page, 'Personal', { not: true });
  await openSwitcher(page);
  const list = page.getByRole('list', { name: 'Your organizations' });
  await expect(list.getByRole('button', { name: /Personal/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
  if (process.env.SHOTS_DIR)
    await page.screenshot({
      path: `${process.env.SHOTS_DIR}/${info.project.name}-personal-switcher.png`,
    });
  await list.getByRole('button', { name: /Personal/ }).click();
  await expectCurrentOrg(page, 'Personal');
});
