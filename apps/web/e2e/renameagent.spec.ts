import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  settle,
  signIn,
  workspaceOf,
} from './helpers';

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

const agentDoc = () => ({
  name: 'Claude Code (desktop)',
  color: 'agent-3',
  projectIds: '*',
  createdBy: 'seed',
  createdAt: new Date(Date.now() - 36e5),
  revokedAt: null,
  lastSeenAt: new Date(),
  tokenHint: 'a7f3',
  previousAgentUid: null,
  lastEventId: 'seed',
});

async function enter(page: Page, name: string) {
  const owner = person(name);
  await page.goto('/');
  await signIn(page, owner);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', 'seed'));
  await adminSet(`workspaces/${wid}/agents/live`, agentDoc());
  await adminSet(`workspaces/${wid}/agents/other`, { ...agentDoc(), tokenHint: 'b8c4' });
  await adminSet(`workspaces/${wid}/projects/blog/items/card1`, {
    title: 'Write the intro',
    type: 'idea',
    stepId: 'draft',
    status: 'working',
    summary: 'A seeded summary.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: 'seed' },
    parentItemId: null,
    sourceRunId: null,
    claim: { runId: 'r1', agentUid: 'live', heartbeatAt: new Date() },
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });
  await adminSet(`workspaces/${wid}/runs/r1`, {
    projectId: 'blog',
    itemId: 'card1',
    agentUid: 'live',
    status: 'running',
    startedAt: new Date(),
    heartbeatAt: new Date(),
    endedAt: null,
    summary: null,
    costEur: 0,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    lastEventId: 'seed',
  });
  return wid;
}

// Runs in both Playwright projects, so 1440 and 390 wide.
for (const theme of ['light', 'dark'] as const) {
  test(`rename an agent from the menu and from its page in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await enter(page, `Rena Rename ${theme}`);
    await page.goto('/agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const row = page.getByRole('listitem', { name: 'Claude Code (desktop)' }).first();
    await expect(row).toBeVisible();

    // From the menu.
    await row.getByRole('button', { name: 'Actions for Claude Code (desktop)' }).click();
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename Claude Code (desktop)' });
    await expect(dialog).toBeVisible();
    await settle(page);
    await axe(page);
    await expectNoHorizontalScroll(page);
    await dialog.getByLabel('Name').fill('');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(dialog.getByText('Give the agent a name')).toBeVisible();
    await dialog.getByLabel('Name').fill('IKEA agent');
    await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByRole('listitem', { name: 'IKEA agent' })).toBeVisible();

    // Presence on the list uses the new name.
    await expect(page.getByRole('listitem', { name: 'IKEA agent' })).toContainText(
      /Online|Idle|Waiting/i,
    );

    // The board card shows the new name.
    await page.goto('/p/blog');
    await expect(page.getByText('IKEA agent').first()).toBeVisible();
    await expect(page.getByText('Claude Code (desktop)')).toHaveCount(0);

    // From the agent's page.
    await page.goto('/agents/other');
    await expect(page.getByTestId('agent-name')).toHaveText('Claude Code (desktop)');
    await page.getByRole('button', { name: 'Rename Claude Code (desktop)' }).click();
    await page
      .getByRole('dialog', { name: 'Rename Claude Code (desktop)' })
      .getByLabel('Name')
      .fill('Pairpoint agent');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect(page.getByTestId('agent-name')).toHaveText('Pairpoint agent');
    await axe(page);
    await expectNoHorizontalScroll(page);

    // The activity says who renamed what.
    await page.goto('/activity');
    await expect(page.getByText('renamed Claude Code (desktop) to Pairpoint agent')).toBeVisible();
    await axe(page);
  });
}
