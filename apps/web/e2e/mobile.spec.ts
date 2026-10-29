import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
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
  fastTimers,
  settle,
  UNDO_WAIT,
} from './helpers';

// The phone experience (SPEC 8): gestures, sheets, scrubber, keyboard, offline, narrow screens.
test.beforeEach(({ page }, info) => {
  void page;
  test.skip(info.project.name === 'desktop-1440', 'phone gestures');
});

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page) {
  const owner = person('João');
  await fastTimers(page);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `mob${rand()}`;
  const base = projectFields('Blog', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      base.steps[0]!,
      base.steps[1]!,
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  return { wid, uid, pid };
}

const waiting = (uid: string, title: string, ageH: number, over: Record<string, unknown> = {}) => ({
  title,
  type: 'idea',
  stepId: 'review',
  status: 'waiting',
  summary: `Draft of ${title}, ready for a decision.`,
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: { stepId: 'review', approvals: {}, rejections: {} },
  triage: null,
  sendBackCount: 0,
  costEur: 0.2,
  order: 1,
  updatedAt: new Date(Date.now() - ageH * 3_600_000),
  lastEventId: 'seed',
  ...over,
});
const path = (wid: string, pid: string, iid: string) =>
  `workspaces/${wid}/projects/${pid}/items/${iid}`;
const stepOf = async (wid: string, pid: string, iid: string) =>
  (await adminDoc(path(wid, pid, iid)))?.fields.stepId?.stringValue;

/** Drags with the pointer (what the row's swipe listens to), in small steps like a finger. */
/** Bounding box of an element once it has stopped moving (same box on two polls 120 ms apart). */
async function settledBox(page: Page, loc: Locator) {
  let last = '';
  await expect
    .poll(async () => {
      const cur = JSON.stringify(await loc.boundingBox());
      const stable = cur !== 'null' && cur === last;
      last = cur;
      if (!stable) await page.waitForTimeout(120);
      return stable;
    })
    .toBe(true);
  return (await loc.boundingBox())!;
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy = 0) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
}

/** A touch swipe on an element, as the browser would deliver it. */
async function touchSwipe(page: Page, selector: string, dx: number, dy = 0, startX?: number) {
  await page.evaluate(
    ([sel, dX, dY, sX]) => {
      const el = document.querySelector(sel as string)!;
      const r = el.getBoundingClientRect();
      const x0 = (sX as number | null) ?? r.left + r.width / 2;
      const y0 = Math.max(r.top + 40, 120);
      const mk = (type: string, x: number, y: number) => {
        const t = new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
        const end = type === 'touchend';
        return new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: end ? [] : [t],
          targetTouches: end ? [] : [t],
          changedTouches: [t],
        });
      };
      el.dispatchEvent(mk('touchstart', x0, y0));
      el.dispatchEvent(mk('touchend', x0 + (dX as number), y0 + (dY as number)));
    },
    [selector, dx, dy, startX ?? null] as const,
  );
}

test('swipe a card: right opens approve, left opens iterate', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  const row = page.getByRole('button', { name: /Launch post/ }).first();
  await expect(row).toBeVisible();
  // The first-run checklist appears once the lists are settled and pushes the rows down; measure after it.
  await page.getByRole('button', { name: 'Dismiss the checklist' }).click();
  await expect(page.getByRole('region', { name: 'Get started' })).toBeHidden();
  // The row slides into place (layout spring): wait until it stops moving.
  let box = (await row.boundingBox())!;
  await expect
    .poll(async () => {
      await page.waitForTimeout(150);
      const b = (await row.boundingBox())!;
      const still = b.y === box.y;
      box = b;
      return still;
    })
    .toBe(true);
  const mid = { x: box.x + 40, y: box.y + box.height / 2 };
  await drag(page, mid, 160);
  await expect(page.getByRole('dialog', { name: /Approve/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();

  await drag(page, { x: box.x + box.width - 40, y: mid.y }, -200);
  await expect(page.getByRole('dialog', { name: /back/i })).toBeVisible();
});

test('swipe or tap between items in the detail, with a counter', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Oldest one', 5));
  await adminSet(path(wid, pid, 'i2'), waiting(uid, 'Newest one', 1));
  await page
    .getByRole('button', { name: /Oldest one/ })
    .first()
    .click();
  const detail = page.getByRole('article', { name: /Decision: Oldest one/ });
  await expect(detail.getByText('1 of 2')).toBeVisible();
  await expect(detail.getByRole('button', { name: 'Previous item' })).toBeDisabled();

  await touchSwipe(page, 'article', -140);
  await expect(page.getByRole('article', { name: /Decision: Newest one/ })).toBeVisible();
  await expect(page.getByText('2 of 2')).toBeVisible();
  await page.getByRole('button', { name: 'Previous item' }).click();
  await expect(page.getByRole('article', { name: /Decision: Oldest one/ })).toBeVisible();
  await touchSwipe(page, 'article', 140);
  // Already first: a swipe right does nothing and the page does not scroll sideways.
  await expect(page.getByRole('article', { name: /Decision: Oldest one/ })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('long press starts selecting an approval; a finding row opens quick actions', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  const row = page.getByRole('button', { name: /Launch post/ }).first();
  // The row can still move (first-run checklist, late rows): press where it settles.
  const box = await settledBox(page, row);
  await page.mouse.move(box.x + 60, box.y + 30);
  await page.mouse.down();
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(page.getByRole('toolbar')).toContainText('1 selected');
  await expect(page.getByLabel('Select Launch post')).toBeChecked();
  await page.getByRole('button', { name: 'Clear selection' }).click();
  await expect(page.getByRole('toolbar')).toBeHidden();
});

test('the keyboard never covers the field, and the textarea grows', async ({ page }) => {
  // A stand-in for the visual viewport so a test can "open the keyboard".
  await page.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & { height: number; offsetTop: number };
    vv.height = window.innerHeight;
    vv.offsetTop = 0;
    Object.defineProperty(window, 'visualViewport', { value: vv, configurable: true });
    (window as unknown as { __kb: (px: number) => void }).__kb = (px) => {
      vv.height = window.innerHeight - px;
      vv.dispatchEvent(new Event('resize'));
    };
  });
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await page
    .getByRole('button', { name: /Launch post/ })
    .first()
    .click();
  const area = page.getByLabel('Your note (optional)');
  await area.scrollIntoViewIfNeeded();
  await area.focus();
  const kb = 300;
  await page.evaluate((px) => (window as unknown as { __kb: (n: number) => void }).__kb(px), kb);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--kb')))
    .toBe(`${kb}px`);
  const h = await page.evaluate(() => window.innerHeight);
  await expect
    .poll(async () => (await area.boundingBox())!.y + (await area.boundingBox())!.height)
    .toBeLessThanOrEqual(h - kb);
  // The action bar rides above the keyboard.
  const bar = (await page.locator('[data-action-bar]').boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(h - kb + 1);
  await expect(page.getByRole('navigation', { name: 'Tabs' })).toBeHidden();

  const before = (await area.boundingBox())!.height;
  await area.fill(Array.from({ length: 8 }, (_, i) => `Line ${i + 1} of the rationale`).join('\n'));
  expect((await area.boundingBox())!.height).toBeGreaterThan(before);

  // Typing a long multi-line rationale keeps the last line above the action bar and the keyboard
  // (re-revealed on every input). Simulated keyboard (visualViewport stand-in), NOT a real OSK.
  await area.focus();
  await page.keyboard.press('Control+End');
  for (let i = 1; i <= 14; i++) {
    await page.keyboard.type(
      `Another long line of the rationale, number ${i}, long enough to wrap`,
    );
    await page.keyboard.press('Enter');
    await expect
      .poll(async () => {
        const box = (await area.boundingBox())!;
        // The note lives in the bar: it grows inside it, above the keyboard, never off the top.
        const bb = (await page.locator('[data-action-bar]').boundingBox())!;
        return box.y + box.height <= Math.min(bb.y + bb.height, h - kb) + 1 && box.y >= 0;
      })
      .toBe(true);
  }
  // The caret is the bottom of the text: the field scrolls inside itself once it stops growing.
  const atEnd = await area.evaluate(
    (el: HTMLTextAreaElement) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
  );
  expect(atEnd).toBe(true);
});

test('the full-page viewer closes with a pull down on its header', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await adminSet(`${path(wid, pid, 'i1')}/attachments/a1`, {
    kind: 'markdown',
    name: 'report.md',
    content: '# Launch post\n\nA short draft.',
    url: null,
    bytes: 30,
    runId: null,
    by: { type: 'human', id: uid },
    at: new Date(),
    lastEventId: 'seed',
  });
  await page.goto(`/p/${pid}/i/i1/view/a1`);
  await expect(page.getByRole('button', { name: /Decide/ })).toBeVisible();
  await touchSwipe(page, 'header', 0, 220);
  await expect(page).not.toHaveURL(/\/view\//);
});

test('a pull down that starts on the attachment dropdown closes the viewer', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  for (const a of ['a1', 'a2']) {
    await adminSet(`${path(wid, pid, 'i1')}/attachments/${a}`, {
      kind: 'markdown',
      name: `${a}.md`,
      content: '# Draft',
      url: null,
      bytes: 30,
      runId: null,
      by: { type: 'human', id: uid },
      at: new Date(),
      lastEventId: 'seed',
    });
  }
  await page.goto(`/p/${pid}/i/i1/view/a1`);
  await expect(page.getByLabel('Attachment')).toBeVisible();
  await touchSwipe(page, 'select[aria-label="Attachment"]', 0, 220);
  await expect(page).not.toHaveURL(/\/view\//);
});

test('landscape phone: Approve is reachable in the viewer side panel', async ({ page }, info) => {
  test.skip(info.project.name !== 'iphone-se', 'viewport set explicitly');
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await adminSet(`${path(wid, pid, 'i1')}/attachments/a1`, {
    kind: 'markdown',
    name: 'report.md',
    content: '# Launch post',
    url: null,
    bytes: 30,
    runId: null,
    by: { type: 'human', id: uid },
    at: new Date(),
    lastEventId: 'seed',
  });
  await page.setViewportSize({ width: 667, height: 375 });
  await page.goto(`/p/${pid}/i/i1/view/a1`);
  const approve = page
    .getByRole('complementary', { name: 'Review' })
    .getByRole('button', { name: /Approve/ });
  await expect(approve).toBeInViewport({ ratio: 1 });
});

test('the step scrubber jumps to a column on the board', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await page.goto(`/p/${pid}`);
  const nav = page.getByRole('navigation', { name: 'Steps' });
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: /Publish/ }).click();
  await expect
    .poll(async () => (await page.locator('[data-step="publish"]').first().boundingBox())!.x)
    .toBeLessThan(120);
  // The tap moves the board sideways only: the page does not scroll, and the column header stays
  // visible under the sticky chip strip (card weB6bMnf, tester round 1).
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const head = page.locator('[data-step="publish"]').first().getByRole('heading').first();
  const navBox = (await nav.boundingBox())!;
  const headBox = (await head.boundingBox())!;
  expect(headBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 1);
  // It stays below the phone header while the page scrolls.
  const top = (await nav.boundingBox())!.y;
  expect(top).toBeGreaterThanOrEqual(40);
  await expectNoHorizontalScroll(page);
});

test('the step pager marks the step on screen, not the gate (card pacU0a76)', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await page.goto(`/p/${pid}`);
  const nav = page.getByRole('navigation', { name: 'Steps' });
  await expect(nav).toBeVisible();
  // Draft is on screen first; Review (the gate) is not the current one.
  await expect(nav.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(nav.getByRole('button', { name: /Draft/ })).toHaveAttribute('aria-current', 'step');
  await expect(nav.getByRole('button', { name: /Review/ })).not.toHaveAttribute('aria-current');
  await nav.getByRole('button', { name: /Publish/ }).click();
  await expect(nav.getByRole('button', { name: /Publish/ })).toHaveAttribute(
    'aria-current',
    'step',
  );
  await expect(nav.locator('[aria-current="step"]')).toHaveCount(1);
});

test('the step pager strip follows the board so the current pill stays visible (card MZmBDw2C)', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await page.goto(`/p/${pid}`);
  const nav = page.getByRole('navigation', { name: 'Steps' });
  await expect(nav).toBeVisible();
  // Scroll the board itself to the last column (not a pager click).
  await page.getByTestId('board').evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  const current = nav.locator('[aria-current="step"]');
  await expect(current).toHaveCount(1);
  await expect
    .poll(async () => {
      const n = await nav.boundingBox();
      const c = await current.boundingBox();
      return !!n && !!c && c.x >= n.x - 1 && c.x + c.width <= n.x + n.width + 1;
    })
    .toBe(true);
});

test('offline: the data stays, an approval is queued and syncs when back online', async ({
  page,
  context,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  const row = page.getByRole('button', { name: /Launch post/ }).first();
  await expect(row).toBeVisible();
  // The code behind a tapped row is lazy: going offline before it has downloaded would crash
  // the screen. A phone under load can show the list well before that (card AQzVFCGA).
  await expect
    .poll(() =>
      page.evaluate(() => {
        const names = performance.getEntriesByType('resource').map((r) => r.name);
        return ['InboxDetail', 'SendBackDialog'].every((n) => names.some((u) => u.includes(n)));
      }),
    )
    .toBe(true);

  await context.setOffline(true);
  await expect(page.getByText(/You're offline/)).toBeVisible({ timeout: 10_000 });
  await expect(row).toBeVisible();
  await row.click();
  await page.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(page.locator('button[data-undo]')).toBeVisible();
  await page.waitForTimeout(UNDO_WAIT);
  expect(await stepOf(wid, pid, 'i1')).toBe('review');

  await context.setOffline(false);
  await expect(page.getByText('Back online. Your changes are syncing.')).toBeVisible({
    timeout: 15_000,
  });
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 30_000 }).toBe('publish');
});

test('a 320 px screen (small foldable) has no sideways scroll on the main screens', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(
    path(wid, pid, 'i1'),
    waiting(uid, 'A rather long title that has to wrap neatly', 3),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  for (const url of [
    '/',
    '/projects',
    '/activity',
    '/agents',
    '/insights',
    '/settings/profile',
    `/p/${pid}`,
  ]) {
    await page.goto(url);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expectNoHorizontalScroll(page);
  }
  await page.goto('/');
  await page
    .getByRole('button', { name: /A rather long title/ })
    .first()
    .click();
  const approve = page.getByRole('button', { name: /Approve/ });
  await expect(approve).toBeVisible();
  // The label is never cut off, even at 320 px.
  expect(await approve.evaluate((b) => b.scrollWidth <= b.clientWidth)).toBe(true);
  await expectNoHorizontalScroll(page);
  // Landscape on a phone: the action bar stays reachable.
  await page.setViewportSize({ width: 667, height: 320 });
  await expect(page.getByRole('button', { name: /Approve/ })).toBeInViewport();
  await expectNoHorizontalScroll(page);
});

test('landscape phone: side nav scrolls, Settings reachable, no overlap', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'iphone-se', 'viewport set explicitly');
  const { pid } = await seed(page);
  for (const [width, height] of [
    [667, 375],
    [812, 375],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const side = page.getByRole('complementary', { name: 'Main' });
    await expect(side).toBeVisible();
    const me = side.getByRole('link', { name: /(^|, )Settings$/ });
    await me.scrollIntoViewIfNeeded();
    await expect(me).toBeInViewport({ ratio: 1 });
    const project = side.locator(`a[href="/p/${pid}"]`);
    await project.scrollIntoViewIfNeeded();
    await expect(project).toBeInViewport({ ratio: 1 });
    // Nothing overlaps: the last project link ends above the footer's Settings link.
    const [pb, mb] = await Promise.all([project.boundingBox(), me.boundingBox()]);
    await me.scrollIntoViewIfNeeded();
    const pb2 = await project.boundingBox();
    const mb2 = await me.boundingBox();
    expect(pb2!.y + pb2!.height).toBeLessThanOrEqual(mb2!.y + 0.5);
    void pb;
    void mb;
    await me.click();
    await expect(page).toHaveURL(/\/settings/);
    await expectNoHorizontalScroll(page);
  }
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  test.skip(info.project.name !== 'iphone-se', 'one phone size');
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post for the new board', 3));
  await adminSet(path(wid, pid, 'i2'), waiting(uid, 'Pricing page copy', 26, { sendBackCount: 1 }));
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto(`/p/${pid}`);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${dir}/board-scrubber-375-${theme}.png` });
    await page.goto('/');
    await page
      .getByRole('button', { name: /Launch post/ })
      .first()
      .click();
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${dir}/detail-stepper-375-${theme}.png` });
  }
});

test('phone board: one-row header, step chips with counts, first card high up (card weB6bMnf)', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(path(wid, pid, 'i1'), waiting(uid, 'Launch post', 3));
  await adminSet(path(wid, pid, 'i2'), {
    ...waiting(uid, 'Draft post', 1),
    stepId: 'draft',
    status: 'queued',
    gate: null,
  });
  await page.goto(`/p/${pid}`);
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  // Header: back, name, menu on one row; Columns/Rows and the big buttons are gone.
  await expect(page.getByRole('link', { name: 'All projects', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Columns', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New item', exact: true })).toHaveCount(0);
  const nav = page.getByRole('navigation', { name: 'Steps' });
  await expect(nav.getByRole('button', { name: 'Draft 1' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Review 1' })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'Publish 0' })).toBeVisible();
  // The first card starts above 300 px on a phone.
  const card = page.getByRole('button', { name: /Draft post/ }).first();
  await expect(card).toBeVisible();
  expect((await card.boundingBox())!.y).toBeLessThan(300);
  // The menu holds the rest.
  await page.getByRole('button', { name: 'Project menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'List view' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit process' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Insights' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Spend this month/ })).toBeVisible();
  await page.getByRole('menuitem', { name: 'List view' }).click();
  await expect(page).toHaveURL(/view=list/);
  // List: the filters hide behind one Filter button.
  await expect(page.getByLabel('Agent', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByLabel('Agent', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Status', { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test('Inbox tab: badge equals the /inbox "wait for you" line, live, axe-clean (item k5KCcXfk)', async ({
  page,
}) => {
  const { wid, uid } = await seed(page);
  const thread = (state: string) => ({
    memberUid: uid,
    subjectId: null,
    state,
    waiting: null,
    question: null,
    title: `Thread ${state}`,
    refs: [],
    lastMessageAt: new Date('2026-01-05T10:00:00Z'),
    fetchedBy: 'agent1',
    urgent: false,
    createdAt: new Date('2026-01-05T10:00:00Z'),
    updatedAt: new Date('2026-01-05T10:00:00Z'),
    lastEventId: 'seed',
  });
  const tp = (id: string) => `workspaces/${wid}/inboxThreads/${id}`;
  await adminSet(tp('t1'), thread('needsYou'));
  await adminSet(tp('t2'), thread('yourCall'));
  await adminSet(tp('t3'), thread('done'));
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Tabs' });
  const inbox = tabs.getByRole('link', { name: /^Inbox/ });
  await expect(inbox).toHaveAccessibleName('Inbox 2 waiting');
  await expect(inbox.locator('[data-inbox-badge]')).toHaveText('2');
  expect((await inbox.boundingBox())!.height).toBeGreaterThanOrEqual(56);
  await expectNoHorizontalScroll(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', scheme);
    await settle(page);
    const res = await new AxeBuilder({ page }).analyze();
    expect(
      res.violations.map((v) => `${scheme} ${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`),
    ).toEqual([]);
  }
  await inbox.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText('2 threads wait for you')).toBeVisible();
  await expect(inbox).toHaveAttribute('data-status', 'active');
  await expectNoHorizontalScroll(page);
  // Live: one thread is handled, the badge and the line follow; at zero the badge is gone.
  await adminSet(tp('t1'), thread('done'));
  await expect(page.getByText('1 thread waits for you')).toBeVisible();
  await expect(inbox).toHaveAccessibleName('Inbox 1 waiting');
  await adminSet(tp('t2'), thread('done'));
  await expect(page.getByText('Nothing waits for you')).toBeVisible();
  await expect(inbox).toHaveAccessibleName('Inbox');
  await expect(inbox.locator('[data-inbox-badge]')).toHaveCount(0);
  // Activity left the bar but is still in the palette.
  await expect(tabs.getByRole('link', { name: 'Activity' })).toHaveCount(0);
});
