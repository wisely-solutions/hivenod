/**
 * Item AzveC: status checks on ongoing work. The card and the item show the agent's last status
 * ("Running release checks · 70%") and the notifier's "No update for N min" flag. Anyone on the
 * project presses "Ask for status" (item view and card menu): the ask is stored, the button reads
 * "Asked · waiting…" and stays disabled; a stub agent answers and the status shows. Settings >
 * Projects sets the interval (off by default) and the silence threshold (40 min). At 1440 and 390, light and dark, axe-clean. The status events and
 * the status tool are tested in cli/e2e (channel suite, Go CLI); the silence check
 * in packages/notifier.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminUpdate,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
const SHOTS = process.env.SHOTS_DIR;
const THEMES = ['light', 'dark'] as const;

async function themed(page: Page, name: string, check: () => Promise<void>) {
  const size = page.viewportSize()!.width <= 500 ? '390' : '1440';
  for (const theme of THEMES) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(200);
    await check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png` });
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

function runDoc(itemId: string) {
  return {
    agentUid: 'scout',
    projectId: 'blog',
    itemId,
    stepId: 'draft',
    startedAt: ago(90),
    heartbeatAt: ago(0),
    heartbeatEventAt: ago(4),
    endedAt: null,
    status: 'running',
    costEur: 0,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    summary: null,
    lastEventId: 'seed',
  };
}
function itemDoc(uid: string, title: string, runId: string, order: number, extra = {}) {
  return {
    title,
    type: 'task',
    stepId: 'draft',
    status: 'working',
    summary: '',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: { runId, agentUid: 'scout', heartbeatAt: new Date() },
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order,
    updatedAt: new Date(),
    lastEventId: 'seed',
    ...extra,
  };
}

async function seed(page: Page, name: string) {
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
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`${base}/agents/scout`, {
    name: 'Scout',
    color: 'agent-3',
    projectIds: '*',
    createdBy: uid,
    createdAt: ago(1000),
    revokedAt: null,
    lastSeenAt: ago(0),
    tokenHint: 'a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/runs/r1`, runDoc('i1'));
  await adminSet(`${base}/runs/r2`, runDoc('i2'));
  await adminSet(
    `${base}/projects/blog/items/i1`,
    itemDoc(uid, 'Ship the pricing page', 'r1', 1, {
      statusUpdate: {
        runId: 'r1',
        text: 'Running release checks, e2e batch 2 of 3',
        pct: 70,
        at: ago(3),
        by: 'scout',
      },
    }),
  );
  await adminSet(
    `${base}/projects/blog/items/i2`,
    itemDoc(uid, 'Draft the launch email', 'r2', 2, {
      silence: { runId: 'r2', since: Date.now() - 42 * MIN, at: Date.now() - MIN, agent: 'Scout' },
    }),
  );
  return { wid, base };
}

const cardOf = (page: Page, title: string) =>
  page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: title }) })
    .first();

test('the card and the item show the status line and the silent flag', async ({
  page,
}, info) => {
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, 'Stella Status');
  await page.goto('/p/blog');
  const working = cardOf(page, 'Ship the pricing page');
  await expect(working.getByTestId('status-line')).toHaveText(
    'Running release checks, e2e batch 2 of 3 · 70%',
    { timeout: 15_000 },
  );
  const quiet = cardOf(page, 'Draft the launch email');
  await expect(quiet.getByTestId('silence-flag')).toHaveText(/Scout silent for 4[23] min/);
  await settle(page);
  await expectNoHorizontalScroll(page);
  await themed(page, 'status-board', async () => {
    await expect(working).toBeVisible();
  });

  await working.click();
  const detail = page.locator('[aria-label="Item detail"]:visible');
  await expect(detail.getByTestId('status-line')).toHaveText(
    'Running release checks, e2e batch 2 of 3 · 70%',
  );
  await expect(detail.getByTestId('ask-status')).toBeEnabled();
  await themed(page, 'status-detail', async () => {
    await expect(detail).toBeVisible();
  });
});

test('Ask for status: stored, "Asked · waiting…" until a stub agent answers; again only after 2 min', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  const { base } = await seed(page, 'Askin Asker');
  await page.goto('/p/blog');
  await cardOf(page, 'Draft the launch email').click();
  const detail = page.locator('[aria-label="Item detail"]:visible');
  const button = detail.getByTestId('ask-status');
  await expect(button).toHaveText('Ask for status', { timeout: 15_000 });
  await button.click();
  await expect(button).toHaveText('Asked · waiting…');
  await expect(button).toBeDisabled();
  const path = `${base}/projects/blog/items/i2`;
  await expect
    .poll(
      async () => (await adminDoc(path))?.fields.statusAsk?.mapValue?.fields?.runId?.stringValue,
    )
    .toBe('r2');
  await themed(page, 'status-asked', async () => {
    await expect(button).toBeDisabled();
  });
  // The history says who asked.
  await detail.getByRole('tab', { name: 'History' }).click();
  await expect(
    detail.getByText('Askin Asker asked for a status on “Draft the launch email”'),
  ).toBeVisible({ timeout: 15_000 });
  await detail.getByRole('tab', { name: 'Details' }).click();

  // A stub agent answers through the item (the status tool's write).
  await adminUpdate(path, {
    statusUpdate: {
      runId: 'r2',
      text: 'Writing the subject lines',
      pct: 40,
      at: new Date(),
      by: 'scout',
    },
  });
  await expect(detail.getByTestId('status-line')).toHaveText('Writing the subject lines · 40%');
  // The silence flag is gone (a status newer than it); a second ask within 2 minutes is disabled.
  await expect(detail.getByTestId('silence-flag')).toHaveCount(0);
  await expect(button).toHaveText('Ask for status');
  await expect(button).toBeDisabled();

  // The card menu has it too (desktop: the "..." button).
  if (info.project.name === 'desktop-1440') {
    await page.goto('/p/blog');
    const card = cardOf(page, 'Draft the launch email');
    await expect(card.getByTestId('status-line')).toHaveText('Writing the subject lines · 40%', {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Actions for Draft the launch email' }).click();
    const item = page.getByRole('menuitem', { name: 'Ask for status' });
    await expect(item).toBeVisible();
    await expect(item).toHaveAttribute('data-disabled', '');
  }
});

test('Settings > Projects: the status push is off by default, silence after 40 min; both change', async ({
  page,
}, info) => {
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  const { base } = await seed(page, 'Ivan Interval');
  await page.goto('/settings/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem', { name: 'Blog' });
  const select = row.getByLabel('Ask agents for a status');
  await expect(select).toHaveValue('0', { timeout: 20_000 });
  const silence = row.getByLabel('Flag an item as silent after');
  await expect(silence).toHaveValue('40');
  await select.selectOption('15');
  await expect(
    page.getByText('Agents in Blog are asked for a status every 15 minutes.'),
  ).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog`))?.fields.statusEvery?.integerValue)
    .toBe('15');
  await silence.selectOption('20');
  await expect(
    page.getByText('Items in Blog are flagged after 20 minutes without activity.'),
  ).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog`))?.fields.silenceAfter?.integerValue)
    .toBe('20');
  await expectNoHorizontalScroll(page);
  await themed(page, 'status-setting', async () => {
    await expect(select).toBeVisible();
    await expect(silence).toBeVisible();
  });
  // The edit form saves both too.
  await row.getByRole('button', { name: 'Edit Blog' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Blog' });
  const inForm = dialog.getByLabel('Ask agents for a status');
  await expect(inForm).toHaveValue('15');
  await inForm.selectOption('0');
  const silenceInForm = dialog.getByLabel('Flag an item as silent after');
  await expect(silenceInForm).toHaveValue('20');
  await silenceInForm.selectOption('120');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog`))?.fields.statusEvery?.integerValue)
    .toBe('0');
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog`))?.fields.silenceAfter?.integerValue)
    .toBe('120');
});
