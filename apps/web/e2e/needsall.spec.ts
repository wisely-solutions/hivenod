import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminPatch,
  adminSet,
  expectNoHorizontalScroll,
  fastTimers,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

// Item 2YZRd4tmFrXR1UjBWYJF: one Needs you across every organization, each row tagged "Only you"
// or "You or others · <names>", grouped by organization and project, with filters.

const rand = () => Math.random().toString(36).slice(2, 8);
const isPhone = () => test.info().project.name !== 'desktop-1440';

function waitingItem(uid: string, title: string, hoursAgo: number) {
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
    order: 1,
    updatedAt: new Date(Date.now() - hoursAgo * 3_600_000),
    lastEventId: 'seed',
  };
}

/** A project with Draft → Review (the given deciders) → Publish. */
function project(name: string, uid: string, gate: Record<string, unknown>, members: string[]) {
  const base = projectFields(name, uid, members);
  const review = base.steps[1]!;
  return {
    ...base,
    steps: [
      base.steps[0]!,
      { ...review, gate: { ...review.gate!, ...gate } },
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  };
}

const card = (name: string) => ({
  name,
  email: `${name.toLowerCase()}@example.test`,
  photoURL: null,
  color: 'c2',
});

/**
 * Three organizations: the person's own (Acme) with a solo gate; Beta Co (a member there) with a
 * gate shared with Ana and an urgent Inbox thread at Your call; Gamma Ltd with a gate shared with
 * the Product team group.
 */
async function seed(page: Page) {
  const me = person('Nina Needs');
  await fastTimers(page);
  await page.goto('/');
  await signIn(page, me);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wa = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const wb = `beta${rand()}`;
  const wc = `gamma${rand()}`;
  const [pa, pb, pc] = [`pa${rand()}`, `pb${rand()}`, `pc${rand()}`];

  await adminPatch(`workspaces/${wa}`, { name: 'Acme' });
  for (const [w, name] of [
    [wb, 'Beta Co'],
    [wc, 'Gamma Ltd'],
  ] as const) {
    await adminSet(`workspaces/${w}`, {
      name,
      ownerUid: 'zoe',
      memberRoles: { [uid]: 'member', zoe: 'admin', ana: 'member', ben: 'member', cy: 'member' },
      adminUids: ['zoe'],
      createdAt: new Date(),
      lastEventId: 'seed',
    });
    for (const p of ['Zoe', 'Ana', 'Ben', 'Cy'])
      await adminSet(`workspaces/${w}/members/${p.toLowerCase()}`, card(p));
    await adminSet(`workspaces/${w}/members/${uid}`, card('Nina'));
  }

  await adminSet(
    `workspaces/${wa}/projects/${pa}`,
    project('Blog', uid, { deciderUids: [uid] }, [uid]),
  );
  await adminSet(
    `workspaces/${wa}/projects/${pa}/items/a1`,
    waitingItem(uid, 'Alpha solo post', 5),
  );

  await adminSet(
    `workspaces/${wb}/projects/${pb}`,
    project('Site', uid, { deciderUids: [uid, 'ana'], rule: 'any' }, [uid, 'ana']),
  );
  await adminSet(
    `workspaces/${wb}/projects/${pb}/items/b1`,
    waitingItem(uid, 'Beta shared page', 4),
  );
  const now = new Date();
  await adminSet(`workspaces/${wb}/inboxThreads/t1`, {
    memberUid: uid,
    subjectId: null,
    state: 'yourCall',
    waiting: null,
    question: null,
    title: 'Invoice from a supplier',
    refs: ['r1'],
    lastMessageAt: now,
    fetchedBy: 'agent1',
    urgent: true,
    createdAt: now,
    updatedAt: now,
    lastEventId: 'seed',
  });

  await adminSet(`workspaces/${wc}/groups/g1`, {
    name: 'Product team',
    memberUids: ['ben', 'cy'],
    lastEventId: 'seed',
  });
  await adminSet(
    `workspaces/${wc}/projects/${pc}`,
    project('Ops', uid, { deciderUids: [uid, 'ben', 'cy'], groupIds: ['g1'], rule: 'any' }, [uid]),
  );
  await adminSet(
    `workspaces/${wc}/projects/${pc}/items/c1`,
    waitingItem(uid, 'Gamma group runbook', 3),
  );

  const before = (await adminDoc(`users/${uid}`))!.fields;
  await adminSet(`users/${uid}`, {
    name: before.name!.stringValue,
    email: before.email!.stringValue,
    photoURL: before.photoURL?.stringValue ?? null,
    color: before.color!.stringValue,
    workspaceId: wa,
    workspaceIds: [wa, wb, wc],
    theme: null,
  });
  await page.goto('/');
  await expect(page.getByText('4 things need you.')).toBeVisible({ timeout: 20_000 });
  return { uid, wa, wb, wc, pa, pb, pc };
}

const row = (page: Page, title: string) =>
  page.getByRole('list', { name: 'Needs you' }).getByRole('button', { name: new RegExp(title) });

const stepOf = async (wid: string, pid: string, iid: string) =>
  (await adminDoc(`workspaces/${wid}/projects/${pid}/items/${iid}`))?.fields.stepId?.stringValue;

test('rows of all three organizations, tagged, grouped, filtered and counted', async ({ page }) => {
  test.setTimeout(90_000);
  const { wb } = await seed(page);
  const list = page.getByRole('list', { name: 'Needs you' });
  for (const t of ['Alpha solo post', 'Beta shared page', 'Gamma group runbook', 'Invoice from'])
    await expect(row(page, t)).toBeVisible();

  // Tags: a sole decider and the member's own thread are Only you; shared gates name the others.
  await expect(row(page, 'Alpha solo post')).toContainText('Only you');
  await expect(row(page, 'Invoice from')).toContainText('Only you');
  await expect(row(page, 'Invoice from')).toContainText('Urgent');
  await expect(row(page, 'Beta shared page')).toContainText('You or others · Ana');
  await expect(row(page, 'Gamma group runbook')).toContainText('You or others · Product team');

  // Grouped by organization, then project (Inbox threads are a group of their own).
  for (const org of ['Acme', 'Beta Co', 'Gamma Ltd'])
    await expect(list.getByRole('heading', { name: org, exact: true })).toBeVisible();
  await expect(list.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();

  // The counter counts everything, the Only-you part apart (sidebar on desktop, tab on phones).
  await expect(
    page.locator('[aria-label="Needs you 4 waiting, 2 only you"]').first(),
  ).toBeAttached();

  // Only me · Shared · All.
  const who = page.getByRole('group', { name: 'Who can act' });
  await who.getByRole('button', { name: /Only me/ }).click();
  await expect(page).toHaveURL(/who=mine/);
  await expect(row(page, 'Alpha solo post')).toBeVisible();
  await expect(row(page, 'Invoice from')).toBeVisible();
  await expect(row(page, 'Beta shared page')).toHaveCount(0);
  await expect(row(page, 'Gamma group runbook')).toHaveCount(0);
  await who.getByRole('button', { name: /Shared/ }).click();
  await expect(row(page, 'Beta shared page')).toBeVisible();
  await expect(row(page, 'Gamma group runbook')).toBeVisible();
  await expect(row(page, 'Alpha solo post')).toHaveCount(0);
  await who.getByRole('button', { name: /^All/ }).click();
  await expect(page).not.toHaveURL(/who=/);

  // The workspace picker narrows to one organization.
  await page
    .getByRole('combobox', { name: 'Filter by organization' })
    .selectOption({ label: 'Beta Co' });
  await expect(page).toHaveURL(new RegExp(`org=${wb}`));
  await expect(row(page, 'Beta shared page')).toBeVisible();
  await expect(row(page, 'Invoice from')).toBeVisible();
  await expect(row(page, 'Alpha solo post')).toHaveCount(0);
  await expect(row(page, 'Gamma group runbook')).toHaveCount(0);
  await page
    .getByRole('combobox', { name: 'Filter by organization' })
    .selectOption({ label: 'All organizations' });
  await expect(row(page, 'Alpha solo post')).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('bulk approve across organizations, with Undo on the button', async ({ page }) => {
  test.skip(isPhone(), 'checkbox selection is checked on desktop (bulkinbox covers phones)');
  test.setTimeout(90_000);
  const { wa, wb, wc, pa, pb, pc } = await seed(page);
  await page.getByLabel('Select Alpha solo post').click();
  await page.getByLabel('Select Beta shared page').click();
  await page.getByLabel('Select Gamma group runbook').click();
  const bar = page.getByRole('toolbar', { name: 'Actions for the selected items' });
  await expect(bar).toContainText('3 selected');
  await bar.getByRole('button', { name: 'Approve 3' }).click();
  await expect(bar.locator('button[data-undo]')).toContainText(/Undo · \d/);
  // Undo on the button brings all three back, in all three organizations.
  await bar.locator('button[data-undo]').click();
  await expect(bar.getByRole('button', { name: 'Approve 3' })).toBeEnabled();
  await page.waitForTimeout(3_000);
  expect(await stepOf(wa, pa, 'a1')).toBe('review');
  expect(await stepOf(wb, pb, 'b1')).toBe('review');
  expect(await stepOf(wc, pc, 'c1')).toBe('review');
  // This time it commits: each item moves on in its own organization.
  await bar.getByRole('button', { name: 'Approve 3' }).click();
  await expect.poll(() => stepOf(wa, pa, 'a1'), { timeout: 15_000 }).toBe('publish');
  await expect.poll(() => stepOf(wb, pb, 'b1'), { timeout: 15_000 }).toBe('publish');
  await expect.poll(() => stepOf(wc, pc, 'c1'), { timeout: 15_000 }).toBe('publish');
  await expect(page.getByText('1 thing needs you.')).toBeVisible({ timeout: 15_000 });
  await expect(
    page.locator('[aria-label="Needs you 1 waiting, 1 only you"]').first(),
  ).toBeAttached();
});

test('a row of another organization opens there', async ({ page }) => {
  test.setTimeout(90_000);
  await seed(page);
  await row(page, 'Gamma group runbook').click();
  const detail = page.getByRole('article', { name: /Decision: Gamma group runbook/ });
  await expect(detail).toBeVisible({ timeout: 15_000 });
  // The organization on screen is now Gamma Ltd; the list still spans all three.
  await page.keyboard.press('Escape');
  await expect(row(page, 'Alpha solo post')).toBeVisible();
});

test('screenshots and axe: 1440 and 390, light and dark', async ({ page }, info) => {
  test.setTimeout(120_000);
  if (isPhone()) await page.setViewportSize({ width: 390, height: 844 });
  await seed(page);
  const size = isPhone() ? '390' : '1440';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(600); // colour transitions finish before axe reads the colours
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    await expectNoHorizontalScroll(page);
    if (process.env.SHOTS_DIR)
      await page.screenshot({
        path: `${process.env.SHOTS_DIR}/needsyou-all-${size}-${theme}.png`,
        fullPage: true,
      });
  }
  void info;
});
