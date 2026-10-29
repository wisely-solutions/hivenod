/**
 * Card rLntxm7C round 3: a final approval is decided on the item's real path (skipped steps do not
 * count), Needs you keeps the item on screen through Undo and Done, and the Released toast comes
 * with the Done panel. Screens go to SHOTS_DIR.
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { adminSetAll, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/finalpath-shots';
const rand = () => Math.random().toString(36).slice(2, 8);
const ago = (m: number) => new Date(Date.now() - m * 60_000);
test.skip(({ isMobile }) => isMobile, 'phone widths are set inside');

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Ideas, Pick, Approve (people), Draft, Publish. "Final" skips Draft and Publish; "Mid" skips only Draft. */
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
  const pid = `fin${rand()}`;
  const base = projectFields('Blog', uid);
  const gate = { ...base.steps[1]!.gate!, rule: 'any' as const, deciderUids: [uid] };
  const steps = [
    { id: 'ideas', name: 'Ideas', kind: 'agent', description: 'Collect' },
    { id: 'pick', name: 'Pick', kind: 'agent', description: 'Choose' },
    { id: 'approve', name: 'Approve', kind: 'human', description: 'Ok?', gate },
    { id: 'draft', name: 'Draft', kind: 'agent', description: 'Write' },
    { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship' },
  ];
  const P = `workspaces/${wid}/projects/${pid}`;
  const shaped = { by: { type: 'agent', id: 'scout' }, at: ago(40), note: 'short' };
  const item = (title: string, order: number, skipped: string[], waited: number) => ({
    title,
    type: 'task',
    stepId: 'approve',
    status: 'waiting',
    summary: '',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'approve', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order,
    updatedAt: ago(waited),
    lastEventId: 'seed',
    shape: shaped,
    pathSkips: Object.fromEntries(skipped.map((s) => [s, 'not needed'])),
    gateSkips: {},
    pathRev: 1,
  });
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
    [`${P}/items/fin`, item('Skipped tail', 1, ['draft', 'publish'], 50)],
    [`${P}/items/mid`, item('Mid skip', 2, ['draft'], 40)],
    [`${P}/items/full`, item('Full path', 3, [], 30)],
  ]);
  return { pid };
}

const stage = (page: Page) => page.getByRole('article', { name: /^Decision: / });

for (const [label, size] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`Needs you, final approval over a skipped tail (${label}): Releasing, then Done, burst and Released together`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await seed(page);
    await page.setViewportSize(size);
    await page.goto('/');
    const row = page.getByRole('list', { name: 'Needs you' }).getByText('Skipped tail');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const detail = stage(page).filter({ hasText: 'Skipped tail' });
    await expect(detail).toBeVisible();
    // No skipped step is offered as the next one.
    await expect(detail.getByRole('button', { name: /^Approve/ })).toHaveText(/^Approve\s*A?$/);
    await detail.getByRole('button', { name: /^Approve/ }).click();
    await expect(detail.locator('button[data-undo]')).toBeVisible();
    await expect(page.getByText(/Moved to/)).toHaveCount(0);
    // Through the whole Undo window the item stays on screen.
    await page.waitForTimeout(1500);
    await expect(detail).toBeVisible();
    await expect(detail.getByTestId('done-panel')).toHaveCount(0);
    await shot(page, `${label}-releasing`);
    const done = detail.getByTestId('done-panel');
    await expect(done).toBeVisible({ timeout: 15_000 });
    // The Released toast is already there at the same moment.
    expect(await page.getByText('Released. “Skipped tail” is done.').isVisible()).toBe(true);
    await expect(done.getByTestId('hex-burst')).toBeAttached();
    await shot(page, `${label}-done`);
    // The stepper says the item is done, not "You decide" (card szHhS3cA).
    await expect(detail.getByTestId('path-done')).toHaveText(/steps done/);
    await expect(detail.getByText('You decide')).toHaveCount(0);
    await expect(detail.getByText(/Step \d of \d/)).toHaveCount(0);
    // The Done moment lasts, then Needs you moves on.
    await page.waitForTimeout(1000);
    await expect(detail).toBeVisible();
    if (label === 'desktop') {
      // Sample every frame from now on: once the next item shows, the old title must be gone at
      // once, and the Released toast must not be on screen over the next item's bar.
      await page.evaluate(() => {
        const w = window as unknown as { __frames: string[] };
        w.__frames = [];
        const tick = () => {
          const art = document.querySelector('article[aria-label^="Decision: "]');
          const toast = !!document.body.innerText.includes('Released. ');
          w.__frames.push(`${art?.getAttribute('aria-label') ?? 'none'}|${toast ? 'toast' : ''}`);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await expect(stage(page).filter({ hasText: 'Mid skip' })).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const frames = await page.evaluate(
        () => (window as unknown as { __frames: string[] }).__frames,
      );
      const firstNext = frames.findIndex((f) => f.startsWith('Decision: Mid skip'));
      expect(firstNext).toBeGreaterThan(0);
      for (const f of frames.slice(firstNext)) {
        expect(f).not.toContain('Skipped tail');
        expect(f).not.toContain('toast');
      }
    } else {
      await expect(page.getByRole('list', { name: 'Needs you' })).toBeVisible({ timeout: 10_000 });
    }
    await expect(
      page.getByRole('list', { name: 'Needs you' }).getByText('Skipped tail'),
    ).toHaveCount(0);
  });

  test(`Needs you, Undo during Releasing (${label}) keeps the item`, async ({ page }) => {
    await seed(page);
    await page.setViewportSize(size);
    await page.goto('/');
    const row = page.getByRole('list', { name: 'Needs you' }).getByText('Skipped tail');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const detail = stage(page).filter({ hasText: 'Skipped tail' });
    await detail.getByRole('button', { name: /^Approve/ }).click();
    await detail.locator('button[data-undo]').click();
    await expect(detail.getByRole('button', { name: /^Approve/ })).toBeEnabled();
    await expect(detail.getByTestId('done-panel')).toHaveCount(0);
    if (label === 'desktop')
      await expect(
        page.getByRole('list', { name: 'Needs you' }).getByText('Skipped tail'),
      ).toBeVisible();
  });
}

test('Needs you names the real next step, never a skipped one', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('list', { name: 'Needs you' }).getByText('Mid skip').click();
  const detail = stage(page).filter({ hasText: 'Mid skip' });
  await expect(detail.getByRole('button', { name: /Approve → Publish/ })).toBeVisible();
  await detail.getByRole('button', { name: /^Approve/ }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  await expect(page.getByText(/Moved to Draft/)).toHaveCount(0);
});

test('board panel: the Released toast is up when the Done panel appears', async ({ page }) => {
  test.setTimeout(60_000);
  const { pid } = await seed(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/p/${pid}?item=fin`);
  const detail = page.getByRole('article', { name: /Skipped tail/ });
  await detail.getByRole('button', { name: /^Approve/ }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  const done = detail.getByTestId('done-panel');
  await expect(done).toBeVisible({ timeout: 15_000 });
  expect(await page.getByText('Released. “Skipped tail” is done.').isVisible()).toBe(true);
  expect(await page.getByText(/Releasing/).count()).toBe(0);
  // The board panel's stepper says done too.
  await expect(detail.getByTestId('path-done')).toHaveText(/steps done/);
  await expect(detail.getByText('You decide')).toHaveCount(0);
});
