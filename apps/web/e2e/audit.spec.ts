import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { seed } from './seed';
import { settle } from './helpers';

const DIR = process.env.AUDIT_DIR;

const ROUTES: Array<[string, string]> = [
  ['needs-you', '/'],
  ['needs-you-questions', '/?f=questions'],
  ['inbox', '/inbox'],
  ['insights', '/insights'],
  ['activity', '/activity'],
  ['agents', '/agents'],
  ['agent', '/agents/scout'],
  ['settings-profile', '/account/profile'],
  ['settings-organization', '/settings/organization'],
  ['settings-members', '/settings/members'],
  ['settings-groups', '/settings/groups'],
  ['settings-notifications', '/account/notifications'],
  ['kit', '/kit'],
];

// In parallel groups of routes, so the walk is not one long test at the end of a run.
const GROUPS = 3;
for (let g = 0; g < GROUPS; g++) {
  const routes = ROUTES.filter((_, i) => i % GROUPS === g);
  test(`every route is axe clean in light and dark, with no sideways scroll (${routes.map(([n]) => n).join(', ')})`, async ({
    page,
  }) => {
    await walk(page, routes, g);
  });
}

async function walk(page: Page, routes: Array<[string, string]>, group: number) {
  test.setTimeout(120_000);
  await seed(page);
  if (DIR) mkdirSync(DIR, { recursive: true });
  const size = String(page.viewportSize()!.width);
  const found: string[] = [];
  const reads: Record<string, number> = {};
  for (const [name, url] of routes) {
    // Cold start for the read count: drop the Firestore cache (not the sign-in) on a static page.
    await page.goto('/favicon.svg');
    await page.evaluate(async () => {
      for (const d of await indexedDB.databases())
        if (d.name?.startsWith('firestore')) indexedDB.deleteDatabase(d.name);
    });
    await page.goto(url);
    // The read count wants a fixed window after a cold load; the axe check only needs a settled page.
    if (DIR) await page.waitForTimeout(1800);
    // Loaded: the screen has its heading (a still, blank page during sign-in would pass as settled).
    await expect(page.locator('h1').first()).toBeAttached({
      timeout: 15_000,
    });
    await settle(page, { loading: name !== 'kit' });
    reads[name] = await page.evaluate(
      () => (window as unknown as { __hiveReads?: number }).__hiveReads ?? 0,
    );
    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await settle(page, { loading: name !== 'kit' });
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
        .analyze();
      for (const v of violations)
        found.push(
          `${name} ${theme}: ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        );
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      if (wide) {
        const who = await page.evaluate(() => {
          const hits: string[] = [];
          for (const e of document.querySelectorAll<HTMLElement>('main *')) {
            const old = e.style.display;
            e.style.display = 'none';
            if (document.documentElement.scrollWidth <= document.documentElement.clientWidth)
              hits.push(`${e.tagName}.${String(e.className).slice(0, 80)}`);
            e.style.display = old;
          }
          return hits.slice(-3);
        });
        found.push(
          `${name} ${theme}: horizontal scroll ${await page.evaluate(() => document.documentElement.scrollWidth + '/' + document.documentElement.clientWidth)} ${who.join(' | ')}`,
        );
      }
      if (DIR) await page.screenshot({ path: `${DIR}/${name}-${size}-${theme}.png` });
    }
  }
  if (DIR) writeFileSync(`${DIR}/reads-${size}-${group}.json`, JSON.stringify(reads, null, 2));
  if (DIR) writeFileSync(`${DIR}/axe-${size}-${group}.json`, JSON.stringify(found, null, 2));
  expect(found).toEqual([]);
}
