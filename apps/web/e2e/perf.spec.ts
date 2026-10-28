import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

// Mid-range Android on a mobile network: 4x slower CPU, "Fast 3G"-class link. Run with PERF_DIR set.
test.skip(!process.env.PERF_DIR, 'set PERF_DIR to measure');

const LCP_BUDGET = 1800;
const INP_BUDGET = 150;

async function observe(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __lcp: number; __inp: number };
    w.__lcp = 0;
    w.__inp = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<PerformanceEntry & { interactionId?: number }>) {
        if (e.interactionId) w.__inp = Math.max(w.__inp, e.duration);
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  });
}

test('LCP and INP on a throttled phone', async ({ page, browser }, info) => {
  test.skip(info.project.name !== 'pixel-7', 'the mid-range Android profile');
  const dir = process.env.PERF_DIR!;
  mkdirSync(dir, { recursive: true });
  const owner = person('João');
  await observe(page);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = 'perf1';
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Blog', uid));
  for (let i = 1; i <= 6; i++) {
    await adminSet(`workspaces/${wid}/projects/${pid}/items/i${i}`, {
      title: `Item number ${i}`,
      type: 'idea',
      stepId: 'review',
      status: 'waiting',
      summary:
        'A summary that is long enough to take two lines on a phone screen, as real ones do.',
      source: { kind: 'manual', label: 'Test' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      triage: null,
      sendBackCount: 0,
      costEur: 0.1,
      order: i,
      updatedAt: new Date(Date.now() - i * 3_600_000),
      lastEventId: 'seed',
    });
  }

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  });

  await browser.startTracing(page, {
    path: `${dir}/trace-inbox-swipe-sheet.json`,
    categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing'],
  });
  await page.reload();
  await expect(page.getByRole('button', { name: /Item number 1/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(1500);
  const lcp = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);

  // Interactions: open a card, step to the next, open and close the approve sheet.
  await page
    .getByRole('button', { name: /Item number 6/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Next item' }).click();
  await page.getByRole('button', { name: 'Previous item' }).click();
  await page.getByRole('button', { name: /^Send back/ }).click();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.waitForTimeout(500);
  await browser.stopTracing();
  const inp = await page.evaluate(() => (window as unknown as { __inp: number }).__inp);

  writeFileSync(
    `${dir}/vitals.json`,
    JSON.stringify(
      {
        profile: 'Pixel 7, CPU 4x slower, 1.6 Mbps / 150 ms',
        lcpMs: Math.round(lcp),
        inpMs: Math.round(inp),
        budget: { lcpMs: LCP_BUDGET, inpMs: INP_BUDGET },
      },
      null,
      2,
    ),
  );
  expect(lcp, 'LCP').toBeLessThan(LCP_BUDGET);
  expect(inp, 'INP').toBeLessThan(INP_BUDGET);
});
