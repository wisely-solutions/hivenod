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
  UNDO_MS,
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

const archivedAt = async (wid: string, pid: string) =>
  (await adminDoc(`workspaces/${wid}/projects/${pid}`))?.fields.archivedAt?.timestampValue;

// Card 6OVGEySr: closing the tab inside the Undo window must still write the decision. Nothing
// here reloads: the page is closed ~1 s after the action (the window is UNDO_MS = 2 s) and the
// server is checked directly, so the localStorage replay cannot be what saved it.

test('archive a project, close the page 1 s later: it is archived on the server', async ({
  page,
}) => {
  const { wid, pid } = await seed(page);
  await page.goto('/settings/projects');
  await page
    .getByRole('list', { name: 'Projects' })
    .getByRole('button', { name: 'Archive Blog' })
    .click();
  await expect(page.getByText('Blog archived.')).toBeVisible();
  await page.waitForTimeout(1000);
  expect(UNDO_MS).toBeGreaterThan(1500);
  await page.close();
  await expect.poll(() => archivedAt(wid, pid), { timeout: 15_000 }).toBeTruthy();
});

test('decision with Undo, close the page 1 s later: the item moved on', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await expect(detail.locator('button[data-undo]')).toBeVisible();
  await page.waitForTimeout(1000);
  await page.close();
  await expect.poll(() => stepOf(wid, pid, 'i1'), { timeout: 15_000 }).toBe('publish');
  expect(await decisionCount(wid, pid)).toBe(1);
});

test('Undo then close: nothing is written', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'i1'), waitingItem(uid));
  const detail = await openRow(page, 'Launch post');
  await detail.getByRole('button', { name: 'Approve → Publish' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(500);
  await page.close();
  await new Promise((r) => setTimeout(r, UNDO_WAIT + 1500));
  expect(await stepOf(wid, pid, 'i1')).toBe('review');
  expect(await decisionCount(wid, pid)).toBe(0);
});

test('archive then Undo, close: the project stays active', async ({ page }) => {
  const { wid, pid } = await seed(page);
  await page.goto('/settings/projects');
  const list = page.getByRole('list', { name: 'Projects' });
  await list.getByRole('button', { name: 'Archive Blog' }).click();
  await list.getByRole('button', { name: 'Restore Blog' }).click();
  await page.waitForTimeout(500);
  await page.close();
  await new Promise((r) => setTimeout(r, UNDO_WAIT + 1500));
  expect(await archivedAt(wid, pid)).toBeFalsy();
});
