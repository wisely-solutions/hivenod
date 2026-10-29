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

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

const agentDoc = (name: string, revoked: boolean) => ({
  name,
  color: 'agent-3',
  projectIds: '*',
  createdBy: 'seed',
  createdAt: ago(10 * HOUR),
  revokedAt: revoked ? ago(HOUR) : null,
  lastSeenAt: null,
  tokenHint: 'a7f3',
  previousAgentUid: null,
  lastEventId: 'seed',
});

async function enter(page: Page, name: string) {
  const owner = person(name);
  await page.goto('/');
  await signIn(page, owner);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(owner.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const wid = await workspaceOf(owner.email);
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', 'seed'));
  await adminSet(`workspaces/${wid}/agents/live`, agentDoc('Live Bot', false));
  await adminSet(`workspaces/${wid}/agents/old`, agentDoc('Old Bot', true));
  await adminSet(`workspaces/${wid}/agents/gone`, agentDoc('Gone Bot', true));
  // Past work by the agent that is about to be removed: the event stores the name.
  await adminSet(`workspaces/${wid}/events/past1`, {
    actor: { type: 'agent', id: 'old', name: 'Old Bot' },
    projectId: 'blog',
    itemId: null,
    runId: null,
    type: 'run.started',
    data: {},
    at: ago(2 * HOUR),
  });
  return wid;
}

for (const theme of ['light', 'dark'] as const) {
  test(`remove a revoked agent from the list and from its page in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await enter(page, `Rita Remove ${theme}`);
    await page.goto('/agents');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const live = page.getByRole('listitem', { name: 'Live Bot' });
    const old = page.getByRole('listitem', { name: 'Old Bot' });
    await expect(old).toBeVisible();

    // A live agent can only be revoked or rotated, never removed.
    await live.getByRole('button', { name: 'Actions for Live Bot' }).click();
    await expect(page.getByRole('menuitem', { name: 'Remove…' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // A revoked one can be removed, after a confirm.
    await old.getByRole('button', { name: 'Actions for Old Bot' }).click();
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove Old Bot?' });
    await expect(dialog).toContainText('Remove Old Bot for good? Its past work keeps its name.');
    await settle(page);
    await axe(page);
    await expectNoHorizontalScroll(page);
    await dialog.getByRole('button', { name: 'Keep' }).click();
    await expect(old).toBeVisible();
    await old.getByRole('button', { name: 'Actions for Old Bot' }).click();
    await page.getByRole('menuitem', { name: 'Remove…' }).click();
    await page.getByRole('button', { name: 'Remove agent' }).click();
    await expect(old).toHaveCount(0);
    await expect(live).toBeVisible();
    await axe(page);

    // Past work keeps the name.
    await page.goto('/activity');
    await expect(page.getByText('Old Bot').first()).toBeVisible();
    await axe(page);

    // From the agent's page: the button leads back to the list.
    await page.goto('/agents/gone');
    await expect(page.getByRole('heading', { name: 'Gone Bot' })).toBeVisible();
    await axe(page);
    await page.getByRole('button', { name: 'Remove…' }).click();
    await expect(page.getByRole('dialog', { name: 'Remove Gone Bot?' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove agent' }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.getByRole('listitem', { name: 'Gone Bot' })).toHaveCount(0);

    // A live agent's page has no Remove.
    await page.goto('/agents/live');
    await expect(page.getByRole('heading', { name: 'Live Bot' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove…' })).toHaveCount(0);
  });
}
