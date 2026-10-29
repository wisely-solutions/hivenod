/**
 * Item icVly (model A): the sidebar has two zones. "You · all organizations" (Today, Inbox,
 * Calendar) spans every organization; below a divider, the organization picked in the switcher
 * (its projects, Projects, Agents, Activity, Decision insights, Organization settings). Switching
 * changes only the second zone, and each badge counts one named scope.
 *
 * The member is in three organizations: Brightline Studio (admin), Northwind (member) and Personal.
 * SHOTS_DIR=<dir> also writes screenshots.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { personalOrgPlan, SERVER_TIME } from '@hive/shared';
import { mkdirSync } from 'node:fs';
import {
  adminPatch,
  adminSet,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  projectFields,
  settle,
} from './helpers';
import { agentOf, seedInbox } from './inboxSeed';

const isPhone = () => test.info().project.name !== 'desktop-1440';

function waitingItem(uid: string, title: string, hoursAgo: number, order = 1) {
  return {
    title,
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: `${title}: ready for a decision.`,
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order,
    updatedAt: new Date(NOW - hoursAgo * 3_600_000),
    lastEventId: 'seed',
  };
}

const card = (name: string, color = 'c2') => ({
  name,
  email: `${name.toLowerCase().replace(/\W/g, '')}@example.test`,
  photoURL: null,
  color,
});

/** A member in Brightline Studio, Northwind and Personal, with decisions and threads in each. */
export async function seedThreeOrgs(page: Page) {
  const s = await seedInbox(page, 'Cara Lindqvist');
  const { wid, client, uid } = s;
  await adminPatch(`workspaces/${wid}`, { name: 'Brightline Studio' });
  await adminSet(`workspaces/${client}/members/${uid}`, card('Cara Lindqvist', 'c1'));
  await adminSet(`workspaces/${client}/members/zoe`, card('Zoe Park'));

  const p1 = `pw${Date.now().toString(36)}`;
  const proj = (name: string, emoji: string) => ({ ...projectFields(name, uid), emoji });
  await adminSet(`workspaces/${wid}/projects/${p1}`, proj('Website relaunch', '🌐'));
  await adminSet(
    `workspaces/${wid}/projects/${p1}/items/i1`,
    waitingItem(uid, 'Approve the new pricing page', 3),
  );
  await adminSet(
    `workspaces/${wid}/projects/${p1}/items/i2`,
    waitingItem(uid, 'Pick the hero photo', 6, 2),
  );
  await adminSet(`workspaces/${wid}/projects/o${p1}`, proj('Operations', '🧰'));
  await adminSet(`workspaces/${client}/projects/c${p1}`, proj('Client portal', '🧭'));
  await adminSet(
    `workspaces/${client}/projects/c${p1}/items/c1`,
    waitingItem(uid, 'Sign off the portal login flow', 2),
  );

  // The Personal organization (the operator command's batch), with its own agent and a thread.
  const pid = `personal${Date.now().toString(36)}`;
  const plan = personalOrgPlan(
    { workspaceId: pid, actor: { type: 'human', id: uid, name: 'Cara Lindqvist' } },
    { profile: { name: 'Cara Lindqvist', email: s.me.email, photoURL: null, color: 'c1' } },
  );
  const now = new Date(NOW);
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
  await adminUpdate(`users/${uid}`, { workspaceIds: [wid, client, pid] });
  const mine = await agentOf(pid, uid, 'Personal assistant');
  const dent = await mine.add(uid, {
    source: 'mail',
    from: 'City Dental',
    text: 'Confirm your appointment\nPlease confirm your check-up on Thursday 08:00.',
    ref: 'dent',
    id: 'd1',
    at: new Date(NOW - 5 * 3600_000),
  });
  await mine.file(dent, { newName: 'Dentist', area: 'Health' });
  await mine.ask(dent, 'Keep Thursday 08:00 or move it to next week?', ['Keep', 'Move']);
  return {
    ...s,
    personal: pid,
    project: p1,
    stop: async () => {
      await s.stop();
      await mine.stop();
    },
  };
}

async function axe(page: Page) {
  await settle(page).catch(() => undefined);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([]);
}

async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await settle(page).catch(() => undefined);
  await page.screenshot({ path: `${dir}/${name}.png` });
}

const switcher = (page: Page) => page.getByRole('button', { name: /, switch organization$/ });

async function switchTo(page: Page, name: RegExp) {
  await switcher(page).first().click();
  await page
    .getByRole('dialog', { name: 'Organizations' })
    .getByRole('list', { name: 'Your organizations' })
    .getByRole('button', { name })
    .click();
  await expect(switcher(page).first()).toHaveAccessibleName(
    new RegExp(`^${name.source}.*, switch organization$`),
  );
}

/** "Today 4 waiting, 2 only you" → 4. */
const countIn = (label: string | null) => Number(/(\d+) waiting/.exec(label ?? '')?.[1] ?? 0);

for (const theme of ['light', 'dark'] as const) {
  test(`the sidebar has a You zone and an Organization zone (${theme})`, async ({ page }) => {
    test.skip(isPhone(), 'the sidebar is desktop');
    test.setTimeout(180_000);
    await fastTimers(page);
    await freezeClock(page);
    await page.emulateMedia({ colorScheme: theme });
    const s = await seedThreeOrgs(page);
    try {
      await page.goto('/');
      const side = page.getByRole('complementary', { name: 'Main' });
      const you = side.getByRole('navigation', { name: 'You, all organizations' });
      const org = side.getByRole('navigation', { name: 'Organization, Brightline Studio' });
      await expect(you).toBeVisible({ timeout: 20_000 });
      await expect(you.getByText('all organizations')).toBeVisible();
      for (const name of [/^Today/, /^Inbox/, /^Calendar$/])
        await expect(you.getByRole('link', { name })).toBeVisible();
      await expect(org.getByRole('link', { name: /^Website relaunch/ })).toBeVisible();
      for (const name of [
        'Operations',
        'Projects',
        'Agents',
        'Activity',
        'Decision insights',
        'Organization settings',
      ])
        await expect(org.getByRole('link', { name, exact: true })).toBeVisible();
      await expect(side.getByRole('link', { name: 'All projects' })).toHaveCount(0);
      // The switcher sits in the Organization zone, with the role and size under the name.
      await expect(org.getByRole('button', { name: /switch organization$/ })).toContainText(
        'Brightline Studio',
      );

      // Today's badge is the Today page's own count: everything waiting for you, every organization.
      const today = you.getByRole('link', { name: /^Today/ });
      await expect(today).toHaveAttribute('aria-label', /^Today \d+ waiting/, { timeout: 20_000 });
      const pageCount = page.locator('[data-today-count]');
      await expect(pageCount).toHaveText(/^\d+ waiting for you$/);
      await expect
        .poll(async () => countIn(await today.getAttribute('aria-label')))
        .toBe(Number((await pageCount.textContent())!.split(' ')[0]));
      await expect(page.locator('[data-brief]').getByText('all organizations')).toBeVisible();
      // A project's badge counts that project in this organization (two waiting items).
      await expect(org.getByRole('link', { name: /^Website relaunch/ })).toHaveAccessibleName(
        'Website relaunch Needs you: 2',
      );
      await expectNoHorizontalScroll(page);
      await shot(page, `A-today-1440-${theme}`);
      await axe(page);

      // Inbox: the badge is the page's "N threads wait for you" line.
      const inboxLink = you.getByRole('link', { name: /^Inbox/ });
      await expect(inboxLink).toHaveAttribute('aria-label', /^Inbox \d+ waiting$/);
      const threads = countIn(await inboxLink.getAttribute('aria-label'));
      await inboxLink.click();
      await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
      await expect(
        page.getByText(`${threads} thread${threads === 1 ? '' : 's'} wait`),
      ).toBeVisible();
      await expect(page.locator('main [data-scope-pill]')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await axe(page);

      await you.getByRole('link', { name: /^Calendar$/ }).click();
      await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
      await expect(page.locator('main [data-scope-pill]')).toBeVisible();
      await shot(page, `A-calendar-1440-${theme}`);
      await axe(page);

      // Switching organization changes only the Organization zone.
      await page.goto('/');
      await expect(today).toHaveAttribute('aria-label', /^Today \d+ waiting/, { timeout: 20_000 });
      const youBefore = await you.innerText();
      const todayBefore = await today.getAttribute('aria-label');
      await switcher(page).first().click();
      await expect(page.locator('[data-switch-scope]')).toContainText(
        'Today, Inbox and Calendar stay across all your organizations',
      );
      await shot(page, `A-switcher-1440-${theme}`);
      await page.keyboard.press('Escape');
      for (const [name, project] of [
        [/Northwind/, 'Client portal'],
        [/Personal/, null],
      ] as const) {
        await switchTo(page, name);
        const zone = side.getByRole('navigation', {
          name: new RegExp(`^Organization, ${name.source}`),
        });
        await expect(zone).toBeVisible();
        if (project) await expect(zone.getByRole('link', { name: project })).toBeVisible();
        await expect(zone.getByRole('link', { name: 'Website relaunch' })).toHaveCount(0);
        await expect(zone.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
        await expect.poll(() => today.getAttribute('aria-label')).toBe(todayBefore);
        await expect.poll(() => you.innerText()).toBe(youBefore);
      }
      await shot(page, `A-personal-1440-${theme}`);
      await axe(page);
    } finally {
      await s.stop();
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`phone at 390: the tabs, and the You pages say they span every organization (${theme})`, async ({
    page,
  }) => {
    test.skip(!isPhone(), 'phone layout');
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await fastTimers(page);
    await freezeClock(page);
    await page.emulateMedia({ colorScheme: theme });
    const s = await seedThreeOrgs(page);
    try {
      await page.goto('/');
      const tabs = page.getByRole('navigation', { name: 'Tabs' });
      await expect(tabs.getByRole('link', { name: /^Projects$/ })).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('[data-brief]').getByText('all organizations')).toBeVisible();
      const today = tabs.getByRole('link', { name: /^Today/ });
      await expect(today).toHaveAttribute('aria-label', /^Today \d+ waiting/, { timeout: 20_000 });
      await expect
        .poll(async () => countIn(await today.getAttribute('aria-label')))
        .toBe(Number((await page.locator('[data-today-count]').textContent())!.split(' ')[0]));
      await expectNoHorizontalScroll(page);
      await shot(page, `A-today-390-${theme}`);
      await axe(page);
      await tabs.getByRole('link', { name: /^Calendar/ }).click();
      await expect(page.getByRole('heading', { name: 'Calendar', level: 1 })).toBeVisible();
      await expect(page.locator('main [data-scope-pill]')).toBeVisible();
      await expectNoHorizontalScroll(page);
      await shot(page, `A-calendar-390-${theme}`);
      await axe(page);
      await tabs.getByRole('link', { name: /^Projects$/ }).click();
      await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
      await expect(page.getByText(/^Brightline Studio · 2 projects$/)).toBeVisible();
      await expectNoHorizontalScroll(page);
      await axe(page);
    } finally {
      await s.stop();
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`Settings split: Account under the avatar, Organization settings named after the organization (${theme})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    if (isPhone()) await page.setViewportSize({ width: 390, height: 844 });
    await fastTimers(page);
    await freezeClock(page);
    await page.emulateMedia({ colorScheme: theme });
    const s = await seedThreeOrgs(page);
    const vw = isPhone() ? '390' : '1440';
    try {
      await page.goto('/');
      // The avatar opens Account: yours, the same in every organization.
      const avatar = page.getByRole('link', { name: /^Cara Lindqvist, Account$/ }).first();
      await expect(avatar).toBeVisible({ timeout: 20_000 });
      if (!isPhone()) await expect(avatar).toHaveAttribute('title', 'Account and notifications');
      await avatar.click();
      await expect(page).toHaveURL(/\/account\/profile$/);
      await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
      await expect(page.locator('main [data-scope-pill]')).toBeVisible();
      const account = page.getByRole('tablist', { name: 'Account' }).getByRole('tab');
      await expect(account).toHaveText(['Profile', 'Notifications']);
      await expectNoHorizontalScroll(page);
      await shot(page, `A-account-${vw}-${theme}`);
      await axe(page);

      // Organization settings: the organization's name on the page and on its first tab.
      if (isPhone()) await page.goto('/settings/organization');
      else
        await page
          .getByRole('complementary', { name: 'Main' })
          .getByRole('link', { name: 'Organization settings' })
          .click();
      await expect(page).toHaveURL(/\/settings\/organization$/);
      await expect(
        page.getByRole('heading', { name: 'Organization settings', level: 1 }),
      ).toBeVisible();
      await expect(page.locator('[data-org-scope]')).toContainText('Brightline Studio · Admin');
      const tabs = page.getByRole('tablist', { name: 'Organization settings' }).getByRole('tab');
      await expect(tabs).toHaveText([
        'Brightline Studio',
        'Members',
        'Groups',
        'Projects',
        'Inbox labels',
      ]);
      await expectNoHorizontalScroll(page);
      await shot(page, `A-orgsettings-${vw}-${theme}`);
      await axe(page);

      // Switching follows: now Northwind's settings, where Cara is a member.
      await switchTo(page, /Northwind/);
      await expect(page.locator('[data-org-scope]')).toContainText('Northwind · Member');
      await expect(tabs.first()).toHaveText('Northwind');

      // Old links land on the right page.
      await page.goto('/settings/notifications');
      await expect(page).toHaveURL(/\/account\/notifications$/);
      await page.goto('/me/members');
      await expect(page).toHaveURL(/\/settings\/members$/);
    } finally {
      await s.stop();
    }
  });
}
