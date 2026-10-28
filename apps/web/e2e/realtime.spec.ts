import { expect, test, type Page } from '@playwright/test';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);
const LIMIT_MS = 2500; // acceptance: a change shows within ~2 s, without a refresh

const item = (uid: string, over: Record<string, unknown>) => ({
  title: 'Seeded',
  type: 'idea',
  stepId: 'draft',
  status: 'queued',
  summary: 'Seed',
  source: { kind: 'manual', label: 'Test' },
  createdBy: { type: 'human', id: uid },
  parentItemId: null,
  sourceRunId: null,
  claim: null,
  progress: null,
  gate: null,
  triage: null,
  sendBackCount: 0,
  costEur: 0,
  order: 1,
  updatedAt: new Date(),
  lastEventId: 'seed',
  ...over,
});

async function seed(page: Page) {
  const owner = person('Rita Realtime');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `rt${rand()}`;
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Blog', uid));
  return { wid, uid, pid };
}

/** Writes with the admin helper (as another browser would), then times until `visible` shows. */
async function delay(write: () => Promise<void>, visible: () => Promise<void>): Promise<number> {
  const t0 = Date.now();
  await write();
  await visible();
  return Date.now() - t0;
}

test('board, Needs you and Activity update live within ~2 s, without a refresh', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  const base = `workspaces/${wid}/projects/${pid}`;
  const seen: Record<string, number> = {};

  await page.goto('/');
  await expect(page.getByText('You are all caught up.')).toBeVisible();
  seen.needsYou = await delay(
    () =>
      adminSet(
        `${base}/items/g1`,
        item(uid, {
          title: 'Live gate item',
          stepId: 'review',
          status: 'waiting',
          gate: { stepId: 'review', approvals: {}, rejections: {} },
        }),
      ),
    () => expect(page.getByText('Live gate item').first()).toBeVisible({ timeout: LIMIT_MS }),
  );

  await page.goto(`/p/${pid}`);
  await expect(page.getByRole('heading', { name: /Blog/ })).toBeVisible();
  seen.board = await delay(
    () => adminSet(`${base}/items/b1`, item(uid, { title: 'Live board item' })),
    () => expect(page.getByText('Live board item')).toBeVisible({ timeout: LIMIT_MS }),
  );

  await page.goto('/activity');
  await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  await page.waitForTimeout(1500);
  seen.activity = await delay(
    () =>
      adminSet(`workspaces/${wid}/events/rt1`, {
        actor: { type: 'agent', id: 'scout', name: 'Scout' },
        projectId: pid,
        itemId: 'b1',
        runId: null,
        type: 'message.posted',
        data: { kind: 'question' },
        at: new Date(),
      }),
    () =>
      expect(page.getByText(/Scout asked a question on/).first()).toBeVisible({
        timeout: LIMIT_MS,
      }),
  );

  test.info().annotations.push({ type: 'delay-ms', description: JSON.stringify(seen) });
  console.log('REALTIME delay ms', JSON.stringify(seen));
});

test('a silently dropped connection shows Reconnecting within ~10 s, and clears when it is back', async ({
  page,
}) => {
  await seed(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible();
  await expect(page.getByTestId('reconnecting')).toHaveCount(0);

  // Block every request to the Firestore host (the emulator here), as a network that stops answering.
  const firestore = new RegExp(`:${process.env.E2E_FIRESTORE_PORT ?? 8080}/`);
  await page.route(firestore, (route) => route.abort('connectionfailed'));
  const t0 = Date.now();
  await expect(page.getByTestId('reconnecting')).toBeVisible({ timeout: 10_000 });
  const ms = Date.now() - t0;
  console.log('RECONNECTING banner after ms', ms);
  test.info().annotations.push({ type: 'banner-ms', description: String(ms) });

  await page.unroute(firestore);
  await expect(page.getByTestId('reconnecting')).toHaveCount(0, { timeout: 10_000 });
});

test('an idle signed-in page logs no console errors or failed requests over 10 s', async ({
  page,
}) => {
  await seed(page);
  const bad: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') bad.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => bad.push(`failed: ${r.url()}`));
  page.on('response', (r) => {
    if (r.status() >= 400) bad.push(`${r.status()}: ${r.url()}`);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible();
  bad.length = 0;
  await page.waitForTimeout(10_000); // several heartbeats
  expect(bad).toEqual([]);
});
