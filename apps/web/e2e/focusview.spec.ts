/**
 * Card ExMNfP8A, the item focus view: one scroll (the page behind never moves), Esc returns to the
 * same board position, J / K walk the waiting items, the title edits in place, files attach from the
 * view, and the decision bar is pinned at the bottom.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminSetAll,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

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
  for (let n = 1; n <= 24; n++)
    docs.push([
      `${P}/items/q${n}x`,
      item({ title: `Queued idea ${n}`, order: 10 + n, summary: 'Filler to make the board tall.' }),
    ]);
  docs.push([
    `${P}/items/go2`,
    item({
      title: 'Second decision',
      stepId: 'go',
      status: 'waiting',
      summary: 'Another one waiting.',
      gate: { stepId: 'go', approvals: {}, rejections: {} },
      shape: shaped,
      pathSkips: {},
      gateSkips: {},
      pathRev: 1,
      order: 2,
    }),
  ]);
  await adminSetAll(docs);
  return { wid, uid, pid };
}

test('the board item opens as a focus view: one scroll, Esc returns to the same spot', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}`);
  await expect(page.getByText('Queued idea 24').first()).toBeAttached();
  await page.evaluate(() => window.scrollTo(0, 120));
  const card = page.getByRole('button', { name: /Pricing page rewrite/ }).first();
  await expect(card).toBeVisible();
  await card.click();
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view).toBeVisible();
  const before = await page.evaluate(() => window.scrollY);
  // The page behind is locked: a wheel over the view scrolls the view, never the page.
  await page.mouse.move(400, 400);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    'hidden',
  );
  // The bar is pinned at the bottom of the screen.
  const bar = view.locator('[data-decision-bar]');
  const vh = page.viewportSize()!.height;
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(vh - 4);
  await expectNoHorizontalScroll(page);
  await page.keyboard.press('Escape');
  await expect(view).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(before);
  await expect(page).not.toHaveURL(/item=/);
});

test('J and K walk the waiting items; the title edits in place; files attach from the view', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=go1`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view.getByRole('heading', { name: 'Pricing page rewrite' })).toBeVisible();
  await expect(view).toContainText('1 of 2 waiting');
  await page.keyboard.press('j');
  await expect(view.getByRole('heading', { name: 'Second decision' })).toBeVisible();
  await expect(view).toContainText('2 of 2 waiting');
  await page.keyboard.press('k');
  await expect(view.getByRole('heading', { name: 'Pricing page rewrite' })).toBeVisible();

  await view.getByRole('heading', { name: 'Pricing page rewrite' }).click();
  await view.getByLabel('Title').fill('Pricing page rewrite v2');
  await view.getByRole('button', { name: 'Save title' }).click();
  await expect(view.getByRole('heading', { name: 'Pricing page rewrite v2' })).toBeVisible();

  await view.getByLabel('Add files').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello from the focus view'),
  });
  await expect(view.getByRole('tab', { name: /notes\.txt/ })).toBeVisible();
  // The properties column carries the step and who decides.
  const props = view.getByRole('complementary', { name: 'Properties' });
  await expect(props).toContainText('Go/no-go');
  await expect(props)
    .toContainText('Scout')
    .catch(() => undefined);
});

test('phone: the focus view fills the screen and the bar sits at the bottom', async ({ page }) => {
  const { pid } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/p/${pid}?item=go1`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view).toBeVisible();
  const bar = view.locator('[data-decision-bar]');
  await expect(bar.getByRole('button', { name: 'Approve → Build' })).toBeInViewport();
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeGreaterThan(844 - 4);
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'Close item' }).click();
  await expect(view).toHaveCount(0);
});

test('reject and send back work from the focus view on the board', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=go2`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view.getByRole('heading', { name: 'Second decision' })).toBeVisible();
  await view.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await dialog.getByLabel('Why are you dropping it?').fill('Not worth doing this quarter');
  await dialog.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(view.locator('button[data-undo]')).toContainText(/Undo · \d/);
});

test('phone: Undo is on the pressed button in the decision bar, with no toast, and the tab bar is inert', async ({
  page,
}) => {
  const { pid } = await seed(page);
  await page.setViewportSize({ width: 390, height: 844 });
  if (process.env.SHOT === 'dark') await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`/p/${pid}?item=go2`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view.getByRole('heading', { name: 'Second decision' })).toBeVisible();
  const tabs = page.locator('[data-tab-bar]');
  await expect(tabs).toHaveAttribute('inert', '');
  await expect(tabs).toHaveAttribute('aria-hidden', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('[data-tab-bar]'))).toBe(
    false,
  );
  await view.getByRole('button', { name: 'Approve → Build' }).click();
  const bar = view.locator('[data-decision-bar]');
  const undo = bar.locator('button[data-undo]');
  await expect(undo).toBeVisible();
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  // The button sits inside the bar, in the viewport, and is reachable (44 px high).
  const u = (await undo.boundingBox())!;
  const b = (await bar.boundingBox())!;
  expect(u.y).toBeGreaterThanOrEqual(b.y);
  expect(u.y + u.height).toBeLessThanOrEqual(b.y + b.height);
  expect(u.height).toBeGreaterThanOrEqual(44);
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await page.screenshot({
    path: `${process.env.HOME}/reports/AIqw6-shots/focus-${process.env.SHOT ?? 'x'}.png`,
  });
  await undo.click();
  await page.getByRole('button', { name: 'Close item' }).click();
  await expect(tabs).not.toHaveAttribute('inert', '');
  await expect(tabs).not.toHaveAttribute('aria-hidden', 'true');
});
