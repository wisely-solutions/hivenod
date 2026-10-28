/**
 * The bell (item 3ENs): pop-ups are live only, the history waits behind the bell. Signing in
 * with unread entries shows no toast and the count; a live entry gives one toast and one row;
 * opening an entry opens the item and marks it read on every device; Mark all read; phones get
 * the bell in the top bar with a full-screen list; light and dark are axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSetAll,
  expectNoHorizontalScroll,
  newPerson,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  type Person,
} from './helpers';

const MIN = 60_000;
const rand = () => Math.random().toString(36).slice(2, 8);
const SHOTS = process.env.SHOTS_DIR;

const item = (uid: string, title: string, stepId = 'review') => ({
  title,
  type: 'task',
  stepId,
  status: stepId === 'review' ? 'waiting' : 'queued',
  summary: 'Seeded for the bell.',
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: stepId === 'review' ? { stepId: 'review', approvals: {}, rejections: {} } : null,
  triage: null,
  sendBackCount: 0,
  costEur: 0,
  order: 1,
  updatedAt: new Date(Date.now() - 90 * MIN),
  lastEventId: 'seed',
});

function entry(
  wid: string,
  pid: string,
  itemId: string,
  itemTitle: string,
  kind: 'gate' | 'question' | 'answer' | 'sentBack',
  at: number,
  over: Record<string, unknown> = {},
) {
  return {
    kind,
    workspaceId: wid,
    projectId: pid,
    itemId,
    projectName: 'Hive',
    itemTitle,
    stepName: kind === 'sentBack' ? 'Build' : kind === 'gate' ? 'Accept' : '',
    actorName: kind === 'gate' ? '' : 'Hive',
    text: kind === 'question' ? 'token ready?' : kind === 'sentBack' ? '7 e2e failures' : '',
    at,
    readAt: null,
    ...over,
  };
}

const TITLES = [
  'Archive or delete an item',
  'Open source Hivenod',
  'Connect wizard page',
  'Hivenod CLI in Go',
  'Item focus view',
];

/** A person in an org with a project "Hive", 5 items and 5 unread bell entries (seeded before sign-in shows). */
async function seedBell(page: Page, who: Person = person('Jo Bell'), readIds: string[] = []) {
  await page.goto('/');
  await signIn(page, who);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(who.email);
  const uid = await uidOf(who.email);
  const pid = `bl${rand()}`;
  const now = Date.now();
  const kinds = ['gate', 'question', 'gate', 'sentBack', 'answer'] as const;
  const docs: Array<[string, Record<string, unknown>]> = [
    [`workspaces/${wid}/projects/${pid}`, { ...projectFields('Hive', uid), name: 'Hive' }],
  ];
  TITLES.forEach((t, i) => {
    docs.push([`workspaces/${wid}/projects/${pid}/items/b${i}`, item(uid, t)]);
    // Two today, the rest yesterday and before: a day's worth of things that happened while away.
    const at = now - (i < 2 ? (i + 1) * 30 * MIN : (i + 22) * 60 * MIN);
    docs.push([
      `users/${uid}/notifications/n${i}`,
      entry(wid, pid, `b${i}`, t, kinds[i]!, at, readIds.includes(`n${i}`) ? { readAt: now } : {}),
    ]);
  });
  await adminSetAll(docs);
  return { wid, uid, pid, who };
}

const toasts = (page: Page) => page.locator('[data-toast-region] [role="status"]');
const bellCount = (page: Page) => page.locator('[data-bell] [data-testid="bell-count"]:visible');
const readAt = async (uid: string, id: string) => {
  const d = await adminDoc(`users/${uid}/notifications/${id}`);
  const f = d?.fields.readAt;
  return f && !('nullValue' in f) ? 'read' : 'unread';
};

test('signing in with 5 unread shows no pop-up; the bell says 5; open, read, mark all read', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the sidebar bell is desktop');
  test.setTimeout(90_000);
  const { uid, pid } = await seedBell(page);
  // A fresh load is a sign-in: the history must not pop up.
  await page.reload();
  const side = page.getByRole('complementary', { name: 'Main' });
  const bell = side.getByRole('button', { name: /^Notifications/ }).filter({ visible: true });
  await expect(bell).toHaveAccessibleName('Notifications, 5 unread');
  await expect(bellCount(page)).toHaveText('5');
  await page.waitForTimeout(1500);
  await expect(toasts(page)).toHaveCount(0);

  await bell.click();
  const pop = page.getByRole('dialog', { name: 'Notifications' });
  await expect(pop).toBeVisible();
  await expect(pop.locator('[data-entry]')).toHaveCount(5);
  await expect(pop.getByText('Today', { exact: true })).toBeVisible();
  await expect(pop.getByText('Yesterday', { exact: true })).toBeVisible();
  await expect(pop.locator('[data-entry="n0"]')).toContainText(
    'Archive or delete an item waits for your Accept',
  );
  await expect(pop.locator('[data-entry="n1"]')).toContainText(
    'Hive asked about Open source Hivenod: “token ready?”',
  );
  // Filters: Needs you = approvals and questions.
  await pop.getByRole('button', { name: 'Needs you' }).click();
  await expect(pop.locator('[data-entry]')).toHaveCount(3);
  await pop.getByRole('button', { name: 'All', exact: true }).click();

  // A click opens the item and marks the entry read.
  await pop.locator('[data-entry="n2"]').click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?item=b2`));
  await expect.poll(() => readAt(uid, 'n2')).toBe('read');
  await expect(bellCount(page)).toHaveText('4');
  await page.keyboard.press('Escape');

  // Unread filter, then Mark all read.
  await bell.click();
  await pop.getByRole('button', { name: /^Unread/ }).click();
  await expect(pop.locator('[data-entry]')).toHaveCount(4);
  await pop.getByRole('button', { name: 'Mark all read' }).click();
  await expect(pop.getByText('All read.')).toBeVisible();
  await expect(bellCount(page)).toHaveCount(0);
  await expect(bell).toHaveAccessibleName('Notifications');
  for (const id of ['n0', 'n1', 'n3', 'n4']) await expect.poll(() => readAt(uid, id)).toBe('read');

  // See all opens the full page.
  await pop.getByRole('button', { name: 'All', exact: true }).click();
  await pop.getByRole('link', { name: 'See all notifications' }).click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(page.locator('main [data-entry]')).toHaveCount(5);
});

test('a live event while the app is open gives one toast and one bell entry', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const { wid, uid, pid } = await seedBell(page);
  await page.reload();
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  await expect(bellCount(page)).toHaveText('5');
  await expect(toasts(page)).toHaveCount(0);
  await adminSetAll([
    [
      `users/${uid}/notifications/live1`,
      entry(wid, pid, 'b4', 'Item focus view', 'gate', Date.now()),
    ],
  ]);
  await expect(toasts(page)).toHaveCount(1);
  await expect(toasts(page)).toContainText('Item focus view waits for your Accept');
  await expect(bellCount(page)).toHaveText('6');
  // Once only.
  await page.waitForTimeout(1000);
  await expect(toasts(page)).toHaveCount(1);
  // Its Open goes to the item and marks it read.
  await toasts(page).getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?item=b4`));
  await expect.poll(() => readAt(uid, 'live1')).toBe('read');
  await expect(bellCount(page)).toHaveText('5');
});

test('read state follows the person to another device', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'two desktop windows');
  test.setTimeout(90_000);
  const { uid, who } = await seedBell(page);
  const other = await newPerson(browser);
  try {
    await other.page.goto('/');
    await signIn(other.page, who);
    await expect(bellCount(other.page)).toHaveText('5');
    await expect(bellCount(page)).toHaveText('5');
    // Opened on this device...
    const bell = page
      .getByRole('complementary', { name: 'Main' })
      .getByRole('button', { name: /^Notifications/ })
      .filter({ visible: true });
    await bell.click();
    await page.locator('[data-entry="n0"]').click();
    await expect.poll(() => readAt(uid, 'n0')).toBe('read');
    // ...read on the other one.
    await expect(bellCount(other.page)).toHaveText('4');
    await other.page
      .getByRole('complementary', { name: 'Main' })
      .getByRole('button', { name: /^Notifications/ })
      .filter({ visible: true })
      .click();
    await expect(other.page.locator('[data-entry="n0"]')).not.toHaveAttribute('data-unread', '');
    await expect(other.page.locator('[data-entry="n1"]')).toHaveAttribute('data-unread', '');
  } finally {
    await other.ctx.close();
  }
});

test('phones: the bell sits in the top bar and opens the full-screen list; the tab bar stays', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop-1440', 'phone layout');
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { uid, pid } = await seedBell(page);
  await page.reload();
  const header = page.locator('header');
  const bell = header.getByRole('link', { name: /^Notifications/ });
  await expect(bell).toHaveAccessibleName('Notifications, 5 unread');
  await expect(toasts(page)).toHaveCount(0);
  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeVisible();
  await expect(page.locator('main [data-entry]')).toHaveCount(5);
  await expectNoHorizontalScroll(page);
  await page.locator('main [data-entry="n1"]').click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?item=b1`));
  await expect.poll(() => readAt(uid, 'n1')).toBe('read');
  await expect(bell).toHaveAccessibleName('Notifications, 4 unread');
});

for (const theme of ['light', 'dark'] as const) {
  test(`the bell and its list are axe-clean (${theme})`, async ({ page }, info) => {
    test.setTimeout(120_000);
    const phone = info.project.name !== 'desktop-1440';
    if (phone) await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    // One read entry, so both looks are on screen.
    await seedBell(page, undefined, ['n3']);
    await page.reload();
    await expect(bellCount(page)).toHaveText('4');
    const tag = `${phone ? '390' : '1440'}-${theme}`;
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/after-${tag}-home.png` });
    const axe = async () => {
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(
        violations.map((v) => [v.id, v.nodes.map((n) => n.target)]),
        `axe ${tag}`,
      ).toEqual([]);
    };
    await axe();
    if (phone) {
      await page
        .locator('header')
        .getByRole('link', { name: /^Notifications/ })
        .click();
      await expect(page.locator('main [data-entry]')).toHaveCount(5);
    } else {
      await page
        .getByRole('complementary', { name: 'Main' })
        .getByRole('button', { name: /^Notifications/ })
        .filter({ visible: true })
        .click();
      await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    }
    await expectNoHorizontalScroll(page);
    // Let the screen cross-fade (view transition) finish before the picture.
    await page.waitForTimeout(800);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/after-${tag}-bell.png` });
    await axe();
  });
}
