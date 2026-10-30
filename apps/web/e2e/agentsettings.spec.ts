/**
 * Card zSzW3LXy: agent settings (projects, steps, guardrails, unattended permissions), the paused
 * state with Resume, tokens and model on the agent page and in run details, and "Who can do this
 * step" in the process editor. Rules for who may change what are covered by the rules tests.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  NOW,
  ago,
  freezeClock,
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

const SHOTS = process.env.SHOTS_DIR;

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize()!.width <= 500 ? '375' : '1440';
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${name}-${size}-${theme}.png`, fullPage: true });
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
}

const agentDoc = (uid: string, name: string, over: Record<string, unknown> = {}) => ({
  name,
  color: 'agent-3',
  projectIds: '*',
  createdBy: uid,
  createdAt: ago(1000),
  revokedAt: null,
  lastSeenAt: ago(1),
  tokenHint: 'a7f3',
  previousAgentUid: null,
  lastEventId: 'seed',
  ...over,
});

const launchPost = (uid: string) => ({
  title: 'Launch post',
  type: 'task',
  stepId: 'draft',
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
  updatedAt: new Date(NOW),
  lastEventId: 'seed',
});

async function seed(page: Page) {
  const owner = person('Ana Admin');
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
  await adminSet(`${base}/projects/docs`, { ...projectFields('Docs', uid), emoji: '📚' });
  // Scout: paused after 3 failed runs, created before settings existed (no guardrails field).
  await adminSet(
    `${base}/agents/scout`,
    agentDoc(uid, 'Scout', {
      failStreak: 3,
      pausedAt: ago(2),
      pausedReason: '3 failed runs in a row',
    }),
  );
  await adminSet(`${base}/agents/writer`, agentDoc(uid, 'Writer', { projectIds: ['blog'] }));
  await adminSet(`${base}/projects/blog/items/i1`, launchPost(uid));
  await adminSet(`${base}/runs/r1`, {
    agentUid: 'scout',
    projectId: 'blog',
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago(6),
    heartbeatAt: ago(4),
    heartbeatEventAt: ago(6),
    endedAt: ago(4),
    status: 'failed',
    costEur: 0,
    tokensIn: 50_000,
    tokensCached: 40_000,
    tokensOut: 2_000,
    model: 'claude-opus-5-5',
    summary: 'Stopped by the token limit',
    lastEventId: 'seed',
    // An interactive run (card OPpbi0MS): its Remote Control session.
    remote: {
      url: 'https://claude.ai/code/session_01FakeRemoteSession42',
      sessionId: '09817820-8d33-4efd-9b86-5272eb25da0d',
    },
  });
  return { wid, uid, base };
}

test.beforeEach(async ({ page }) => {
  await freezeClock(page);
});

test('Agent settings: paused + Resume, guardrails saved, no project scope', async ({ page }) => {
  const { base } = await seed(page);
  await page.goto('/agents');
  const row = page.getByRole('listitem', { name: 'Scout' });
  await expect(row.getByText('Paused', { exact: true })).toBeVisible();
  // Seen a minute ago, but paused: not "Online · waiting for work" (tester R72).
  await expect(row.getByText('Paused · 3 failed runs in a row · takes no new work')).toBeVisible();
  await expect(row.getByText(/waiting for work/)).toHaveCount(0);
  // Paused is never in the online green (card PfL7qxSM).
  await expect(row.getByText(/^Paused · 3 failed/)).toHaveClass(/text-gate-text/);
  await expect(row.getByText(/^Paused · 3 failed/)).not.toHaveClass(/text-approve-text/);
  await row.getByRole('link', { name: 'Scout' }).click();
  await expect(page.getByRole('heading', { name: 'Scout', level: 1 })).toBeVisible();

  // Paused, with the reason, and an admin can resume it.
  const banner = page.getByTestId('paused-banner');
  await expect(banner).toContainText('3 failed runs in a row');

  // Settings start from the defaults for an agent that never had them.
  const settings = page.getByRole('region', { name: 'Works on' });
  await expect(settings.getByLabel('Stop after failed runs in a row')).toHaveValue('3');
  // No token limit and no permission chips: usage is tracked only, permissions are Claude Code's.
  await expect(settings.getByLabel(/Token limit/)).toHaveCount(0);
  await expect(settings.getByText(/Allowed when unattended/)).toHaveCount(0);
  await expect(settings.getByText(/set in that machine’s Claude Code settings/)).toBeVisible();
  // Projects were removed (OE8Fm slice 10): no project or step picker.
  await expect(settings.getByRole('button', { name: 'All projects' })).toHaveCount(0);
  await expect(settings.getByText(/threads and plans of the Inbox/)).toBeVisible();
  await expect(settings.getByText('Ask in Hivenod (Needs you)')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await shot(page, 'agent-settings');

  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toBeHidden();
  await expect
    .poll(async () => (await adminDoc(`${base}/agents/scout`))?.fields.failStreak?.integerValue)
    .toBe('0');
  expect((await adminDoc(`${base}/agents/scout`))?.fields.pausedAt?.nullValue).toBeNull();

  // Change the guardrails.
  await settings.getByLabel('Stop after failed runs in a row').fill('0');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(settings.getByText('A whole number from 1 to 20.')).toBeVisible();
  await settings.getByLabel('Stop after failed runs in a row').fill('5');
  await settings.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${base}/agents/scout`))?.fields.guardrails?.mapValue)
    .toEqual({ fields: { maxFailedRuns: { integerValue: '5' } } });
  const doc = await adminDoc(`${base}/agents/scout`);
  // Nothing is written for permissions any more.
  expect(doc?.fields.permissions).toBeUndefined();
  // The legacy project scope is left as it was.
  expect(doc?.fields.projectIds?.stringValue).toBe('*');

  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
});
