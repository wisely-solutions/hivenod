/**
 * Card 9bmMIGlC, one decision bar everywhere: the same bar (rule, Approve, Send back, keys A and R)
 * on Needs you, in the board panel and in the viewer; a direct Reply on questions; the path
 * decision on the same bar; "Step 3 of 6 · Go/no-go → next: Build" on the trail. Screens go to SHOTS.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminSetAll,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/decisionbar-shots';
const rand = () => Math.random().toString(36).slice(2, 8);
const ago = (m: number) => new Date(Date.now() - m * 60_000);

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
  const pid = `bar${rand()}`;
  const base = projectFields('Hive web', uid);
  const gate = { ...base.steps[1]!.gate!, rule: 'any' as const, deciderUids: [uid, 'ana'] };
  const steps = [
    { id: 'intake', name: 'Intake', kind: 'agent', description: 'Sort it' },
    { id: 'research', name: 'Research', kind: 'agent', description: 'Look around' },
    { id: 'go', name: 'Go/no-go', kind: 'human', description: 'Worth it?', gate },
    { id: 'build', name: 'Build', kind: 'agent', description: 'Make it' },
    { id: 'accept', name: 'Accept', kind: 'human', description: 'Is it right?', gate },
  ];
  const P = `workspaces/${wid}/projects/${pid}`;
  const item = (over: Record<string, unknown>) => ({
    title: 'Item',
    type: 'task',
    stepId: 'intake',
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
    updatedAt: ago(30),
    lastEventId: 'seed',
    ...over,
  });
  const shaped = { by: { type: 'agent', id: 'scout' }, at: ago(40), note: 'short' };
  const docs: Array<[string, Record<string, unknown>]> = [
    [
      P,
      {
        ...base,
        steps,
        stepIndex: Object.fromEntries(steps.map((s, i) => [s.id, i])),
        shapeNewItems: true,
      },
    ],
    [
      `workspaces/${wid}/agents/scout`,
      {
        name: 'Scout',
        color: 'agent-3',
        projectIds: '*',
        createdBy: uid,
        createdAt: ago(1000),
        revokedAt: null,
        lastSeenAt: ago(1),
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    ],
    [
      `${P}/items/go1`,
      item({
        title: 'Pricing page rewrite',
        stepId: 'go',
        status: 'waiting',
        summary: 'Is the rewrite worth doing now?',
        gate: { stepId: 'go', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
        order: 1,
      }),
    ],
    [
      `${P}/items/dark`,
      item({
        title: 'Add dark mode to the settings screen',
        stepId: 'research',
        status: 'working',
        claim: { runId: 'r1', agentUid: 'scout', heartbeatAt: ago(1) },
        shape: shaped,
        pathSkips: {},
        gateSkips: { go: 'Small change' },
        pathRequests: {
          go: {
            op: 'add',
            by: { type: 'agent', id: 'scout' },
            reason: 'The settings change touches every screen',
            at: ago(10),
          },
        },
        pathRev: 2,
        order: 2,
      }),
    ],
    [
      `workspaces/${wid}/runs/r1`,
      {
        agentUid: 'scout',
        projectId: pid,
        itemId: 'dark',
        stepId: 'research',
        startedAt: ago(5),
        heartbeatAt: ago(1),
        heartbeatEventAt: ago(5),
        endedAt: null,
        status: 'running',
        costEur: 0,
        tokensIn: 0,
        tokensOut: 0,
        model: null,
        summary: null,
        lastEventId: 'seed',
      },
    ],
    [
      `${P}/items/q1`,
      item({
        title: 'Research brief',
        stepId: 'research',
        status: 'working',
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
        order: 3,
      }),
    ],
    [
      `${P}/items/q1/messages/m1`,
      {
        workspaceId: wid,
        projectId: pid,
        itemId: 'q1',
        by: { type: 'agent', id: 'scout' },
        kind: 'question',
        text: 'Which audience should the brief target?',
        at: ago(10),
        answered: false,
        replyTo: null,
        lastEventId: 'seed',
      },
    ],
  ];
  await adminSetAll(docs);
  return { wid, uid, pid };
}

const shoot = async (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  const project = test.info().project.name;
  const sizes =
    project === 'desktop-1440'
      ? [
          ['1440x900', { width: 1440, height: 900 }],
          ['390x844', { width: 390, height: 844 }],
        ]
      : [[project, null]];
  for (const [label, size] of sizes as [string, { width: number; height: number } | null][]) {
    if (size) await page.setViewportSize(size);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await settle(page).catch(() => undefined);
      await page.screenshot({ path: `${SHOTS}/${name}-${label}-${theme}.png` });
    }
  }
  if (project === 'desktop-1440') await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
};

test.skip(({ isMobile }) => isMobile, 'phone widths are checked inside');

test('shots: approval, path decision and question on Needs you; the board panel', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { pid } = await seed(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /Pricing page rewrite/ })
    .first()
    .click();
  await expect(page.getByRole('article', { name: /Decision: Pricing page rewrite/ })).toBeVisible();
  await shoot(page, 'needs-you-approval');
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await page
    .getByRole('button', { name: /Add Go\/no-go to “Add dark mode/ })
    .first()
    .click();
  await expect(page.getByTestId('path-request')).toBeVisible();
  await shoot(page, 'needs-you-path');
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await page
    .getByRole('button', { name: /Research brief/ })
    .first()
    .click();
  await expect(page.getByRole('article', { name: /Decision: Research brief/ })).toBeVisible();
  await shoot(page, 'needs-you-question');
  await page.goto(`/p/${pid}?item=go1`);
  await expect(page.getByRole('button', { name: 'Approve → Build' })).toBeVisible();
  await shoot(page, 'board-panel');
  await expectNoHorizontalScroll(page);
});

test('one bar: rule, Approve and Send back with keys, Reply, the path decision and the trail line', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { pid } = await seed(page);
  await page.goto('/');
  await page
    .getByRole('button', { name: /Pricing page rewrite/ })
    .first()
    .click();
  const detail = page.getByRole('article', { name: /Decision: Pricing page rewrite/ });
  await expect(detail).toBeVisible();
  const bar = detail.locator('[data-decision-bar]');
  await expect(bar.getByTestId('gate-rule')).toHaveText('Any one of 2 deciders');
  await expect(bar).toContainText('Go/no-go · you decide');
  await expect(bar.getByRole('button', { name: 'Approve → Build' })).toBeVisible();
  await expect(bar.getByRole('button', { name: /^Send back/ })).toBeVisible();
  await expect(detail.getByLabel('Your note (optional)')).toBeVisible();
  // The bar stays at the bottom of the viewport.
  const vh = page.viewportSize()!.height;
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(vh - 80);
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // A path decision sits on the same bar.
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await page
    .getByRole('button', { name: /Add Go\/no-go to “Add dark mode/ })
    .first()
    .click();
  const pathBar = page.locator('[data-decision-bar]');
  await expect(pathBar).toContainText('Path · you decide');
  await expect(pathBar.getByRole('button', { name: 'Add Go/no-go', exact: true })).toBeVisible();
  await expect(pathBar.getByRole('button', { name: 'Keep it skipped' })).toBeVisible();
  await expect(page.getByTestId('path-strip').first()).toContainText(
    'Step 2 of 4 · Research → next: Build',
  );

  // A question gets a direct Reply on the bar.
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  await page
    .getByRole('button', { name: /Research brief/ })
    .first()
    .click();
  const q = page.getByRole('article', { name: /Decision: Research brief/ });
  await q.getByLabel('Your reply').fill('Developers');
  await q
    .locator('[data-decision-bar]')
    .getByRole('button', { name: 'Reply', exact: true })
    .click();
  await expect(page.getByRole('status').last()).toContainText('Answer sent.');

  // The board panel: same bar, same words, same keys.
  await page.goto(`/p/${pid}?item=go1`);
  const panelBar = page.locator('[data-decision-bar]').first();
  await expect(panelBar.getByTestId('gate-rule')).toHaveText('Any one of 2 deciders');
  await expect(panelBar.getByRole('button', { name: 'Approve → Build' })).toBeVisible();
  await expect(page.getByLabel('Your note (optional)').first()).toBeVisible();
  await expect(page.getByText('Send back…').first()).toBeVisible();
  await page.keyboard.press('r');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expectNoHorizontalScroll(page);

  // On a phone the same bar is fixed to the bottom of the screen, whatever the scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page
    .getByRole('button', { name: /Pricing page rewrite/ })
    .first()
    .click();
  const phoneBar = page.locator('[data-decision-bar]');
  await expect(phoneBar.getByRole('button', { name: 'Approve → Build' })).toBeInViewport();
  const pb = (await phoneBar.boundingBox())!;
  expect(pb.y + pb.height).toBeGreaterThan(844 - 4);
  await expectNoHorizontalScroll(page);
});

test('phone board panel: the decision bar is not covered by the tab bar', async ({ page }) => {
  test.setTimeout(120_000);
  const { pid } = await seed(page);
  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/p/${pid}?item=go1`);
    const panel = page.getByRole('region', { name: 'Item detail' });
    await expect(panel).toBeVisible();
    const path = panel.getByRole('button', { name: /^Path/ });
    if (await path.count()) await path.first().click();
    const approve = panel.getByRole('button', { name: /^Approve/ });
    await expect(approve).toBeVisible();
    await approve.scrollIntoViewIfNeeded();
    const hit = await approve.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    expect(hit).toBe(true);
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: `${SHOTS}/panel-${size.width}x${size.height}.png` });
  }
});
