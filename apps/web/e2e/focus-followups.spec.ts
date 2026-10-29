/**
 * Focus view follow-ups: editing in Needs you, paste in the decision-bar note, Approve that
 * advances on the board, and one step count on the path bar and the properties column.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  adminDoc,
  adminSetAll,
  expectNoHorizontalScroll,
  person,
  projectFields,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const rand = () => Math.random().toString(36).slice(2, 8);
const ago = (m: number) => new Date(Date.now() - m * 60_000);

async function seed(page: Page) {
  const owner = person('João');
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
  const pid = `bar${rand()}`;
  const base = projectFields('Hive web', uid);
  const gate = { ...base.steps[1]!.gate!, rule: 'any' as const, deciderUids: [uid, 'ana'] };
  const steps = [
    { id: 'intake', name: 'Intake', kind: 'agent', description: 'Sort it' },
    { id: 'research', name: 'Research', kind: 'agent', description: 'Look around' },
    { id: 'go', name: 'Go/no-go', kind: 'human', description: 'Worth it?', gate },
    { id: 'build', name: 'Build', kind: 'agent', description: 'Make it' },
    { id: 'accept', name: 'Accept', kind: 'human', description: 'Is it right?', gate },
  ];
  const P = `workspaces/${wid}/projects/${pid}`;
  const item = (over: Record<string, unknown>) => ({
    title: 'Item',
    type: 'task',
    stepId: 'intake',
    status: 'queued',
    summary: '',
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
    updatedAt: ago(30),
    lastEventId: 'seed',
    ...over,
  });
  const shaped = { by: { type: 'agent', id: 'scout' }, at: ago(40), note: 'short' };
  const docs: Array<[string, Record<string, unknown>]> = [
    [
      P,
      {
        ...base,
        steps,
        stepIndex: Object.fromEntries(steps.map((s, i) => [s.id, i])),
        shapeNewItems: true,
      },
    ],
    [
      `workspaces/${wid}/agents/scout`,
      {
        name: 'Scout',
        color: 'agent-3',
        projectIds: '*',
        createdBy: uid,
        createdAt: ago(1000),
        revokedAt: null,
        lastSeenAt: ago(1),
        tokenHint: 'a7f3',
        previousAgentUid: null,
        lastEventId: 'seed',
      },
    ],
    [
      `${P}/items/go1`,
      item({
        title: 'Pricing page rewrite',
        stepId: 'go',
        status: 'waiting',
        summary: 'Is the rewrite worth doing now?',
        gate: { stepId: 'go', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: { research: 'Not needed' },
        gateSkips: {},
        pathRev: 1,
        order: 1,
      }),
    ],
    ...[2, 3].map((n): [string, Record<string, unknown>] => [
      `${P}/items/go${n}`,
      item({
        title: `Waiting item ${n}`,
        stepId: 'go',
        status: 'waiting',
        summary: 'Decide.',
        gate: { stepId: 'go', approvals: {}, rejections: {} },
        shape: shaped,
        pathSkips: {},
        gateSkips: {},
        pathRev: 1,
        order: n,
      }),
    ]),
  ];
  await adminSetAll(docs);
  return { wid, uid, pid, P };
}

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function openInNeedsYou(page: Page, title: RegExp) {
  await page.goto('/');
  await page.getByRole('button', { name: title }).first().click();
  const detail = page.getByRole('article', { name: /^Decision: / });
  await expect(detail).toBeVisible();
  return detail;
}

test('Needs you: the item detail edits the title and description and adds a file', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { P } = await seed(page);
  const detail = await openInNeedsYou(page, /Pricing page rewrite/);
  const region = detail.getByRole('region', { name: 'Item detail' });
  await expect(region).toBeVisible();
  await region.getByRole('button', { name: 'Edit title' }).click();
  await region.getByLabel('Title').fill('Pricing page rewrite v2');
  await region.getByLabel('Title').press('Enter');
  await expect
    .poll(async () => (await adminDoc(`${P}/items/go1`))?.fields.title?.stringValue)
    .toBe('Pricing page rewrite v2');
  await region
    .getByRole('button', { name: /description/i })
    .first()
    .click();
  await region.getByLabel('Description').fill('A **new** brief');
  await region.getByRole('button', { name: 'Save description' }).click();
  await expect
    .poll(async () => (await adminDoc(`${P}/items/go1`))?.fields.summary?.stringValue)
    .toContain('**new**');
  await region.getByLabel('Add files').setInputFiles({
    name: 'notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('hello'),
  });
  await expect
    .poll(async () => (await adminDoc(`${P}/items/go1`))?.fields.attachmentCount?.integerValue)
    .toBe('1');
  await expectNoHorizontalScroll(page);
});

test('Needs you: a pasted image in the note attaches, plain text still types', async ({ page }) => {
  test.setTimeout(120_000);
  const { P } = await seed(page);
  const detail = await openInNeedsYou(page, /Pricing page rewrite/);
  const note = detail.getByLabel('Your note (optional)');
  const plain = await note.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', 'hello');
    return el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  });
  expect(plain).toBe(true); // not prevented: the browser types it
  await note.evaluate((el, b64) => {
    const png = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, PNG);
  await expect
    .poll(async () => (await adminDoc(`${P}/items/go1`))?.fields.attachmentCount?.integerValue)
    .toBe('1');
});

test('board: Approve opens the next waiting item, Undo stays, the last one closes the view', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=go1`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view).toBeVisible();
  // Undo keeps us here.
  await view.getByRole('button', { name: /^Approve/ }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/item=go1/);
  await view.getByRole('button', { name: /^Approve/ }).click();
  await expect(page).toHaveURL(/item=go2/, { timeout: 15_000 });
  await view.getByRole('button', { name: /^Approve/ }).click();
  await expect(page).toHaveURL(/item=go3/, { timeout: 15_000 });
  await view.getByRole('button', { name: /^Approve/ }).click();
  await expect(view).toBeHidden({ timeout: 15_000 });
});

test('the path bar and the properties show the same step count when a step is skipped', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { pid } = await seed(page);
  await page.goto(`/p/${pid}?item=go1`);
  const view = page.getByRole('region', { name: 'Item detail' });
  await expect(view.getByText('Step 2 of 4').first()).toBeVisible();
  await expect(view.getByText('Go/no-go · 2 of 4')).toBeVisible();
  const detail = await openInNeedsYou(page, /Pricing page rewrite/);
  await expect(detail.getByText('Step 2 of 4').first()).toBeVisible();
  await expect(detail.getByText('Go/no-go · 2 of 4')).toBeVisible();
});
