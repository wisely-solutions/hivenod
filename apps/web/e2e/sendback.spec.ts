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

/** Outline (agent) -> Draft (agent) -> Review (gate), plus one earlier "wrong audience" send-back. */
async function seed(page: Page) {
  const owner = person('João');
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
  const pid = `sb${rand()}`;
  const base = projectFields('Blog', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      {
        id: 'outline',
        name: 'Outline',
        kind: 'agent',
        description: 'Drop the topic, propose new ones',
      },
      { id: 'draft', name: 'Draft', kind: 'agent', description: 'Rework the post' },
      base.steps[1]!,
    ],
    stepIndex: { outline: 0, draft: 1, review: 2 },
  });
  const item = (id: string, title: string, over: Record<string, unknown> = {}) =>
    adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, {
      title,
      type: 'idea',
      stepId: 'review',
      status: 'waiting',
      summary: 'A seeded summary.',
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
      updatedAt: new Date(),
      lastEventId: 'seed',
      ...over,
    });
  await item('i1', 'Launch post');
  await item('i2', 'Pricing page', { order: 2 });
  await adminSet(`workspaces/${wid}/projects/${pid}/decisions/d1`, {
    workspaceId: wid,
    projectId: pid,
    itemId: 'old',
    itemTitle: 'Old post',
    stepId: 'review',
    outcome: 'sentBack',
    toStepId: 'outline',
    byUid: uid,
    rationale: 'Not for developers.',
    tags: ['Wrong audience'],
    at: new Date(),
    lastEventId: 'd1',
  });
  return { wid, uid, pid };
}

const field = async (path: string, name: string) => (await adminDoc(path))?.fields[name];

async function openDialog(page: Page, pid: string, item: string) {
  await page.goto(`/p/${pid}?item=${item}`);
  const detail = page.getByRole('article', { name: /./ });
  await expect(detail).toBeVisible();
  await detail.getByRole('button', { name: 'Send back…' }).click();
  const dialog = page.getByRole('dialog', { name: /Send '.*' back/ });
  await expect(dialog).toBeVisible();
  return { detail, dialog };
}

test('send back: reason required, tag, most common target, item lands there with the reason', async ({
  page,
}) => {
  const { wid, pid } = await seed(page);
  const { detail, dialog } = await openDialog(page, pid, 'i1');
  await expectNoHorizontalScroll(page);

  // Most common target is preselected and tagged; steps after the current one do not exist.
  const outline = dialog.getByRole('radio', { name: /Outline/ });
  await expect(outline).toBeChecked();
  await expect(outline).toContainText('most common');
  await expect(dialog.getByRole('radio', { name: /Stop/ })).toBeVisible();

  // Cannot submit without a reason: disabled, with a hint (no error after click).
  const confirm = dialog.getByRole('button', { name: 'Send back to Outline' });
  await expect(confirm).toBeDisabled();
  await expect(dialog.getByText(/Add a reason of at least 10 characters/)).toBeVisible();
  await expect(dialog.getByText('0 / 10 characters minimum')).toBeVisible();

  // Choose Draft, tag it, and the insight line appears.
  await dialog.getByRole('radio', { name: /Draft/ }).click();
  await expect(dialog.getByRole('button', { name: 'Send back to Draft' })).toBeDisabled();
  const tag = dialog.getByRole('button', { name: 'Wrong audience' });
  await tag.click();
  await expect(tag).toHaveAttribute('aria-pressed', 'true');
  await expect(
    dialog.getByText("This is the 2nd 'wrong audience' rejection at Review this month."),
  ).toBeVisible();
  await dialog.getByLabel('Why?').fill('too short');
  await expect(dialog.getByRole('button', { name: 'Send back to Draft' })).toBeDisabled();
  await dialog.getByLabel('Why?').fill('This is written for the wrong audience.');
  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(violations.map((v) => v.id + v.nodes.map((n) => n.html.slice(0, 160)).join('|'))).toEqual(
    [],
  );
  await dialog.getByRole('button', { name: 'Send back to Draft' }).click();
  await expect(dialog).toHaveCount(0);

  const item = `workspaces/${wid}/projects/${pid}/items/i1`;
  await expect.poll(async () => (await field(item, 'stepId'))?.stringValue).toBe('draft');
  expect((await field(item, 'sendBackCount'))?.integerValue).toBe('1');
  await expect(detail.getByText('↩ 1')).toBeVisible();
  await expect(detail.getByText('This is written for the wrong audience.').first()).toBeVisible();
});

test('stop: the item leaves the flow with a reason', async ({ page }) => {
  const { wid, pid } = await seed(page);
  const { dialog } = await openDialog(page, pid, 'i2');
  await dialog.getByRole('radio', { name: /Stop/ }).click();
  const confirm = dialog.getByRole('button', { name: 'Stop item' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Why?').fill('Not worth doing any more.');
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  const item = `workspaces/${wid}/projects/${pid}/items/i2`;
  await expect.poll(async () => (await field(item, 'status'))?.stringValue).toBe('stopped');
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { pid } = await seed(page);
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    const { dialog } = await openDialog(page, pid, 'i1');
    await page.screenshot({ path: `${dir}/sendback-top-${size}-${theme}.png` });
    await dialog.getByRole('radio', { name: /Outline/ }).click();
    await dialog.getByRole('button', { name: 'Wrong audience' }).click();
    await dialog.getByLabel('Why?').fill('This is written for the wrong audience.');
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${dir}/sendback-${size}-${theme}.png` });
  }
});
