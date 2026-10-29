/**
 * Calendar (Inbox item w9SAf): agents upsert events and they show in the view; another
 * organization's event shows as "Busy" only, never its title.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { calendarUpsert, type ActionContext } from '@hive/shared';
import { applyPlan } from '@hive/shared/firestore';
import { createAgentIdentity, signInWithToken } from '@hive/shared/agent-auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  AUTH_PORT,
  expectNoHorizontalScroll,
  FIRESTORE_PORT,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const OPTIONS = { apiKey: 'fake', projectId: 'hive-board-43be' };

/** A new agent of `wid`, signed in as itself (its own app, only the token). */
async function agentOf(wid: string, uid: string) {
  const { uid: aid, token } = await createAgentIdentity(OPTIONS, wid, {
    authEmulatorUrl: `http://localhost:${AUTH_PORT}`,
  });
  await adminSet(`workspaces/${wid}/agents/${aid}`, {
    name: 'Calendar agent',
    color: '#2F5FD0',
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: token.slice(-4),
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  const app = initializeApp(OPTIONS, `agent-${Math.random().toString(36).slice(2)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://localhost:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', FIRESTORE_PORT);
  await signInWithToken(auth, token);
  const ctx: ActionContext = {
    workspaceId: wid,
    actor: { type: 'agent', id: aid, name: 'Calendar agent' },
  };
  return {
    upsert: (memberUid: string, events: Parameters<typeof calendarUpsert>[1]['events']) =>
      applyPlan(db, calendarUpsert(ctx, { memberUid, events })),
    done: () => deleteApp(app),
  };
}

const at = (h: number, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
};

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('agents fill the calendar; another organization shows only as busy', async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const me = person('Cara Calendar');
  await page.goto('/');
  await signIn(page, me);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);

  // A client organization Cara is also in.
  const client = `client${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await adminSet(`workspaces/${client}`, {
    name: 'Client Org',
    ownerUid: uid,
    memberRoles: { [uid]: 'member', zoe: 'admin' },
    adminUids: ['zoe'],
    createdAt: new Date(),
    lastEventId: 'seed',
  });
  const before = (await adminDoc(`users/${uid}`))!.fields;
  await adminSet(`users/${uid}`, {
    name: before.name!.stringValue,
    email: before.email!.stringValue,
    photoURL: before.photoURL?.stringValue ?? null,
    color: before.color!.stringValue,
    workspaceId: wid,
    workspaceIds: [wid, client],
    theme: null,
  });

  const mine = await agentOf(wid, uid);
  const theirs = await agentOf(client, uid);
  try {
    await mine.upsert(uid, [
      {
        source: 'google',
        sourceEventId: 'g1',
        title: 'Team standup',
        start: at(9),
        end: at(9, 30),
      },
      {
        source: 'google',
        sourceEventId: 'g2',
        title: 'Dentist',
        start: at(11),
        end: at(12),
        busyOnly: true,
      },
    ]);
    await theirs.upsert(uid, [
      {
        source: 'outlook',
        sourceEventId: 'o1',
        title: 'Client workshop',
        start: at(14),
        end: at(15, 30),
        attendees: ['zoe@client.example'],
      },
    ]);

    await page.goto('/calendar');
    await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Day', exact: true }).click();
    const grid = page.getByRole('region', { name: 'Time grid' });

    // All my calendars: my events everywhere, with details (busy-only stays busy).
    await expect(grid.getByRole('group', { name: /^Team standup, / })).toBeVisible();
    await expect(
      grid.getByRole('group', { name: /^Client workshop, .*Client Org$/ }),
    ).toBeVisible();
    await expect(grid.getByRole('group', { name: /^Busy, / })).toHaveCount(1);
    await expect(grid.getByText('Dentist')).toHaveCount(0);

    // This organization: its events, the client's time only as busy, no title anywhere.
    const select = page.getByRole('combobox', { name: 'Calendar' });
    await select.selectOption({ value: wid });
    await expect(grid.getByRole('group', { name: /^Team standup, / })).toBeVisible();
    await expect(grid.getByRole('group', { name: /^Busy, .*Another organization$/ })).toBeVisible();
    await expect(page.getByText('Client workshop')).toHaveCount(0);
    await expect(grid.getByRole('group', { name: /^Busy, / })).toHaveCount(2);

    // An agent update shows live.
    await mine.upsert(uid, [
      {
        source: 'google',
        sourceEventId: 'g1',
        title: 'Team standup (moved)',
        start: at(10),
        end: at(10, 30),
      },
    ]);
    await expect(grid.getByRole('group', { name: /^Team standup \(moved\), / })).toBeVisible();

    // The client organization's own view shows its event with details.
    await select.selectOption({ value: client });
    await expect(grid.getByRole('group', { name: /^Client workshop, / })).toBeVisible();
    await expect(page.getByText('Team standup')).toHaveCount(0);

    await select.selectOption({ value: wid });
    await page.getByRole('button', { name: 'Week', exact: true }).click();
    await expect(grid.getByRole('group', { name: /^Team standup \(moved\), / })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await settle(page);
    await axe(page);
    const shots = process.env.SHOTS_DIR;
    if (shots) mkdirSync(shots, { recursive: true });
    if (shots) await page.screenshot({ path: `${shots}/calendar-${info.project.name}-light.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await settle(page);
    await axe(page);
    if (shots) await page.screenshot({ path: `${shots}/calendar-${info.project.name}-dark.png` });
    if (info.project.name === 'iphone-se') {
      await page.setViewportSize({ width: 390, height: 844 });
      await expectNoHorizontalScroll(page);
      if (shots) await page.screenshot({ path: `${shots}/calendar-390-dark.png` });
    }
  } finally {
    await mine.done();
    await theirs.done();
  }
});
