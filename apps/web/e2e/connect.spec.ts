/**
 * `hivenod connect` (item EJ2Cxq4k): the one-click confirm page, like a device login. A plain
 * member confirms a request for the project they are in; the terminal gets the token sealed for
 * its key; an expired, used or declined request is refused with a clear message.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  formatPairingCode,
  newPairingCode,
  openToken,
  pairingKeys,
  pairingPath,
  pairingRequest,
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
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

/** What `hivenod connect` does before it has a token: a connect request, no sign-in. */
async function asTerminal(kind: 'connect' | undefined = 'connect') {
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
      pairingRequest({
        publicKey: keys.publicKey,
        cli: 'claude',
        host: 'laptop',
        folder: 'blog',
        ...(kind ? { kind } : {}),
      }),
    ) as Record<string, unknown>,
  );
  return {
    code,
    link: `/connect?code=${formatPairingCode(code)}`,
    read: () => getDoc(doc(db, pairingPath(code))),
    open: (sealed: Sealed) => openToken(sealed, keys.privateKey, code),
    done: () => deleteApp(app),
  };
}

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
  return { who, read: (path: string) => getDoc(doc(db, path)), done: () => deleteApp(app) };
}

/**
 * Signs a new person in, then makes them a plain member of their organization, in the project
 * Blog only (Ops is someone else's and does not list them).
 */
async function asMember(page: Page, name: string) {
  const me = person(name);
  await page.goto('/');
  await signIn(page, me);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  const wid = await expect
    .poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('')
    .then(() => workspaceOf(me.email));
  const uid = await uidOf(me.email);
  await adminSet(
    `workspaces/${wid}/projects/blog`,
    projectFields('Blog', 'someone', ['someone', uid]),
  );
  await adminSet(`workspaces/${wid}/projects/ops`, projectFields('Ops', 'someone', ['someone']));
  const res = await fetch(
    `http://localhost:${FIRESTORE_PORT}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}?updateMask.fieldPaths=memberRoles.%60${uid}%60`,
    {
      method: 'PATCH',
      headers: { Authorization: 'Bearer owner', 'content-type': 'application/json' },
      body: JSON.stringify({
        fields: { memberRoles: { mapValue: { fields: { [uid]: { stringValue: 'member' } } } } },
      }),
    },
  );
  expect(res.ok, await res.text()).toBe(true);
  return { wid, uid };
}

test('a plain member confirms hivenod connect with one click, for their own project', async ({
  page,
}) => {
  const bodies: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(`:${FIRESTORE_PORT}/`) && r.method() !== 'GET')
      bodies.push(r.postData() ?? '');
  });
  const { wid } = await asMember(page, 'Mona Member');
  const term = await asTerminal();

  await page.goto(term.link);
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Connect this Claude Code to Blog?' }),
  ).toBeVisible();
  const machine = main.getByRole('group', { name: 'Machine asking' });
  await expect(machine).toContainText('Claude Code (laptop)');
  await expect(machine).toContainText('Machine laptop');
  await expect(machine).toContainText(formatPairingCode(term.code));
  await expect(machine).toContainText(/Expires in (9|10) min/);
  // Ops does not list this member: it is not offered.
  await expect(main.getByText('Ops')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
  await main.getByRole('button', { name: 'Connect' }).click();

  await expect(main.getByRole('status')).toHaveText('Connected');
  await expect(
    main.getByRole('heading', { name: 'Claude Code (laptop) is connected' }),
  ).toBeVisible();
  await expect(main.getByRole('link', { name: 'Add your first item' })).toHaveAttribute(
    'href',
    '/p/blog',
  );

  // The terminal gets the token sealed for its key; the agent can use Blog and nothing else.
  await expect
    .poll(async () => (await term.read()).data()?.status, { timeout: 15_000 })
    .toBe('paired');
  const p = (await term.read()).data()!;
  expect(p.workspaceId).toBe(wid);
  const token = await term.open(p.sealed as Sealed);
  const bot = await asAgent(token);
  expect((await bot.read(`workspaces/${wid}/projects/blog`)).exists()).toBe(true);
  await expect(bot.read(`workspaces/${wid}/projects/ops`)).rejects.toThrow();
  await bot.done();
  expect(await page.content()).not.toContain('hive_agt_');
  for (const b of bodies) expect(b).not.toContain(token);

  // The same link again: already used.
  await page.goto(term.link);
  await expect(main.getByRole('alert')).toHaveText(
    'This request was already used. Run hivenod connect again for a new one.',
  );
  await term.done();
});

test('an expired request is refused; Decline stops the terminal; a pair code goes to the admins page', async ({
  page,
}) => {
  await asMember(page, 'Ezra Expired');
  const old = await asTerminal();
  await adminSet(pairingPath(old.code), {
    publicKey: 'B' + 'x'.repeat(86),
    cli: 'claude',
    host: 'laptop',
    folder: 'blog',
    status: 'pending',
    kind: 'connect',
    createdAt: new Date(Date.now() - 11 * 60_000),
  });
  await page.goto(old.link);
  const main = page.getByRole('main');
  await expect(main.getByRole('alert')).toHaveText(
    'This request has expired. Run hivenod connect again in your terminal.',
  );
  // Typing a code by hand works from the same page.
  await expect(main.getByLabel('Code from the terminal')).toBeVisible();
  await old.done();

  const term = await asTerminal();
  await main.getByLabel('Code from the terminal').fill(formatPairingCode(term.code).toLowerCase());
  await main.getByRole('button', { name: 'Continue' }).click();
  await expect(main.getByRole('group', { name: 'Machine asking' })).toBeVisible();
  await main.getByRole('button', { name: 'Decline' }).click();
  await expect(main.getByRole('heading', { name: 'Request declined' })).toBeVisible();
  expect((await term.read()).exists()).toBe(false);
  await term.done();

  const pair = await asTerminal(undefined);
  await page.goto(pair.link);
  await expect(page).toHaveURL(/\/agents\/connect\?code=/);
  await pair.done();
});

for (const theme of ['light', 'dark'] as const) {
  test(`the confirm page is axe-clean in ${theme}`, async ({ page }, info) => {
    await page.addInitScript((t) => localStorage.setItem('hive-theme', t), theme);
    await asMember(page, 'Axel Confirm');
    const term = await asTerminal();
    const shots = process.env.SHOTS_DIR;
    const snap = async (name: string) => {
      if (shots)
        await page.screenshot({
          path: `${shots}/connect-${info.project.name}-${theme}-${name}.png`,
          fullPage: true,
        });
    };
    const axe = async () => {
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      expect(
        violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
    };
    await page.goto('/connect');
    await expect(page.getByLabel('Code from the terminal')).toBeVisible();
    await settle(page);
    await axe();
    await snap('1-enter-code');
    await page.goto(term.link);
    await expect(page.getByRole('group', { name: 'Machine asking' })).toBeVisible();
    await settle(page);
    await axe();
    await expectNoHorizontalScroll(page);
    await snap('2-confirm');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
    await axe();
    await snap('3-connected');
    await term.done();
  });
}
