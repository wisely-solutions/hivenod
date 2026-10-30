import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
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

// Item DhsO9: agents create items where a project allows it ("Agents may create items"). People
// switch it in Settings > Projects (row and edit form); the item and Activity show the agent.

const rand = () => Math.random().toString(36).slice(2, 8);
const THEMES = ['light', 'dark'] as const;

async function enter(page: Page, name: string, info: TestInfo) {
  // The phone run checks the 390 px width (iPhone 12 to 15).
  if ((info.project.use.viewport?.width ?? 1440) < 1000)
    await page.setViewportSize({ width: 390, height: 844 });
  const who = person(name);
  await page.goto('/');
  await signIn(page, who);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(who.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  return { wid: await workspaceOf(who.email), uid: await uidOf(who.email) };
}

async function axe(page: Page, include?: string) {
  // A theme switch fades colours for a moment: check the settled page.
  await page.waitForTimeout(500);
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running'),
  );
  let b = new AxeBuilder({ page }).withTags([
    'wcag2a',
    'wcag2aa',
    'wcag21aa',
    'wcag22aa',
    'best-practice',
  ]);
  if (include) b = b.include(include);
  const { violations } = await b.analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

async function shot(page: Page, info: TestInfo, name: string, theme: string) {
  const dir = process.env.SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const size = (page.viewportSize()?.width ?? 1440) >= 1000 ? '1440' : '390';
  await page.screenshot({ path: `${dir}/${name}-${size}-${theme}.png`, fullPage: false });
  void info;
}

const setting = async (path: string) =>
  (await adminDoc(path))?.fields.agentsMayCreateItems?.booleanValue;

test('Settings > Projects: "Agents may create items" is off by default and switches from the row and the edit form', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const { wid, uid } = await enter(page, 'Carla Create', info);
  const pid = `ac${rand()}`;
  const path = `workspaces/${wid}/projects/${pid}`;
  await adminSet(path, projectFields('Checkout', uid));
  await page.goto('/settings/projects');
  const row = page.getByRole('list', { name: 'Projects' }).getByRole('listitem', {
    name: 'Checkout',
  });
  const sw = row.getByRole('switch', { name: /Agents may create items/ });
  await expect(sw).toBeVisible({ timeout: 20_000 });
  await expect(sw).not.toBeChecked();

  // The row switch saves at once.
  await sw.click();
  await expect(page.getByText('Agents may now create items in Checkout.')).toBeVisible();
  await expect.poll(() => setting(path)).toBe(true);
  await expect(sw).toBeChecked();

  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoHorizontalScroll(page);
    await axe(page);
    await shot(page, info, 'agents-create-setting', theme);
  }

  // The edit form has it too, and saves it with the rest.
  await row.getByRole('button', { name: 'Edit Checkout' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Checkout' });
  const inForm = dialog.getByRole('switch', { name: /Agents may create items/ });
  await expect(inForm).toBeChecked();
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await axe(page, '[role="dialog"]');
    await shot(page, info, 'agents-create-edit', theme);
  }
  await inForm.click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => setting(path)).toBe(false);
  await expect(sw).not.toBeChecked();
});

test('an item an agent created shows "Created by <agent>" in the item and in Activity', async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const { wid, uid } = await enter(page, 'Dora Detail', info);
  const pid = `ac${rand()}`;
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/${pid}`, {
    ...projectFields('Checkout', uid),
    agentsMayCreateItems: true,
  });
  await adminSet(`${base}/agents/scout`, {
    name: 'Scout',
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
  const at = new Date();
  await adminSet(`${base}/projects/${pid}/items/n1`, {
    title: 'Checkout times out on Safari',
    type: 'task',
    stepId: 'draft',
    status: 'queued',
    summary: 'Asked by Dora on Telegram.',
    source: { kind: 'agent', label: 'Scout' },
    createdBy: { type: 'agent', id: 'scout' },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    attachmentCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: at,
    stepAt: at,
    lastEventId: 'ev1',
  });
  await adminSet(`${base}/events/ev1`, {
    actor: { type: 'agent', id: 'scout', name: 'Scout' },
    projectId: pid,
    itemId: 'n1',
    runId: null,
    type: 'item.created',
    data: { title: 'Checkout times out on Safari' },
    at,
  });

  await page.goto(`/p/${pid}?item=n1`);
  const createdBy = page.getByTestId('created-by').first();
  await expect(createdBy).toHaveText('Scout · agent', { timeout: 20_000 });
  // On a phone the properties sit below the details: it is there, and readable.
  await createdBy.scrollIntoViewIfNeeded();
  await expect(createdBy).toBeVisible();
  for (const theme of THEMES) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoHorizontalScroll(page);
    await axe(page);
    await shot(page, info, 'agents-create-item', theme);
  }
});
