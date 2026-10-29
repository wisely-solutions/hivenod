import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

// Card mpWuccjl: edit an item after adding it. Title, type and description are edited in place by
// who made the item (or an admin), files can be added later, and every edit shows in the history.

const rand = () => Math.random().toString(36).slice(2, 8);
const SHOTS = process.env.SHOT_DIR ?? '/tmp';

test('edit the title, type and description, add a file, see it in the history', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const owner = person('Edit Edna');
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
  const pid = `edit${rand()}`;
  const base = projectFields('Portal', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [base.steps[0]!, base.steps[1]!],
    stepIndex: { draft: 0, review: 1 },
  });
  const iid = `it${rand()}`;
  const itemPath = `workspaces/${wid}/projects/${pid}/items/${iid}`;
  await adminSet(itemPath, {
    title: 'Invoice PDF shows the wrong VAT numbr',
    type: 'idea',
    stepId: 'draft',
    status: 'queued',
    summary: '',
    source: { kind: 'manual', label: 'Edit Edna' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    attachmentCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });

  await page.goto(`/p/${pid}?item=${iid}`);
  const item = page.getByRole('article');
  await expect(item.getByRole('heading', { level: 2 })).toHaveText(/wrong VAT numbr/);
  await expect(item.getByText('No description yet')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/edit-before-${test.info().project.name}.png` });

  // Title.
  await item.getByRole('button', { name: 'Edit title' }).click();
  await item.getByLabel('Title').fill('Invoice PDF shows the wrong VAT number for EU clients');
  await item.getByLabel('Title').press('Enter');
  await expect(item.getByRole('heading', { level: 2 })).toHaveText(/for EU clients/);

  // Type.
  await item.getByLabel('Type').selectOption('bug');
  await expect.poll(async () => (await adminDoc(itemPath))?.fields.type?.stringValue).toBe('bug');

  // Description, in Markdown.
  await item.getByRole('button', { name: 'Add a description' }).click();
  await item
    .getByLabel('Description')
    .fill('Seen on 3 invoices for **Arco (DE)**.\n\n- the VAT id comes from the PT entity');
  await expect(item.getByText('Markdown supported. Agents read this as the brief.')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/edit-editing-${test.info().project.name}.png` });
  await item.getByRole('button', { name: 'Save description' }).click();
  await expect(item.locator('strong', { hasText: 'Arco (DE)' })).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(itemPath))?.fields.summary?.stringValue)
    .toContain('**Arco (DE)**');

  // A file, picked.
  await item.getByLabel('Add files').setInputFiles({
    name: 'invoice-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('VAT id on the PDF: PT123456789'),
  });
  await expect(item.getByRole('tab', { name: 'invoice-notes.txt' })).toBeVisible();
  await expect(item.getByText('PT123456789')).toBeVisible();
  // ...and a pasted screenshot.
  await item.getByTestId('attach-zone').evaluate((el) => {
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      ),
      (c) => c.charCodeAt(0),
    );
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'screenshot.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(item.getByRole('tab', { name: 'screenshot.png' })).toBeVisible();
  await expect
    .poll(async () => (await adminDoc(itemPath))?.fields.attachmentCount?.integerValue)
    .toBe('2');
  await expectNoHorizontalScroll(page);

  // History.
  await item.getByRole('tab', { name: 'History' }).click();
  await expect(item.getByText(/renamed .*numbr.* to .*for EU clients/)).toBeVisible();
  await expect(item.getByText(/changed the type of .* to bug/)).toBeVisible();
  await expect(item.getByText(/changed the description of/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/edit-history-${test.info().project.name}.png` });
  mkdirSync(SHOTS, { recursive: true });
  for (const theme of ['light', 'dark'] as const) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: theme });
    await page.getByRole('tab', { name: 'Details' }).last().click();
    await page.screenshot({
      path: `${SHOTS}/edit-390x844-${theme}-${test.info().project.name}.png`,
    });
    await expectNoHorizontalScroll(page);
    if (test.info().project.name === 'desktop-1440')
      await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    await page.getByRole('tab', { name: 'Details' }).last().click();
    await page.screenshot({ path: `${SHOTS}/edit-done-${theme}-${test.info().project.name}.png` });
  }
});

test('an admin can edit an item someone else made', async ({ page }) => {
  test.setTimeout(120_000);
  const owner = person('Owner Olga');
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
  // Made by somebody else: only its creator or an admin may edit it, and Olga is the admin.
  const pid = `agt${rand()}`;
  const base = projectFields('Portal', uid);
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [base.steps[0]!, base.steps[1]!],
    stepIndex: { draft: 0, review: 1 },
  });
  const iid = `it${rand()}`;
  await adminSet(`workspaces/${wid}/projects/${pid}/items/${iid}`, {
    title: 'Made by someone else',
    type: 'idea',
    stepId: 'draft',
    status: 'queued',
    summary: '',
    source: { kind: 'manual', label: 'x' },
    createdBy: { type: 'human', id: 'somebody-else' },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: null,
    triage: null,
    sendBackCount: 0,
    attachmentCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(),
    lastEventId: 'seed',
  });
  await page.goto(`/p/${pid}?item=${iid}`);
  // An admin sees the edit controls on it.
  await expect(page.getByRole('button', { name: 'Edit title' })).toBeVisible();
});
