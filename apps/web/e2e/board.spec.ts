import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  settle,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page, name = 'João') {
  const owner = person(name);
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `board${rand()}`;
  // Draft (agent) -> Review (gate) -> Publish (agent)
  const base = projectFields('Blog', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      base.steps[0]!,
      base.steps[1]!,
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  return { owner, wid, uid, pid };
}

function itemFields(uid: string, over: Record<string, unknown> = {}) {
  return {
    title: 'Seeded',
    type: 'idea',
    stepId: 'draft',
    status: 'queued',
    summary: 'A seeded summary.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
    ...over,
  };
}

const stepOf = async (wid: string, pid: string, iid: string) =>
  (await adminDoc(`workspaces/${wid}/projects/${pid}/items/${iid}`))?.fields.stepId?.stringValue;

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('New item lands at the agent step, an agent works it, and it waits at the gate', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await page.goto(`/p/${pid}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  await expectNoHorizontalScroll(page);

  // The header flow (on a phone the tab bar's + opens the same box)
  const phone = (page.viewportSize()?.width ?? 1440) < 640;
  const addButton = phone
    ? page.getByRole('button', { name: 'Add an item' })
    : page.getByRole('button', { name: 'New item' });
  await addButton.click();
  const dialog = page.getByRole('dialog', { name: 'New item' });
  await expect(dialog.getByLabel('Title')).toBeFocused();
  await page.keyboard.type('Write the launch post');
  await expect(dialog.getByLabel('Title')).toHaveValue('Write the launch post');
  await dialog.getByLabel('Title').press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(addButton).toBeFocused();
  await expect(page.getByText('Write the launch post')).toBeVisible();

  // No inline add box in any column: New item (and C) is the way to add on every device.
  await expect(page.getByLabel('Add an idea, request or bug')).toHaveCount(0);
  await expect(page.locator('form[data-capture="inline"]')).toHaveCount(0);
  if (!phone) {
    await page.keyboard.press('c');
    const second = page.getByRole('dialog', { name: 'New item' });
    await expect(second.getByLabel('Title')).toBeFocused();
    await page.keyboard.type('Fix the footer');
    await page.keyboard.press('Enter');
    await expect(second).toBeHidden();
    await expect(page.getByText('Fix the footer')).toBeVisible();
  }

  // An agent claims it (test helper): the working dots appear live.
  const claimed = `claim${rand()}`;
  await adminSet(
    `workspaces/${wid}/projects/${pid}/items/${claimed}`,
    itemFields(uid, {
      title: 'Claimed by an agent',
      status: 'working',
      claim: { runId: 'r1', agentUid: 'agent1', heartbeatAt: new Date() },
      order: 5,
    }),
  );
  await expect(page.getByText('1 running now')).toBeAttached();

  // Completion moves it to the gate, which is open and asks the decider.
  await adminSet(
    `workspaces/${wid}/projects/${pid}/items/${claimed}`,
    itemFields(uid, {
      title: 'Claimed by an agent',
      stepId: 'review',
      status: 'waiting',
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      order: 5,
    }),
  );
  const review = page.getByRole('region', { name: /Review, decision step/ });
  await expect(review.getByText('Claimed by an agent')).toBeVisible();
  await expect(review.getByText('Waiting for you').first()).toBeVisible();
  await expect(review.getByText(/You decide/i).first()).toBeVisible();

  // Open it, approve it: it moves on to Publish.
  await review.getByRole('button', { name: /Claimed by an agent/ }).click();
  await expect(page).toHaveURL(new RegExp(`item=${claimed}`));
  const detail = page.getByRole('article', { name: /Claimed by an agent/ });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('A seeded summary.')).toBeVisible();
  await detail.getByRole('button', { name: /Approve/ }).click();
  // The approval is written when the 5 s Undo window ends.
  await expect.poll(() => stepOf(wid, pid, claimed), { timeout: 15_000 }).toBe('publish');
  // It was the only item waiting, so the view closes by itself (the last one closes).
  await expect(page).not.toHaveURL(/item=/);
});

test('folded agent columns open on click, and the choice is remembered', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'folding is a desktop layout');
  const { wid, uid, pid } = await seed(page);
  await adminSet(
    `workspaces/${wid}/projects/${pid}/items/p1`,
    itemFields(uid, { title: 'Ready to ship', stepId: 'publish' }),
  );
  await page.goto(`/p/${pid}`);
  const publish = page.getByRole('button', { name: /^1\s*Publish/ });
  await expect(publish).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Ready to ship')).toBeHidden();
  await publish.click();
  await expect(page.getByText('Ready to ship')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Ready to ship')).toBeVisible();
});

test('dropping a card over another column does not reorder it', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'cross-column drag is a desktop layout');
  const { wid, uid, pid } = await seed(page);
  for (const [id, title, order] of [
    ['a1', 'Alpha card', 1],
    ['b1', 'Bravo card', 2],
    ['c1', 'Charlie card', 3],
  ] as const) {
    await adminSet(
      `workspaces/${wid}/projects/${pid}/items/${id}`,
      itemFields(uid, { title, order }),
    );
  }
  await page.goto(`/p/${pid}`);
  const titles = () =>
    page
      .getByText(/^(Alpha|Bravo|Charlie) card$/)
      .evaluateAll((els) => els.map((e) => e.textContent));
  await expect.poll(titles).toEqual(['Alpha card', 'Bravo card', 'Charlie card']);
  await settle(page); // the drag below measures positions: wait until the board stops moving
  const handle = page.getByRole('button', { name: /^Reorder Charlie card/ });
  const hb = (await handle.boundingBox())!;
  const publish = (await page.getByRole('button', { name: /^0\s*Publish/ }).boundingBox())!;
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2 + 20, hb.y + hb.height / 2 - 10, { steps: 5 });
  await page.mouse.move(publish.x + publish.width / 2, hb.y - 100, { steps: 20 });
  await expect(page.getByText('Items can only be reordered inside this step.')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('[id^="DndLiveRegion"]')).toContainText('It did not move.');
  await page.reload();
  await expect.poll(titles).toEqual(['Alpha card', 'Bravo card', 'Charlie card']);
});

test('List view sorts and filters, and opens an item', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(`workspaces/${wid}/projects/${pid}/items/a1`, itemFields(uid, { title: 'Bravo' }));
  await adminSet(
    `workspaces/${wid}/projects/${pid}/items/a2`,
    itemFields(uid, { title: 'Alpha', order: 2 }),
  );
  await page.goto(`/p/${pid}?view=list`);
  const rows = page.getByRole('row');
  await expect(rows.nth(1)).toContainText('Bravo');
  await page.getByRole('button', { name: 'Title', exact: true }).click();
  await expect(rows.nth(1)).toContainText('Alpha');
  await page.getByLabel('Find').fill('brav');
  await expect(page.getByRole('row', { name: /Alpha/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Bravo', exact: true }).click();
  await expect(page.getByRole('article', { name: /Bravo/ })).toBeVisible();
  await settle(page);
  await axe(page);
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { wid, uid, pid } = await seed(page, 'João');
  const mk = (id: string, over: Record<string, unknown>) =>
    adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, itemFields(uid, over));
  await mk('s1', { title: 'Write the launch post', order: 1 });
  await mk('s2', { title: 'Fix the footer on phones', type: 'bug', order: 2 });
  await mk('s3', {
    title: 'Landing page copy',
    status: 'working',
    claim: { runId: 'r1', agentUid: 'ag', heartbeatAt: new Date() },
    progress: { done: 3, total: 8 },
    order: 3,
  });
  await mk('s4', {
    title: 'Pricing page',
    stepId: 'review',
    status: 'waiting',
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    sendBackCount: 1,
  });
  await mk('s5', { title: 'Newsletter issue 12', stepId: 'publish' });
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const width = info.project.use.viewport?.width ?? 375;
  const size = width >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${pid}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${dir}/board-${size}-${theme}.png` });
    await page.goto(`/p/${pid}?item=s4`);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${dir}/item-${size}-${theme}.png` });
    await page.goto(`/p/${pid}?view=list`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/list-${size}-${theme}.png` });
    await page.goto(`/p/${pid}`);
    await page.getByRole('button', { name: 'New item' }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/new-item-${size}-${theme}.png` });
  }
});

test('the first column has no inline add box, empty or not (card 3rEIl3Jj)', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  await settle(page);
  await expect(page.locator('form[data-capture="inline"]')).toHaveCount(0);
  await expect(page.getByLabel('Add an idea, request or bug')).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});
