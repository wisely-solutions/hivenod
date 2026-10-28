/**
 * Card st5INNZj, per-item paths in the app: the path strip on board cards (A), the trail in the
 * item (C), an item waiting to be shaped ("Use the full process"), a pending people-step change and
 * a proposed library step in Needs you, at 1440 and 375 px. Screens for the card go to SHOTS.
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

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/paths-shots';
const rand = () => Math.random().toString(36).slice(2, 8);
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);

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
  const pid = `paths${rand()}`;
  const base = projectFields('Hive web', uid);
  const gate = base.steps[1]!.gate!;
  const steps = [
    { id: 'intake', name: 'Intake', kind: 'agent', description: 'Sort it' },
    { id: 'research', name: 'Research', kind: 'agent', description: 'Look around' },
    { id: 'go', name: 'Go/no-go', kind: 'human', description: 'Worth it?', gate },
    { id: 'build', name: 'Build', kind: 'agent', description: 'Make it' },
    { id: 'accept', name: 'Accept', kind: 'human', description: 'Is it right?', gate },
    { id: 'release', name: 'Release', kind: 'human', description: 'Ship it?', gate },
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
      `${P}/items/typo`,
      item({
        title: 'Fix typo on the pricing page',
        stepId: 'accept',
        status: 'waiting',
        gate: { stepId: 'accept', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: { research: 'Copy only' },
        gateSkips: { go: 'Tiny change', release: 'Ships with the next deploy' },
        pathRev: 3,
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
    [`${P}/items/fresh`, item({ title: 'Export the activity log', shape: null, order: 3 })],
    [
      `${P}/items/early`,
      item({ title: 'Onboarding email', shape: shaped, pathSkips: {}, pathRev: 1, order: 4 }),
    ],
    [
      `${P}/stepProposals/sp1`,
      {
        name: 'Legal review',
        kind: 'human',
        description: 'Check the terms of service',
        instructions: '',
        outputs: [],
        afterStepId: 'build',
        deciderUids: [],
        reason: 'The change touches the terms of service',
        itemId: 'dark',
        by: { type: 'agent', id: 'scout' },
        at: ago(8),
        status: 'open',
        decision: null,
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
  // The card asks for 1440x900 and 390x844 in light and dark: the desktop run takes both sizes.
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

test('the path strip, the trail, shaping by hand and Needs-you path decisions', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { pid } = await seed(page);

  // Board: compact strips (A); the unshaped item says it is being shaped.
  await page.goto(`/p/${pid}`);
  const typo = page.locator('[data-item-id="typo"]');
  await expect(typo.getByTestId('path-strip')).toContainText('Accept');
  await expect(typo.getByTestId('path-strip')).toContainText('Step 3 of 3');
  await expect(typo.getByTestId('path-strip')).toContainText('You decide');
  const dark = page.locator('[data-item-id="dark"]');
  await expect(dark.getByTestId('path-strip')).toContainText('Go/no-go proposed');
  // A proposed people step does not count until it is added.
  await expect(dark.getByTestId('path-strip')).toContainText('Step 2 of 5');
  await expect(page.locator('[data-item-id="fresh"]').getByTestId('path-strip')).toContainText(
    'Shaping…',
  );
  await expectNoHorizontalScroll(page);
  await dark.scrollIntoViewIfNeeded();
  await shoot(page, 'board');

  // Item: the strip opens into the trail (C).
  await typo.click();
  const panel = page.getByRole('region', { name: 'Path' }).first();
  await panel.getByRole('button', { name: 'Path' }).click();
  const trail = panel.getByRole('list', { name: 'Path' });
  await expect(trail.locator('[data-step="intake"]')).toContainText('Done');
  await expect(trail.locator('[data-step="accept"]')).toContainText('You decide');
  await expect(panel).toContainText('3 skipped: Research, Go/no-go, Release');
  await expectNoHorizontalScroll(page);
  await shoot(page, 'item-trail');

  // An item waiting to be shaped: nobody works on it; a person can choose the full process.
  await page.goto(`/p/${pid}?item=fresh`);
  const shaping = page.getByTestId('shaping-panel').first();
  await expect(shaping).toContainText('Shaping…');
  await shoot(page, 'item-unshaped');
  await shaping.getByRole('button', { name: 'Use the full process' }).click();
  await expect(page.getByTestId('shaping-panel')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Path' }).first()).toContainText('Step 1 of 6');

  // Needs you: the proposed people step and the step proposal wait for João.
  await page.goto('/');
  const addGo = page.getByRole('button', { name: /Add Go\/no-go to “Add dark mode/ });
  await expect(addGo).toBeVisible();
  await expect(page.getByRole('button', { name: /Add the step “Legal review”/ })).toBeVisible();
  await addGo.click();
  await expect(page.getByTestId('path-request')).toContainText('Scout suggests adding Go/no-go');
  await shoot(page, 'needs-you-path');
  await page.getByRole('button', { name: 'Add Go/no-go', exact: true }).click();
  await expect(page.getByRole('button', { name: /Add Go\/no-go to “Add dark mode/ })).toHaveCount(
    0,
  );

  // The step proposal: add it to the process; it stays off the other open items.
  await page.getByRole('button', { name: /Add the step “Legal review”/ }).click();
  await expect(page.getByTestId('step-proposal')).toContainText('Scout proposes a new people step');
  await shoot(page, 'needs-you-proposal');
  await page.getByRole('button', { name: 'Add to process…' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Add to process' }).click();
  await expect(
    page.getByText(/Legal review added to the process\. Kept off 2 of 2 other open items/),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expectNoHorizontalScroll(page);

  // The proposing item has it on its path; the early item skips it.
  await page.goto(`/p/${pid}?item=dark`);
  const darkPanel = page.getByRole('region', { name: 'Path' }).first();
  await darkPanel.getByRole('button', { name: 'Path' }).click();
  await expect(darkPanel.getByRole('list', { name: 'Path' })).toContainText('Legal review');
  await expect(darkPanel.getByRole('list', { name: 'Path' })).toContainText('Go/no-go');
  await page.goto(`/p/${pid}?item=early`);
  const earlyPanel = page.getByRole('region', { name: 'Path' }).first();
  await earlyPanel.getByRole('button', { name: 'Path' }).click();
  await expect(earlyPanel).toContainText('skipped: Legal review');
});

test('Shape new items is a project switch in Process', async ({ page }) => {
  test.setTimeout(90_000);
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/process`);
  const sw = page.getByTestId('shape-switch').getByRole('switch', { name: 'Shape new items' });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect(page.getByText('New items go through every step again.')).toBeVisible();
});

test('path polish: approver in the trail, reason and Undo on a person path change (card 1CugPAEc)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { wid, uid, pid } = await seed(page);
  const P = `workspaces/${wid}/projects/${pid}`;
  await adminSetAll([
    [
      `${P}/decisions/d1`,
      {
        workspaceId: wid,
        projectId: pid,
        itemId: 'gated',
        itemTitle: 'Gated',
        stepId: 'go',
        outcome: 'approved',
        toStepId: 'build',
        byUid: uid,
        rationale: '',
        tags: [],
        at: new Date(Date.UTC(2026, 9, 27, 12, 5)),
        lastEventId: 'seed',
      },
    ],
    [
      `${P}/items/gated`,
      {
        title: 'Gated',
        type: 'task',
        stepId: 'build',
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
        shape: { by: { type: 'agent', id: 'scout' }, at: ago(40), note: 'short' },
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
        sendBackCount: 0,
        costEur: 0,
        order: 9,
        updatedAt: ago(30),
        lastEventId: 'seed',
      },
    ],
  ]);
  await page.goto(`/p/${pid}?item=gated`);
  const gatedPanel = page.getByRole('region', { name: 'Path' }).first();
  await gatedPanel.getByRole('button', { name: 'Path' }).click();
  await expect(gatedPanel.locator('[data-step="go"]')).toContainText('Approved by João · 27 Oct');
  await shoot(page, 'path-approver');
  if (test.info().project.name === 'iphone-se') {
    // The focus view covers the tab bar and ends its scroller where the bottom of the screen is.
    const sheet = page.getByRole('region', { name: 'Item detail' });
    const scroller = sheet.locator('[data-focus-scroll]');
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const sb = await scroller.boundingBox();
    expect(sb!.y + sb!.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
    await page.screenshot({ path: `${SHOTS}/tabbar-over-sheet-iphone-se.png` });
  }
  await page.goto(`/p/${pid}?item=early`);
  const panel = page.getByRole('region', { name: 'Path' }).first();
  await panel.getByRole('button', { name: 'Path' }).click();
  await panel.getByRole('button', { name: 'Change path' }).click();
  await panel.getByRole('checkbox', { name: /Research/ }).uncheck();
  await panel.getByLabel(/Why \(optional\)/).fill('Copy only, nothing to look up');
  await page.screenshot({ path: `${SHOTS}/path-reason-${test.info().project.name}.png` });
  await panel.getByRole('button', { name: 'Save path' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Path changed.' });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/path-undo-toast-${test.info().project.name}.png` });
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Path change undone.')).toBeVisible();
  await expectNoHorizontalScroll(page);
});
