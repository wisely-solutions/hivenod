import { expect, test, type Page } from '@playwright/test';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

// Card cWGL3HtJ: opening a done item with an attachment (tap) and opening it from a link must not
// shift the layout. Measured with a buffered layout-shift observer.
const rand = () => Math.random().toString(36).slice(2, 8);
const ago = (m: number) => new Date(Date.now() - m * 60_000);

async function seed(page: Page) {
  const owner = person('Cleo Shift');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `cl${rand()}`;
  const base = `workspaces/${wid}/projects/${pid}`;
  await adminSet(base, projectFields('Blog', uid));
  const item = (id: string, over: Record<string, unknown>) =>
    adminSet(`${base}/items/${id}`, {
      title: id,
      type: 'task',
      stepId: 'review',
      status: 'done',
      summary: 'A seeded summary.',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: null,
      triage: null,
      sendBackCount: 0,
      costEur: 0.07,
      order: 1,
      updatedAt: ago(1),
      lastEventId: 'seed',
      ...over,
    });
  await item('i1', { title: 'Q3 report' });
  for (const [id, order] of [
    ['i2', 2],
    ['i3', 3],
  ] as const)
    await item(id, { title: `Other ${id}`, status: 'waiting', order, stepId: 'draft' });
  await item('f1', {
    title: 'Pricing page is out of date',
    type: 'finding',
    status: 'suggested',
    parentItemId: 'i1',
    stepId: 'draft',
    order: 4,
  });
  for (let r = 0; r < 6; r++)
    await adminSet(`workspaces/${wid}/runs/${pid}r${r}`, {
      agentUid: 'scout',
      projectId: pid,
      itemId: 'i1',
      stepId: 'draft',
      startedAt: ago(20 - r),
      heartbeatAt: ago(2),
      heartbeatEventAt: ago(2),
      endedAt: ago(2),
      status: 'done',
      costEur: 0.01,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'seed',
    });
  await adminSet(`${base}/items/i1/attachments/a1`, {
    kind: 'html',
    name: 'report.html',
    content: '<h1>Report</h1><p>Hello</p>',
    url: null,
    bytes: 30,
    runId: null,
    by: { type: 'human', id: uid },
    at: ago(5),
    lastEventId: 'seed',
  });
  return { pid };
}

async function observe(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >) {
        if (e.startTime < ((w as unknown as { __t0?: number }).__t0 ?? 0)) continue;
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}
const cls = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

test('deep link to a done item with an attachment does not shift', async ({ page }, info) => {
  const { pid } = await seed(page);
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >) {
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.goto(`/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Q3 report/ });
  await expect(detail.getByTestId('done-panel')).toContainText('6 runs');
  await expect(detail.getByTitle('Preview of report.html')).toBeVisible();
  await page.waitForTimeout(1500);
  const v = await cls(page);
  console.log(`${info.project.name} deep link CLS ${v.toFixed(3)}`);
  expect(v).toBeLessThan(0.05);
});

test('tapping a done item with an attachment does not shift', async ({ page }, info) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}`);
  await expect(page.getByText('Other i2').first()).toBeAttached();
  await page.waitForTimeout(800);
  await observe(page);
  await page.evaluate(() => ((window as unknown as { __t0: number }).__t0 = performance.now()));
  // A done item is not on the board; open it the way a tap on a link does: client-side navigation.
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, `/p/${pid}?item=i1`);
  const detail = page.getByRole('article', { name: /Q3 report/ });
  await expect(detail.getByTestId('done-panel')).toContainText('6 runs');
  await expect(detail.getByTitle('Preview of report.html')).toBeVisible();
  await page.waitForTimeout(1500);
  const v = await cls(page);
  console.log(`${info.project.name} tap-open CLS ${v.toFixed(3)}`);
  expect(v).toBeLessThan(0.05);
});
