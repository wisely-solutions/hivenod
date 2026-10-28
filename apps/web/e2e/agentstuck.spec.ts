/**
 * Card KLCTVnX8: after agents sent an item back 3 times, the 4th send-back holds it for people:
 * its question shows in Needs you, marked "Agents sent it back 3×". The answer ends the hold and
 * resets the agent rounds, so agents take it again.
 */
import { expect, test } from '@playwright/test';
import { adminDoc, adminSet, person, projectFields, signIn, uidOf, workspaceOf } from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);
const itemPath = (wid: string, pid: string, iid: string) =>
  `workspaces/${wid}/projects/${pid}/items/${iid}`;

test('a stuck hold shows in Needs you; the answer hands it back to the agents', async ({
  page,
}) => {
  const owner = person('João');
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  const uid = await uidOf(owner.email);
  const pid = `stuck${rand()}`;
  const base = projectFields('App', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      { id: 'build', name: 'Build', kind: 'agent', description: 'Build it' },
      { id: 'test', name: 'Test', kind: 'agent', description: 'Test it' },
      { ...base.steps[1]!, gate: { ...base.steps[1]!.gate!, deciderUids: [uid] } },
    ],
    stepIndex: { build: 0, test: 1, review: 2 },
  });
  const at = new Date(Date.now() - 600_000);
  await adminSet(itemPath(wid, pid, 'i1'), {
    title: 'Login page',
    type: 'task',
    stepId: 'test',
    status: 'queued',
    summary: 'Build the login page.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    agentSendBacks: 3,
    awaitingAnswer: { questionId: 'q1', agentUid: 'agent1', at },
    costEur: 0.3,
    order: 1,
    updatedAt: at,
    lastEventId: 'seed',
  });
  await adminSet(`${itemPath(wid, pid, 'i1')}/messages/q1`, {
    workspaceId: wid,
    projectId: pid,
    itemId: 'i1',
    by: { type: 'agent', id: 'agent1' },
    kind: 'question',
    text: 'Agents sent this back 3 times and it still is not right. Please decide how to go on.\n\nReasons so far:\n1. Login test fails\n2. Still fails\n3. Fails on Safari\n\nThis time: Safari again',
    at,
    answered: false,
    replyTo: null,
    lastEventId: 'seed',
  });
  const row = page.getByRole('button', { name: /Login page/ }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText('Agents sent it back 3×')).toBeVisible();
  await expect(row.getByRole('img', { name: 'Agents are stuck' })).toBeVisible();
  await row.click();
  const detail = page.getByRole('article', { name: /Decision: Login page/ });
  await expect(detail).toBeVisible();
  // The reasons are a numbered list, not one run-on paragraph (card pqqOWE3s).
  const reasons = detail.locator('ol');
  await expect(reasons.getByRole('listitem')).toHaveText([
    'Login test fails',
    'Still fails',
    'Fails on Safari',
  ]);
  if (process.env.SHOTS_DIR) {
    const orig = page.viewportSize()!;
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/stuck-list-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(reasons).toBeVisible();
    await page.screenshot({ path: `${process.env.SHOTS_DIR}/stuck-list-390.png` });
    await page.setViewportSize(orig);
  }
  await detail.getByLabel('Your reply').fill('Skip Safari for now');
  await detail.getByRole('button', { name: 'Reply', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Answer sent.');
  await expect
    .poll(
      async () => {
        const f = (await adminDoc(itemPath(wid, pid, 'i1')))?.fields;
        return `${f?.awaitingAnswer?.nullValue === null ? 'free' : 'held'} ${f?.agentSendBacks?.integerValue}`;
      },
      { timeout: 15_000 },
    )
    .toBe('free 0');
});
