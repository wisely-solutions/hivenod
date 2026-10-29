import { expect, test, type Browser, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  adminPatch,
  adminSetAll,
  projectFields,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

// The real product screenshots on the landing page (item g17GWUkfKRFh4mgn0ciQ), from a clean demo
// organization seeded on the emulators: made-up people, agents and work, never test or personal data.
// Run with `pnpm shots:landing`; it rewrites apps/web/src/landing/shots/*.webp (commit them).
// SHOTS_PREVIEW=<dir> also keeps the full-size PNGs there, to look at before committing.
test.skip(!process.env.SHOTS_LANDING, 'pnpm shots:landing makes the landing screenshots');

const OUT = join(import.meta.dirname, '../src/landing/shots');
const MIN = 60_000;
const ago = (m: number) => new Date(Date.now() - m * MIN);

/** The demo person: a fixed made-up name; the email is never shown in the shots. */
const demo = {
  name: 'Sam Rivera',
  email: `sam.rivera.${Math.random().toString(36).slice(2, 8)}@example.com`,
};

const PID = 'website';

async function seedDemo(page: Page) {
  await page.goto('/');
  await signIn(page, demo);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(demo.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(demo.email);
  const uid = await uidOf(demo.email);
  const base = `workspaces/${wid}`;
  await adminPatch(base, { name: 'Northwind Studio' });
  const gate = () => ({
    deciderUids: [uid],
    groupIds: [],
    rule: 'any',
    n: 1,
    mustInclude: [],
    rejectPolicy: 'one',
    remindAfterHours: 24,
  });
  const steps = [
    { id: 'shape', name: 'Shape', kind: 'agent', description: 'Turn the idea into a plan' },
    { id: 'gonogo', name: 'Go/no-go', kind: 'human', description: 'Go or no-go', gate: gate() },
    { id: 'build', name: 'Build', kind: 'agent', description: 'Code, tests, pull request' },
    { id: 'test', name: 'Test', kind: 'agent', description: 'Check it, send it back if wrong' },
    {
      id: 'accept',
      name: 'Accept',
      kind: 'human',
      description: 'Live, checked, done',
      gate: gate(),
    },
  ];
  const docs: Array<[string, Record<string, unknown>]> = [];
  const put = (path: string, data: Record<string, unknown>) => docs.push([path, data]);
  put(`${base}/projects/${PID}`, {
    ...projectFields('Website', uid),
    emoji: '🌐',
    templateId: 'software',
    steps,
    stepIndex: Object.fromEntries(steps.map((s, i) => [s.id, i])),
  });
  for (const [id, name, color] of [
    ['hive', 'Hive', 'agent-1'],
    ['tester', 'Tester', 'agent-6'],
  ] as const)
    put(`${base}/agents/${id}`, {
      name,
      color,
      projectIds: '*',
      createdBy: uid,
      createdAt: ago(5000),
      revokedAt: null,
      lastSeenAt: ago(0.2),
      tokenHint: 'demo',
      previousAgentUid: null,
      lastEventId: 'seed',
    });
  let order = 0;
  const item = (id: string, over: Record<string, unknown>) => {
    order += 1;
    put(`${base}/projects/${PID}/items/${id}`, {
      title: 'Item',
      type: 'task',
      stepId: 'shape',
      status: 'queued',
      summary: '',
      source: { kind: 'manual', label: 'Sam Rivera' },
      createdBy: { type: 'human', id: uid },
      parentItemId: null,
      sourceRunId: null,
      claim: null,
      progress: null,
      gate: null,
      triage: null,
      sendBackCount: 0,
      costEur: 0,
      order,
      updatedAt: ago(30 + order * 7),
      lastEventId: 'seed',
      ...over,
    });
  };
  const waiting = (stepId: string) => ({
    status: 'waiting',
    gate: { stepId, approvals: {}, rejections: {} },
  });
  const working = (agent: string, run: string, done: number, total: number) => ({
    status: 'working',
    claim: { runId: run, agentUid: agent, heartbeatAt: ago(0.2) },
    progress: { done, total },
  });
  item('referral', {
    title: 'Referral program',
    type: 'idea',
    summary: 'Give customers a link to invite a friend.',
  });
  item('changelog', { title: 'Public changelog page', type: 'idea' });
  item('rewrite', {
    title: 'Pricing page rewrite',
    stepId: 'gonogo',
    ...waiting('gonogo'),
    summary:
      'Rewrite the pricing page around the three plans customers actually pick. Shaped plan, copy draft and the open questions are attached.',
    costEur: 0.42,
  });
  item('onboarding', {
    title: 'Onboarding emails',
    stepId: 'gonogo',
    ...waiting('gonogo'),
    summary: 'Three short emails for the first week.',
    costEur: 0.18,
  });
  item('pricing', {
    title: 'Pricing page',
    stepId: 'build',
    ...working('hive', 'r1', 3, 5),
    summary: 'Build the new pricing page from the approved plan.',
    costEur: 1.1,
  });
  item('signup', { title: 'Fix the sign-up redirect', type: 'bug', stepId: 'build' });
  item('checkout', {
    title: 'Checkout copy',
    stepId: 'test',
    ...working('tester', 'r2', 6, 9),
    costEur: 0.35,
  });
  item('status', {
    title: 'Status page',
    stepId: 'accept',
    ...waiting('accept'),
    summary: 'Live on the site. Tester passed 9 of 9 checks.',
    costEur: 0.9,
  });
  for (const [run, agent, itemId, stepId] of [
    ['r1', 'hive', 'pricing', 'build'],
    ['r2', 'tester', 'checkout', 'test'],
  ] as const)
    put(`${base}/runs/${run}`, {
      agentUid: agent,
      projectId: PID,
      itemId,
      stepId,
      startedAt: ago(12),
      heartbeatAt: ago(0.2),
      heartbeatEventAt: ago(1),
      endedAt: null,
      status: 'running',
      costEur: 0.3,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'seed',
    });
  put(`${base}/projects/${PID}/items/rewrite/attachments/plan`, {
    kind: 'markdown',
    name: 'Plan.md',
    content: '# Pricing page rewrite\n\nThree plans, one comparison table, a short FAQ.',
    url: null,
    bytes: 70,
    runId: null,
    by: { type: 'agent', id: 'hive' },
    at: ago(40),
    lastEventId: 'seed',
  });
  await adminSetAll(docs);
  return uid;
}

/** Encodes a PNG screenshot as WebP at the given widths, in the browser (no image tools needed). */
async function toWebp(browser: Browser, png: Buffer, widths: number[]) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      async ({ src, widths }) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        return widths.map((w) => {
          const c = document.createElement('canvas');
          c.width = w;
          c.height = Math.round((img.naturalHeight * w) / img.naturalWidth);
          const g = c.getContext('2d')!;
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, c.width, c.height);
          return { w, h: c.height, data: c.toDataURL('image/webp', 0.8).split(',')[1]! };
        });
      },
      { src: `data:image/png;base64,${png.toString('base64')}`, widths },
    );
  } finally {
    await page.close();
  }
}

async function save(browser: Browser, name: string, png: Buffer, widths: number[]) {
  mkdirSync(OUT, { recursive: true });
  const preview = process.env.SHOTS_PREVIEW;
  if (preview) {
    mkdirSync(preview, { recursive: true });
    writeFileSync(join(preview, `${name}.png`), png);
  }
  for (const { w, h, data } of await toWebp(browser, png, widths)) {
    writeFileSync(join(OUT, `${name}-${w}.webp`), Buffer.from(data, 'base64'));
    console.log(`shots: ${name}-${w}.webp ${w}x${h}`);
  }
}

test('landing screenshots from the demo organization', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'one run makes both shots');
  test.setTimeout(120_000);
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  });
  await ctx.addInitScript(() => localStorage.setItem('hive-theme', 'dark'));
  const page = await ctx.newPage();
  const uid = await seedDemo(page);
  // Every agent step open, so the board shows the agents at work.
  await page.evaluate(
    ([key]) => localStorage.setItem(key!, JSON.stringify(['shape', 'build', 'test'])),
    [`hive.board.open.${uid}.${PID}`],
  );

  // Desktop: the project's board, agents at work and gates waiting.
  await page.goto(`/p/${PID}`);
  await expect(page.getByText('Pricing page rewrite').first()).toBeVisible({ timeout: 20_000 });
  await settle(page);
  // The top of the page: the board ends above 620 px, the rest is empty canvas.
  await save(
    browser,
    'desk',
    await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: 620 } }),
    [930, 1860],
  );

  // Phone: the item waiting at Go/no-go, with the decision bar.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  });
  await phone.addInitScript(() => localStorage.setItem('hive-theme', 'dark'));
  const p2 = await phone.newPage();
  await p2.goto('/');
  await signIn(p2, demo);
  await expect(
    p2.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await p2.goto(`/p/${PID}?item=rewrite`);
  await expect(p2.getByRole('heading', { name: 'Pricing page rewrite' })).toBeVisible({
    timeout: 20_000,
  });
  await settle(p2);
  await save(browser, 'phone', await p2.screenshot(), [250, 500]);
  await phone.close();
  await ctx.close();
});
