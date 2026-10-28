/**
 * Card zSzW3LXy: agent settings (projects, steps, guardrails, unattended permissions), the paused
 * state with Resume, tokens and model on the agent page and in run details, and "Who can do this
 * step" in the process editor. Rules for who may change what are covered by the rules tests.
 */
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

const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);
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
  updatedAt: new Date(),
  lastEventId: 'seed',
});

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

test('Agent settings: paused + Resume, guardrails saved, tokens and model shown', async ({
  page,
}) => {
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
  const settings = page.getByRole('region', { name: 'Allowed to work on' });
  await expect(settings.getByLabel('Stop after failed runs in a row')).toHaveValue('3');
  // No token limit and no permission chips: usage is tracked only, permissions are Claude Code's.
  await expect(settings.getByLabel(/Token limit/)).toHaveCount(0);
  await expect(settings.getByText(/Allowed when unattended/)).toHaveCount(0);
  await expect(settings.getByText(/set in that machine’s Claude Code settings/)).toBeVisible();
  await expect(settings.getByRole('button', { name: 'All projects' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(settings.getByText('Ask in Hivenod (Needs you)')).toBeVisible();
  await expect(
    settings.getByText('Gates are never decided by agents.', { exact: false }),
  ).toBeVisible();

  // Tokens: new = 50,000 - 40,000 cached + 2,000 out; the model.
  await expect(page.getByTestId('kpi-tokens')).toHaveText('12k');
  await expect(page.getByTestId('kpi-models')).toHaveText('claude-opus-5-5');
  await expectNoHorizontalScroll(page);
  await shot(page, 'agent-settings');

  await banner.getByRole('button', { name: 'Resume' }).click();
  await expect(banner).toBeHidden();
  await expect
    .poll(async () => (await adminDoc(`${base}/agents/scout`))?.fields.failStreak?.integerValue)
    .toBe('0');
  expect((await adminDoc(`${base}/agents/scout`))?.fields.pausedAt?.nullValue).toBeNull();

  // Change the guardrails, limit it to one project.
  await settings.getByRole('button', { name: 'All projects' }).click();
  await settings.getByRole('button', { name: /Blog/ }).click();
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
  expect(
    doc?.fields.projectIds?.arrayValue.values.map((v: { stringValue: string }) => v.stringValue),
  ).toEqual(['blog']);

  // Run details: new tokens in / out, cache reads apart, the model.
  const runs = page.getByRole('list', { name: 'Runs' });
  await runs.getByRole('button', { name: /Launch post/ }).click();
  await expect(page.getByTestId('run-tokens')).toHaveText('10,000 / 2,000');
  await expect(page.getByTestId('run-cached')).toHaveText('40,000');
  // The run's Remote Control session opens on claude.ai/code (card OPpbi0MS).
  await expect(page.getByTestId('run-remote')).toHaveAttribute(
    'href',
    'https://claude.ai/code/session_01FakeRemoteSession42',
  );
  await expect(runs.getByText('claude-opus-5-5')).toBeVisible();
  await shot(page, 'agent-run-tokens');

  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
});

test('Process editor: an agent step limited to one agent; the other agent page shows it', async ({
  page,
}) => {
  const { base } = await seed(page);
  await page.goto('/p/blog/process');
  await page.getByRole('button', { name: 'Edit Draft' }).click();
  const who = page.getByTestId('who-can-do');
  await expect(who.getByRole('radio', { name: /Any agent on this project/ })).toBeChecked();
  await who.getByRole('radio', { name: /Only these agents/ }).click();
  await who.getByRole('button', { name: 'Writer' }).click();
  await expect(who.getByRole('button', { name: 'Writer' })).toHaveAttribute('aria-pressed', 'true');
  await expectNoHorizontalScroll(page);
  await shot(page, 'process-who-can-do');
  // Phones edit in a sheet: close it to reach the save bar.
  const done = page.getByRole('dialog').getByRole('button', { name: 'Done' });
  if (await done.isVisible().catch(() => false)) await done.click();
  await page.getByRole('button', { name: 'Save process' }).click();
  await expect(page.getByText('Process saved.')).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${base}/projects/blog`))?.fields.stepAgents?.mapValue)
    .toEqual({ fields: { draft: { arrayValue: { values: [{ stringValue: 'writer' }] } } } });
  await expect(page.getByText('Only Writer')).toBeVisible();

  // Scout may not take Draft in Blog any more; Writer may.
  await page.goto('/agents/scout');
  const blogSteps = page.getByRole('list', { name: 'Steps this agent may take' });
  await expect(blogSteps.locator('[data-step="draft"]').first()).toHaveAttribute(
    'data-allowed',
    'no',
  );
  await page.goto('/agents/writer');
  await expect(
    page.getByRole('list', { name: 'Steps this agent may take' }).locator('[data-step="draft"]'),
  ).toHaveAttribute('data-allowed', 'yes');
});

test('Held for an answer (an old token-limit hold): the item says so and an admin can let agents take it', async ({
  page,
}) => {
  const { base, uid, wid } = await seed(page);
  await adminSet(`${base}/projects/blog/items/i1/messages/q1`, {
    workspaceId: wid,
    projectId: 'blog',
    itemId: 'i1',
    by: { type: 'agent', id: 'scout' },
    kind: 'question',
    text: 'I stopped: this run used 12,000 new tokens, over this agent’s limit of 10,000 per item.',
    at: ago(2),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, {
    ...launchPost(uid),
    awaitingAnswer: { questionId: 'q1', agentUid: 'scout', at: ago(2), reason: 'tokenLimit' },
  });
  await page.goto('/p/blog?item=i1');
  const held = page.getByTestId('held-banner').first();
  await expect(held).toContainText('Waiting for an answer.');
  // An old hold with reason 'tokenLimit' (a guardrail that no longer exists) reads as an
  // ordinary open question, so nothing is stuck (card rifzGl8M).
  await expect(held).toContainText('The agent asked a question and gave the item back');
  await expect(held).not.toContainText('token limit');
  // The item's Runs panel shows tokens and model, like the agent page (tester finding 9).
  await expect(page.getByTestId('run-tokens').first()).toHaveText('12k tokens');
  await expect(page.getByTestId('run-model').first()).toHaveText('claude-opus-5-5');
  await expect(page.getByTestId('run-remote').first()).toHaveText('Open in Claude');
  await expect(page.getByTestId('run-remote').first()).toHaveAttribute(
    'href',
    'https://claude.ai/code/session_01FakeRemoteSession42',
  );
  await expectNoHorizontalScroll(page);
  await shot(page, 'item-held');
  await held.getByRole('button', { name: 'Let agents take it' }).click();
  await expect(held).toBeHidden();
  await expect
    .poll(
      async () =>
        (await adminDoc(`${base}/projects/blog/items/i1`))?.fields.awaitingAnswer?.nullValue,
    )
    .toBe(null);
});

test('Held for the agent’s own question: the banner says the agent asked', async ({ page }) => {
  const { base, uid, wid } = await seed(page);
  await adminSet(`${base}/projects/blog/items/i1/messages/q2`, {
    workspaceId: wid,
    projectId: 'blog',
    itemId: 'i1',
    by: { type: 'agent', id: 'scout' },
    kind: 'question',
    text: 'I stopped: this run used 12,000 new tokens, over this agent’s limit of 10,000 per item.',
    at: ago(2),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  await adminSet(`${base}/projects/blog/items/i1`, {
    ...launchPost(uid),
    awaitingAnswer: { questionId: 'q2', agentUid: 'scout', at: ago(2) },
  });
  await page.goto('/p/blog?item=i1');
  const held = page.getByTestId('held-banner').first();
  await expect(held).toContainText('The agent asked a question and gave the item back');
  await expect(held).not.toContainText('guardrail');
});
