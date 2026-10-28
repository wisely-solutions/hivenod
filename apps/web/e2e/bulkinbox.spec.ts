import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminSet,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  fastTimers,
  UNDO_WAIT,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

// Item pYDcGpDrilYs6jfiZl3F: select several Approve rows in Needs you and decide them together.

const isPhone = () => test.info().project.name !== 'desktop-1440';

async function seed(page: Page, opts: { otherDecider?: boolean } = {}) {
  const owner = person('João');
  await fastTimers(page);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `inbox${rand()}`;
  const base = projectFields('Blog', uid);
  const review = base.steps[1]!;
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      base.steps[0]!,
      {
        ...review,
        gate: {
          ...review.gate!,
          deciderUids: opts.otherDecider ? [uid, 'ana'] : [uid],
          rule: opts.otherDecider ? 'all' : 'any',
        },
      },
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  return { owner, wid, uid, pid };
}

function waitingItem(uid: string, over: Record<string, unknown> = {}) {
  return {
    title: 'Launch post',
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: 'Draft of the launch post, ready for a decision.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0.42,
    order: 1,
    updatedAt: new Date(Date.now() - 3 * 3_600_000),
    lastEventId: 'seed',
    ...over,
  };
}

const itemPath = (wid: string, pid: string, iid: string) =>
  `workspaces/${wid}/projects/${pid}/items/${iid}`;
const field = async (wid: string, pid: string, iid: string, f: string) =>
  (await adminDoc(itemPath(wid, pid, iid)))?.fields[f]?.stringValue;

const TITLES = ['Alpha post', 'Beta post', 'Gamma post', 'Delta post'];

async function seedFour(page: Page) {
  const s = await seed(page);
  for (const [i, title] of TITLES.entries())
    await adminSet(
      itemPath(s.wid, s.pid, `i${i + 1}`),
      waitingItem(s.uid, {
        title,
        order: i + 1,
        updatedAt: new Date(Date.now() - (i + 1) * 3_600_000),
      }),
    );
  await page.goto('/');
  await expect(page.getByRole('button', { name: /Alpha post/ }).first()).toBeVisible();
  return s;
}

/** Starts selecting: a checkbox on desktop, a long press on a phone (checkboxes show from then on). */
async function startSelecting(page: Page, title: string) {
  if (!isPhone()) {
    await page.getByLabel(`Select ${title}`).click();
    return;
  }
  const row = page.getByRole('button', { name: new RegExp(title) }).first();
  await row.scrollIntoViewIfNeeded();
  // Rows can still be settling (late rows, the checklist): press where the row holds still.
  let last = '';
  await expect
    .poll(async () => {
      const cur = JSON.stringify(await row.boundingBox());
      const stable = cur !== 'null' && cur === last;
      last = cur;
      if (!stable) await page.waitForTimeout(120);
      return stable;
    })
    .toBe(true);
  const box = (await row.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
}

test('select 3, Approve 3, one Undo brings all back, then approve for real', async ({ page }) => {
  const { wid, pid } = await seedFour(page);
  await startSelecting(page, 'Alpha post');
  await page.getByLabel('Select Beta post').click();
  await page.getByLabel('Select Gamma post').click();
  const bar = page.getByRole('toolbar', { name: 'Actions for the selected items' });
  await expect(bar).toContainText('3 selected');
  await expect(page.getByLabel('Select Delta post')).not.toBeChecked();

  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(600); // colour transitions finish before axe reads the colours
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((v) => [v.id, v.nodes.map((n) => n.target)])).toEqual([]);
    if (process.env.SHOT_DIR)
      await page.screenshot({
        path: `${process.env.SHOT_DIR}/needsyou-select-${test.info().project.name}-${theme}.png`,
      });
  }

  await bar.getByRole('button', { name: 'Approve 3' }).click();
  // The pressed button counts down as Undo (no toast); the rows and the bar stay meanwhile.
  await expect(bar.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await expect(page.getByTestId('undo-announcement')).toContainText(
    '3 approved. Undo available for 5 seconds',
  );
  await expect(bar.getByRole('button', { name: 'Reject…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Alpha post/ }).first()).toBeVisible();
  await bar.locator('button[data-undo]').click();
  await expect(bar.getByRole('button', { name: 'Approve 3' })).toBeEnabled();
  for (const t of TITLES.slice(0, 3))
    await expect(page.getByRole('button', { name: new RegExp(t) }).first()).toBeVisible();
  await page.waitForTimeout(UNDO_WAIT + 500);
  for (const i of [1, 2, 3, 4]) expect(await field(wid, pid, `i${i}`, 'stepId')).toBe('review');

  // Undo gave the three back and kept them selected; this time let it commit.
  await expect(bar).toContainText('3 selected');
  await expect(page.getByLabel('Select Alpha post')).toBeChecked();
  await page.getByRole('button', { name: 'Approve 3' }).click();
  await expect.poll(() => field(wid, pid, 'i1', 'stepId'), { timeout: 15_000 }).toBe('publish');
  expect(await field(wid, pid, 'i2', 'stepId')).toBe('publish');
  expect(await field(wid, pid, 'i3', 'stepId')).toBe('publish');
  expect(await field(wid, pid, 'i4', 'stepId')).toBe('review');
});

test('Reject asks one reason (10+ characters) for all selected', async ({ page }) => {
  const { wid, pid } = await seedFour(page);
  await startSelecting(page, 'Beta post');
  await page.getByLabel('Select Delta post').click();
  await page.getByRole('button', { name: 'Reject…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reject' });
  await expect(dialog).toContainText('2 selected items');
  const go = dialog.getByRole('button', { name: 'Reject', exact: true });
  await dialog.getByRole('textbox').fill('too short');
  await expect(go).toBeDisabled();
  await dialog.getByRole('textbox').fill('Not needed any more, thanks');
  await go.click();
  await expect(page.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Beta post/ })).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => field(wid, pid, 'i2', 'status'), { timeout: 15_000 }).toBe('stopped');
  expect(await field(wid, pid, 'i4', 'status')).toBe('stopped');
  expect(await field(wid, pid, 'i1', 'status')).toBe('waiting');
});

test('Shift-click selects a range', async ({ page }) => {
  test.skip(isPhone(), 'Shift-click and x are desktop');
  await seedFour(page);
  await page.getByLabel('Select Alpha post').click();
  await page.getByLabel('Select Gamma post').click({ modifiers: ['Shift'] });
  await expect(page.getByRole('toolbar')).toContainText('3 selected');
  await expect(page.getByLabel('Select Delta post')).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('toolbar')).toBeHidden();
  // x selects the highlighted row (the first one).
  await page.keyboard.press('x');
  await expect(page.getByRole('toolbar')).toContainText('1 selected');
});

test('a long press on a phone starts selecting; tapping rows then toggles them', async ({
  page,
}) => {
  test.skip(!isPhone(), 'long press is the phone way in');
  await seedFour(page);
  await expect(page.getByLabel('Select Alpha post')).toHaveCount(0);
  await startSelecting(page, 'Alpha post');
  await expect(page.getByRole('toolbar')).toContainText('1 selected');
  await expect(page.getByLabel('Select Alpha post')).toBeChecked();
  // The press did not open the item, and a tap on another row selects it.
  await expect(page.getByRole('article')).toHaveCount(0);
  await page
    .getByRole('button', { name: /Beta post/ })
    .first()
    .click();
  await expect(page.getByRole('toolbar')).toContainText('2 selected');
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByRole('toolbar')).toBeHidden();
});

test('an item decided elsewhere meanwhile is skipped, and the toast says so', async ({ page }) => {
  const { wid, pid, uid } = await seedFour(page);
  await startSelecting(page, 'Alpha post');
  await page.getByLabel('Select Beta post').click();
  await page.getByLabel('Select Gamma post').click();
  await expect(page.getByRole('toolbar')).toContainText('3 selected');
  // Someone else moves Beta on.
  await adminSet(
    itemPath(wid, pid, 'i2'),
    waitingItem(uid, { title: 'Beta post', stepId: 'publish', status: 'queued', gate: null }),
  );
  await expect(page.getByRole('button', { name: /Beta post/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Approve 3' }).click();
  // Not your own click, so it is news: it shows once the countdown ends.
  await expect(page.locator('button[data-undo]')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('2 approved, 1 had already moved', {
    timeout: 15_000,
  });
});
