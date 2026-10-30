import { chromium, expect, test } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { seed } from './seed';

// Lighthouse mobile on the main routes, signed in, against the emulator seed.
// Run with LH_DIR (output) and LH_MODULE (path to an installed lighthouse package) set.
test.skip(!process.env.LH_DIR || !process.env.LH_MODULE, 'set LH_DIR and LH_MODULE to measure');

const PORT = 9333;
const ROUTES: Array<[string, string]> = [
  ['needs-you', '/'],
  ['inbox', '/inbox'],
  ['insights', '/insights'],
  ['activity', '/activity'],
];

// eslint-disable-next-line no-empty-pattern
test('Lighthouse mobile scores', async ({}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'one browser is enough');
  test.setTimeout(600_000);
  const dir = process.env.LH_DIR!;
  mkdirSync(dir, { recursive: true });
  const base = String(info.project.use.baseURL);
  const ctx = await chromium.launchPersistentContext(`${dir}/profile`, {
    channel: 'chrome',
    headless: true,
    args: [`--remote-debugging-port=${PORT}`],
    viewport: { width: 1000, height: 800 },
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await seed(page);
    await page.waitForTimeout(1500);
    const lh = (await import(process.env.LH_MODULE!)) as {
      default: (url: string, flags: object, config?: object) => Promise<{ lhr: LHR } | undefined>;
    };
    type LHR = {
      categories: Record<string, { score: number }>;
      audits: Record<string, { numericValue?: number }>;
    };
    const out: Record<string, unknown> = {};
    for (const [name, path] of ROUTES) {
      const res = await lh.default(`${base}${path}`, {
        port: PORT,
        output: 'json',
        logLevel: 'error',
        disableStorageReset: true,
        onlyCategories: ['performance', 'accessibility', 'best-practices'],
      });
      const r = res!.lhr;
      out[name] = {
        performance: Math.round(r.categories.performance!.score * 100),
        accessibility: Math.round(r.categories.accessibility!.score * 100),
        bestPractices: Math.round(r.categories['best-practices']!.score * 100),
        lcpMs: Math.round(r.audits['largest-contentful-paint']!.numericValue ?? 0),
        tbtMs: Math.round(r.audits['total-blocking-time']!.numericValue ?? 0),
        cls: Number((r.audits['cumulative-layout-shift']!.numericValue ?? 0).toFixed(3)),
      };
      writeFileSync(`${dir}/lighthouse.json`, JSON.stringify(out, null, 2));
    }
    expect(Object.keys(out).length).toBe(ROUTES.length);
  } finally {
    await ctx.close();
  }
});
