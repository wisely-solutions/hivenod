import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

/** Tries every way out of the sandbox and writes what happened into its own page. */
const MALICIOUS = `<!doctype html><html><body><h1 id="title">Quarterly report</h1><pre id="out">starting</pre>
<script>
const out = {};
const run = async () => {
  out.ran = true;
  try { out.parentDoc = String(parent.document.title); } catch (e) { out.parentDoc = 'blocked'; }
  try { out.topDoc = String(top.document.title); } catch (e) { out.topDoc = 'blocked'; }
  try { out.cookie = 'read:' + document.cookie; } catch (e) { out.cookie = 'blocked'; }
  try { out.storage = 'read:' + localStorage.length; } catch (e) { out.storage = 'blocked'; }
  try { top.location.href = 'https://example.com/'; out.nav = 'maybe'; } catch (e) { out.nav = 'blocked'; }
  try { await fetch('https://httpbin.org/get', { mode: 'no-cors' }); out.fetch = 'sent'; } catch (e) { out.fetch = 'blocked'; }
  try { out.idb = typeof indexedDB === 'undefined' ? 'blocked' : 'present'; indexedDB.open('x'); } catch (e) { out.idb = 'blocked'; }
  document.getElementById('out').textContent = JSON.stringify(out);
  document.body.dataset.done = '1';
};
run();
</script></body></html>`;

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
  const pid = `rv${rand()}`;
  const base = projectFields('Reports', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, base);
  const itemBase = {
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: 'The Q3 report.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  };
  await adminSet(`workspaces/${wid}/projects/${pid}/items/i1`, { ...itemBase, title: 'Q3 report' });
  for (const [id, title] of [
    ['f1', 'Pricing page is out of date'],
    ['f2', 'Typo in the footer'],
  ] as const) {
    await adminSet(`workspaces/${wid}/projects/${pid}/items/${id}`, {
      ...itemBase,
      title,
      type: 'finding',
      stepId: 'draft',
      status: 'suggested',
      summary: `Details for: ${title}`,
      source: { kind: 'finding', label: 'Research agent on Q3 report' },
      createdBy: { type: 'agent', id: 'agent1' },
      parentItemId: 'i1',
      sourceRunId: 'r1',
      gate: null,
      order: id === 'f1' ? 1 : 2,
    });
  }
  const att = (id: string, over: Record<string, unknown>) =>
    adminSet(`workspaces/${wid}/projects/${pid}/items/i1/attachments/${id}`, {
      kind: 'html',
      name: 'report.html',
      content: null,
      url: null,
      bytes: 10,
      runId: null,
      by: { type: 'human', id: uid },
      at: new Date(Date.now() + Object.keys(over).length),
      lastEventId: 'seed',
      ...over,
    });
  await att('a1', {
    name: 'report.html',
    content: MALICIOUS,
    bytes: MALICIOUS.length,
    at: new Date(1000),
  });
  await att('a2', {
    kind: 'markdown',
    name: 'notes.md',
    content: `# Notes\n\nSome **bold** words.\n\n${'x'.repeat(300)}`,
    at: new Date(2000),
  });
  await att('a3', {
    kind: 'link',
    name: 'Source',
    url: 'https://example.com/source',
    at: new Date(3000),
  });
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4EIwDiqkL4KAAAAPQQBvB5xBgAAAABJRU5ErkJggg==';
  await att('a4', { kind: 'image', name: 'chart.png', content: png, at: new Date(4000) });
  const big =
    '<!doctype html><html><body><p>Start</p>' +
    '<p>' +
    'Lorem ipsum dolor sit amet, '.repeat(31_000) +
    '</p><p id="end">End of report</p><script>document.body.dataset.ran="1"</script></body></html>';
  await att('a5', { name: 'big.html', content: big, bytes: big.length, at: new Date(5000) });
  return { wid, uid, pid };
}

const doc = (page: Page) => page.frameLocator('iframe[title^="Document"]').frameLocator('iframe');
const field = async (path: string, name: string) => (await adminDoc(path))?.fields[name];

test('html runs its scripts but cannot escape the sandbox', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/i/i1/view/a1`);
  const outer = page.locator('iframe[title^="Document"]');
  await expect(outer).toHaveAttribute('sandbox', 'allow-scripts allow-popups');
  await expect(doc(page).locator('body[data-done="1"]')).toBeAttached({ timeout: 15_000 });
  const result = JSON.parse((await doc(page).locator('#out').textContent()) ?? '{}');
  // The inline script ran (the report works), and every escape failed.
  expect(result).toMatchObject({
    ran: true,
    parentDoc: 'blocked',
    topDoc: 'blocked',
    cookie: 'blocked',
    storage: 'blocked',
    nav: 'blocked',
    fetch: 'blocked',
  });
  // The app page itself was not navigated away.
  expect(new URL(page.url()).pathname).toBe(`/p/${pid}/i/i1/view/a1`);
  await expectNoHorizontalScroll(page);
});

test('a 900 KB report opens in under a second', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/i/i1/view/a5`);
  await expect(page.locator('iframe[title^="Document"]')).toBeVisible();
  const t0 = Date.now();
  await expect(doc(page).locator('#end')).toBeAttached({ timeout: 5000 });
  const took = Date.now() - t0;
  console.log(`900 KB report rendered in ${took} ms after the frame was in place`);
  expect(took).toBeLessThan(1000);
});

test('markdown, link, image viewers and the attachment switcher', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}/i/i1/view/a1`);
  const pick = page.getByLabel('Attachment');
  await pick.selectOption({ label: 'notes.md' });
  await expect(page.getByRole('main').getByText('Notes', { exact: true })).toBeVisible();
  // A 300-character word wraps: the pane never scrolls sideways (card dLnThgjq).
  const pane = page.getByRole('main').getByText('x'.repeat(300));
  await expect(pane).toBeVisible();
  const overflow = await pane.evaluate((el) => {
    let n: HTMLElement | null = el as HTMLElement;
    while (n && n.scrollWidth <= n.clientWidth) n = n.parentElement;
    return n ? n.tagName : null;
  });
  expect(overflow).toBeNull();
  await pick.selectOption({ label: 'Source' });
  const open = page.getByRole('link', { name: /Open link/ });
  await expect(open).toHaveAttribute('href', 'https://example.com/source');
  await expect(open).toHaveAttribute('rel', /noopener/);
  await pick.selectOption({ label: 'chart.png' });
  const img = page.getByRole('img', { name: 'chart.png' });
  await expect(img).toBeVisible();
  const w0 = (await img.boundingBox())!.width;
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(async () => (await img.boundingBox())!.width).toBeGreaterThan(w0);
  await page.getByRole('button', { name: 'Fit to screen' }).click();
  await expect.poll(async () => (await img.boundingBox())!.width).toBeCloseTo(w0, 0);
});

test('found while working: add to the first step, add to this item, dismiss needs a reason', async ({
  page,
}, info) => {
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}/i/i1/view/a2`);
  const phone = (info.project.use.viewport?.width ?? 1440) < 640;
  if (phone) {
    await page.getByRole('button', { name: /^Decide/ }).click();
    await expect(page.getByRole('dialog', { name: 'Decide' })).toBeVisible();
  }
  const panel = phone
    ? page.getByRole('dialog', { name: 'Decide' })
    : page.getByRole('complementary', { name: 'Review' });
  await expect(panel.getByText('Pricing page is out of date', { exact: true })).toBeVisible();
  await expect(panel.getByText('Typo in the footer', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Approve' })).toBeVisible();

  // Add to Draft (the first step): the suggestion becomes a normal, linked item there.
  const f1 = `workspaces/${wid}/projects/${pid}/items/f1`;
  await panel.getByRole('button', { name: 'Add to Draft' }).first().click();
  await expect(panel.getByText('Pricing page is out of date', { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await field(f1, 'type'))?.stringValue).toBe('task');
  expect((await field(f1, 'parentItemId'))?.stringValue).toBe('i1');
  expect((await field(f1, 'stepId'))?.stringValue).toBe('draft');
  expect((await field(f1, 'status'))?.stringValue).toBe('queued');
  const triage = (await field(f1, 'triage'))?.mapValue?.fields;
  expect(triage?.outcome?.stringValue).toBe('intake');

  // Dismiss: needs a reason of 10+ characters.
  await panel.getByRole('button', { name: 'Dismiss…' }).click();
  const dismiss = panel.getByRole('button', { name: 'Dismiss suggestion' });
  await expect(dismiss).toBeDisabled();
  await expect(panel.getByText('0 / 10 characters minimum')).toBeVisible();
  await panel.getByLabel('Why dismiss it?').fill('too short');
  await expect(panel.getByText('9 / 10 characters minimum')).toBeVisible();
  await expect(dismiss).toBeDisabled();
  await panel.getByLabel('Why dismiss it?').fill('Already tracked elsewhere.');
  await dismiss.click();
  await expect(panel.getByText('Typo in the footer', { exact: true })).toHaveCount(0);
  const f2 = `workspaces/${wid}/projects/${pid}/items/f2`;
  await expect.poll(async () => (await field(f2, 'status'))?.stringValue).toBe('stopped');
  expect((await field(f2, 'triage'))?.mapValue?.fields?.outcome?.stringValue).toBe('dismissed');
});

test('findings can be triaged from the item detail too', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  const section = page.getByRole('region', { name: 'Found while working' });
  await expect(section.getByText('Typo in the footer', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Add to this item' }).first()).toBeVisible();
});

test('add to this item appends the finding to the summary', async ({ page }, info) => {
  const { wid, pid } = await seed(page);
  await page.goto(`/p/${pid}/i/i1/view/a2`);
  const phone = (info.project.use.viewport?.width ?? 1440) < 640;
  if (phone) await page.getByRole('button', { name: /^Decide/ }).click();
  const panel = phone
    ? page.getByRole('dialog', { name: 'Decide' })
    : page.getByRole('complementary', { name: 'Review' });
  await panel.getByRole('button', { name: 'Add to this item' }).first().click();
  const i1 = `workspaces/${wid}/projects/${pid}/items/i1`;
  await expect
    .poll(async () => (await field(i1, 'summary'))?.stringValue)
    .toContain('Added from finding: Pricing page is out of date');
});

test('item detail links to the full page, and back returns', async ({ page }) => {
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=i1`);
  await page.getByRole('link', { name: 'Full page' }).first().click();
  await expect(page).toHaveURL(/\/view\/a\d/);
  await page.getByRole('link', { name: 'Back to the item' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${pid}\\?item=i1`));
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { pid } = await seed(page);
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${pid}/i/i1/view/a1`);
    await expect(doc(page).locator('body[data-done="1"]')).toBeAttached({ timeout: 15_000 });
    await page.screenshot({ path: `${dir}/viewer-${size}-${theme}.png` });
    if (size === '375') {
      await page.getByRole('button', { name: /^Decide/ }).click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${dir}/viewer-sheet-${size}-${theme}.png` });
    }
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  }
});
