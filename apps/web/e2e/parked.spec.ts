/**
 * Item QjTTL: an agent parks an item it holds (waiting on a release batch, a review). The board
 * card shows "Waiting: <reason> · since <time>" and the agent's presence reads
 * "working N · waiting M" (card footer, agents list, agent profile). At 1440 and 390, light and
 * dark, axe-clean. Parking itself is tested in cli/e2e (channel suite, Go CLI).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  NOW,
  ago,
  freezeClock,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const SHOTS = process.env.SHOTS_DIR;
const THEMES = ['light', 'dark'] as const;

async function themed(
  page: Page,
  name: string,
  check: () => Promise<void>,
  disable: string[] = [],
) {
  const size = page.viewportSize()!.width <= 500 ? '390' : '1440';
  for (const theme of THEMES) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(200);
    await check();
    expect((await new AxeBuilder({ page }).disableRules(disable).analyze()).violations).toEqual([]);
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
    claim: { runId, agentUid: 'scout', heartbeatAt: new Date(NOW) },
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order,
    updatedAt: new Date(NOW),
    lastEventId: 'seed',
    ...extra,
  };
}

async function seed(page: Page) {
  const owner = person('Ana Admin');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
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
  const since = ago(45);
  await adminSet(
    `${base}/projects/blog/items/i1`,
    itemDoc(uid, 'Ship the pricing page', 'r1', 1, {
      parked: { runId: 'r1', reason: 'release batch with the docs update', at: since },
    }),
  );
  await adminSet(`${base}/projects/blog/items/i2`, itemDoc(uid, 'Draft the launch email', 'r2', 2));
  const p = (n: number) => String(n).padStart(2, '0');
  return { hhmm: `${p(since.getUTCHours())}:${p(since.getUTCMinutes())}` };
}

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
});

test('a parked item shows Waiting on its card; the agent reads working 1 · waiting 1', async ({
  page,
}, info) => {
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  const { hhmm } = await seed(page);

  await page.goto('/p/blog');
  const card = page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: 'Ship the pricing page' }) })
    .first();
  await expect(card).toContainText('Waiting: release batch with the docs update', {
    timeout: 15_000,
  });
  await expect(card).toContainText(`· since ${hhmm}`);
  await expect(card.getByTestId('agent-presence')).toHaveText('Scout · working 1 · waiting 1');
  // The open item says it too, and offers Stop work (it is not running right now).
  await card.click();
  const detail = page.locator('[aria-label="Item detail"]:visible');
  await expect(detail).toContainText('Waiting: release batch with the docs update');
  await expect(detail.getByRole('button', { name: 'Stop work' })).toBeVisible();
  await themed(page, 'parked-detail', async () => {
    await expect(detail).toBeVisible();
  });
  await page.goto('/p/blog');
  // The footer of the sidebar (desktop): the organization's agent line.
  if (info.project.name === 'desktop-1440')
    await expect(page.getByLabel('Organization status')).toContainText(
      '1 agent · working 1 · waiting 1 · 0 idle',
    );
  await settle(page);
  await expectNoHorizontalScroll(page);
  await themed(page, 'parked-board', async () => {
    await expect(card).toBeVisible();
  });

  await page.goto('/agents');
  const row = page.getByRole('listitem', { name: 'Scout' });
  await expect(row).toContainText('Online · working 1 · waiting 1', { timeout: 15_000 });
  await settle(page);
  await themed(page, 'parked-agents', async () => {
    await expect(row).toBeVisible();
  });

  await page.goto('/agents/scout');
  await expect(page.getByTestId('working-items')).toHaveText('Working 1 · waiting 1', {
    timeout: 15_000,
  });
  await settle(page);
  await expectNoHorizontalScroll(page);
  await themed(page, 'parked-agent', async () => {
    await expect(page.getByTestId('working-items')).toBeVisible();
  });
});
