/**
 * May act on my word (thread it18ecc2f3446f3b4e29e8f24c): on the Agents page each agent has a
 * "May act on my word" switch, off by default, the member's own. While it is on, his home agent
 * records his decision typed in its terminal ("approved") at the gate; the thread says "Approved by
 * <member> via <agent>’s terminal: “approved”" and Activity names him with the agent's terminal.
 * Turned off, the agent is refused again. 1440 and 390, light and dark, axe-clean.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminUpdate,
  expectNoHorizontalScroll,
  fastTimers,
  freezeClock,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
  NOW,
} from './helpers';
import { agentOf } from './inboxSeed';

async function look(page: Page, name: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page, { loading: false });
    await page.waitForTimeout(300);
    await expectNoHorizontalScroll(page);
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
      .analyze();
    expect(
      violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
    ).toEqual([]);
    if (shots)
      await page.screenshot({
        path: `${shots}/decideword-${name}-${page.viewportSize()!.width}-${scheme}.png`,
      });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const trusted = async (wid: string, uid: string) => {
  const f = (await adminDoc(`workspaces/${wid}/agentTrust/${uid}`))?.fields as
    { agents?: { arrayValue?: { values?: { stringValue: string }[] } } } | undefined;
  return (f?.agents?.arrayValue?.values ?? []).map((v) => v.stringValue);
};

test('the member lets his agent act on his word; the gate shows his decision via its terminal', async ({
  page,
}) => {
  test.setTimeout(150_000);
  await fastTimers(page);
  await freezeClock(page);
  const me = person('Dana Okafor');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const hive = await agentOf(wid, uid, 'Hive');
  const tid = await hive.add(uid, {
    source: 'teams',
    from: 'Sam Example',
    text: 'Release 9 is ready to ship.',
    ref: 'release9',
    id: 'm1',
    at: new Date(NOW - 3_600_000),
  });
  await adminUpdate(`workspaces/${wid}/inboxThreads/${tid}`, { title: 'Release 9' });
  const { planId } = await hive.plan(tid, [
    { type: 'approval', fields: { what: 'Ship it?' } },
    { type: 'release', fields: {} },
  ]);

  // Agents page: off by default.
  await page.goto('/agents');
  const sw = page.getByRole('switch', { name: 'May act on my word: Hive' });
  await expect(sw).toBeVisible({ timeout: 20_000 });
  await expect(sw).not.toBeChecked();
  await look(page, 'agents-before');
  // Without his trust the agent is refused.
  await expect(hive.decide(planId, 'approve', 'approved', 'Dana Okafor')).rejects.toThrow();

  await sw.click();
  await expect(sw).toBeChecked();
  await expect.poll(() => trusted(wid, uid)).toEqual([hive.aid]);
  await look(page, 'agents-after');

  // He types "approved" in Hive's terminal: Hive records it at the gate.
  await hive.decide(planId, 'approve', 'approved', 'Dana Okafor');
  await page.goto(`/inbox/${wid}/t/${tid}`);
  await page.getByRole('button', { name: /^Everything/ }).click();
  const line = page.getByText('Approved by Dana Okafor via Hive’s terminal: “approved”');
  await expect(line.first()).toBeVisible({ timeout: 20_000 });
  await line.first().scrollIntoViewIfNeeded();
  await look(page, 'timeline');

  // Activity: his decision, via Hive's terminal.
  await page.goto('/activity');
  await expect(
    page.getByText(/approved Ship it\? on .*via Hive’s terminal: “approved”/).first(),
  ).toBeVisible({ timeout: 20_000 });

  // Revoked: off again, the agent is refused.
  await page.goto('/agents');
  await page.getByRole('switch', { name: 'May act on my word: Hive' }).click();
  await expect.poll(() => trusted(wid, uid)).toEqual([]);
  await expect(hive.decide(planId, 'close', 'close it', 'Dana Okafor')).rejects.toThrow();
});
