/**
 * The decision page (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 3 and 5): a summary written with
 * the shared action (as thread_summary does) opens on the top card, the short version with the
 * visual kit, More detail and Everything folded, and the plan as a right rail (1440) or a fold
 * (390). States: a gate at the cursor, the agent at work, a question, blocked, no summary (the
 * fallback, agent offline or CLI too old). Labels stay plain text. Light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  NOW,
  settle,
  UNDO_WAIT,
} from './helpers';
import { at, seedInbox, type Seed } from './inboxSeed';

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

const PR = 'https://github.com/wisely-solutions/hivenod/pull/86';
const bar = {
  kind: 'bar',
  title: 'Check time, last 6 releases (min)',
  caption: 'Release 175 ran the checks in 10.8 min, the fastest of the last six.',
  unit: 'min',
  x: ['170', '171', '172', '173', '174', '175'],
  series: [{ name: 'Minutes', values: [14.2, 16.1, 13.4, 12.6, 12.1, 10.8] }],
  highlight: 5,
  better: 'down',
};
const v1 = {
  headline: 'Release 175: Inbox summaries',
  ask: 'Ship release 175 to hivenod.com?',
  answer: 'Build done: 610 of 612 checks passed.',
  recommendation: { action: 'Wait', why: 'two checks still run' },
  confidence: 'medium',
  bullets: [
    { text: 'Every thread gets a 3-layer summary.' },
    { text: 'Checks: 610 of 612 passed, 2 running.' },
    { text: 'Risk low: web only.' },
  ],
  visuals: [bar],
};
const v2 = {
  headline: 'Release 175: Inbox summaries',
  ask: 'Ship release 175 to hivenod.com?',
  answer: 'Everything passed: 612 of 612 checks, 2 changes, no data migration.',
  recommendation: { action: 'Approve', why: 'rollback takes 1 min if needed' },
  confidence: 'high',
  bullets: [
    {
      text: 'Every thread gets a 3-layer summary.',
      refs: [{ kind: 'link', id: 'pr86', label: 'PR #86', url: PR }],
    },
    { text: 'Checks: 612 of 612 passed (4 retried, all known flakes).' },
    { text: 'Risk low: web only.' },
    { text: 'Check time down to 10.8 min, the fastest of the last 6 releases.' },
  ],
  details:
    '## What changed\n- The thread page opens on the decision.\n- Today shows the top line.\n\n## Checks\n612 of 612 passed.\n\n## Risks\nNone known: **rollback** takes 1 min.',
  visuals: [
    bar,
    {
      kind: 'before_after',
      title: 'Thread page, before and after',
      caption: 'The conversation moves into Everything; the ask comes first.',
      before: { lines: ['Conversation', 'Agent panel', 'Plan in the panel'] },
      after: { lines: ['Top card', 'The short version', 'Plan in the panel'] },
    },
    {
      kind: 'flow',
      title: 'Where this release is',
      caption: 'Ship it? waits for you; release and live check follow.',
      nodes: [
        { id: 'build', label: 'Build', who: 'agent', state: 'done' },
        { id: 'ship', label: 'Ship it?', who: 'person', state: 'now' },
        { id: 'release', label: 'Release + live check', who: 'agent', state: 'next' },
        { id: 'accept', label: 'Accept on live', who: 'person', state: 'next' },
      ],
    },
    {
      kind: 'timeline',
      title: 'This release',
      caption: 'Live within the hour once approved.',
      events: [
        { at: '2026-10-29T21:40', label: 'Build done', state: 'done' },
        { at: '2026-10-29T22:05', label: 'Ship it?', state: 'now' },
        { at: '2026-10-29T22:30', label: 'Live', state: 'next' },
      ],
    },
  ],
};

const oPath = (s: Seed, oid: string) => `workspaces/${s.wid}/inboxOutcomes/${oid}`;
const done = (s: Seed, text: string, permalink: string | null = null) => ({
  state: 'done',
  result: { text, permalink, itemId: null, error: null, by: s.agent.aid, at: new Date(NOW) },
});

/** A release thread with a 5-step plan whose cursor waits at "Ship it?", and two summaries. */
async function seedDecision(page: Page) {
  await fastTimers(page);
  await freezeClock(page);
  const s = await seedInbox(page);
  const tid = await s.agent.add(s.uid, {
    source: 'mail',
    from: 'Release bot',
    text: 'Release 175: Inbox summaries\nPR #86 is ready: every thread gets a summary and Today shows its top line.',
    ref: 'rel175',
    id: 'g1',
    at: at(0, 8),
  });
  await s.agent.file(tid, { newName: 'Releases', area: 'Hivenod' });
  const { planId, stepIds } = await s.agent.plan(
    tid,
    [
      { type: 'reply', fields: { text: 'Shape: a summary on every thread.' } },
      { type: 'reply', fields: { text: 'Build: PR #86 with the decision page.' } },
      {
        type: 'approval',
        fields: { what: 'Ship it?', detail: '612 of 612 checks passed; rollback takes 1 min.' },
      },
      { type: 'nudge', fields: { text: 'Release 175 is live.' } },
      { type: 'approval', fields: { what: 'Accept on live' } },
    ],
    'Build, then ask before shipping.',
  );
  const [a, b, , d] = stepIds;
  await adminUpdate(oPath(s, a!), done(s, 'Shaped.'));
  await adminUpdate(oPath(s, b!), done(s, 'PR #86 open, checks green.', PR));
  await adminUpdate(oPath(s, d!), { state: 'approved' });
  await adminUpdate(`workspaces/${s.wid}/inboxPlans/${planId}`, { state: 'active', cursor: 2 });
  await s.agent.summary(tid, v1);
  await s.agent.summary(tid, v2);
  return { s, tid, planId, stepIds };
}

const top = (page: Page) => page.getByRole('region', { name: 'Decision' });
const fold = (page: Page, name: string) =>
  page.getByRole('button', { name: new RegExp(`^${name}`) });

test.describe('desktop 1440', () => {
  test.skip(({ isMobile }) => isMobile, 'desktop layout');

  test('a gate at the cursor: top card, short version with visuals, folds, rail, versions; approve', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const { s, tid, planId } = await seedDecision(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const t = top(page);
      await expect(t.locator('[data-kicker]')).toHaveText(
        /Your approval · step 3 of 5 · Ship it\?/,
        { timeout: 20_000 },
      );
      await expect(t.getByRole('heading', { level: 2 })).toHaveText(
        'Ship release 175 to hivenod.com?',
      );
      await expect(t.locator('[data-answer]')).toHaveText(v2.answer);
      await expect(t.locator('[data-recommends]')).toHaveText(
        'Desk agent recommends Approve · confidence high · rollback takes 1 min if needed',
      );
      await expect(t.locator('[data-updated]')).toHaveText(/^updated /);
      await expect(t.locator('[data-versions]')).toContainText('v2');
      await expect(t.locator('[data-stale]')).toHaveCount(0);
      await expect(t.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();

      // The layers, top to bottom.
      const y = async (sel: string) => (await page.locator(sel).first().boundingBox())!.y;
      const ys = [
        await y('[data-decision-page] header'),
        await y('[data-top]'),
        await y('[data-short]'),
        await y('[data-fold="detail"]'),
        await y('[data-fold="everything"]'),
      ];
      expect([...ys].sort((p, q) => p - q)).toEqual(ys);

      // The short version: bullets with an https ref, then the visuals.
      const bullets = page.getByRole('list', { name: 'Summary' }).getByRole('listitem');
      await expect(bullets).toHaveCount(4);
      await expect(bullets.first().getByRole('link', { name: /PR #86/ })).toHaveAttribute(
        'href',
        PR,
      );
      const kinds = page.locator('[data-visuals] [data-visual]');
      await expect(kinds).toHaveCount(4);
      expect(await kinds.evaluateAll((l) => l.map((e) => e.getAttribute('data-visual')))).toEqual([
        'bar',
        'before_after',
        'flow',
        'timeline',
      ]);
      const chart = page.locator('[data-visual="bar"]');
      await expect(chart.getByRole('img', { name: bar.caption })).toBeVisible();
      await chart.getByRole('button', { name: 'Show data' }).click();
      await expect(chart.getByRole('table', { name: bar.title }).getByRole('row')).toHaveCount(7);
      await expect(page.locator('[data-visual="before_after"] [data-changed="after"]')).toHaveCount(
        2,
      );

      // The plan as a right rail; no plan fold on a desktop.
      const rail = page.locator('[data-plan-rail]');
      await expect(rail).toContainText('Plan · Step 3 of 5');
      await expect(rail.locator('li[data-step]')).toHaveCount(5);
      await expect(page.locator('[data-fold="plan"]')).toHaveCount(0);
      expect((await rail.boundingBox())!.x).toBeGreaterThan((await t.boundingBox())!.x + 400);

      // More detail and Everything start folded; D and E toggle them.
      await expect(fold(page, 'More detail')).toHaveAttribute('aria-expanded', 'false');
      await expect(fold(page, 'More detail')).toContainText('what changed · checks · risks');
      await expect(fold(page, 'Everything')).toHaveAttribute('aria-expanded', 'false');
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await page.keyboard.press('d');
      await expect(fold(page, 'More detail')).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('[data-details]')).toContainText('The thread page opens');
      await expect(page.locator('[data-details] strong')).toHaveText('rollback');
      await page.keyboard.press('e');
      const talk = page.getByRole('region', { name: 'Conversation' });
      await expect(talk.locator('[data-message]')).toHaveCount(1);
      await expect(page.locator('[data-everything]')).toContainText('Open the result');
      await look(page, 'decision-1440');

      // The version history: v2 and v1; v1 read only, its bullets compared with v2.
      await t.locator('[data-versions]').click();
      const dialog = page.getByRole('dialog', { name: 'Summary versions' });
      await expect(dialog.locator('[data-version]')).toHaveCount(2);
      await dialog.locator('[data-version="1"]').click();
      const view = page.getByRole('dialog', { name: 'Summary v1' });
      await expect(view.locator('[data-change="removed"]')).toContainText([
        'Checks: 610 of 612 passed, 2 running.',
      ]);
      await expect(view.locator('[data-change="added"]')).toHaveCount(2);
      await view.getByRole('button', { name: 'Close', exact: true }).last().click();
      await expect(page.locator('[role="dialog"]')).toHaveAttribute('data-state', 'closed');
      // The dialog's exit animation stalls under the test's fake clock: start the page afresh.
      await page.reload();
      await expect(t.locator('[data-kicker]')).toHaveText(/step 3 of 5/, { timeout: 20_000 });

      // Approve passes the gate: the plan moves on; the summary is now out of date.
      await t.getByRole('button', { name: 'Approve', exact: true }).click();
      await expect
        .poll(
          async () =>
            Number(
              (await adminDoc(`workspaces/${s.wid}/inboxPlans/${planId}`))?.fields.cursor
                ?.integerValue,
            ),
          { timeout: UNDO_WAIT + 8000 },
        )
        .toBe(3);
      await expect(t.locator('[data-kicker]')).toHaveText(/Desk agent is working · step 4 of 5/);
      await expect(t.locator('[data-stale]')).toContainText('May be out of date: changed since');
      await expect(t.locator('[data-why]')).toHaveText('Desk agent has not been online yet');
    } finally {
      await s.stop();
    }
  });

  test('charts, an unknown kind, plain-text labels; the fallback and the other states', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await fastTimers(page);
    await freezeClock(page);
    const s = await seedInbox(page);
    try {
      const charts = [
        {
          kind: 'stacked_bar',
          title: 'Price lines by margin',
          caption: '4 lines fall below 20% margin.',
          unit: null,
          x: ['Basic', 'Pro', 'Team', 'Ent'],
          series: [
            { name: 'Above 20%', values: [12, 9, 7, 6] },
            { name: 'Below 20%', values: [1, 2, 0, 1] },
          ],
          highlight: null,
          better: null,
        },
        {
          kind: 'line',
          title: 'Average margin (%)',
          caption: 'Margin falls to 23% with the new list.',
          unit: '%',
          x: ['Q1', 'Q2', 'Q3', 'Q4'],
          series: [{ name: 'Margin', values: [27, 26, null, 23] }],
          highlight: 3,
          better: 'up',
        },
        {
          kind: 'number',
          title: 'Lines changed',
          caption: '38 lines changed since Q3.',
          value: 38,
          unit: null,
          delta: 12,
          trend: [20, 26, 38],
          better: null,
        },
      ];
      await s.agent.summary(s.threads.price, {
        headline: 'Q4 price list: sign off by Wednesday',
        ask: 'Create the review item for the Q4 price list?',
        answer: '38 lines changed; 4 fall below margin.',
        recommendation: { action: 'Approve', why: 'a real review, not a reply' },
        confidence: 'high',
        bullets: [{ text: 'Ava needs the sign-off by Wednesday noon.' }],
        visuals: charts,
      });
      // What a broken or newer agent could leave (the rules check less than the tool).
      await adminUpdate(`workspaces/${s.wid}/inboxSummaries/${s.threads.price}`, {
        ask: 'Sign off <script>alert(1)</script>?',
        bullets: [{ text: '<b>bold</b> stays text', refs: [] }],
        visuals: [
          ...charts,
          { kind: 'image', title: 'Screenshot', caption: 'The list', attachment: 'a1' },
        ],
      });
      await page.goto(`/inbox/${s.wid}/t/${s.threads.price}`);
      const t = top(page);
      await expect(t.getByRole('heading', { level: 2 })).toHaveText(
        'Sign off <script>alert(1)</script>?',
        { timeout: 20_000 },
      );
      await expect(page.getByText('<b>bold</b> stays text')).toBeVisible();
      await expect(page.locator('[data-decision-page] b, [data-decision-page] script')).toHaveCount(
        0,
      );
      await expect(page.locator('[data-visual="stacked_bar"] svg[role="img"]')).toHaveAttribute(
        'aria-label',
        '4 lines fall below 20% margin.',
      );
      await expect(page.locator('[data-visual="line"] polyline')).toHaveCount(2);
      await expect(page.locator('[data-visual="number"]')).toContainText('38');
      await expect(page.locator('[data-visual-unknown="image"]')).toContainText('can’t show yet');
      await expect(t.locator('[data-kicker]')).toHaveText(/Your approval/);
      await look(page, 'decision-kinds-1440');

      // No summary: the fallback top line, "No summary yet" with the first message, and why.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.review}`);
      await expect(t.locator('[data-kicker]')).toHaveText(/Your approval/, { timeout: 20_000 });
      await expect(t.getByRole('heading', { level: 2 })).toHaveText(
        'Desk agent proposes: Reply and book',
      );
      await expect(t.getByRole('button', { name: /Send and book/ })).toBeVisible();
      await expect(t.locator('[data-effects]')).toContainText('When you approve, Desk agent will:');
      const none = page.locator('[data-no-summary]');
      await expect(none).toContainText('No summary yet');
      await expect(none).toContainText('Move the payments review to Tuesday');
      await expect(none).toContainText('Desk agent has not been online yet');
      await adminUpdate(`workspaces/${s.wid}/agents/${s.agent.aid}`, { cliVersion: '0.2.100' });
      await expect(none).toContainText("Desk agent's CLI 0.2.100 can't write summaries");
      await fold(page, 'More detail').click();
      await expect(
        page.getByRole('list', { name: 'What the agent checked' }).getByRole('listitem'),
      ).toHaveText(['Your calendar: Tue 10:00-11:00 free', 'Asked Rita by mail: either works']);
      await look(page, 'decision-fallback-1440');

      // A question: the chips under the question.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.room}`);
      await expect(t.locator('[data-kicker]')).toHaveText(/Desk agent asks/, { timeout: 20_000 });
      await expect(t.getByRole('heading', { level: 2 })).toHaveText(
        'Book the small room (6 seats) or move to the afternoon?',
      );
      await expect(t.getByRole('group', { name: 'Answers' }).getByRole('button')).toHaveText([
        'Small room',
        'Afternoon',
      ]);

      // The agent at work.
      await page.goto(`/inbox/${s.wid}/t/${s.threads.visit}`);
      await expect(t.locator('[data-kicker]')).toHaveText(/Desk agent is working on it/, {
        timeout: 20_000,
      });

      // Blocked: where and why, with Retry, Skip and Stop plan.
      const { planId, stepIds } = await s.agent.plan(s.threads.omar, [
        { type: 'nudge', fields: { text: 'Any news on the summary?' } },
        { type: 'approval', fields: { what: 'Close the hiring thread' } },
      ]);
      await adminUpdate(oPath(s, stepIds[0]!), {
        state: 'failed',
        result: {
          text: null,
          permalink: null,
          itemId: null,
          error: 'The live check failed: Today shows no top line',
          by: s.agent.aid,
          at: new Date(NOW),
        },
      });
      await adminUpdate(`workspaces/${s.wid}/inboxPlans/${planId}`, {
        state: 'blocked',
        cursor: 0,
      });
      await page.goto(`/inbox/${s.wid}/t/${s.threads.omar}`);
      await expect(t.locator('[data-kicker]')).toHaveText(
        'Blocked at step 1: The live check failed: Today shows no top line',
        { timeout: 20_000 },
      );
      for (const name of ['Retry', 'Skip', 'Stop plan'])
        await expect(t.getByRole('button', { name, exact: true })).toBeVisible();
      await look(page, 'decision-blocked-1440');
    } finally {
      await s.stop();
    }
  });
});

test.describe('phone 390', () => {
  test.skip(({ isMobile }) => !isMobile, 'phone layout');
  test.use({ viewport: { width: 390, height: 844 } });

  test('stacked: top card with full-width buttons, the plan as a fold', async ({ page }) => {
    test.setTimeout(180_000);
    const { s, tid } = await seedDecision(page);
    try {
      await page.goto(`/inbox/${s.wid}/t/${tid}`);
      const t = top(page);
      await expect(t.locator('[data-kicker]')).toHaveText(/step 3 of 5/, { timeout: 20_000 });
      const approve = t.getByRole('button', { name: 'Approve', exact: true });
      await expect(approve).toBeInViewport();
      expect((await approve.boundingBox())!.width).toBeGreaterThan(300);
      await expect(page.locator('[data-plan-rail]')).toHaveCount(0);
      const planFold = fold(page, 'Plan');
      await expect(planFold).toContainText('2 done');
      await expect(planFold).toContainText('you');
      await expect(planFold).toContainText('2 next');
      // Folds in order: Plan, More detail, Everything.
      const y = async (id: string) => (await page.locator(`[data-fold="${id}"]`).boundingBox())!.y;
      expect(await y('plan')).toBeLessThan(await y('detail'));
      expect(await y('detail')).toBeLessThan(await y('everything'));
      await look(page, 'decision-390');
      await planFold.click();
      await expect(page.locator('[data-fold="plan"] li[data-step]')).toHaveCount(5);
      await fold(page, 'Everything').click();
      await expect(page.getByRole('region', { name: 'Conversation' })).toBeVisible();
      // axe's target-size flags whatever the fixed tab bar covers at this scroll position.
      await page.evaluate(() => window.scrollTo(0, 0));
      await look(page, 'decision-390-open');
    } finally {
      await s.stop();
    }
  });
});
