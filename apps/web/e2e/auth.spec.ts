import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminPatch,
  userTheme,
  expectNoHorizontalScroll,
  newPerson,
  parseInvite,
  person,
  signIn,
  settle,
  expectCurrentOrg,
} from './helpers';

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

for (const theme of ['light', 'dark'] as const) {
  test(`sign-in page, ${theme}: product line, one big button, accessible`, async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await page.goto('/signin');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('heading', { name: 'Agents do the work. You make the decisions.' }),
    ).toBeVisible();
    const button = page.getByRole('button', { name: 'Continue with Google' });
    await expect(button).toBeVisible();
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
  });
}

test('the backdrop stands still under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/signin');
  const animation = await page
    .locator('.fold-strip')
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe('none');
});

test('sign in, get an organization, invite someone, they join and land in a group', async ({
  page,
  browser,
}) => {
  const olivia = person('Olivia Owner');
  const max = person('Max Member');

  // 1. First sign-in creates the profile and the organization.
  await page.goto('/');
  await signIn(page, olivia, 'Continue with Google', { ui: true });
  await expect(page.getByRole('heading', { name: /^Good \w+, Olivia$/ })).toBeVisible();
  await expectCurrentOrg(page, 'Olivia’s organization');

  // 2. The owner invites Max.
  await page.goto('/me/members');
  await expect(page.getByRole('heading', { name: 'Members' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(max.email);
  await page.getByRole('radio', { name: /Member/ }).check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  expect(link).toMatch(/\/join\/.+\/.+/);
  await expect(page.getByRole('img', { name: 'QR code for the invite link' })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByText(max.email, { exact: true })).toBeVisible(); // pending invite

  // 3. Max opens the link in his own browser, signs in, joins.
  const maxSide = await newPerson(browser);
  const mp = maxSide.page;
  await mp.goto(link);
  await expect(mp.getByRole('heading', { name: /You are invited to join/ })).toBeVisible();
  await signIn(mp, max, 'Continue with Google', { ui: true });
  await expect(mp.getByRole('heading', { name: /Join / })).toBeVisible();
  await mp.getByRole('button', { name: 'Join organization' }).click();
  await expect(mp.getByRole('heading', { name: /^Good \w+, Max$/ })).toBeVisible();

  // 4. The owner sees Max and adds him to a new group "Product".
  await expect(page.getByText('Max Member', { exact: true })).toBeVisible();
  await expect(page.getByText(max.email, { exact: true })).toHaveCount(1); // a member now, no longer pending
  await page.goto('/me/groups');
  await page.getByRole('button', { name: 'New group' }).first().click();
  await page.getByLabel('Name').fill('Product');
  await page.getByRole('button', { name: /Max Member/ }).click();
  await axe(page);
  await page.getByRole('button', { name: 'Create group' }).click();
  await expect(page.getByRole('button', { name: 'Edit group Product' })).toContainText('1 member');

  // 5. Max sees the group but none of the management actions.
  await mp.goto('/me/groups');
  await expect(mp.getByText('Product')).toBeVisible();
  await expect(mp.getByRole('button', { name: 'New group' })).toHaveCount(0);
  await expect(mp.getByRole('button', { name: /Edit group/ })).toHaveCount(0);
  await mp.goto('/me/members');
  await expect(mp.getByText('Olivia Owner')).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Invite', exact: true })).toHaveCount(0);
  await expect(mp.getByRole('combobox')).toHaveCount(0);
  await expect(mp.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expectNoHorizontalScroll(mp);

  // 6. The owner changes Max's role, then removes him; Max is told.
  await page.goto('/me/members');
  await page.getByRole('combobox', { name: 'Role for Max Member' }).selectOption('admin');
  await expect(mp.getByRole('button', { name: 'Invite', exact: true })).toBeVisible(); // live: Max is an admin now
  await page.getByRole('button', { name: 'Remove Max Member' }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Max Member')).toHaveCount(0);
  await expect(
    mp.getByRole('heading', { name: 'You are no longer in this organization' }),
  ).toBeVisible();
  await maxSide.ctx.close();
});

test.describe('invite states', () => {
  async function makeInvite(page: Page, owner: ReturnType<typeof person>, invitee: string) {
    await page.goto('/');
    await signIn(page, owner, 'Continue with Google', { ui: true });
    await expect(
      page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
    ).toBeVisible();
    await page.goto('/me/members');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByLabel('Email').fill(invitee);
    await page.getByRole('button', { name: 'Create invite link' }).click();
    return page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  }

  test('expired, used and wrong-account invites explain themselves', async ({ page, browser }) => {
    const owner = person('Ida Owner');
    const guest = person('Gus Guest');
    const link = await makeInvite(page, owner, guest.email);
    const { wid, code } = parseInvite(link);
    const path = `workspaces/${wid}/invites/${code}`;

    // wrong account
    const other = await newPerson(browser);
    await other.page.goto(link);
    await signIn(other.page, person('Wrong Person'), 'Continue with Google', { ui: true });
    await expect(
      other.page.getByRole('heading', { name: 'This invite is not available for you' }),
    ).toBeVisible();
    await expectNoHorizontalScroll(other.page);
    await axe(other.page);
    await other.ctx.close();

    // expired
    await adminPatch(path, { expiresAt: new Date(Date.now() - 60_000) });
    const guestSide = await newPerson(browser);
    await guestSide.page.goto(link);
    await signIn(guestSide.page, guest, 'Continue with Google', { ui: true });
    await expect(
      guestSide.page.getByRole('heading', { name: 'This invite has expired' }),
    ).toBeVisible();
    await axe(guestSide.page);

    // used by someone else
    await adminPatch(path, {
      expiresAt: new Date(Date.now() + 86_400_000),
      usedBy: 'someone-else',
    });
    await guestSide.page.reload();
    await expect(
      guestSide.page.getByRole('heading', { name: 'This invite was already used' }),
    ).toBeVisible();
    await guestSide.ctx.close();
  });
});

test('profile: theme choice sticks across reloads, name and organization can be changed', async ({
  page,
}) => {
  const who = person('Tess Tester');
  await page.goto('/');
  await signIn(page, who, 'Continue with Google', { ui: true });
  // Signed in and the profile + workspace exist; navigating earlier drops the not-yet-persisted session.
  await expect(page.getByRole('heading', { name: /^Good \w+, Tess$/ })).toBeVisible();
  await page.goto('/me'); // forwards to Account > Profile
  await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/account\/profile$/);

  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(() => userTheme(who.email)).toBe('dark'); // saved to the server
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  await axe(page);
  await page.getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  await page.getByLabel('Name', { exact: true }).fill('Tess T.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Name saved')).toBeVisible();
  await page.getByRole('button', { name: 'Violet' }).click();
  await expect(page.getByRole('button', { name: 'Violet' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // The organization's own settings are a separate page (item icVly).
  await page.goto('/settings/organization');
  await page.getByLabel('Organization name').fill('Bee team');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByText('Organization renamed')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await page.goto('/account/profile');
  await page.getByRole('button', { name: 'Sign out' }).click();
  // Signed out, "/" is the product page again.
  await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();
});
