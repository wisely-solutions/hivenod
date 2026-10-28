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
  settle,
  fastTimers,
  UNDO_WAIT,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page, opts: { otherDecider?: boolean } = {}) {
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
  const pid = `inbox${rand()}`;
  const base = projectFields('Blog', uid);
  const review = base.steps[1]!;
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      base.steps[0]!,
      {
        ...review,
        gate: {
          ...review.gate!,
          deciderUids: opts.otherDecider ? [uid, 'ana'] : [uid],
          rule: opts.otherDecider ? 'all' : 'any',
        },
      },
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  return { owner, wid, uid, pid };
}

function waitingItem(uid: string, over: Record<string, unknown> = {}) {
  return {
    title: 'Launch post',
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: 'Draft of the launch post, ready for a decision.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0.42,
    order: 1,
    updatedAt: new Date(Date.now() - 3 * 3_600_000),
    lastEventId: 'seed',
    ...over,
  };
}

const itemPath = (wid: string, pid: string, iid: string) =>
  `workspaces/${wid}/projects/${pid}/items/${iid}`;
const stepOf = async (wid: string, pid: string, iid: string) =>
  (await adminDoc(itemPath(wid, pid, iid)))?.fields.stepId?.stringValue;
const statusOf = async (wid: string, pid: string, iid: string) =>
  (await adminDoc(itemPath(wid, pid, iid)))?.fields.status?.stringValue;

/** Opens the row (phones show the full detail, desktop selects it) and returns the detail. */
async function openRow(page: Page, title: string) {
  await page
    .getByRole('button', { name: new RegExp(title) })
    .first()
    .click();
  const detail = page.getByRole('article', { name: new RegExp(`Decision: ${title}`) });
  await expect(detail).toBeVisible();
  return detail;
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('a reload never shows a partial count or the all-caught-up state (card JtZDsMEb)', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  for (const n of [1, 2, 3]) {
    await adminSet(itemPath(wid, pid, `r${n}`), waitingItem(uid, { title: `Post ${n}` }));
  }
  await expect(page.getByText('3 things need you.')).toBeVisible();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __summary: string[] }).__summary = seen;
    const watch = () => {
      const el = document.querySelector('p[aria-live="polite"]');
      if (!el) return;
      const note = () => {
        const t = (el.textContent ?? '').trim();
        if (t && seen[seen.length - 1] !== t) seen.push(t);
      };
      note();
      new MutationObserver(note).observe(el, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    };
    new MutationObserver(() => watch()).observe(document, { childList: true, subtree: true });
  });
  await page.reload();
  await expect(page.getByText('3 things need you.')).toBeVisible();
  await expect(page.getByText('Nothing needs you.')).toHaveCount(0);
  const seen = await page.evaluate(() => (window as unknown as { __summary: string[] }).__summary);
  expect(seen.filter((t) => t !== '3 things need you.')).toEqual([]);
});

test('the Needs-you nav badge never climbs across a reload (card JtZDsMEb)', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  for (const n of [1, 2, 3]) {
    await adminSet(itemPath(wid, pid, `b${n}`), waitingItem(uid, { title: `Badge ${n}` }));
  }
  await expect(page.getByText('3 things need you.')).toBeVisible();
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __badge: string[] }).__badge = seen;
    const scan = () => {
      // Sidebar link and phone tab both carry "Needs you N waiting" when the badge shows.
      for (const el of document.querySelectorAll('[aria-label^="Needs you, "]')) {
        const t = el.getAttribute('aria-label') ?? '';
        if (seen[seen.length - 1] !== t) seen.push(t);
      }
    };
    new MutationObserver(scan).observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-label'],
    });
  });
  await page.reload();
  await expect(page.getByText('3 things need you.')).toBeVisible();
  await expect(page.locator('[aria-label="Needs you 3 waiting"]').first()).toBeAttached();
  const seen = await page.evaluate(() => (window as unknown as { __badge: string[] }).__badge);
  expect(seen.filter((t) => t !== 'Needs you 3 waiting')).toEqual([]);
});

test('an item at the gate shows up live, is approved with a rationale and moves on', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await expect(page.getByText('You are all caught up.')).toBeVisible();
  await expect(page.getByText('Nothing needs you.')).toBeVisible();

  // An agent submits the deliverable at the gate (test helper).
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  await adminSet(`${itemPath(wid, pid, 'i1')}/attachments/a1`, {
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
  await expect(page.getByText('1 thing needs you.')).toBeVisible();
  await expectNoHorizontalScroll(page);

  const detail = await openRow(page, 'Launch post');
  await expect(detail.getByRole('heading', { name: 'Launch post' })).toBeVisible();
  await expect(detail.getByText('A short draft.')).toBeVisible();
  await expect(detail.getByRole('link', { name: 'Full page' })).toBeVisible();
  await detail.getByLabel('Your note (optional)').fill('Clear and on brand');
  await settle(page);
  await axe(page);
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();

  // The pressed button counts down as Undo (no toast); when it ends the row leaves and the write commits.
  await expect(detail.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('publish');
  const decisions = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/projects/${pid}/decisions`,
    { headers: { Authorization: 'Bearer owner' } },
  ).then(
    (r) =>
      r.json() as Promise<{ documents: Array<{ fields: Record<string, Record<string, string>> }> }>,
  );
  expect(decisions.documents).toHaveLength(1);
  expect(decisions.documents[0]!.fields.outcome!.stringValue).toBe('approved');
  expect(decisions.documents[0]!.fields.rationale!.stringValue).toBe('Clear and on brand');
});

async function decisionCount(wid: string, pid: string) {
  const r = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/projects/${pid}/decisions`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await r.json()) as { documents?: unknown[] };
  return body.documents?.length ?? 0;
}

test('undo within 5 seconds restores everything', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  // The item stays; the pressed button is the Undo, the others are dimmed, and there is no toast.
  const undo = detail.locator('button[data-undo]');
  await expect(undo).toContainText(/Undo · \d/);
  await expect(detail.getByRole('button', { name: /^Send back/ })).toBeDisabled();
  await expect(detail.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await undo.click();
  await expect(detail.getByRole('button', { name: 'Approve → Publish' })).toBeEnabled();
  await expect(detail.locator('button[data-undo]')).toHaveCount(0);
  await expect(page.getByText('1 thing needs you.')).toBeVisible();
  // Well past the 5 s window: nothing was written, not even late.
  await page.waitForTimeout(UNDO_WAIT);
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
  expect(await decisionCount(wid, pid)).toBe(0);
});

test('Undo state: axe-clean in light and dark, and reduced motion drops the bar', async ({
  page,
}) => {
  const { uid, pid, wid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await page.evaluate(() => localStorage.setItem('hive.e2e.undoMs', '12000')); // room for axe
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  const undo = detail.locator('button[data-undo]');
  await expect(undo).toBeVisible();
  await expect(page.getByTestId('undo-bar')).toHaveCount(1);
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(400);
    await axe(page);
  }
  await undo.click();
  // Reduced motion: only the countdown text, no animated bar.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect(page.getByTestId('undo-bar')).toHaveCount(0);
  await detail.locator('button[data-undo]').click();
});

test('Reject counts down on its button too, and Undo restores it', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await page.evaluate(() => localStorage.setItem('hive.e2e.undoMs', '12000')); // room for axe
  await detail.getByRole('button', { name: 'Reject', exact: true }).click();
  const d = page.getByRole('dialog');
  await d.getByLabel('Why are you dropping it?').fill('Not worth doing this quarter');
  await d.getByRole('button', { name: 'Reject', exact: true }).click();
  const undo = detail.locator('button[data-undo]');
  await expect(undo).toContainText(/Undo · \d/);
  await expect(detail.getByRole('button', { name: /^Approve/ })).toBeDisabled();
  await expect(page.locator('[data-toast-region] [role="status"]')).toHaveCount(0);
  await undo.click();
  await expect(detail.getByRole('button', { name: 'Reject', exact: true })).toBeEnabled();
  await page.waitForTimeout(UNDO_WAIT);
  expect(await statusOf(wid, pid, 'i1')).not.toBe('stopped');
  expect(await decisionCount(wid, pid)).toBe(0);
});

test('phone: leaving the item during its countdown keeps the decision', async ({ page }, info) => {
  test.skip(info.project.name === 'desktop-1440', 'the phone flow');
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { title: 'Spec one' }));
  await adminSet(itemPath(wid, pid, 'i2'), waitingItem(uid, { title: 'Spec two', order: 2 }));
  const one = await openRow(page, 'Spec one');
  await one.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(one.locator('button[data-undo]')).toBeVisible();
  await page.getByRole('button', { name: 'Back to inbox' }).click();
  const two = await openRow(page, 'Spec two');
  await expect(two).toBeVisible();
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('publish');
  expect(await stepOf(wid, pid, 'i2')).toBe('review');
});

test('four approvals inside the undo window all commit', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'keyboard flow');
  const { wid, uid, pid } = await seed(page);
  const ids = ['i1', 'i2', 'i3', 'i4'];
  for (const [n, id] of ids.entries())
    await adminSet(itemPath(wid, pid, id), waitingItem(uid, { title: `Spec ${n + 1}`, order: n }));
  await expect(page.getByText('4 things need you.')).toBeVisible();
  // The first item opens in the focus view; each approval moves on to the next one.
  await page.keyboard.press('Enter');
  for (const n of [1, 2, 3, 4]) {
    const detail = page.getByRole('article', { name: `Decision: Spec ${n}` });
    await expect(detail).toBeVisible();
    await page.keyboard.press('a');
    await expect(detail.locator('button[data-undo]')).toBeVisible();
    // The item stays through its countdown; J goes to the next one meanwhile.
    if (n < 4) await page.keyboard.press('j');
  }
  await expect(page.getByText('Nothing needs you.')).toBeVisible({ timeout: 15_000 });
  // Four countdowns ran side by side; every one must be written, none stranded.
  await expect
    .poll(() => Promise.all(ids.map((id) => stepOf(wid, pid, id))), { timeout: 15_000 })
    .toEqual(['publish', 'publish', 'publish', 'publish']);
  expect(await decisionCount(wid, pid)).toBe(4);
});

test('Z undoes the countdown and the item keeps the selection', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'keyboard is a desktop idea');
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { title: 'Spec one' }));
  await adminSet(itemPath(wid, pid, 'i2'), waitingItem(uid, { title: 'Spec two', order: 2 }));
  const detail = await openRow(page, 'Spec one');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  await expect(page.getByTestId('undo-announcement')).toHaveText(
    'Approved. Undo available for 5 seconds',
  );
  await page.keyboard.press('z');
  await expect(detail.locator('button[data-undo]')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: 'Approve → Publish' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Spec one/ }).first()).toHaveAttribute(
    'aria-current',
    'true',
  );
  await page.waitForTimeout(UNDO_WAIT);
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
});

test('phone: from opening the app to an approved item in under 10 seconds', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop-1440', 'the phone flow');
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const started = Date.now();
  await page.goto('/');
  await page
    .getByRole('button', { name: /Launch post/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(page.locator('button[data-undo]')).toBeVisible();
  expect(Date.now() - started).toBeLessThan(10_000);
});

test('Send back and Reject need a reason; both are recorded', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { title: 'Spec one' }));
  await adminSet(itemPath(wid, pid, 'i2'), waitingItem(uid, { title: 'Spec two', order: 2 }));

  let detail = await openRow(page, 'Spec one');
  await detail.getByRole('button', { name: /^Send back/ }).click();
  const dialog = page.getByRole('dialog', { name: /Send '.*' back/ });
  await expect(dialog.getByRole('button', { name: 'Send back to Draft' })).toBeDisabled();
  await dialog.getByLabel('Why?').fill('Wrong audience, aim at developers');
  await dialog.getByRole('button', { name: 'Send back to Draft' }).click();
  await expect(page.getByRole('status')).toContainText('Sent back to Draft.');
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('draft');

  detail = await openRow(page, 'Spec two');
  await detail.getByRole('button', { name: 'Reject', exact: true }).click();
  const d2 = page.getByRole('dialog');
  await expect(d2.getByRole('button', { name: 'Reject', exact: true })).toBeDisabled();
  await expect(d2.getByText('0 / 10 characters minimum')).toBeVisible();
  await d2.getByLabel('Why are you dropping it?').fill('Not worth doing this quarter');
  await d2.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(page.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect.poll(() => statusOf(wid, pid, 'i2'), { timeout: 15_000 }).toBe('stopped');
});

test('a second decider: the item waits on others after I approve', async ({ page }) => {
  const { wid, uid, pid } = await seed(page, { otherDecider: true });
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await expect(detail.getByText('0 of 2 approved · you')).toBeVisible();
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toContainText(/Undo · \d/);
  await expect
    .poll(async () => (await adminDoc(itemPath(wid, pid, 'i1')))?.fields.gate !== undefined)
    .toBe(true);
  await page.waitForTimeout(UNDO_WAIT);
  const waiting = page.getByRole('region', { name: 'Waiting on others' });
  await expect(waiting.getByText('Launch post', { exact: true })).toBeVisible();
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
});

test('questions are answered inline and the answer is saved', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), {
    ...waitingItem(uid, {
      title: 'Research brief',
      stepId: 'draft',
      status: 'working',
      gate: null,
    }),
  });
  await adminSet(`${itemPath(wid, pid, 'i1')}/messages/q1`, {
    workspaceId: wid,
    projectId: pid,
    itemId: 'i1',
    by: { type: 'agent', id: 'agent1' },
    kind: 'question',
    text: 'Which audience should the brief target?',
    at: new Date(Date.now() - 600_000),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  await expect(page.getByText('1 thing needs you.')).toBeVisible();
  await page.getByRole('button', { name: 'Questions 1' }).click();
  const detail = await openRow(page, 'Research brief');
  await detail.getByLabel('Your reply').fill('Developers');
  await detail.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Answer sent.');
  await expect
    .poll(
      async () =>
        (await adminDoc(`${itemPath(wid, pid, 'i1')}/messages/q1`))?.fields.answered?.booleanValue,
      { timeout: 15_000 },
    )
    .toBe(true);
});

test('keyboard: J and K move, A approves', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'keyboard is a desktop feature');
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { title: 'First one' }));
  await adminSet(
    itemPath(wid, pid, 'i2'),
    waitingItem(uid, { title: 'Second one', updatedAt: new Date() }),
  );
  await expect(page.getByText('2 things need you.')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'First one' })).toBeVisible();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: 'Second one' })).toBeVisible();
  await page.keyboard.press('k');
  await expect(page.getByRole('heading', { name: 'First one' })).toBeVisible();
  await page.keyboard.press('a');
  // The item moves on when its Undo countdown ends.
  await expect(page.getByRole('heading', { name: 'Second one' })).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('publish');
});

test('a finding row shows the suggestion, not the last run of the item it was found on (card RNYWeQz5)', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(
    itemPath(wid, pid, 'i1'),
    waitingItem(uid, { title: 'Launch post', stepId: 'draft', status: 'working', gate: null }),
  );
  await adminSet(`workspaces/${wid}/runs/run-old`, {
    agentUid: 'agent1',
    projectId: pid,
    itemId: 'i1',
    stepId: 'draft',
    startedAt: new Date(Date.now() - 4 * 3_600_000),
    heartbeatAt: new Date(Date.now() - 3.9 * 3_600_000),
    heartbeatEventAt: new Date(Date.now() - 3.9 * 3_600_000),
    endedAt: new Date(Date.now() - 3.9 * 3_600_000),
    status: 'done',
    costEur: 0.1,
    tokensIn: 1,
    tokensOut: 1,
    model: null,
    summary: 'Drafted A: three short paragraphs ready for review.',
    lastEventId: 'seed',
  });
  await adminSet(
    itemPath(wid, pid, 'f1'),
    waitingItem(uid, {
      title: 'Pricing page is out of date',
      type: 'finding',
      stepId: 'draft',
      status: 'suggested',
      summary: 'The pricing page still shows the 2025 plans.',
      source: { kind: 'finding', label: 'Other agent on Launch post' },
      createdBy: { type: 'agent', id: 'agent2' },
      parentItemId: 'i1',
      sourceRunId: null,
      gate: null,
    }),
  );
  await page.goto('/?f=findings');
  const row = page.getByRole('button', { name: /Pricing page is out of date/ }).first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('The pricing page still shows the 2025 plans.');
  await expect(row).not.toContainText('Drafted A');
});

test('desktop: the bar is pinned and the text scrolls inside the one scroller (card ExMNfP8A)', async ({
  page,
}, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the pinned bar is checked on desktop');
  const { wid, uid, pid } = await seed(page);
  await adminSet(
    itemPath(wid, pid, 'i1'),
    waitingItem(uid, {
      summary: Array.from({ length: 60 }, (_, i) => `Line ${i} of a long brief.`)
        .join(' ')
        .repeat(8),
    }),
  );
  const detail = await openRow(page, 'Launch post');
  const bar = detail.locator('[data-action-bar]');
  await expect(bar).toBeVisible();
  const vh = page.viewportSize()!.height;
  const box = (await bar.boundingBox())!;
  expect(box.y + box.height).toBeCloseTo(vh, 0);
  // One scroll: the page behind never scrolls, the view's own scroller does.
  const scroller = detail.locator('[data-focus-scroll]');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe(
    'hidden',
  );
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  // The bar is below the scroller, so the last bit of text is never under it.
  const sb = (await scroller.boundingBox())!;
  expect(sb.y + sb.height).toBeLessThanOrEqual(box.y + 0.5);
});

test('the detail shows a placeholder, never "No run yet", while runs load (card CGPynEQY)', async ({
  page,
}, info) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { sourceRunId: 'r1' }));
  const ago = new Date(Date.now() - 3_600_000);
  await adminSet(`workspaces/${wid}/runs/r1`, {
    agentUid: 'scout',
    projectId: pid,
    itemId: 'i1',
    stepId: 'draft',
    startedAt: ago,
    heartbeatAt: ago,
    heartbeatEventAt: ago,
    endedAt: ago,
    status: 'done',
    costEur: 0.12,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    summary: 'The run summary that arrives last.',
    lastEventId: 'seed',
  });
  // Runs are held back for 4 s (emulator builds only), as on a slow link.
  await page.addInitScript(() => {
    (window as unknown as { __hiveRunsDelayMs: number }).__hiveRunsDelayMs = 4000;
  });
  await page.reload();
  const detail = await openRow(page, 'Launch post');
  await expect(detail.locator('[data-loading="run-facts"]')).toBeVisible();
  await expect(detail.locator('[data-loading="run-summary"]')).toBeVisible();
  await expect(detail.getByText('No run yet.')).toHaveCount(0);
  await expect(detail.getByText('Nothing beyond the decision itself.')).toHaveCount(0);
  if (process.env.SHOTS_DIR) {
    mkdirSync(process.env.SHOTS_DIR, { recursive: true });
    await page.screenshot({
      path: `${process.env.SHOTS_DIR}/r3-detail-loading-${info.project.name}.png`,
    });
  }
  // Then the real data replaces the placeholder.
  await expect(detail.getByText('The run summary that arrives last.')).toBeVisible({
    timeout: 15_000,
  });
  await expect(detail.getByText('Run time')).toBeVisible();
  await expect(detail.getByText('No run yet.')).toHaveCount(0);
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  const { wid, uid, pid } = await seed(page, { otherDecider: true });
  await adminSet(`workspaces/${wid}/agents/agent1`, {
    name: 'Research agent',
    color: 'agent-2',
    projectIds: '*',
    createdBy: uid,
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: new Date(),
    tokenHint: '…a7f3',
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  await adminSet(
    itemPath(wid, pid, 'i1'),
    waitingItem(uid, {
      title: 'Launch post for the new board',
      gate: {
        stepId: 'review',
        approvals: { ana: { at: new Date(), rationale: 'Good' } },
        rejections: {},
      },
    }),
  );
  await adminSet(`${itemPath(wid, pid, 'i1')}/attachments/a1`, {
    kind: 'markdown',
    name: 'report.md',
    content:
      '# Launch post\n\nHivenod is a board where agents do the work and you decide.\n\n- Short\n- Plain\n- Honest',
    url: null,
    bytes: 120,
    runId: null,
    by: { type: 'human', id: uid },
    at: new Date(),
    lastEventId: 'seed',
  });
  await adminSet(
    itemPath(wid, pid, 'i2'),
    waitingItem(uid, {
      title: 'Pricing page copy',
      gate: { stepId: 'review', approvals: {}, rejections: {} },
      updatedAt: new Date(Date.now() - 26 * 3_600_000),
      sendBackCount: 1,
    }),
  );
  await adminSet(
    itemPath(wid, pid, 'i3'),
    waitingItem(uid, { title: 'Research brief', stepId: 'draft', status: 'working', gate: null }),
  );
  await adminSet(`${itemPath(wid, pid, 'i3')}/messages/q1`, {
    workspaceId: wid,
    projectId: pid,
    itemId: 'i3',
    by: { type: 'agent', id: 'agent1' },
    kind: 'question',
    text: 'Which audience should the brief target?',
    at: new Date(Date.now() - 600_000),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  for (const iid of ['i1', 'i2']) {
    await adminSet(`workspaces/${wid}/runs/run-${iid}`, {
      agentUid: 'agent1',
      projectId: pid,
      itemId: iid,
      stepId: 'draft',
      startedAt: new Date(Date.now() - 4 * 3_600_000),
      heartbeatAt: new Date(Date.now() - 3.9 * 3_600_000),
      heartbeatEventAt: new Date(Date.now() - 3.9 * 3_600_000),
      endedAt: new Date(Date.now() - 3.9 * 3_600_000),
      status: 'done',
      costEur: 0.42,
      tokensIn: 12000,
      tokensOut: 3400,
      model: null,
      summary:
        'Drafted the post in three short sections and checked the tone against the brand notes.',
      lastEventId: 'seed',
    });
  }
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const size = (info.project.use.viewport?.width ?? 375) >= 1000 ? '1440' : '375';
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.goto('/');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${dir}/inbox-${size}-${theme}.png` });
    if (size === '375') {
      await page
        .getByRole('button', { name: /Launch post/ })
        .first()
        .click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${dir}/detail-${size}-${theme}.png` });
    }
  }
});

test('the Needs-you filter fits at 390 and 320 without the control or the page scrolling sideways (card 1wVfp4Nz)', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid, { title: 'First one' }));
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    const group = page.getByRole('group', { name: 'Filter' });
    await expect(group).toBeVisible();
    const m = await group.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(m.sw, `filter overflows at ${width}`).toBeLessThanOrEqual(m.cw);
    const g = (await group.boundingBox())!;
    for (const b of await group.getByRole('button').all()) {
      const bb = (await b.boundingBox())!;
      expect(bb.x + bb.width, `segment clipped at ${width}`).toBeLessThanOrEqual(
        g.x + g.width + 0.5,
      );
      const t = await b.evaluate((el) => el.scrollWidth <= el.clientWidth);
      expect(t, `segment text clipped at ${width}`).toBe(true);
    }
    for (const b of await group.getByRole('button').all()) {
      expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expectNoHorizontalScroll(page);
  }
});
