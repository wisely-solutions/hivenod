import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, oobCode, oobLink, person, settle, signIn } from './helpers';

const PASSWORD = 'correct horse battery';

async function openPanel(page: import('@playwright/test').Page, mode: 'create' | 'signin') {
  await page.goto(mode === 'create' ? '/signin?mode=create' : '/signin');
}

test('sign up with email: blocked until the address is confirmed, then a workspace', async ({
  page,
}) => {
  const who = person('Emma Email');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();

  // Unconfirmed: one screen only.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText(who.email)).toBeVisible();
  // Sign-up just sent the mail: the cooldown is already running, then Resend enables.
  await expect(page.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Hi / })).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await settle(page);
  await page.screenshot({
    path: `${process.env.SHOTS ?? 'test-results'}/check-your-email-${page.viewportSize()!.width}.png`,
  });

  // The link in the email opens our own action page.
  const code = await oobCode(who.email, 'VERIFY_EMAIL');
  await page.goto(`/auth/action?mode=verifyEmail&oobCode=${code}`);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Hivenod' }).click();

  // Confirmed: the workspace is created (the rules now let it through).
  await expect(page.getByRole('heading', { name: /^Hi emma/ })).toBeVisible();
});

test('the Check your email screen moves on by itself once confirmed elsewhere', async ({
  page,
  browser,
}) => {
  const who = person('Nora Notice');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto(
    `/auth/action?mode=verifyEmail&oobCode=${await oobCode(who.email, 'VERIFY_EMAIL')}`,
  );
  await expect(p2.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await other.close();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: /^Hi nora/ })).toBeVisible({ timeout: 15_000 });
});

test('sign in with a confirmed account, wrong password says so, forgot password resets', async ({
  page,
}) => {
  const who = person('Rita Reset');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.goto(
    `/auth/action?mode=verifyEmail&oobCode=${await oobCode(who.email, 'VERIFY_EMAIL')}`,
  );
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Hivenod' }).click();
  await expect(page.getByRole('heading', { name: /^Hi rita/ })).toBeVisible();
  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();

  await openPanel(page, 'signin');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');

  // Forgot password: the emulator "sends" a reset code; our action page sets a new password.
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(who.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/link to choose a new password is on its way/)).toBeVisible();
  await page.goto(
    `/auth/action?mode=resetPassword&oobCode=${await oobCode(who.email, 'PASSWORD_RESET')}`,
  );
  await page.getByLabel('New password').fill('a brand new password');
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await page.getByRole('link', { name: 'Sign in' }).click();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill('a brand new password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Hi rita/ })).toBeVisible();
});

test('an existing address is not revealed; an expired link is explained', async ({ page }) => {
  const who = person('Dora Dup');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('link', { name: 'Get started' }).first()).toBeVisible();
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  // Neutral: it does not say whether the address has an account.
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText(/If .* can be used for a new account/)).toBeVisible();
  await expect(page.getByText(/already has an account/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeVisible();

  await page.goto('/auth/action?mode=verifyEmail&oobCode=bogus');
  await expect(page.getByRole('heading', { name: 'This link did not work' })).toBeVisible();
});

test('Google still works from the product page', async ({ page }) => {
  const who = person('Gina Google');
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: /^Hi Gina/ })).toBeVisible();
});

test('the emails carry a continue URL that lands on Hivenod', async ({ page }) => {
  const who = person('Carl Continue');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  const verify = await oobLink(who.email, 'VERIFY_EMAIL');
  expect(verify).toBe(`${new URL(page.url()).origin}/auth/action?done=verified`);
  await page.goto(
    `/auth/action?mode=verifyEmail&oobCode=${await oobCode(who.email, 'VERIFY_EMAIL')}`,
  );
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  // Firebase's Continue button goes to that URL: a confirmed screen, then the app.
  await page.goto(verify!);
  await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  await page.getByRole('link', { name: 'Open Hivenod' }).click();
  await expect(page.getByRole('heading', { name: /^Hi carl/ })).toBeVisible();

  await page.goto('/me');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/signin');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill(who.email);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText(/is on its way/)).toBeVisible();
  const reset = await oobLink(who.email, 'PASSWORD_RESET');
  expect(reset).toBe(`${new URL(page.url()).origin}/auth/action?done=reset`);
  await page.goto(reset!);
  await expect(page.getByRole('heading', { name: 'Password changed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});

test('the panel text follows the mode', async ({ page }) => {
  await page.goto('/signin');
  await expect(page.getByText('Sign in to see what is waiting on you.')).toBeVisible();
  await expect(page.getByText('New here? Choose Create account')).toBeVisible();
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByText('Create your account and start your first workspace.')).toBeVisible();
  await expect(page.getByText(/Signing in creates your workspace/)).toHaveCount(0);
  await expect(page.getByText('Sign in to see what is waiting on you.')).toHaveCount(0);
  await expect(page.getByText(/At least 8 characters, and not a common password/)).toBeVisible();
  await page.getByRole('button', { name: 'Have an account? Sign in' }).click();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByText(/Forgot your password\?/)).toBeVisible();
  await expect(page.getByText(/Sign in to see/)).toHaveCount(0);
});

test('a malformed address and a common password are refused', async ({ page }) => {
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill('a@b');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('alert')).toHaveText('Enter a valid email address');
  await page.getByLabel('Email').fill('someone@example.com');
  await page.getByLabel('Password').fill('Password1');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('too common');
  await page.getByLabel('Password').fill('short');
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('at least 8');
  await page.getByRole('button', { name: 'Have an account? Sign in' }).click();
  await page.getByLabel('Email').fill('a@b');
  await page.getByLabel('Password').fill('whatever12');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Enter a valid email address');
});

test('Resend: a refused send shows a countdown, never a dead button', async ({ page }) => {
  const who = person('Rita Refused');
  await openPanel(page, 'create');
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click();
  await expect(page.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeEnabled({ timeout: 10_000 });

  // Firebase starts refusing (the emulator never rate-limits, so simulate its answer).
  await page.route('**/accounts:sendOobCode*', (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 400, message: 'TOO_MANY_ATTEMPTS_TRY_LATER' } }),
    }),
  );
  await page.getByRole('button', { name: 'Resend email' }).click();
  await expect(page.getByText(/^Try again in \d+s\.$/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resend in \d+s$/ })).toBeDisabled();
  await expect(page.getByText(/Could not send it now/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resend email' })).toBeEnabled({ timeout: 15_000 });
});
