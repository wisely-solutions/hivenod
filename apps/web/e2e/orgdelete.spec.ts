import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { createAgentIdentity, signInWithToken } from '@hive/shared/agent-auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, inMemoryPersistence, initializeAuth } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import {
  adminDoc,
  adminPatch,
  adminSet,
  AUTH_PORT,
  FIRESTORE_PORT,
  newPerson,
  person,
  signIn,
  uidOf,
  workspaceOf,
  expectCurrentOrg,
} from './helpers';

const OPTIONS = { apiKey: 'fake', projectId: 'hive-board-43be' };

async function enter(page: Page, who: ReturnType<typeof person>) {
  await page.goto('/');
  await signIn(page, who);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  return { wid: await workspaceOf(who.email), uid: await uidOf(who.email) };
}

async function axe(page: Page) {
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="dialog"]')].every((d) => {
      for (let el: Element | null = d; el; el = el.parentElement)
        if (Number(getComputedStyle(el).opacity) < 1) return false;
      return true;
    }),
  );
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** One of everything the delete has to find (Projects, runs and the calendar went in slice 11). */
async function fill(wid: string, uid: string, agentUid: string) {
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/groups/g1`, { name: 'Team', memberUids: [uid], lastEventId: 'seed' });
  await adminSet(`${base}/notified/n1`, { at: new Date() });
  await adminSet(`${base}/agents/${agentUid}`, {
    name: 'Scout',
    color: 'agent-3',
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  return [
    base,
    `${base}/groups/g1`,
    `${base}/notified/n1`,
    `${base}/agents/${agentUid}`,
    `${base}/events/seed`,
    `${base}/members/${uid}`,
  ];
}

async function agentCanRead(token: string, path: string): Promise<boolean> {
  const app = initializeApp(OPTIONS, `agent-${Math.random().toString(36).slice(2)}`);
  try {
    const auth = initializeAuth(app, { persistence: inMemoryPersistence });
    connectAuthEmulator(auth, `http://localhost:${AUTH_PORT}`, { disableWarnings: true });
    const db = getFirestore(app);
    connectFirestoreEmulator(db, 'localhost', FIRESTORE_PORT);
    await signInWithToken(auth, token);
    await getDoc(doc(db, path));
    return true;
  } catch {
    return false;
  } finally {
    await deleteApp(app);
  }
}

const confirmDialog = (page: Page, name: string) =>
  page.getByRole('dialog', { name: `Delete ${name}?` });

test('an admin deletes the organization: everything goes, the agent is cut off, the member moves on, the admin lands on a fresh one', async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  const ada = person('Ada Admin');
  const max = person('Max Member');
  const { wid, uid } = await enter(page, ada);
  const orgName = 'Ada’s organization';

  // An active agent with a working token, and data at every depth.
  const agent = await createAgentIdentity(OPTIONS, wid, {
    authEmulatorUrl: `http://localhost:${AUTH_PORT}`,
  });
  const gone = await fill(wid, uid, agent.uid);
  expect(await agentCanRead(agent.token, `workspaces/${wid}/agents/${agent.uid}`)).toBe(true);

  // Max joins as a member; he has an organization of his own too.
  await page.goto('/settings/members');
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await page.getByLabel('Email').fill(max.email);
  await page.getByRole('radio', { name: /Member/ }).check();
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = await page.getByRole('textbox', { name: 'Invite link' }).inputValue();
  await page.getByRole('button', { name: 'Done' }).click();
  const maxSide = await newPerson(browser);
  const mp = maxSide.page;
  await mp.goto('/');
  await signIn(mp, max);
  await expect(mp.getByRole('heading', { name: /^Good \w+, Max$/ })).toBeVisible({
    timeout: 20_000,
  });
  await mp.goto(link);
  await mp.getByRole('button', { name: 'Join organization' }).click();
  await expect(mp.getByRole('heading', { name: /^Good \w+, Max$/ })).toBeVisible();
  const maxOwn = await workspaceOf(max.email);
  expect(maxOwn).toBe(wid);

  // A member sees the organization read-only: no Danger zone, no way to delete.
  await mp.goto('/settings/organization');
  await expect(mp.getByRole('heading', { name: 'Organization', level: 2 })).toBeVisible();
  await expect(mp.getByRole('button', { name: 'Delete organization' })).toHaveCount(0);
  await expect(mp.getByText('Danger zone')).toHaveCount(0);

  // The admin's confirm screen lists what goes, and needs the name typed.
  await page.goto('/settings/organization');
  await expect(page.getByText('Danger zone')).toBeVisible();
  await page.getByRole('button', { name: 'Delete organization' }).click();
  const dialog = confirmDialog(page, orgName);
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('list', { name: 'What will be deleted' });
  await expect(list.getByText('2 members lose access')).toBeVisible();
  await expect(list.getByText('1 agent disconnected')).toBeVisible();
  const go = dialog.getByRole('button', { name: 'Delete everything' });
  await expect(go).toBeDisabled();
  await dialog.getByLabel(`Type ${orgName} to confirm`).fill('Wrong name');
  await expect(go).toBeDisabled();
  await axe(page);
  await dialog.getByLabel(`Type ${orgName} to confirm`).fill(orgName);
  await expect(go).toBeEnabled();
  await go.click();

  // Ada's only organization: she lands on a fresh one, with a toast.
  await expect(page.getByText(/was deleted\. Here is a fresh organization\./).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => workspaceOf(ada.email), { timeout: 30_000 }).not.toBe(wid);
  // Max had another organization: he is moved to it, with a toast, no error screen.
  await expect(mp.getByText(/was deleted\. Switched to /).first()).toBeVisible({ timeout: 30_000 });
  await expectCurrentOrg(mp, 'Max’s organization');
  await expect.poll(() => workspaceOf(max.email), { timeout: 30_000 }).not.toBe(wid);

  // Everything under the organization is gone, at every depth, and the document itself.
  await expect
    .poll(
      async () => {
        const left: string[] = [];
        for (const p of gone) if (await adminDoc(p)) left.push(p);
        return left;
      },
      { timeout: 60_000 },
    )
    .toEqual([]);
  // The agent's token no longer reads anything.
  expect(await agentCanRead(agent.token, `workspaces/${wid}/agents/${agent.uid}`)).toBe(false);

  // Ada's new organization is empty and works.
  await page.goto('/');
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
  await maxSide.ctx.close();
});

test('an interrupted delete carries on by itself and can be continued; nobody is stranded', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const sam = person('Sam Several');
  const { wid, uid } = await enter(page, sam);
  const first = wid;

  // A second organization, so the flagged one is not the only one.
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  const nd = page.getByRole('dialog', { name: 'New organization' });
  await nd.getByLabel('Name').fill('Second Co');
  await nd.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Second Co is ready.')).toBeVisible();
  await expect.poll(() => workspaceOf(sam.email)).not.toBe(first);

  // The first one is left half-deleted: flagged, with data still in it (a tab that closed).
  const agentUid = 'agent-left-behind';
  const gone = await fill(first, uid, agentUid);
  await adminPatch(`workspaces/${first}`, { deletingAt: new Date(), deletingBy: uid });

  // Signing in again finishes it (this page load stands for the next visit).
  await page.reload();
  await expect
    .poll(
      async () => {
        const left: string[] = [];
        for (const p of gone) if (await adminDoc(p)) left.push(p);
        return left;
      },
      { timeout: 60_000 },
    )
    .toEqual([]);
  // Still on the second organization, no error screen.
  await expectCurrentOrg(page, 'Second Co');
});

test('deleting the first organization leaves the second in place and the switcher working', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const who = person('Flo Flagged');
  const { wid, uid } = await enter(page, who);
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'New organization' }).first().click();
  const nd = page.getByRole('dialog', { name: 'New organization' });
  await nd.getByLabel('Name').fill('Keeper Co');
  await nd.getByRole('button', { name: 'Create organization' }).click();
  await expect(page.getByText('Keeper Co is ready.')).toBeVisible();
  // Flag the first one but keep a document the walk cannot remove while the page is closed:
  // (the app resumes it at once, so only check it ends up gone and Keeper Co remains.)
  await adminPatch(`workspaces/${wid}`, { deletingAt: new Date(), deletingBy: uid });
  await expect.poll(() => adminDoc(`workspaces/${wid}`), { timeout: 60_000 }).toBeNull();
  await expectCurrentOrg(page, 'Keeper Co');
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  test.skip(info.project.name !== 'desktop-1440', 'sizes are set here');
  test.setTimeout(120_000);
  const dir = process.env.SHOTS_DIR!;
  const who = person('Shot Person');
  const { wid, uid } = await enter(page, who);
  await fill(wid, uid, 'agent-shot');
  const sizes = { '1440': { width: 1440, height: 900 }, '390': { width: 390, height: 844 } };
  for (const [name, vp] of Object.entries(sizes)) {
    await page.setViewportSize(vp);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/settings/organization');
      await page.getByRole('button', { name: 'Delete organization' }).click();
      const d = page.getByRole('dialog', { name: /^Delete / });
      await expect(d.getByText('1 agent disconnected')).toBeVisible();
      await d.getByLabel(/^Type .* to confirm$/).fill('Shot’s organization');
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${dir}/delete-confirm-${name}-${theme}.png` });
      await d.getByRole('button', { name: 'Keep it' }).click();
    }
  }
});

test('closing the page right after confirming a delete: a new page opens Settings within seconds', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const who = person('Cleo Closer');
  const { wid, uid } = await enter(page, who);
  const orgName = 'Cleo’s organization';
  await fill(wid, uid, 'agent-closer');
  await page.goto('/settings/organization');
  await page.getByRole('button', { name: 'Delete organization' }).click();
  const dialog = confirmDialog(page, orgName);
  await dialog.getByLabel(`Type ${orgName} to confirm`).fill(orgName);
  await dialog.getByRole('button', { name: 'Delete everything' }).click();
  // The flag is set; the tab closes at once, whatever the delete has reached.
  await expect
    .poll(
      async () => {
        const d = await adminDoc(`workspaces/${wid}`);
        return d === null || d.fields.deletingAt !== undefined;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.close();

  const next = await context.newPage();
  await next.goto('/settings/organization');
  await expect(next.getByRole('heading', { name: 'Organization', level: 2 })).toBeVisible({
    timeout: 8000,
  });
  await expect(next.getByText(/Can.t reach the server/)).toHaveCount(0);
  // And it ends deleted, with a working organization to stand in.
  await expect.poll(() => adminDoc(`workspaces/${wid}`), { timeout: 60_000 }).toBeNull();
  await expect.poll(() => workspaceOf(who.email)).not.toBe(wid);
});

test('a delete left half-done while no page was open: the next page opens Settings within seconds', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const who = person('Hana Halfway');
  const { wid, uid } = await enter(page, who);
  const gone = await fill(wid, uid, 'agent-halfway');
  await page.goto('/settings/organization');
  await expect(page.getByRole('heading', { name: 'Organization', level: 2 })).toBeVisible();
  await page.close();
  // Flagged while nobody is looking, the organization still the person's current one.
  await adminPatch(`workspaces/${wid}`, { deletingAt: new Date(), deletingBy: uid });

  const next = await context.newPage();
  await next.goto('/settings/organization');
  await expect(next.getByRole('heading', { name: 'Organization', level: 2 })).toBeVisible({
    timeout: 8000,
  });
  await expect(next.getByText(/Can.t reach the server/)).toHaveCount(0);
  await expect
    .poll(
      async () => {
        const left: string[] = [];
        for (const p of gone) if (await adminDoc(p)) left.push(p);
        return left;
      },
      { timeout: 60_000 },
    )
    .toEqual([]);
});

test('the organization was deleted behind a closed page: the next page is not left waiting', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  const who = person('Gus Gone');
  const { wid, uid } = await enter(page, who);
  const gone = await fill(wid, uid, 'agent-gone');
  await page.goto('/settings/organization');
  await expect(page.getByRole('heading', { name: 'Organization', level: 2 })).toBeVisible();
  await page.close();
  for (const p of [...gone].reverse()) {
    await fetch(
      `http://localhost:${FIRESTORE_PORT}/v1/projects/hive-board-43be/databases/(default)/documents/${p}`,
      {
        method: 'DELETE',
        headers: { Authorization: 'Bearer owner' },
      },
    );
  }
  expect(await adminDoc(`workspaces/${wid}`)).toBeNull();
  void uid;

  const next = await context.newPage();
  await next.goto('/settings/organization');
  // Either a fresh organization or the "no longer in this organization" screen; never a long wait.
  await expect(
    next
      .getByRole('heading', { name: 'Organization', level: 2 })
      .or(next.getByRole('heading', { name: 'You are no longer in this organization' })),
  ).toBeVisible({ timeout: 10_000 });
  await expect(next.getByText(/Can.t reach the server/)).toHaveCount(0);
});
