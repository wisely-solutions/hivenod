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
} from './helpers';

// Card TU5pDmzE: agent findings are suggestions in a dashed lane at the top of the first column.

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page) {
  const owner = person('João');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `sg${rand()}`;
  const base = projectFields('Launch blog', uid);
  const steps = [
    { id: 'ideas', name: 'Ideas', kind: 'agent', description: 'Ideas' },
    base.steps[1],
  ];
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps,
    stepIndex: { ideas: 0, review: 1 },
  });
  await adminSet(`workspaces/${wid}/agents/writer`, {
    name: 'Writer',
    color: 'agent-2',
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  const item = {
    type: 'idea',
    stepId: 'ideas',
    status: 'queued',
    summary: '',
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
  };
  const at = (id: string) => `workspaces/${wid}/projects/${pid}/items/${id}`;
  await adminSet(at('p3'), { ...item, title: 'Post 3: launch recap' });
  for (const [id, title, summary] of [
    ['s1', 'Add alt text to hero images', '4 images have none.'],
    ['s2', 'Footer link to /pricing is broken', ''],
  ] as const) {
    await adminSet(at(id), {
      ...item,
      title,
      summary,
      type: 'finding',
      status: 'suggested',
      source: { kind: 'finding', label: 'Writer on Post 3: launch recap' },
      createdBy: { type: 'agent', id: 'writer' },
      parentItemId: 'p3',
      order: id === 's1' ? 1 : 2,
    });
  }
  return { wid, pid, at };
}

const status = async (path: string) => (await adminDoc(path))?.fields.status?.stringValue;

test('suggestions lane: add to Ideas, dismiss needs a reason, hidden when empty', async ({
  page,
}) => {
  const { pid, at } = await seed(page);
  await page.goto(`/p/${pid}`);
  const lane = page.getByRole('region', { name: '2 suggestions from agents' });
  await expect(lane).toBeVisible({ timeout: 20_000 });
  await expect(
    lane.getByText('Found by Writer while on “Post 3: launch recap”: 4 images'),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  const axe = await new AxeBuilder({ page }).include('[data-testid="suggestions"]').analyze();
  expect(axe.violations).toEqual([]);
  // The suggestions are not items of the column (they are not work).
  const column = page.locator('[data-step="ideas"]');
  await expect(column.getByText('Post 3: launch recap', { exact: true })).toBeVisible();

  // Add to Ideas: a normal item at the first step, agents can claim it.
  await lane.getByRole('button', { name: 'Add to Ideas' }).first().click();
  await expect(page.getByRole('region', { name: '1 suggestion from agents' })).toBeVisible();
  await expect.poll(() => status(at('s1'))).toBe('queued');
  expect((await adminDoc(at('s1')))?.fields.type?.stringValue).toBe('task');
  await expect(column.getByText('Add alt text to hero images', { exact: true })).toBeVisible();

  // Dismiss…: a reason of 10+ characters, with the counter.
  const one = page.getByRole('region', { name: '1 suggestion from agents' });
  await one.getByRole('button', { name: 'Dismiss…' }).click();
  const dialog = page.getByRole('dialog');
  const go = dialog.getByRole('button', { name: 'Dismiss', exact: true });
  await expect(go).toBeDisabled();
  await expect(dialog.getByText('0 / 10 characters minimum')).toBeVisible();
  await dialog.getByLabel('Why are you dismissing it?').fill('too short');
  await expect(go).toBeDisabled();
  await dialog.getByLabel('Why are you dismissing it?').fill('Already fixed in the footer card.');
  await go.click();
  await expect(page.getByTestId('suggestions')).toHaveCount(0);
  await expect.poll(() => status(at('s2'))).toBe('stopped');
  const triage = (await adminDoc(at('s2')))?.fields.triage?.mapValue?.fields;
  expect(triage?.outcome?.stringValue).toBe('dismissed');
  expect(triage?.reason?.stringValue).toBe('Already fixed in the footer card.');

  // The activity feed says what happened in plain words.
  await page.goto('/activity');
  await expect(
    page.getByText(/dismissed the suggestion “Footer link to \/pricing is broken”/).first(),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByText('added the suggestion “Add alt text to hero images” to Ideas').first(),
  ).toBeVisible();
});

test('suggestions show in Needs you > Findings for a triager', async ({ page }) => {
  await seed(page);
  await page.goto('/?f=findings');
  await expect(page.getByText('Add alt text to hero images').first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('Footer link to /pricing is broken').first()).toBeVisible();
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { pid } = await seed(page);
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${pid}`);
    await expect(page.getByTestId('suggestions')).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${dir}/suggestions-${size}-${theme}.png` });
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .include('[data-testid="suggestions"]')
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  }
});
