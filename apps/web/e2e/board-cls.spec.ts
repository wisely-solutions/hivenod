import { expect, test, type Page } from '@playwright/test';
import { login, seedSteps } from './boardSeed';

// Card 3j7gK: opening a project must not shift the board while it loads, even on a slow phone
// (the board scroller used to grow from ~94 px to ~480 px when the items arrived: 0.077 at 6x CPU).
// The observer is installed before the page's own scripts and replays nothing: it counts every shift
// of this load. `CLS_RUNS` (default 3) sets the number of loads per rate; `CLS_THROTTLE=6` adds a rate.
const LIMIT = 0.05;
const RUNS = Number(process.env.CLS_RUNS ?? 3);
const extra = Number(process.env.CLS_THROTTLE ?? 0);
const RATES = [...new Set([1, 4, 6, ...(extra > 1 ? [extra] : [])])];

type Shift = { value: number; at: number; nodes: string[] };

async function observeLoads(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __shifts: Shift[] };
    w.__shifts = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & {
          value: number;
          hadRecentInput: boolean;
          sources?: Array<{ node?: Element }>;
        }
      >) {
        if (e.hadRecentInput) continue;
        w.__shifts.push({
          value: e.value,
          at: Math.round(e.startTime),
          nodes: (e.sources ?? []).map(
            (s) => (s.node as HTMLElement | undefined)?.dataset?.testid ?? s.node?.nodeName ?? '?',
          ),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

async function loadOnce(page: Page, url: string, rate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  await page.goto(url);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByText('Item 1', { exact: true }).first()).toBeAttached({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  const shifts = await page.evaluate(() => (window as unknown as { __shifts: Shift[] }).__shifts);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await cdp.detach();
  return shifts;
}

test('the board does not shift while it loads, at any CPU speed', async ({ page }) => {
  test.setTimeout(600_000);
  const who = await login(page);
  const pid = await seedSteps(page, who, 5, ['First', 'Second', 'Third']);
  const url = `/p/${pid}`;
  await observeLoads(page);
  const worst: Record<string, number> = {};
  for (const rate of RATES) {
    for (let i = 0; i < RUNS; i++) {
      const shifts = await loadOnce(page, url, rate);
      const total = shifts.reduce((a, s) => a + s.value, 0);
      worst[rate] = Math.max(worst[rate] ?? 0, total);
      if (total >= LIMIT)
        console.log(`rate ${rate} run ${i}: ${total.toFixed(4)}`, JSON.stringify(shifts));
    }
  }
  console.log('worst CLS per CPU rate', JSON.stringify(worst));
  for (const rate of RATES) expect(worst[rate], `CLS at ${rate}x`).toBeLessThan(LIMIT);
});
