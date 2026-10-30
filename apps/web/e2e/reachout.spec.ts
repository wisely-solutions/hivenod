/**
 * Item KZ6O9: Hivenod reaches out when work in agent hands goes quiet. When the agent did not
 * answer the status request, the notifier flags it; the web shows "<agent> silent for N min" on the
 * card and the item (parked items too), on the thread's plan step, and in Today's "Agents working".
 * The timers, requests, messages and buttons are tested in packages/notifier (emulator, fake
 * clock) and cli (Go). At 1440 and 390, light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
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

async function look(page: Page, name: string) {
  const size = page.viewportSize()!.width <= 500 ? '390' : '1440';
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: `${SHOTS}/built-${name}-${size}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function seed(page: Page) {
  const me = person('Rhea Reach');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const base = `workspaces/${wid}`;
  await adminSet(`${base}/projects/hive`, projectFields('Hive', uid));
  await adminSet(`${base}/agents/hive`, {
    name: 'Hive',
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
  const run = (itemId: string) => ({
    agentUid: 'hive',
    projectId: 'hive',
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
  });
  await adminSet(`${base}/runs/r1`, run('i1'));
  await adminSet(`${base}/projects/hive/items/i1`, {
    title: 'Dark mode for the board',
    type: 'task',
    stepId: 'draft',
    status: 'working',
    summary: '',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: { runId: 'r1', agentUid: 'hive', heartbeatAt: new Date() },
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: ago(41),
    lastEventId: 'seed',
    statusUpdate: {
      runId: 'r1',
      text: 'tests green, opening the PR',
      pct: null,
      at: ago(41),
      by: 'hive',
    },
    statusAsk: { runId: 'r1', byUid: 'hivenod', at: ago(10) },
    silence: {
      runId: 'r1',
      since: Date.now() - 41 * MIN,
      at: Date.now() - MIN,
      asked: Date.now() - 11 * MIN,
      agent: 'Hive',
      told: Date.now() - MIN,
    },
  });
  // An Inbox thread whose plan step the agent carries out went silent.
  const old = ago(52);
  await adminSet(`${base}/inboxThreads/rt1`, {
    memberUid: uid,
    subjectId: null,
    state: 'investigating',
    waiting: null,
    question: null,
    title: 'Invoice from the printer',
    refs: ['r1'],
    lastMessageAt: old,
    fetchedBy: 'hive',
    createdAt: old,
    updatedAt: old,
    lastEventId: 'e1',
  });
  await adminSet(`${base}/inboxPlans/pl1`, {
    memberUid: uid,
    threadId: 'rt1',
    proposedBy: 'hive',
    steps: ['ro1'],
    cursor: 0,
    state: 'active',
    note: 'Pay it and say thanks.',
    createdAt: old,
    updatedAt: old,
    lastEventId: 'e1',
  });
  await adminSet(`${base}/inboxOutcomes/ro1`, {
    memberUid: uid,
    threadId: 'rt1',
    type: 'reply',
    fields: { text: 'Paid, thanks.' },
    state: 'approved',
    note: '',
    proposedBy: 'hive',
    executor: 'hive',
    decision: { byUid: uid, at: old, edited: false, reason: null },
    result: null,
    planId: 'pl1',
    statusAsk: { byUid: 'hivenod', at: ago(12) },
    silence: {
      since: Date.now() - 52 * MIN,
      at: Date.now() - 2 * MIN,
      asked: Date.now() - 12 * MIN,
      agent: 'Hive',
      told: Date.now() - 2 * MIN,
    },
    createdAt: old,
    updatedAt: old,
    lastEventId: 'e1',
  });
  return { wid, uid };
}

test('silent work shows "<agent> silent for N min" on the card, the item, the plan step and Today', async ({
  page,
}, info) => {
  if (info.project.name !== 'desktop-1440') await page.setViewportSize({ width: 390, height: 844 });
  const { wid } = await seed(page);

  await page.goto('/p/hive');
  const card = page
    .getByRole('button')
    .filter({ has: page.getByRole('heading', { name: 'Dark mode for the board' }) })
    .first();
  await expect(card.getByTestId('silence-flag')).toHaveText(/Hive silent for 4[12] min/, {
    timeout: 15_000,
  });
  await look(page, 'card');

  await card.click();
  const flag = page.locator('[aria-label="Item detail"]:visible').getByTestId('silence-flag');
  await expect(flag).toHaveText(/Hive silent for 4[12] min/, { timeout: 15_000 });
  await look(page, 'item');

  await page.goto(`/inbox/${wid}/t/rt1`);
  // The decision page's top says it; at 1440 the plan step shows it too (the plan folds at 390).
  const top = page.getByRole('region', { name: 'Decision' });
  await expect(top.getByTestId('silence-flag')).toHaveText(/Hive silent for 5[23] min/, {
    timeout: 15_000,
  });
  if (info.project.name === 'desktop-1440')
    await expect(
      page.locator('[data-outcome="ro1"]').first().getByTestId('silence-flag'),
    ).toHaveText(/Hive silent for 5[23] min/);
  await look(page, 'thread');

  await page.goto('/');
  const rail = page.getByRole('region', { name: 'Agents working' });
  await expect(rail.getByTestId('silence-flag')).toHaveText(/Hive silent for 5[23] min/, {
    timeout: 15_000,
  });
  await rail.scrollIntoViewIfNeeded();
  await look(page, 'today');
});
