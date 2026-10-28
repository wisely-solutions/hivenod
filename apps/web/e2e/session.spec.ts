import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminSet,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  fastTimers,
  UNDO_WAIT,
} from './helpers';

// A recorded phone session: open, approve 2, send back 1, answer a question, read a full-page report.
// Run with VIDEO_DIR set; the video lands there as session-375.webm.
test.skip(!process.env.VIDEO_DIR, 'set VIDEO_DIR to record');

test('a full phone session', async ({ browser }, info) => {
  test.skip(info.project.name !== 'iphone-se', 'one phone size');
  test.setTimeout(180_000);
  const dir = process.env.VIDEO_DIR!;
  mkdirSync(dir, { recursive: true });
  const u = info.project.use;
  const ctx = await browser.newContext({
    viewport: u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    recordVideo: { dir, size: { width: 375, height: 667 } },
  });
  const page = await ctx.newPage();
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
  const pid = 'session1';
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
  const item = (title: string, hours: number, over: Record<string, unknown> = {}) => ({
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
    costEur: 0.3,
    order: 1,
    updatedAt: new Date(Date.now() - hours * 3_600_000),
    lastEventId: 'seed',
    ...over,
  });
  const at = (iid: string) => `workspaces/${wid}/projects/${pid}/items/${iid}`;
  await adminSet(at('i1'), item('Launch post', 5));
  await adminSet(at('i2'), item('Pricing page copy', 4));
  await adminSet(at('i3'), item('Onboarding email', 3));
  await adminSet(
    at('i4'),
    item('Research brief', 2, { stepId: 'draft', status: 'working', gate: null }),
  );
  await adminSet(`${at('i1')}/attachments/a1`, {
    kind: 'html',
    name: 'report.html',
    content:
      '<h1 style="font-family:sans-serif">Launch post</h1><p style="font-family:sans-serif">Hivenod is a board where agents do the work and you decide. Short, plain, honest.</p>',
    url: null,
    bytes: 200,
    runId: null,
    by: { type: 'human', id: uid },
    at: new Date(),
    lastEventId: 'seed',
  });
  await adminSet(`${at('i4')}/messages/q1`, {
    workspaceId: wid,
    projectId: pid,
    itemId: 'i4',
    by: { type: 'agent', id: 'agent1' },
    kind: 'question',
    text: 'Which audience should the brief target?',
    at: new Date(Date.now() - 600_000),
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  const beat = () => page.waitForTimeout(900);

  await page.goto('/');
  await expect(page.getByText('4 things need you.')).toBeVisible();
  await beat();

  // Approve 1 and 2 from the detail, stepping with the next button.
  await page
    .getByRole('button', { name: /Launch post/ })
    .first()
    .click();
  await beat();
  // The full-page report first, then back.
  await page.getByRole('link', { name: 'Full page' }).click();
  await expect(page.getByRole('button', { name: /Decide/ })).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /Decide/ }).click();
  await beat();
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Back to the item' }).click();
  await page.goto('/');
  await page
    .getByRole('button', { name: /Launch post/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Approve → Publish' }).click();
  await beat();
  await page
    .getByRole('button', { name: /Pricing page copy/ })
    .first()
    .click();
  await beat();
  await page.getByLabel('Your note (optional)').fill('Clear and on brand');
  await page.getByRole('button', { name: 'Approve → Publish' }).click();
  await page.waitForTimeout(UNDO_WAIT);

  // Send one back.
  await page
    .getByRole('button', { name: /Onboarding email/ })
    .first()
    .click();
  await beat();
  await page.getByRole('button', { name: /^Send back/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Why?').fill('Too long, aim it at developers');
  await beat();
  await dialog.getByRole('button', { name: 'Send back to Draft' }).click();
  await page.waitForTimeout(UNDO_WAIT);

  // Answer the agent's question.
  await page.getByRole('button', { name: /Questions/ }).click();
  await page
    .getByRole('button', { name: /Research brief/ })
    .first()
    .click();
  await beat();
  await page.getByLabel('Your reply').fill('Developers');
  await page.getByRole('button', { name: 'Reply', exact: true }).click();
  await page.waitForTimeout(UNDO_WAIT);
  await expect(page.getByText('Nothing needs you.')).toBeVisible();
  await beat();
  await ctx.close();
});
