/**
 * Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6): the member starts a Development thread
 * from New thread; Shape starts without a further approval; Build waits for Approve idea (which
 * pins the summary version); at Ship it? the top card asks with Approve · Ask for changes · Not
 * now (Not approved in the ⋯ menu); Ask for changes sends the plan back to Build with the text.
 * 1440 and 390, light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  settle,
  UNDO_WAIT,
} from './helpers';
import { seedInbox, type Seed } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.waitForTimeout(400);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots) await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const top = (page: Page) => page.getByRole('region', { name: 'Decision' });
type Fields = Record<
  string,
  {
    stringValue?: string;
    integerValue?: string;
    mapValue?: { fields: Record<string, { stringValue?: string; integerValue?: string }> };
  }
>;
const docOf = async (path: string) => ((await adminDoc(path))?.fields ?? {}) as Fields;
const planPath = (s: Seed, pid: string) => `workspaces/${s.wid}/inboxPlans/${pid}`;
const oPath = (s: Seed, oid: string) => `workspaces/${s.wid}/inboxOutcomes/${oid}`;
const stateOf = async (s: Seed, oid: string) => (await docOf(oPath(s, oid))).state?.stringValue;
const cursorOf = async (s: Seed, pid: string) =>
  Number((await docOf(planPath(s, pid))).cursor?.integerValue ?? -1);

const bar = {
  kind: 'bar',
  title: 'Board load time (ms)',
  caption: 'Dark mode adds nothing to the load time: 412 ms before, 409 ms after.',
  unit: 'ms',
  x: ['Before', 'After'],
  series: [{ name: 'Load', values: [412, 409] }],
  highlight: 1,
  better: 'down',
};

/** New thread › Development, from the Inbox page; returns the thread and plan ids. */
async function newDevThread(page: Page, s: Seed, shot?: string) {
  await page.goto('/inbox');
  await page.locator('[data-new-thread-open]').click({ timeout: 20_000 });
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Title').fill('Dark mode for the board');
  await dialog
    .getByLabel('What do you want?')
    .fill('Add a dark mode to the board: it follows the system, with a toggle in Settings.');
  await dialog.getByRole('radio', { name: /Development/ }).click();
  await expect(dialog.locator('[data-new-thread-dev]')).toContainText('Shape starts at once');
  await expect(dialog.getByLabel('Agent')).toHaveValue(s.agent.aid);
  if (shot) await look(page, shot);
  await dialog.locator('[data-new-thread-create]').click();
  await expect(page).toHaveURL(new RegExp(`/inbox/${s.wid}/t/`), { timeout: 20_000 });
  const tid = new URL(page.url()).pathname.split('/').pop()!;
  const plans = await s.agent.plansOf(tid);
  expect(plans).toHaveLength(1);
  return { tid, planId: plans[0]! };
}

/** The agent runs Shape, the member approves the idea, the agent builds: Ship it? waits. */
async function toShipIt(page: Page, s: Seed, tid: string, planId: string) {
  await s.agent.finishStep(planId, 'done', { permalink: 'https://example.com/drafts/dark-mode' });
  const v = await s.agent.summary(tid, {
    headline: 'Dark mode for the board',
    ask: 'Build this?',
    answer: 'Size M: one theme token set, a Settings toggle, no data change.',
    recommendation: { action: 'Approve', why: 'small, and asked for twice' },
    confidence: 'high',
    bullets: [{ text: 'Follows the system theme; a toggle in Settings overrides it.' }],
    noVisualWhy: 'An idea: nothing to show yet.',
  });
  await expect(top(page)).toHaveAttribute('data-top', 'person', { timeout: 20_000 });
  await expect(top(page).locator('[data-kicker]')).toContainText('step 2 of 6 · Approve idea');
  await top(page).locator('[data-gate-approve]').click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(() => cursorOf(s, planId)).toBe(2);
  const [, gate] = await s.agent.stepsOf(planId);
  const dec = (await docOf(oPath(s, gate!))).decision?.mapValue?.fields;
  expect(dec?.summaryVersion?.integerValue).toBe(String(v));
  // Build: an open, green, unmerged pull request.
  await s.agent.finishStep(planId, 'done', {
    permalink: 'https://github.com/example/board/pull/86',
  });
  await s.agent.summary(tid, {
    headline: 'Dark mode for the board: PR #86 is ready',
    ask: 'Ship it?',
    answer: 'PR #86 open, 214 of 214 checks green, not merged.',
    recommendation: { action: 'Approve', why: 'every check passed; the release merges it' },
    confidence: 'high',
    bullets: [
      {
        text: 'Every screen follows the system theme; Settings has a Light / Dark / System toggle.',
      },
      { text: 'Checks: 214 of 214 green (lint, unit, rules, e2e).' },
      { text: 'Load time unchanged: 409 ms.' },
    ],
    visuals: [bar],
  });
  await expect(top(page).locator('[data-kicker]')).toContainText('step 4 of 6 · Ship it?', {
    timeout: 20_000,
  });
}

async function shipItThenSendBack(page: Page, s: Seed, planId: string, shot: string) {
  const card = top(page);
  await expect(card.locator('[data-headline]')).toHaveText('Ship it?');
  await expect(card.locator('[data-gate-approve]')).toBeVisible();
  await expect(card.locator('[data-gate-ask-open]')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Not now' })).toBeVisible();
  // Not approved is out of the way, in the ⋯ menu.
  await expect(card.locator('[data-gate-reject]')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Not approved' })).toHaveCount(0);
  await look(page, shot);
  await card.locator('[data-more-decisions]').click();
  await expect(page.getByRole('menuitem', { name: /Not approved/ })).toBeVisible();
  await page.keyboard.press('Escape');
  // Ask for changes: back to Build (the template's target), with the text.
  await card.locator('[data-gate-ask-open]').click();
  const form = card.locator('[data-gate-ask]');
  await expect(form).toBeVisible();
  await form
    .getByLabel('What should change?')
    .fill('The toggle should sit at the top of Settings.');
  await form.locator('[data-gate-send-back]').click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect.poll(() => cursorOf(s, planId)).toBe(2);
  const [, , build, ship] = await s.agent.stepsOf(planId);
  expect(await stateOf(s, build!)).toBe('approved');
  expect(await stateOf(s, ship!)).toBe('proposed');
  const sb = (await docOf(planPath(s, planId))).sentBack?.mapValue?.fields;
  expect(sb?.reason?.stringValue).toBe('The toggle should sit at the top of Settings.');
  expect(sb?.n?.integerValue).toBe('1');
  await expect(card).toHaveAttribute('data-top', 'working', { timeout: 20_000 });
  await expect(card.locator('[data-kicker]')).toContainText('step 3 of 6');
}

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('New thread › Development runs gate by gate; Ask for changes sends it back', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await fastTimers(page);
    await freezeClock(page);
    const s = await seedInbox(page);
    try {
      const { tid, planId } = await newDevThread(page, s, 'slice6-newthread-1440');
      // The member's plan: Shape is approved and running at once; the gates wait.
      const rail = page.locator(`[data-plan="${planId}"]`);
      const rows = rail.locator('li[data-step]');
      await expect(rows).toHaveCount(6, { timeout: 20_000 });
      await expect(rows.nth(0)).toHaveAttribute('data-step-ui', 'running');
      await expect(rows.nth(2)).toHaveAttribute('data-step-ui', 'approved');
      await expect(rows.nth(3)).toContainText('Ship it?');
      await expect(top(page)).toHaveAttribute('data-top', 'working');
      const [shape] = await s.agent.stepsOf(planId);
      expect(await stateOf(s, shape!)).toBe('approved');
      await toShipIt(page, s, tid, planId);
      await shipItThenSendBack(page, s, planId, 'slice6-shipit-1440');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');

  test('the Development thread at Ship it?, and a send back', async ({ page }) => {
    test.setTimeout(240_000);
    await fastTimers(page);
    await freezeClock(page);
    const s = await seedInbox(page);
    try {
      const { tid, planId } = await newDevThread(page, s, 'slice6-newthread-390');
      await toShipIt(page, s, tid, planId);
      await shipItThenSendBack(page, s, planId, 'slice6-shipit-390');
    } finally {
      await s.stop();
    }
  });
});
