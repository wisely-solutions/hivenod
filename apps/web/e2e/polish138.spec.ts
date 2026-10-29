/**
 * Card rLntxm7C, polish found while testing R138: the board-panel decision bar (fixed above the tab
 * bar, no overflow at 360, Undo on approve), Archived reasons, Restore in the Decisions list and
 * the old reason back after undoing a path change. Screens go to SHOTS_DIR.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSetAll,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/polish138-shots';
const rand = () => Math.random().toString(36).slice(2, 8);
const ago = (m: number) => new Date(Date.now() - m * 60_000);
test.skip(({ isMobile }) => isMobile, 'phone widths are set inside');

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
  const pid = `pol${rand()}`;
  const base = projectFields('Hive web', uid);
  const gate = { ...base.steps[1]!.gate!, rule: 'any' as const, deciderUids: [uid] };
  const steps = [
    { id: 'intake', name: 'Intake', kind: 'agent', description: 'Sort it' },
    { id: 'research', name: 'Research', kind: 'agent', description: 'Look around' },
    { id: 'go', name: 'Go/no-go', kind: 'human', description: 'Worth it?', gate },
    { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
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
  const decision = (id: string, itemId: string, outcome: string, rationale: string) =>
    [
      `${P}/decisions/${id}`,
      {
        workspaceId: wid,
        projectId: pid,
        itemId,
        itemTitle: itemId,
        stepId: 'go',
        outcome,
        toStepId: null,
        byUid: uid,
        rationale,
        tags: [],
        at: ago(20),
        lastEventId: 'seed',
      },
    ] as [string, Record<string, unknown>];
  await adminSetAll([
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
      `${P}/items/go1`,
      item({
        title: 'Pricing page rewrite',
        stepId: 'go',
        status: 'waiting',
        gate: { stepId: 'go', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
      }),
    ],
    decision('d-go1', 'go1', 'stopped', 'Parked once, then brought back for another look'),
    [
      `${P}/items/acc1`,
      item({
        title: 'Final check',
        stepId: 'accept',
        status: 'waiting',
        gate: { stepId: 'accept', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
        order: 9,
      }),
    ],
    [
      `${P}/items/rej`,
      item({ title: 'Rejected idea', stepId: 'go', status: 'stopped', shape: shaped }),
    ],
    decision('d-rej', 'rej', 'stopped', 'Not worth the effort this quarter'),
    [
      `${P}/items/can`,
      item({
        title: 'Cancelled run',
        stepId: 'research',
        status: 'stopped',
        shape: shaped,
        workStopped: {
          mode: 'cancel',
          byUid: uid,
          at: ago(25),
          reason: 'Wrong audience entirely',
          runId: 'r1',
        },
      }),
    ],
    [
      `${P}/items/arc`,
      item({
        title: 'Archived note',
        stepId: 'intake',
        status: 'stopped',
        archivedAt: ago(15),
        shape: shaped,
      }),
    ],
    [
      `${P}/items/res`,
      item({
        title: 'Restored thing',
        stepId: 'intake',
        status: 'queued',
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
      }),
    ],
    decision('d-res', 'res', 'stopped', 'Park it'),
    [
      `workspaces/${wid}/events/ev-res`,
      {
        actor: { type: 'human', id: uid, name: 'João' },
        projectId: pid,
        itemId: 'res',
        runId: null,
        type: 'item.restored',
        data: { stepId: 'intake' },
        at: ago(5),
      },
    ],
    [
      `${P}/items/early`,
      item({
        title: 'Early item',
        stepId: 'intake',
        shape: shaped,
        pathSkips: { research: 'Copy only, nothing to look up' },
        gateSkips: {},
        pathRev: 2,
        order: 5,
      }),
    ],
  ]);
  return { wid, uid, pid, P };
}

const shot = (page: Page, name: string) => {
  mkdirSync(SHOTS, { recursive: true });
  return page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test('board panel bar: pinned to the bottom of the view, fits at 360, Undo on approve', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { pid, P } = await seed(page);
  for (const size of [
    { width: 375, height: 667 },
    { width: 390, height: 844 },
    { width: 360, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/p/${pid}?item=go1`);
    const panel = page.getByRole('region', { name: 'Item detail' });
    const bar = panel.locator('[data-decision-bar]');
    await expect(bar).toBeVisible();
    await settle(page).catch(() => undefined);
    // Pinned to the bottom of the screen (the focus view covers the tab bar).
    const box1 = (await bar.boundingBox())!;
    expect(Math.abs(box1.y + box1.height - size.height)).toBeLessThanOrEqual(2);
    // Stays put when the view scrolls.
    const scroller = panel.locator('[data-focus-scroll]');
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const box2 = (await bar.boundingBox())!;
    expect(Math.abs(box2.y - box1.y)).toBeLessThanOrEqual(1);
    // The note is part of the bar.
    await expect(bar.getByLabel('Your note (optional)')).toBeVisible();
    // No button overflows its own box.
    for (const b of await bar.getByRole('button').all()) {
      const over = await b.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over).toBeLessThanOrEqual(0);
    }
    await shot(page, `panel-bar-${size.width}x${size.height}`);
    await expectNoHorizontalScroll(page);
  }

  // Approve is not final for 5 s: Undo takes it back.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}?item=go1`);
  const panel = page.getByRole('region', { name: 'Item detail' });
  await panel.getByRole('button', { name: /^Approve/ }).click();
  // The pressed button becomes Undo, in the bar (no toast).
  const undoBtn = panel.locator('[data-decision-bar] button[data-undo]');
  await expect(undoBtn).toContainText(/Undo · \d/);
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await shot(page, 'panel-approve-undo-390');
  await undoBtn.click();
  await expect(panel.getByRole('button', { name: /^Approve/ })).toBeEnabled();
  expect((await adminDoc(`${P}/items/go1`))!.fields.stepId?.stringValue).toBe('go');
  // Not undone: it is written when the toast ends.
  await panel.getByRole('button', { name: /^Approve/ }).click();
  await expect
    .poll(async () => (await adminDoc(`${P}/items/go1`))!.fields.stepId?.stringValue, {
      timeout: 15_000,
    })
    .toBe('publish');
});

test('Archived shows Rejected, Cancelled, Archived and the reason; Decisions shows Restored', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { pid } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}?view=list`);
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByLabel('Show', { exact: true }).selectOption('archived');
  const row = (t: string) => page.locator('tr').filter({ hasText: t });
  await expect(row('Rejected idea')).toContainText('Rejected');
  await expect(row('Rejected idea')).toContainText('Not worth the effort this quarter');
  await expect(row('Cancelled run')).toContainText('Cancelled');
  await expect(row('Cancelled run')).toContainText('Wrong audience entirely');
  await expect(row('Archived note')).toContainText('Archived');
  await expect(row('Archived note')).not.toContainText('stopped');
  await row('Cancelled run').evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'archived-390');
  await expectNoHorizontalScroll(page);

  await page.goto(`/p/${pid}?item=res`);
  const sheet = page.getByRole('region', { name: 'Item detail' });
  const list = sheet.locator('section').filter({ hasText: 'Decisions' }).last();
  await expect(list).toContainText('Stopped at Go/no-go');
  await expect(list).toContainText('Restored to Intake');
  await shot(page, 'decisions-restored-390');
});

test('undoing a path change puts the old skip reason back', async ({ page }) => {
  test.setTimeout(120_000);
  const { pid, P } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}?item=early`);
  const panel = page.getByRole('region', { name: 'Path' }).first();
  await panel.getByRole('button', { name: 'Path' }).click();
  await panel.getByRole('button', { name: 'Change path' }).click();
  await panel.getByRole('checkbox', { name: /Research/ }).check();
  await panel.getByRole('button', { name: 'Save path' }).click();
  const toast = page.getByRole('status').filter({ hasText: 'Path changed.' });
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`${P}/items/early`))!.fields.pathSkips?.mapValue?.fields)
    .toBeFalsy();
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText('Path change undone.')).toBeVisible();
  await expect
    .poll(
      async () =>
        (await adminDoc(`${P}/items/early`))!.fields.pathSkips?.mapValue?.fields?.research
          ?.stringValue,
    )
    .toBe('Copy only, nothing to look up');
});

test('phone panel: Decisions end above the bar, note stays above it, final approval wording', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { pid } = await seed(page);
  for (const size of [
    { width: 360, height: 740 },
    { width: 375, height: 667 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/p/${pid}?item=go1`);
    const panel = page.getByRole('region', { name: 'Item detail' });
    const bar = panel.locator('[data-decision-bar]');
    await expect(bar).toBeVisible();
    await expect(panel).toContainText('Stopped at Go/no-go');
    await settle(page).catch(() => undefined);
    await shot(page, `r2-before-scroll-${size.width}x${size.height}`);
    // Path expanded (the tall case at 375x667).
    await panel.getByRole('button', { name: 'Path' }).first().click();
    const scroller = panel.locator('[data-focus-scroll]');
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForTimeout(300);
    // The scroller ends where the bar starts: nothing is ever under the bar.
    const barTop = (await bar.boundingBox())!.y;
    const sb = (await scroller.boundingBox())!;
    expect(sb.y + sb.height).toBeLessThanOrEqual(barTop + 1);
    await shot(page, `r2-bottom-${size.width}x${size.height}`);
  }

  // Typing in the note grows it inside the bar; the whole bar stays on screen.
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(`/p/${pid}?item=go1`);
  const panel = page.getByRole('region', { name: 'Item detail' });
  const area = panel.getByLabel('Your note (optional)');
  await area.click();
  const h0 = (await area.boundingBox())!.height;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.type(`line ${i} of the note`);
    await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(400);
  const nb = (await area.boundingBox())!;
  expect(nb.height).toBeGreaterThan(h0);
  expect(nb.y).toBeGreaterThanOrEqual(0);
  expect(nb.y + nb.height).toBeLessThanOrEqual(667);

  // Undo is the pressed button itself, inside the bar.
  await panel.getByRole('button', { name: /^Approve/ }).click();
  const undoOnBar = panel.locator('[data-decision-bar] button[data-undo]');
  await expect(undoOnBar).toBeVisible();
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await undoOnBar.click();

  // Final approval: Releasing during the window; Released only with the Done state.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}?item=acc1`);
  const fin = page.getByRole('region', { name: 'Item detail' });
  await fin.getByRole('button', { name: /^Approve/ }).click();
  await expect(fin.locator('button[data-undo]')).toBeVisible();
  await expect(page.getByText(/Released\. .* is done\./)).toHaveCount(0);
  await shot(page, 'r2-final-releasing-390');
  await expect(page.getByText('Released. \u201cFinal check\u201d is done.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(fin).toContainText('Done');
  await shot(page, 'r2-final-released-390');
});
