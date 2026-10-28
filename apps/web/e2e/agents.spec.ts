import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  decodeToken,
  formatPairingCode,
  newPairingCode,
  openToken,
  pairingKeys,
  pairingPath,
  pairingRequest,
  tokenHint,
  type Sealed,
} from '@hive/shared';
import { toFirestoreValue } from '@hive/shared/firestore';
import { signInWithToken } from '@hive/shared/agent-auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc } from 'firebase/firestore';
import {
  adminSet,
  AUTH_PORT,
  expectNoHorizontalScroll,
  FIRESTORE_PORT,
  person,
  projectFields,
  signIn,
  workspaceOf,
  settle,
} from './helpers';

/** What an agent process does: only the token, a fresh app, the emulators. */
async function asAgent(token: string) {
  const app = initializeApp(
    { apiKey: 'fake', projectId: 'hive-board-43be' },
    `agent-${Math.random().toString(36).slice(2)}`,
  );
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://localhost:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', FIRESTORE_PORT);
  const who = await signInWithToken(auth, token);
  return {
    who,
    db,
    read: (path: string) => getDoc(doc(db, path)),
    done: () => deleteApp(app),
  };
}

/** Everything the page sends to Firestore and prints to the console, for the secrets check. */
function watch(page: Page) {
  const firestoreBodies: string[] = [];
  const consoleText: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`:${FIRESTORE_PORT}/`) && r.method() !== 'GET') {
      firestoreBodies.push(r.url() + (r.postData() ?? ''));
    }
  });
  page.on('console', (m) => consoleText.push(m.text()));
  page.on('pageerror', (e) => consoleText.push(String(e)));
  return { firestoreBodies, consoleText };
}

async function enter(page: Page, name: string) {
  const owner = person(name);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  const wid = await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('')
    .then(() => workspaceOf(owner.email));
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', 'seed'));
  await adminSet(`workspaces/${wid}/projects/ops`, projectFields('Ops', 'seed'));
  return { owner, wid };
}

/** New agent opens on the CLI path; the plain MCP form with a token is behind "Advanced". */
async function openTokenForm(page: Page) {
  await page.getByRole('button', { name: 'New agent' }).first().click();
  await page.getByRole('link', { name: 'Advanced: plain MCP with a token' }).click();
  await expect(page.getByRole('dialog', { name: 'New agent with a token' })).toBeVisible();
}

async function createAgent(
  page: Page,
  name: string,
  opts: { color?: string; projects?: string[] } = {},
) {
  await openTokenForm(page);
  await page.getByLabel('Name').fill(name);
  if (opts.color) await page.getByRole('radio', { name: opts.color }).click();
  if (opts.projects) {
    await page.getByRole('radio', { name: /Chosen projects/ }).check();
    for (const p of opts.projects) await page.getByRole('checkbox', { name: p }).check();
  }
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByRole('dialog', { name: `Token for ${name}` })).toBeVisible();
  return page.getByLabel('Agent token').inputValue();
}

async function saveToken(page: Page) {
  await page.getByRole('checkbox', { name: /saved this token/ }).check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByLabel('Agent token')).toBeHidden();
}

const isDenied = (e: unknown) => (e as { code?: string }).code === 'permission-denied';

test('create -> token once -> sign in -> allowed / denied -> revoke -> denied', async ({
  page,
}) => {
  const seen = watch(page);
  const { wid } = await enter(page, 'Olga Owner');
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  await expect(page.getByText('No agents yet')).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Validation first.
  await openTokenForm(page);
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Give the agent a name.')).toBeVisible();
  await page.getByLabel('Name').fill('Scout');
  await page.getByRole('radio', { name: /Chosen projects/ }).check();
  await page.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Pick at least one project.')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Create: Scout may use Blog only.
  const token = await createAgent(page, 'Scout', { color: 'Teal', projects: ['Blog'] });
  expect(token).toMatch(/^hive_agt_[A-Za-z0-9_-]+$/);
  const { p: password, w } = decodeToken(token);
  expect(w).toBe(wid);
  await expect(page.getByText('You won’t see this again.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy token' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy as env var' })).toBeVisible();

  // It cannot be dismissed by accident.
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Agent token')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Done' })).toBeDisabled();
  await saveToken(page);

  // The list shows it; the token is gone from the page, and only its hint is shown.
  const row = page.getByRole('listitem', { name: 'Scout' });
  await expect(row).toBeVisible();
  await expect(row.getByText('Offline · not connected yet')).toBeVisible();
  await expect(row.getByText('Blog', { exact: true })).toBeVisible();
  await expect(row.getByText(tokenHint(token))).toBeVisible();
  expect(await page.content()).not.toContain(token);
  expect(await page.content()).not.toContain(password);

  // An agent process signs in with only the token.
  const bot = await asAgent(token);
  expect(bot.who.workspaceId).toBe(wid);
  expect((await bot.read(`workspaces/${wid}/projects/blog`)).exists()).toBe(true);
  await bot.read(`workspaces/${wid}/projects/ops`).then(
    () => {
      throw new Error('expected the non-allowed project to be denied');
    },
    (e) => expect(isDenied(e)).toBe(true),
  );

  // Revoke names the consequences, then takes effect on the very next request.
  await row.getByRole('button', { name: 'Actions for Scout' }).click();
  await page.getByRole('menuitem', { name: 'Revoke' }).click();
  await expect(page.getByRole('dialog', { name: 'Revoke Scout?' })).toContainText(
    'It stops all its work now',
  );
  await page.getByRole('button', { name: 'Revoke agent' }).click();
  await expect(row.getByText('Revoked', { exact: true }).first()).toBeVisible();
  // The revoked row stays readable (it is dimmed by its picture, not by its text).
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await expect(row.getByRole('button', { name: 'Actions for Scout' })).toHaveCount(0);
  await bot.read(`workspaces/${wid}/projects/blog`).then(
    () => {
      throw new Error('expected the revoked token to be denied');
    },
    (e) => expect(isDenied(e)).toBe(true),
  );
  await bot.done();
  // A brand new sign-in with the same token is denied too.
  const again = await asAgent(token);
  await again.read(`workspaces/${wid}/projects/blog`).then(
    () => {
      throw new Error('expected the revoked token to be denied');
    },
    (e) => expect(isDenied(e)).toBe(true),
  );
  await again.done();

  // Acceptance: no write contains the password (or the token), and nothing was logged.
  expect(seen.firestoreBodies.length).toBeGreaterThan(0);
  expect(seen.firestoreBodies.some((b) => b.includes('agent.created'))).toBe(true);
  expect(seen.firestoreBodies.some((b) => b.includes('agent.revoked'))).toBe(true);
  for (const b of seen.firestoreBodies) {
    expect(b).not.toContain(password);
    expect(b).not.toContain(token);
    expect(b).not.toContain('hive_agt_');
  }
  for (const c of seen.consoleText) {
    expect(c).not.toContain(password);
    expect(c).not.toContain('hive_agt_');
  }
  const stored = await page.evaluate(() =>
    JSON.stringify([{ ...localStorage }, { ...sessionStorage }]),
  );
  expect(stored).not.toContain(password);
});

test('rotate: the old token stops, the new one works, the history link is kept', async ({
  page,
}) => {
  const { wid } = await enter(page, 'Rita Rotate');
  await page.goto('/agents');
  const oldToken = await createAgent(page, 'Writer');
  await saveToken(page);
  const row = page.getByRole('listitem', { name: 'Writer' }).first();
  const oldBot = await asAgent(oldToken);
  expect((await oldBot.read(`workspaces/${wid}/projects/ops`)).exists()).toBe(true);

  await row.getByRole('button', { name: 'Actions for Writer' }).click();

  await page.getByRole('menuitem', { name: 'Rotate token' }).click();
  await expect(page.getByRole('dialog', { name: /Rotate the token for Writer/ })).toContainText(
    'The old token stops working now',
  );
  await page.getByRole('button', { name: 'Rotate token', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'New token for Writer' })).toBeVisible();
  const newToken = await page.getByLabel('Agent token').inputValue();
  expect(newToken).not.toBe(oldToken);
  await saveToken(page);

  await oldBot.read(`workspaces/${wid}/projects/ops`).then(
    () => {
      throw new Error('expected the old token to be denied');
    },
    (e) => expect(isDenied(e)).toBe(true),
  );
  await oldBot.done();
  const newBot = await asAgent(newToken);
  expect((await newBot.read(`workspaces/${wid}/projects/ops`)).exists()).toBe(true);
  await newBot.done();

  const rows = page.getByRole('listitem', { name: 'Writer' });
  await expect(rows).toHaveCount(2);
  await expect(rows.first().getByText(`rotated from ${tokenHint(oldToken)}`)).toBeVisible();
  await expect(rows.nth(1).getByText('Revoked', { exact: true }).first()).toBeVisible();
});

test('members see agents but cannot create, rotate or revoke', async ({ page, browser }) => {
  await enter(page, 'Oscar Owner');
  await page.goto('/agents');
  await createAgent(page, 'Scout');
  await saveToken(page);
  // Invite Mia through the real flow, then she joins in her own browser.
  const mia = person('Mia Member');
  await page.goto('/me/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(mia.email);
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Done' }).click();
  const u = test.info().project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport,
    userAgent: u.userAgent,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
  });
  const other = await ctx.newPage();
  await other.goto(link);
  await signIn(other, mia);
  await other.getByRole('button', { name: 'Join organization' }).click();
  await expect(other.getByRole('heading', { name: 'Hi Mia' })).toBeVisible({ timeout: 20_000 });
  await other.goto('/agents');
  await expect(other.getByRole('listitem', { name: 'Scout' })).toBeVisible();
  await expect(other.getByRole('button', { name: 'New agent' })).toHaveCount(0);
  await expect(other.getByRole('button', { name: /^Actions for/ })).toHaveCount(0);
  await ctx.close();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the agents screen has no accessibility violations in ${theme}, with the token sheet open`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: theme });
    await enter(page, 'Ada Axe');
    await page.goto('/agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
    const axe = async () => {
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    };
    await axe();
    await openTokenForm(page);
    await settle(page);
    await axe();
    await page.getByLabel('Name').fill('Scout');
    await page.getByRole('button', { name: 'Create agent' }).click();
    await expect(page.getByLabel('Agent token')).toBeVisible();
    await settle(page);
    await axe();
    await saveToken(page);
    await axe();
    await expectNoHorizontalScroll(page);
  });
}

/** What `hivenod pair` does before it has a token: a pairing request, no sign-in. */
async function asTerminal(cli = 'claude') {
  const app = initializeApp(
    { apiKey: 'fake', projectId: 'hive-board-43be' },
    `terminal-${Math.random().toString(36).slice(2)}`,
  );
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', FIRESTORE_PORT);
  const keys = await pairingKeys();
  const code = newPairingCode();
  await setDoc(
    doc(db, pairingPath(code)),
    toFirestoreValue(
      pairingRequest({ publicKey: keys.publicKey, cli, host: 'laptop', folder: 'blog' }),
    ) as Record<string, unknown>,
  );
  return {
    code,
    read: () => getDoc(doc(db, pairingPath(code))),
    open: (sealed: Sealed) => openToken(sealed, keys.privateKey, code),
    done: () => deleteApp(app),
  };
}

test('connect a terminal: the code from hivenod pair creates the agent and hands it the token', async ({
  page,
}) => {
  const seen = watch(page);
  const { wid } = await enter(page, 'Tara Terminal');
  const term = await asTerminal();

  // New agent opens the Connect page: Install first, then Pair.
  await page.goto('/agents');
  await page.getByRole('button', { name: 'New agent' }).first().click();
  await expect(page).toHaveURL(/\/agents\/connect$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const setup = page.getByRole('main');
  await expect(setup.getByRole('status').filter({ hasText: 'Not paired yet' })).toBeVisible();
  await expect(setup.getByRole('list', { name: 'Setup steps' })).toContainText('Plugin');
  await expect(setup.getByLabel('Install command', { exact: true })).toHaveText(
    /^curl -fsSL https?:\/\/[^ ]+\/install\.sh \| sh$/,
  );
  await expect(setup.getByLabel('Pair command', { exact: true })).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Copy: Install command' })).toBeVisible();
  await setup.getByRole('button', { name: 'Next: Pair' }).click();
  await expect(setup.getByLabel('Pair command', { exact: true })).toHaveText('hivenod pair');
  await expect(setup.getByRole('button', { name: 'Copy: Pair command' })).toBeVisible();
  await expect(setup.getByText(/hivenod run|headless|YOLO|Remote Control/i)).toHaveCount(0);
  await expect(setup.getByText('Troubleshooting', { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
  // A wrong code first, typed by hand.
  await page.getByLabel('Code from the terminal').fill('AAAA-BBBB');
  await page.getByRole('button', { name: 'Find terminal' }).click();
  await expect(page.getByText('No terminal is waiting with this code')).toBeVisible();

  // The link the terminal prints opens the Pair step with the code filled in.
  const shown = formatPairingCode(term.code);
  await page.goto(`/agents/connect?code=${shown}`);
  await expect(page.getByLabel('Code from the terminal')).toHaveValue(shown);
  await expect(page.getByLabel('Pair command', { exact: true })).toHaveText('hivenod pair');
  const modal = page.getByRole('main');
  // The Pair step confirms the waiting terminal by name before pairing.
  await expect(modal.getByLabel('Terminal waiting')).toContainText(shown);
  await expect(modal.getByLabel('Terminal waiting')).toContainText('Claude Code on laptop');
  await expect(modal.getByLabel('Name')).toHaveValue('Claude Code (laptop)');
  await expectNoHorizontalScroll(page);
  // A terminal gets only chosen projects by default (tester finding 8).
  await expect(modal.getByRole('radio', { name: /Chosen projects/ })).toBeChecked();
  await modal.getByRole('button', { name: 'Pair this terminal' }).click();
  await expect(modal.getByText('Pick at least one project.')).toBeVisible();
  await modal.getByRole('checkbox', { name: 'Blog' }).check();
  await expect(modal.getByText('Allowed when unattended')).toHaveCount(0);
  await modal.getByRole('button', { name: 'Pair this terminal' }).click();

  // Paired: the status says so, and the Plugin and Start steps follow.
  const next = page.getByRole('main');
  await expect(
    next.getByRole('status').filter({ hasText: 'Paired as Claude Code (laptop)' }),
  ).toBeVisible();
  await expect(next.getByLabel('Marketplace command', { exact: true })).toHaveText(
    'claude plugin marketplace add wisely-solutions/hivenod',
  );
  await expect(next.getByLabel('Plugin command', { exact: true })).toHaveText(
    'claude plugin install hivenod@hivenod',
  );
  await next.getByRole('button', { name: 'Next: Start' }).click();
  await expect(next.getByLabel('Start command', { exact: true })).toHaveText(
    'claude --dangerously-load-development-channels plugin:hivenod@hivenod',
  );
  await expect(next.getByText(/own Claude config/)).toBeVisible();
  await expect(next.getByText(/hivenod run/)).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await next.getByRole('button', { name: 'Done' }).click();

  // The admin lands on the new agent's page (guardrails) and never sees a token.
  await expect(page).toHaveURL(/\/agents\/[^/?]+$/);
  await expect(page.getByRole('heading', { name: 'Claude Code (laptop)' })).toBeVisible();
  expect(await page.content()).not.toContain('hive_agt_');
  // Permissions are a read-only note: they belong to the machine's Claude Code settings.
  await expect(page.getByText('Allowed when unattended')).toHaveCount(0);
  await expect(page.getByText(/set in that machine’s Claude Code settings/)).toBeVisible();
  await expect(page.getByLabel(/Token limit/)).toHaveCount(0);
  await expect(page.getByLabel('Experimental CLIs')).toHaveCount(0);

  // The terminal receives the token, sealed for its key, and can work with it.
  await expect
    .poll(async () => (await term.read()).data()?.status, { timeout: 15_000 })
    .toBe('paired');
  const p = (await term.read()).data()!;
  expect(p.workspaceId).toBe(wid);
  const token = await term.open(p.sealed as Sealed);
  expect(token).toMatch(/^hive_agt_/);
  const bot = await asAgent(token);
  expect(bot.who.uid).toBe(p.agentUid);
  expect((await bot.read(`workspaces/${wid}/projects/blog`)).exists()).toBe(true);
  await bot.done();
  await term.done();

  // The token never travelled in clear text.
  for (const b of seen.firestoreBodies) expect(b).not.toContain(token);
  for (const c of seen.consoleText) expect(c).not.toContain('hive_agt_');
});

test('an org with no agents: the empty state opens the Connect page', async ({ page }) => {
  await enter(page, 'Olga Owner');
  await page.goto('/agents');
  await expect(page.getByText('No agents yet')).toBeVisible();
  await expect(page.getByLabel('Set up your first agent')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'New agent' }).last().click();
  await expect(page).toHaveURL(/\/agents\/connect$/);
  await expect(page.getByRole('heading', { name: 'Connect an agent' })).toBeVisible();
});

test('the old ?connect= and ?new=1 links redirect to the Connect page, code kept', async ({
  page,
}) => {
  await enter(page, 'Rita Redirect');
  await page.goto('/agents?connect=K7QX-29PD');
  await expect(page).toHaveURL(/\/agents\/connect\?code=K7QX-29PD$/);
  await expect(page.getByLabel('Code from the terminal')).toHaveValue('K7QX-29PD');
  await page.goto('/agents?new=1');
  await expect(page).toHaveURL(/\/agents\/connect$/);
  await expect(page.getByLabel('Install command', { exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the Connect page is axe-clean in ${theme}, all four steps`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: theme });
    await enter(page, 'Axel Axe');
    const term = await asTerminal();
    const shots = process.env.SHOTS_DIR;
    const snap = async (name: string) => {
      if (shots)
        await page.screenshot({
          path: `${shots}/${info.project.name}-${theme}-${name}.png`,
          fullPage: true,
        });
    };
    const axe = async () => {
      await settle(page);
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    };
    await page.goto('/agents/connect');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByLabel('Install command', { exact: true })).toBeVisible();
    await axe();
    await snap('1-install');
    await page.getByRole('button', { name: 'Next: Pair' }).click();
    await expect(page.getByLabel('Code from the terminal')).toBeVisible();
    await axe();
    await snap('2-pair-empty');
    await page.goto(`/agents/connect?code=${formatPairingCode(term.code)}`);
    await expect(page.getByLabel('Terminal waiting')).toBeVisible();
    await page.getByRole('checkbox', { name: 'Blog' }).check();
    await axe();
    await snap('2-pair-found');
    await page.getByRole('button', { name: 'Pair this terminal' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Paired as' })).toBeVisible();
    await axe();
    await snap('3-plugin');
    await page.getByRole('button', { name: 'Next: Start' }).click();
    await expect(page.getByLabel('Start command', { exact: true })).toBeVisible();
    await axe();
    await snap('4-start');
    await term.done();
  });
}
