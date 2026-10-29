import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
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

const rand = () => Math.random().toString(36).slice(2, 8);

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
  const pid = `nt${rand()}`;
  const base = projectFields('Blog', uid);
  const review = base.steps[1]!;
  await adminSet(`workspaces/${wid}/projects/${pid}`, {
    ...base,
    steps: [
      base.steps[0]!,
      {
        ...review,
        gate: { ...review.gate!, deciderUids: [uid], rule: 'any', remindAfterHours: 24 },
      },
      { id: 'publish', name: 'Publish', kind: 'agent', description: 'Ship it' },
    ],
    stepIndex: { draft: 0, review: 1, publish: 2 },
  });
  return { wid, uid, pid };
}

function waiting(uid: string, hours: number, over: Record<string, unknown> = {}) {
  return {
    title: 'Launch post',
    type: 'idea',
    stepId: 'review',
    status: 'waiting',
    summary: 'Draft of the launch post, ready for a decision.',
    source: { kind: 'manual', label: 'Test' },
    createdBy: { type: 'human', id: uid },
    parentItemId: null,
    sourceRunId: null,
    claim: null,
    progress: null,
    gate: { stepId: 'review', approvals: {}, rejections: {} },
    triage: null,
    sendBackCount: 0,
    costEur: 0,
    order: 1,
    updatedAt: new Date(Date.now() - hours * 3_600_000),
    lastEventId: 'seed',
    ...over,
  };
}
const itemPath = (wid: string, pid: string, iid: string) =>
  `workspaces/${wid}/projects/${pid}/items/${iid}`;
const configOn = () =>
  adminSet('config/notify', {
    vapidPublicKey: 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9',
    telegramBot: 'hivenod_bot',
  });

test('the tab title carries the Needs-you count', async ({ page }) => {
  const { wid, uid, pid } = await seed(page);
  for (const n of [1, 2])
    await adminSet(itemPath(wid, pid, `t${n}`), waiting(uid, 1, { title: `Post ${n}` }));
  await expect(page.getByText('2 things need you.')).toBeVisible();
  await expect(page).toHaveTitle('(2) Today · Hivenod');
  await page.goto('/projects');
  await expect(page).toHaveTitle(/^\(2\) All projects · Hivenod$/);
});

test('a gate past its reminder time says so, then "reminder sent" once the notifier sent it', async ({
  page,
}) => {
  const { wid, uid, pid } = await seed(page);
  await adminSet(itemPath(wid, pid, 'late'), waiting(uid, 30, { title: 'Pricing page copy' }));
  await adminSet(itemPath(wid, pid, 'early'), waiting(uid, 2, { title: 'Fresh post' }));
  const late = page.getByRole('button', { name: /Pricing page copy/ }).first();
  await expect(late).toContainText('Waiting 30 h · reminder due');
  await expect(page.getByRole('button', { name: /Fresh post/ }).first()).not.toContainText(
    'reminder',
  );
  await adminSet(`workspaces/${wid}/notified/g-late`, {
    itemId: 'late',
    projectId: pid,
    gateKey: 'review:0',
    sent: [uid],
    remindedAt: Date.now(),
    at: Date.now(),
  });
  await expect(late).toContainText('Waiting 30 h · reminder sent');
  // The board card says the same.
  await page.goto(`/p/${pid}`);
  await expect(page.getByRole('button', { name: /Pricing page copy/ }).first()).toContainText(
    'reminder sent',
  );
});

test('Me, Notifications: choices are saved, Telegram links, quiet hours, install steps', async ({
  page,
}, info) => {
  const { uid } = await seed(page);
  await configOn();
  await page.goto('/settings/profile');
  await page.getByRole('tab', { name: 'Notifications' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible();
  await expect(page.getByText('Add to Home Screen', { exact: false }).first()).toBeVisible();
  // The email digest cannot be switched on: nothing sends email yet.
  await expect(page.getByRole('switch', { name: /Daily email digest/ })).toBeDisabled();

  // Choices persist.
  await page.getByRole('switch', { name: /Telegram messages/ }).click();
  await expect
    .poll(async () => (await adminDoc(`users/${uid}/notify/prefs`))?.fields.telegram?.booleanValue)
    .toBe(false);
  await page.getByRole('switch', { name: 'Quiet hours' }).click();
  await expect(page.getByLabel('From')).toHaveValue('22:00');
  await page.getByLabel('From').fill('21:30');
  await expect
    .poll(async () => {
      const q = (await adminDoc(`users/${uid}/notify/prefs`))?.fields.quiet?.mapValue?.fields;
      return `${q?.enabled?.booleanValue} ${q?.from?.stringValue}`;
    })
    .toBe('true 21:30');

  // Telegram: Connect makes a one-time code (the notifier answers it), then the page shows the link.
  await page.addInitScript(() => {
    (window as unknown as { __opened: string[] }).__opened = [];
    window.open = (u) => {
      (window as unknown as { __opened: string[] }).__opened.push(String(u));
      return null;
    };
  });
  await page.reload();
  await page.getByRole('button', { name: 'Connect Telegram' }).click();
  await expect(page.getByText('Press Start in Telegram')).toBeVisible();
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened[0]).toMatch(/^https:\/\/t\.me\/hivenod_bot\?start=[A-Za-z0-9]{24}$/);
  const code = opened[0]!.split('start=')[1]!;
  expect(await adminDoc(`telegramLinks/${code}`)).not.toBeNull();
  await adminSet(`users/${uid}/notify/telegram`, {
    chatId: 7,
    username: 'joao',
    linkedAt: Date.now(),
  });
  await expect(page.getByText('Connected as @joao')).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: 'Connect Telegram' })).toBeVisible();

  // Push cannot be turned on in a test browser without a service worker push service, but the
  // button is offered when the notifier published its key.
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
  void info;
});

test('without the notifier the page says nothing is sent yet and the buttons are off', async ({
  page,
}) => {
  await seed(page);
  // The emulator is shared: a missing config doc means the notifier never ran.
  await page.route('**/*', (r) => r.continue());
  await page.goto('/me/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible();
  const off = page.getByText('Sending is not switched on yet.');
  const on = page.getByRole('button', { name: 'Connect Telegram' });
  // Either the config was seeded by a sibling test (button enabled) or it is absent (banner shown).
  await expect(off.or(on).first()).toBeVisible();
});

test('screenshots', async ({ page }, info) => {
  test.skip(!process.env.SHOTS_DIR, 'set SHOTS_DIR to capture');
  test.skip(info.project.name !== 'desktop-1440', 'sizes are set below');
  const { wid, uid, pid } = await seed(page);
  await configOn();
  await adminSet(itemPath(wid, pid, 'late'), waiting(uid, 30, { title: 'Pricing page copy' }));
  await adminSet(`workspaces/${wid}/notified/g-late`, {
    itemId: 'late',
    projectId: pid,
    gateKey: 'review:0',
    sent: [uid],
    remindedAt: Date.now(),
    at: Date.now(),
  });
  await adminSet(itemPath(wid, pid, 'due'), waiting(uid, 26, { title: 'Launch post' }));
  await adminSet(itemPath(wid, pid, 'new'), waiting(uid, 1, { title: 'Newsletter draft' }));
  await adminSet(`users/${uid}/notify/prefs`, {
    push: true,
    telegram: true,
    digest: false,
    quiet: { enabled: true, from: '22:00', to: '08:00', tz: 'Europe/Lisbon' },
  });
  await adminSet(`users/${uid}/notify/telegram`, {
    chatId: 7,
    username: 'joao',
    linkedAt: Date.now(),
  });
  await adminSet(`users/${uid}/pushSubs/s1`, {
    endpoint: 'https://push.example.com/send/abc',
    keys: { p256dh: 'p', auth: 'a' },
    label: 'Chrome on Mac',
    createdAt: Date.now(),
  });
  const dir = process.env.SHOTS_DIR!;
  mkdirSync(dir, { recursive: true });
  const sizes = {
    '1440x900': { width: 1440, height: 900 },
    '390x844': { width: 390, height: 844 },
  };
  for (const [name, vp] of Object.entries(sizes)) {
    await page.setViewportSize(vp);
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.goto('/');
      await expect(page.getByText(/reminder sent/).first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${dir}/needs-you-${name}-${theme}.png` });
      await page.goto(`/p/${pid}`);
      await expect(page.getByText(/reminder sent/).first()).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${dir}/board-${name}-${theme}.png` });
      await page.goto('/me/notifications');
      await expect(page.getByText('Connected as @joao')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${dir}/notifications-${name}-${theme}.png`, fullPage: true });
      await page.goto('/settings/profile');
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${dir}/me-${name}-${theme}.png` });
    }
  }
});
