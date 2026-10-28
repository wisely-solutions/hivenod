import { expect, test, type Page } from '@playwright/test';
import { adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

// An org with ten projects (items, runs, one open question): the projects list must not shift as
// the per-project reads arrive, and money must never show less than it is.
const PROJECTS = 10;
const RUNS = 3;
const COST = 0.11;
const ago = (m: number) => new Date(Date.now() - m * 60_000);

async function seedOrg(page: Page) {
  const owner = person('Tess Ten');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const base = `workspaces/${wid}`;
  for (let p = 0; p < PROJECTS; p++) {
    const pid = `p${p}`;
    await adminSet(`${base}/projects/${pid}`, {
      ...projectFields(`Project ${p}`, uid),
      createdAt: ago(1000 - p),
    });
    for (let i = 0; i < 2; i++) {
      await adminSet(`${base}/projects/${pid}/items/i${i}`, {
        title: `Item ${i}`,
        type: 'task',
        stepId: 'draft',
        status: 'queued',
        summary: 'A short summary.',
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
        order: i,
        updatedAt: ago(90),
        lastEventId: 'seed',
      });
    }
    for (let r = 0; r < RUNS; r++) {
      await adminSet(`${base}/runs/${pid}r${r}`, {
        agentUid: 'scout',
        projectId: pid,
        itemId: 'i0',
        stepId: 'draft',
        startedAt: ago(30 + r),
        heartbeatAt: ago(20),
        heartbeatEventAt: ago(20),
        endedAt: ago(20),
        status: 'done',
        costEur: COST,
        tokensIn: 0,
        tokensOut: 0,
        model: null,
        summary: null,
        lastEventId: 'seed',
      });
    }
    await adminSet(`${base}/events/e${p}`, {
      actor: { type: 'agent', id: 'scout', name: 'Scout' },
      projectId: pid,
      itemId: 'i0',
      runId: null,
      type: 'item.updated',
      data: {},
      at: ago(p + 1),
    });
  }
  await adminSet(`${base}/projects/p3/items/i0/messages/q1`, {
    workspaceId: wid,
    projectId: 'p3',
    itemId: 'i0',
    by: { type: 'agent', id: 'scout' },
    kind: 'question',
    text: 'Which audience?',
    at: ago(10),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
}

/** Sums layout shifts not caused by input, from the start of each load. */
async function observeCls(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { value: number; hadRecentInput: boolean }
      >) {
        if (!e.hadRecentInput) w.__cls += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
}

const cls = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

test('ten projects: spend is right from the first number on', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'the sidebar shows spend on desktop');
  test.setTimeout(120_000);
  await seedOrg(page);
  const expected = `€${(PROJECTS * RUNS * COST).toFixed(2)}`;
  // The page that seeded the org was open while the data arrived, so its sidebar stored every
  // in-between sum as "the last spend I knew" (hive.spend.last.*), and the next load shows that
  // until the server confirms. That is the design for a returning user, but not what this test is
  // about: let the open page settle on the final sum, then forget the remembered values.
  await expect(page.getByText(/^Spend this month /).first()).toHaveText(
    `Spend this month ${expected}`,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage))
      if (k.startsWith('hive.spend.last.')) localStorage.removeItem(k);
  });
  for (const path of ['/projects', '/agents']) {
    // `CLS_THROTTLE=6` reruns the load under CPU throttling (the CI runner is that slow).
    const rate = Number(process.env.CLS_THROTTLE ?? 0);
    if (rate > 1 && path === '/projects') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    }
    // Records every spend text the sidebar shows while the page loads.
    await page.goto(path);
    const seen = new Set<string>();
    const spend = page.getByText(/^Spend this month /).first();
    // Watches until the final sum has shown (a throttled CPU can take many seconds), then 1.5 s more.
    const deadline = Date.now() + 30_000;
    let until = deadline;
    while (Date.now() < until) {
      const t = await spend.textContent().catch(() => null);
      const m = t?.match(/^Spend this month (\S+)$/);
      if (m) seen.add(m[1]!);
      if (m?.[1] === expected && until === deadline) until = Math.min(deadline, Date.now() + 1500);
      await page.waitForTimeout(25);
    }
    expect([...seen].filter((v) => v !== '€…')).toEqual([expected]);
  }
  // Today's runs on /agents are complete too (the agent has no doc, so check the card totals).
  await page.goto('/projects');
  const cards = page.getByRole('list', { name: 'Projects' }).getByRole('listitem');
  await expect(cards).toHaveCount(PROJECTS);
  await expect(cards.filter({ hasText: `€${(RUNS * COST).toFixed(2)}` })).toHaveCount(PROJECTS);
});

test('ten projects: the list and Recent activity do not shift on a phone', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'desktop-1440', 'phones');
  test.setTimeout(120_000);
  await seedOrg(page);
  await observeCls(page);
  const cards = page.getByRole('list', { name: 'Projects' }).getByRole('listitem');
  const loads: number[] = [];
  for (let i = 0; i < 3; i++) {
    await page.goto('/projects');
    await expect(cards).toHaveCount(PROJECTS);
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
    await page.waitForTimeout(1500);
    loads.push(await cls(page));
  }
  console.log(`${info.project.name} /projects CLS per load: ${loads.map((v) => v.toFixed(3))}`);
  // The first visit has no remembered shape yet; repeat visits must be still.
  expect(loads[1]!).toBeLessThanOrEqual(0.02);
  expect(loads[2]!).toBeLessThanOrEqual(0.02);
  // The project that needs you comes first and the swap is not left to the 3 s fallback.
  await expect(cards.first()).toContainText('need you');
});
