/**
 * Inbox labels (item YaOErIjeIFG8Y3EvZuIp): the agent suggests a label on a new subject (dashed
 * "Sales?" chip); the person confirms (OK) or changes it; the Inbox list and Today filter by label;
 * an admin edits the list in Settings and the agent files with the new list.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addInboxMessage,
  askMember,
  assignSubject,
  digest24,
  inboxLabelsSchema,
  inboxMessageKey,
  inboxPaths,
  inboxThreadKey,
  type ActionContext,
  type ActionPlan,
  type ThreadStateOf,
} from '@hive/shared';
import { applyPlan } from '@hive/shared/firestore';
import { createAgentIdentity, signInWithToken } from '@hive/shared/agent-auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import { connectFirestoreEmulator, doc, getDoc, getFirestore } from 'firebase/firestore';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import {
  adminDoc,
  adminSet,
  AUTH_PORT,
  expectNoHorizontalScroll,
  fastTimers,
  FIRESTORE_PORT,
  person,
  settle,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const OPTIONS = { apiKey: 'fake', projectId: 'hive-board-43be' };
const h = (s: string) => digest24(createHash('sha256').update(s, 'utf8').digest('hex'));

/** A new agent of `wid` that works the inbox with the shared actions, as the agent tools do. */
async function agentOf(wid: string, ownerUid: string, name: string) {
  const { uid: aid, token } = await createAgentIdentity(OPTIONS, wid, {
    authEmulatorUrl: `http://localhost:${AUTH_PORT}`,
  });
  await adminSet(`workspaces/${wid}/agents/${aid}`, {
    name,
    color: '#2F5FD0',
    projectIds: '*',
    createdBy: ownerUid,
    createdAt: new Date(),
    revokedAt: null,
    lastSeenAt: null,
    tokenHint: token.slice(-4),
    previousAgentUid: null,
    lastEventId: 'seed',
  });
  const app = initializeApp(OPTIONS, `agent-${Math.random().toString(36).slice(2)}`);
  const auth = initializeAuth(app, { persistence: inMemoryPersistence });
  connectAuthEmulator(auth, `http://localhost:${AUTH_PORT}`, { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, 'localhost', FIRESTORE_PORT);
  await signInWithToken(auth, token);
  const ctx: ActionContext = { workspaceId: wid, actor: { type: 'agent', id: aid, name } };
  const run = (p: Pick<ActionPlan, 'ops'>) => applyPlan(db, p);
  const thread = async (tid: string) =>
    (await getDoc(doc(db, inboxPaths.thread(wid, tid)))).data() as ThreadStateOf;
  /** The workspace's label list, as the agent reads it (the defaults when there is none). */
  const labels = async () => {
    const d = await getDoc(doc(db, inboxPaths.labels(wid)));
    return d.exists() ? inboxLabelsSchema.parse(d.data()).labels : undefined;
  };
  return {
    async add(member: string, m: { from: string; text: string; ref: string; id: string }) {
      const ref = h(inboxThreadKey(member, 'mail', m.ref));
      const p = addInboxMessage(ctx, {
        messageDocId: `im${h(inboxMessageKey(member, 'mail', m.ref, m.id))}`,
        ref,
        memberUid: member,
        source: 'mail',
        sender: { name: m.from, handle: `${m.from.split(' ')[0]!.toLowerCase()}@example.com` },
        text: m.text,
        threadRef: m.ref,
        messageId: m.id,
        permalink: `https://mail.example.com/${m.ref}/${m.id}`,
        receivedAt: new Date(),
        thread: null,
      });
      await run(p);
      return p.threadId;
    },
    async file(tid: string, to: { newName: string; label?: string }) {
      const p = assignSubject(ctx, {
        threadId: tid,
        thread: await thread(tid),
        ...to,
        ...(to.label ? { labels: await labels() } : {}),
      });
      await run(p);
      return p.subjectId;
    },
    async ask(tid: string, question: string) {
      await run(askMember(ctx, { threadId: tid, thread: await thread(tid), question }));
    },
    stop: () => deleteApp(app),
  };
}

async function axe(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
  ).toEqual([]);
}

/** Light and dark: axe-clean, no sideways scroll, and a screenshot of each when SHOTS_DIR is set. */
async function look(page: Page, name: string, project: string) {
  const shots = process.env.SHOTS_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await expectNoHorizontalScroll(page);
    await axe(page);
    if (shots)
      await page.screenshot({
        path: `${shots}/labels-${name}-${project}-${scheme}.png`,
        fullPage: true,
      });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const chipOf = (page: Page, label: string) => page.locator(`[data-label-chip="${label}"]`);

test('Inbox labels: suggested by the agent, confirmed or changed, filtered, edited by an admin', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await fastTimers(page);
  const me = person('Lena Labels');
  await page.goto('/');
  await signIn(page, me);
  await expect(
    page.getByRole('heading', { name: /^Good (morning|afternoon|evening), / }),
  ).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const agent = await agentOf(wid, uid, 'Labels agent');
  try {
    const t1 = await agent.add(uid, {
      from: 'Sam Example',
      text: 'Quote for 40 seats?',
      ref: 'c1',
      id: 'm1',
    });
    const t2 = await agent.add(uid, {
      from: 'Ida Example',
      text: 'I cannot log in',
      ref: 'c2',
      id: 'm2',
    });
    const t3 = await agent.add(uid, {
      from: 'Max Example',
      text: 'Lunch on Friday?',
      ref: 'c3',
      id: 'm3',
    });
    // Not on the list: refused with the allowed values.
    await expect(agent.file(t1, { newName: 'Seat quote', label: 'Marketing' })).rejects.toThrow(
      /Sales, Support/,
    );
    const s1 = await agent.file(t1, { newName: 'Seat quote', label: 'sales' });
    const s2 = await agent.file(t2, { newName: 'Login problem', label: 'Support' });
    const s3 = await agent.file(t3, { newName: 'Team lunch' });
    await agent.ask(t1, 'Offer the 10% discount?');
    await agent.ask(t2, 'Reset the password?');

    // The list: a dashed "Sales?" chip until the person says OK.
    await page.goto('/inbox');
    const card1 = page.locator(`[data-subject="${s1}"]`);
    const card2 = page.locator(`[data-subject="${s2}"]`);
    const card3 = page.locator(`[data-subject="${s3}"]`);
    await expect(card1.locator('[data-label-chip="Sales"][data-suggested]')).toBeVisible();
    await expect(card1.locator('[data-label-chip="Sales"]')).toContainText('Sales?');
    await expect(card3.locator('[data-label-chip]')).toHaveCount(0);
    await look(page, 'list', info.project.name);

    // OK confirms it; it stays after a reload.
    await card1.getByRole('button', { name: 'Confirm label Sales' }).click();
    await expect(card1.locator('[data-label-chip="Sales"]')).not.toHaveAttribute(
      'data-suggested',
      /.*/,
    );
    await expect(card1.getByRole('button', { name: 'Confirm label Sales' })).toHaveCount(0);
    await page.reload();
    await expect(card1.locator('[data-label-chip="Sales"]')).toBeVisible();
    await expect(card1.locator('[data-label-chip="Sales"][data-suggested]')).toHaveCount(0);
    await expect(card2.locator('[data-label-chip="Support"][data-suggested]')).toBeVisible();

    // Change picks another one from the list; it persists.
    await card2.getByRole('button', { name: 'Change label, now Support' }).click();
    await page.getByRole('menuitem', { name: 'Billing' }).click();
    await expect(card2.locator('[data-label-chip="Billing"]')).toBeVisible();
    await expect(card2.locator('[data-label-chip="Billing"][data-suggested]')).toHaveCount(0);
    await page.reload();
    await expect(card2.locator('[data-label-chip="Billing"]')).toBeVisible();

    // Filter by label (with counts), combined with the other filters (behind Filters, item kt3E7).
    await page.getByRole('button', { name: /^Filters/ }).click();
    const filters = page.getByRole('group', { name: 'Label' });
    await expect(filters.getByRole('button', { name: 'Billing · 1' })).toBeVisible();
    await filters.getByRole('button', { name: 'Billing · 1' }).click();
    await expect(card2).toBeVisible();
    await expect(card1).toHaveCount(0);
    await expect(card3).toHaveCount(0);
    await filters.getByRole('button', { name: 'Sales · 1' }).click();
    await expect(card1).toBeVisible();
    await expect(card2).toBeVisible();
    await page.getByRole('button', { name: 'Has open threads' }).click();
    await expect(card1).toBeVisible();
    await page.getByRole('button', { name: 'Has open threads' }).click();
    await filters.getByRole('button', { name: 'Billing · 1' }).click();
    await filters.getByRole('button', { name: 'Sales · 1' }).click();
    await page.keyboard.press('Escape');
    await expect(card3).toBeVisible();

    // Today: the threads that wait carry the chip, and the label filter narrows them.
    await page.goto('/');
    await expect(page.getByText('Offer the 10% discount?')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-label-chip="Sales"]')).toBeVisible();
    await expect(page.locator('[data-label-chip="Billing"]')).toBeVisible();
    // The filters fold into a button on Today (item kt3E7).
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByLabel('Filter by label').selectOption({ label: 'Billing (1)' });
    await page.keyboard.press('Escape');
    await expect(page.getByText('Offer the 10% discount?')).toHaveCount(0);
    await expect(page.getByText('Reset the password?')).toBeVisible();
    await look(page, 'today', info.project.name);
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByLabel('Filter by label').selectOption({ label: 'All labels' });
    await page.keyboard.press('Escape');
    await expect(page.getByText('Offer the 10% discount?')).toBeVisible();

    // The subject page: add a label to a subject that has none.
    await page.goto(`/inbox/${wid}/s/${s3}`);
    await page.getByRole('button', { name: 'Add label' }).click();
    await page.getByRole('menuitem', { name: 'Internal' }).click();
    await expect(chipOf(page, 'Internal')).toBeVisible();
    // The subject's timeline folds into a disclosure (item kt3E7).
    await page.getByRole('button', { name: /^Timeline/ }).click();
    await expect(page.getByText('You set the label to “Internal”')).toBeVisible();
    await look(page, 'subject', info.project.name);

    // Settings > Inbox labels: an admin adds one; the agent files with the new list.
    await page.goto('/settings/labels');
    await expect(page.getByRole('heading', { name: 'Inbox labels' })).toBeVisible();
    await expect(page.getByLabel('Label 1')).toHaveValue('Sales');
    await page.getByLabel('New label').fill('Legal');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Save labels' }).click();
    await expect
      .poll(async () => JSON.stringify((await adminDoc(inboxPaths.labels(wid)))?.fields ?? {}))
      .toContain('Legal');
    await look(page, 'settings', info.project.name);
    const t4 = await agent.add(uid, {
      from: 'Eve Example',
      text: 'NDA for review',
      ref: 'c4',
      id: 'm4',
    });
    const s4 = await agent.file(t4, { newName: 'NDA review', label: 'legal' });
    await page.goto(`/inbox/${wid}/s/${s4}`);
    await expect(chipOf(page, 'Legal')).toHaveAttribute('data-suggested', '');
  } finally {
    await agent.stop();
  }
});
