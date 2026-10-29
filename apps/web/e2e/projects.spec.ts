import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  type RawDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
  settle,
} from './helpers';

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
  const uid = await uidOf(owner.email);
  return { owner, wid, uid };
}

const kinds = (doc: RawDoc) =>
  (doc.fields.steps!.arrayValue.values as Array<{ mapValue: { fields: RawDoc['fields'] } }>).map(
    (v) => v.mapValue.fields.kind!.stringValue as string,
  );

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

test('a new workspace explains Hivenod and offers the templates; "Build a system" makes 10 steps with 4 gates', async ({
  page,
}) => {
  const { wid } = await enter(page, 'Tess Template');
  await page.goto('/projects');
  await expect(
    page.getByRole('heading', { name: 'Agents do the work. You make the decisions.' }),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);

  // Five templates plus Blank, each with its process strip.
  const gallery = page.getByRole('radiogroup', { name: 'Project templates' });
  await expect(gallery.getByRole('radio')).toHaveCount(6);
  await expect(
    gallery
      .getByRole('radio', { name: /Build a system/ })
      .getByRole('img', { name: '10 steps, gates at 3, 5, 9 and 10' }),
  ).toBeVisible();
  // Each card is wide enough for its process strip to stay legible (it was ~120px at desktop).
  const box = await gallery.getByRole('radio', { name: /Build a system/ }).boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(240);
  await axe(page);

  // Pick a template: the form opens with it chosen. A name is required.
  await gallery.getByRole('radio', { name: /Build a system/ }).click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Build a system/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(dialog.getByText('Give the project a name.')).toBeVisible();
  await settle(page);
  await axe(page);

  await dialog.getByLabel('Name').fill('Customer portal');
  await expect(dialog.getByText(/budget/i)).toHaveCount(0);
  await dialog.getByRole('radio', { name: 'Emoji 🚀' }).click();
  await dialog.getByRole('button', { name: 'Create project' }).click();

  // Creating opens the new project's board; back on the list it animates into the grid
  await expect(page).toHaveURL(/\/p\//);
  await page.goto('/projects');

  // It animates into the grid with no open items, and the hero is gone.
  const card = page.getByRole('listitem', { name: 'Customer portal' });
  await expect(card).toBeVisible();
  await expect(card.getByText('Build a system')).toBeVisible();
  await expect(card.getByRole('img', { name: '10 steps, gates at 3, 5, 9 and 10' })).toBeVisible();
  await expect(card.getByText('Open items').locator('xpath=following-sibling::dd')).toHaveText('0');
  await expect(
    card.getByText('Spend this month').locator('xpath=following-sibling::dd'),
  ).toHaveText('€0');
  await expect(card.getByText('need you')).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Agents do the work. You make the decisions.' }),
  ).toHaveCount(0);
  await expectNoHorizontalScroll(page);

  // The stored project has the 10 steps with human gates at 3, 5, 9 and 10, and a tracking event.
  const listUrl = `http://localhost:${process.env.E2E_FIRESTORE_PORT ?? 8080}/v1/projects/hive-board-43be/databases/(default)/documents/workspaces/${wid}/projects`;
  const ids = async () => {
    const res = await fetch(listUrl, { headers: { Authorization: 'Bearer owner' } });
    const j = (await res.json()) as { documents?: Array<{ name: string }> };
    return (j.documents ?? []).map((d) => d.name.split('/').pop()!);
  };
  await expect.poll(async () => (await ids()).length).toBe(1);
  const pid = (await ids())[0]!;
  const doc = (await adminDoc(`workspaces/${wid}/projects/${pid}`))!;
  const k = kinds(doc);
  expect(k).toHaveLength(10);
  expect(k.flatMap((x, i) => (x === 'human' ? [i + 1] : []))).toEqual([3, 5, 9, 10]);
  expect(doc.fields.templateId!.stringValue).toBe('build-a-system');
  expect(doc.fields.emoji!.stringValue).toBe('🚀');
  expect(doc.fields).not.toHaveProperty('budgetEur');
  const eventId = doc.fields.lastEventId!.stringValue;
  const event = (await adminDoc(`workspaces/${wid}/events/${eventId}`))!;
  expect(event.fields.type!.stringValue).toBe('project.created');

  // The activity column shows it.
  await expect(page.getByText(/created a project/).first()).toBeVisible();
  await axe(page);
});

test('cards show what needs you, open items, live agents, spend and the latest activity', async ({
  page,
}) => {
  const { wid, uid } = await enter(page, 'Cora Cards');
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`workspaces/${wid}/projects/ops`, projectFields('Ops', uid));
  const item = (title: string, stepId: string, status: string) => ({
    title,
    type: 'idea',
    stepId,
    status,
    summary: '',
    source: { kind: 'manual', label: 'test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: stepId === 'review' ? { stepId, approvals: {}, rejections: {} } : null,
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });
  await adminSet(`workspaces/${wid}/projects/blog/items/i1`, item('Post A', 'review', 'waiting'));
  await adminSet(`workspaces/${wid}/projects/blog/items/i2`, item('Post B', 'review', 'waiting'));
  await adminSet(`workspaces/${wid}/projects/blog/items/i3`, item('Post C', 'draft', 'queued'));
  const run = (cost: number, agentUid: string) => ({
    agentUid,
    projectId: 'blog',
    itemId: 'i3',
    stepId: 'draft',
    startedAt: new Date(),
    heartbeatAt: new Date(),
    heartbeatEventAt: new Date(),
    endedAt: null,
    status: 'running',
    costEur: cost,
    tokensIn: 0,
    tokensOut: 0,
    model: null,
    summary: null,
    lastEventId: 'seed',
  });
  await adminSet(`workspaces/${wid}/runs/r1`, run(1.25, 'agentA'));
  await adminSet(`workspaces/${wid}/runs/r2`, run(0.5, 'agentB'));
  await adminSet(`workspaces/${wid}/events/ev1`, {
    actor: { type: 'agent', id: 'agentA', name: 'Scout' },
    projectId: 'blog',
    itemId: 'i3',
    runId: 'r1',
    type: 'item.completed',
    data: {},
    at: new Date(),
  });

  await page.goto('/projects');
  const blog = page.getByRole('listitem', { name: 'Blog' });
  await expect(blog).toBeVisible();
  await expect(blog.getByText('2 need you')).toBeVisible();
  const dd = (label: string) => blog.getByText(label).locator('xpath=following-sibling::dd');
  await expect(dd('Open items')).toHaveText('3');
  await expect(dd('Agents active')).toContainText('2');
  await expect(dd('Spend this month')).toHaveText('€1.75');
  await expect(blog.getByText(/Scout finished their step on “Post C”/)).toBeVisible();

  // Projects that need you come first.
  const names = await page
    .getByRole('list', { name: 'Projects' })
    .getByRole('heading')
    .allTextContents();
  expect(names).toEqual(['Blog', 'Ops']);
  const ops = page.getByRole('listitem', { name: 'Ops' });
  await expect(ops.getByText('need you')).toHaveCount(0);

  // Recent activity lists the latest events across projects.
  const activity = page.getByRole('region', { name: 'Recent activity' });
  await expect(activity.getByText(/Scout finished their step/)).toBeVisible();
  await expectNoHorizontalScroll(page);
  await axe(page);

  // Opening a card goes to the project.
  await blog.getByRole('link').click();
  await expect(page).toHaveURL(/\/p\/blog$/);
});

test('archive hides the project at once; Undo brings it back; otherwise it is written when the toast ends', async ({
  page,
}) => {
  const { wid, uid } = await enter(page, 'Archie Owner');
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', uid));
  await adminSet(`workspaces/${wid}/projects/ops`, projectFields('Ops', uid));
  await page.goto('/projects');
  const blog = page.getByRole('listitem', { name: 'Blog' });
  await expect(blog).toBeVisible();

  // Undo.
  await page.getByRole('button', { name: 'Archive Blog' }).click();
  await expect(blog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Blog archived.');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(blog).toBeVisible();
  expect((await adminDoc(`workspaces/${wid}/projects/blog`))!.fields.archivedAt).toEqual({
    nullValue: null,
  });

  // Let it end.
  await page.getByRole('button', { name: 'Archive Blog' }).click();
  await expect(blog).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 10_000 });
  await expect
    .poll(async () => (await adminDoc(`workspaces/${wid}/projects/blog`))!.fields.archivedAt)
    .toHaveProperty('timestampValue');
  await page.reload();
  await expect(page.getByRole('listitem', { name: 'Ops' })).toBeVisible();
  await expect(page.getByRole('listitem', { name: 'Blog' })).toHaveCount(0);

  // Restore from the archived list.
  await page.getByText('Archived (1)').click();
  await page.getByRole('button', { name: 'Restore Blog' }).click();
  await expect(page.getByRole('listitem', { name: 'Blog' })).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(`workspaces/${wid}/projects/blog`))!.fields.archivedAt)
    .toEqual({ nullValue: null });
});

test('the New project form works from the header button and is accessible', async ({ page }) => {
  const { wid, uid } = await enter(page, 'Nia New');
  await adminSet(`workspaces/${wid}/projects/blog`, projectFields('Blog', uid));
  await page.goto('/projects');
  await expect(page.getByRole('listitem', { name: 'Blog' })).toBeVisible();
  await page.getByRole('button', { name: 'New project' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New project' });
  await expect(dialog).toBeVisible();
  await settle(page);
  await axe(page);
  await dialog.getByRole('radio', { name: /Blank/ }).click();
  await dialog.getByLabel('Name').fill('Scratch');
  await dialog.getByRole('button', { name: 'Create project' }).click();
  await expect(page).toHaveURL(/\/p\//);
  await page.goto('/projects');
  const card = page.getByRole('listitem', { name: 'Scratch' });
  await expect(card).toBeVisible();
  await expect(card.getByRole('img', { name: '1 step, no gates' })).toBeVisible();
  await expect(page.getByRole('listitem')).not.toHaveCount(0);
});
