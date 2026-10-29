import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminSet,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  fastTimers,
  UNDO_WAIT,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);

async function seed(page: Page, opts: { otherDecider?: boolean } = {}) {
  const owner = person('João');
  await fastTimers(page);
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

async function decisionCount(wid: string, pid: string) {
  const r = await fetch(
    `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/projects/${pid}/decisions`,
    { headers: { Authorization: 'Bearer owner' } },
  );
  const body = (await r.json()) as { documents?: unknown[] };
  return body.documents?.length ?? 0;
}

/** The page is killed before its write leaves: Firestore's write channel is cut during the reload. */
async function reloadWithoutWrites(page: Page) {
  await page.route(/Firestore\/Write/, (r) => r.abort());
  await page.reload();
  await page.unroute(/Firestore\/Write/);
}

test('approve, reload within the Undo window: the decision still lands and you are told', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  await reloadWithoutWrites(page);
  await expect(page.getByText('Saved your approval of \u201cLaunch post\u201d')).toBeVisible({
    timeout: 20_000,
  });
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('publish');
  expect(await decisionCount(wid, pid)).toBe(1);
  // Nothing is written twice: another reload leaves exactly one decision.
  await page.reload();
  await page.waitForTimeout(2000);
  expect(await decisionCount(wid, pid)).toBe(1);
});

test('Undo then reload: the decision does not land', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.reload();
  await page.waitForTimeout(UNDO_WAIT + 1500);
  await expect(page.getByText(/Saved your/)).toHaveCount(0);
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
  expect(await decisionCount(wid, pid)).toBe(0);
});

test('the replay write fails on the first load: the entry survives and lands on the next load', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  // Every write fails for the whole first load (the page may also be killed again).
  await page.route(/Firestore\/Write/, (r) => r.abort());
  await page.reload();
  await page.waitForTimeout(3000);
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
  const kept = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('hive.pendingDecisions.')),
  );
  expect(kept).toHaveLength(1);
  await page.unroute(/Firestore\/Write/);
  await page.reload();
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 20_000 }).toBe('publish');
  expect(await decisionCount(wid, pid)).toBe(1);
});

test('a screen chunk that fails to load does not stop the replay', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  await page.route(/\/assets\/(InboxPage|InboxDetail)-.*\.js/, (r) => r.abort());
  await page.reload();
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 20_000 }).toBe('publish');
  expect(await decisionCount(wid, pid)).toBe(1);
});

test('archive a project, reload within the Undo window: it is archived and you are told', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await page.goto('/settings/projects');
  const list = page.getByRole('list', { name: 'Projects' });
  await list.getByRole('button', { name: 'Archive Blog' }).click();
  await expect(page.getByText('Blog archived.')).toBeVisible();
  await reloadWithoutWrites(page);
  await expect(page.getByText('Saved: Blog archived')).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () =>
        (await adminDoc(`workspaces/${wid}/projects/${pid}`))?.fields.archivedAt?.timestampValue,
      {
        timeout: 15_000,
      },
    )
    .toBeTruthy();
  void uid;
});

test('archive, Restore on the row, reload: stays active', async ({ page }) => {
  const { wid, pid } = await seed(page);
  await page.goto('/settings/projects');
  const list = page.getByRole('list', { name: 'Projects' });
  await list.getByRole('button', { name: 'Archive Blog' }).click();
  await list.getByRole('button', { name: 'Restore Blog' }).click();
  await page.reload();
  await page.waitForTimeout(UNDO_WAIT + 1500);
  await expect(page.getByText(/Saved: Blog/)).toHaveCount(0);
  expect(
    (await adminDoc(`workspaces/${wid}/projects/${pid}`))?.fields.archivedAt?.nullValue,
  ).toBeDefined();
});
