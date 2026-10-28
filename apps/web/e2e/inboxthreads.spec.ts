/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo, part 3): an agent brings messages in (seeded through the
 * shared actions, as the agent tools do), the member answers, edits and approves (with Undo),
 * the agent carries it out, and the member reorganizes subjects. Another member never sees it.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  addInboxMessage,
  addThreadNote,
  askMember,
  assignSubject,
  digest24,
  finishOutcome,
  flagThread,
  inboxMessageKey,
  inboxPaths,
  inboxThreadKey,
  proposeOutcome,
  proposeRelation,
  relationId,
  type ActionContext,
  type RelationStateOf,
  type ActionPlan,
  type OutcomeStateOf,
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
  newPerson,
  person,
  projectFields,
  settle,
  signIn,
  uidOf,
  UNDO_WAIT,
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
  const outcome = async (oid: string) =>
    (await getDoc(doc(db, inboxPaths.outcome(wid, oid)))).data() as OutcomeStateOf;
  return {
    aid,
    async add(
      member: string,
      m: {
        source: string;
        from: string;
        text: string;
        ref: string;
        id: string;
        at?: Date;
      },
    ) {
      const ref = h(inboxThreadKey(member, m.source, m.ref));
      const own = await getDoc(doc(db, inboxPaths.thread(wid, `it${ref}`)));
      const p = addInboxMessage(ctx, {
        messageDocId: `im${h(inboxMessageKey(member, m.source, m.ref, m.id))}`,
        ref,
        memberUid: member,
        source: m.source,
        sender: { name: m.from, handle: `${m.from.split(' ')[0]!.toLowerCase()}@example.com` },
        text: m.text,
        threadRef: m.ref,
        messageId: m.id,
        permalink: `https://${m.source}.example.com/${m.ref}/${m.id}`,
        receivedAt: m.at ?? new Date(),
        thread: own.exists() ? { threadId: own.id, state: own.data() as ThreadStateOf } : null,
      });
      await run(p);
      return p.threadId;
    },
    async file(tid: string, to: { newName?: string; subjectId?: string; area?: string }) {
      const p = assignSubject(ctx, { threadId: tid, thread: await thread(tid), ...to });
      await run(p);
      return p.subjectId;
    },
    async note(tid: string, text: string) {
      await run(addThreadNote(ctx, { threadId: tid, thread: await thread(tid), text }));
    },
    async ask(tid: string, question: string) {
      await run(askMember(ctx, { threadId: tid, thread: await thread(tid), question }));
    },
    async propose(tid: string, type: string, fields: Record<string, unknown>, note = '') {
      const p = proposeOutcome(ctx, {
        threadId: tid,
        thread: await thread(tid),
        type,
        fields,
        note,
      });
      await run(p);
      return p.outcomeId;
    },
    async done(oid: string, permalink: string) {
      const o = await outcome(oid);
      await run(
        finishOutcome(ctx, {
          outcomeId: oid,
          outcome: o,
          thread: await thread(o.threadId),
          status: 'done',
          result: { text: String(o.fields.text ?? ''), permalink },
        }),
      );
    },
    async relate(a: string, b: string, note: string) {
      const rid = relationId(a, b);
      const ex = await getDoc(doc(db, inboxPaths.relation(wid, rid)));
      const subj = { memberUid: ownerUid };
      await run(
        proposeRelation(ctx, {
          a,
          b,
          subjectA: subj,
          subjectB: subj,
          existing: ex.exists() ? (ex.data() as RelationStateOf) : null,
          note,
        }),
      );
    },
    async flag(tid: string, urgent: boolean) {
      await run(flagThread(ctx, { threadId: tid, thread: await thread(tid), urgent }));
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
        path: `${shots}/inbox-${name}-${project}-${scheme}.png`,
        fullPage: true,
      });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const chip = (page: Page, state: string) => page.locator(`[data-state="${state}"]`).first();

test('Inbox: investigate, answer, edit and send with Undo, done; reorganize; private', async ({
  page,
}, info) => {
  test.setTimeout(240_000);
  await fastTimers(page);
  const me = person('Cara Inbox');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const pid = `p${Date.now().toString(36)}`;
  await adminSet(`workspaces/${wid}/projects/${pid}`, projectFields('Payments work', uid));

  const agent = await agentOf(wid, uid, 'Payments agent');
  try {
    // Intake: a new thread, not filed yet, investigating.
    const t1 = await agent.add(uid, {
      source: 'teams',
      from: 'Sam Example',
      text: 'Can we move the payments review to Thursday?\nThe team is out on Wednesday.',
      ref: 'conv-1',
      id: 'm1',
    });
    await page.goto('/inbox');
    await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
    const unfiled = page.locator('[data-subject="unfiled"]');
    await expect(unfiled.getByText('Can we move the payments review to Thursday?')).toBeVisible();
    await expect(unfiled.locator('[data-state="investigating"]')).toBeVisible();

    // Filed under a subject, a note, then a question: Needs you.
    const s1 = await agent.file(t1, { newName: 'Review dates (Payments)' });
    await agent.note(t1, 'Thursday 10:00 is free in your calendar.');
    await agent.ask(t1, 'Thursday 10:00 or 14:00?');
    const card = page.locator(`[data-subject="${s1}"]`);
    await expect(card.getByRole('heading', { name: 'Review dates (Payments)' })).toBeVisible();
    await expect(card.locator('[data-state="needsYou"]')).toBeVisible();
    await expect(card.getByText('1 for you')).toBeVisible();
    await look(page, 'list', info.project.name);

    await card.locator(`[data-thread="${t1}"]`).click();
    await expect(
      page.getByRole('heading', { name: /move the payments review/, level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('The team is out on Wednesday.')).toBeVisible();
    await expect(page.getByText('Sam Example')).toBeVisible();
    await expect(page.getByText('teams', { exact: true })).toBeVisible();
    await expect(page.getByText(/noted: .Thursday 10:00 is free/)).toBeVisible();
    await page.getByLabel('Your answer').fill('10:00, please.');
    await page.getByRole('button', { name: 'Answer' }).click();
    await expect(chip(page, 'investigating')).toBeVisible();

    // A reply proposed: Your call. Edit, Send, Undo, Send again.
    const o1 = await agent.propose(
      t1,
      'reply',
      { text: 'Thursday 10:00 works for me.' },
      'They asked for a new date.',
    );
    await expect(chip(page, 'yourCall')).toBeVisible();
    const out = page.locator(`[data-outcome="${o1}"]`);
    await expect(out.getByText('Thursday 10:00 works for me.')).toBeVisible();
    await look(page, 'thread', info.project.name);
    await out.getByRole('button', { name: 'Edit' }).click();
    await out.getByLabel('Reply', { exact: true }).fill('Thursday 10:00 works. See you then, Sam.');
    await out.getByRole('button', { name: 'Send' }).click();
    await out.getByRole('button', { name: 'Undo' }).click();
    await expect(out.getByRole('button', { name: 'Send' })).toBeVisible();
    await page.waitForTimeout(UNDO_WAIT);
    expect((await adminDoc(inboxPaths.outcome(wid, o1)))!.fields.state!.stringValue).toBe(
      'proposed',
    );
    await out.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator(`[data-outcome="${o1}"][data-outcome-state="approved"]`)).toBeVisible(
      {
        timeout: UNDO_WAIT + 5000,
      },
    );
    const approved = (await adminDoc(inboxPaths.outcome(wid, o1)))!.fields;
    expect(approved.fields!.mapValue.fields.text.stringValue).toBe(
      'Thursday 10:00 works. See you then, Sam.',
    );
    await expect(page.getByText('Approved: Payments agent carries it out')).toBeVisible();

    // The agent sends it: Waiting on them. Then nothing more to answer: Done.
    await agent.done(o1, 'https://teams.example.com/conv-1/reply');
    await expect(chip(page, 'waiting')).toHaveText('Waiting on them');
    await expect(page.getByRole('link', { name: 'Open what was sent' })).toBeVisible();
    const o2 = await agent.propose(t1, 'no_reply', { reason: 'Sam confirmed by thumbs-up.' });
    await page.locator(`[data-outcome="${o2}"]`).getByRole('button', { name: 'Close' }).click();
    await expect(chip(page, 'done')).toBeVisible({ timeout: UNDO_WAIT + 5000 });
    await expect(page.getByText('You approved Reply (edited)')).toBeVisible();

    // Reply and book: approving books the meeting in the member's calendar.
    const at = (h: number) => {
      const d = new Date();
      d.setHours(h, 0, 0, 0);
      return d.toISOString();
    };
    const o4 = await agent.propose(t1, 'reply_book', {
      text: 'Let us meet to go through it.',
      start: at(15),
      end: at(16),
      with: 'Sam Example',
    });
    const book = page.locator(`[data-outcome="${o4}"]`);
    await expect(book.getByText('Starts')).toBeVisible();
    await book.getByRole('button', { name: 'Send and book' }).click();
    await expect(book.locator('[data-booked]')).toHaveText(
      /^Booked in your calendar: .+, with Sam Example$/,
      { timeout: UNDO_WAIT + 5000 },
    );
    await page.goto('/calendar');
    await expect(
      page
        .getByRole('region', { name: 'Time grid' })
        .getByRole('group', { name: /^Meeting with Sam Example, / }),
    ).toBeVisible();
    await agent.done(o4, 'https://teams.example.com/conv-1/invite');
    await page.goto(`/inbox/${wid}/t/${t1}`);
    await expect(chip(page, 'waiting')).toBeVisible();

    // A second thread under its own subject; a nudge rejected (with Undo first).
    const t2 = await agent.add(uid, {
      source: 'mail',
      from: 'Rita Ops',
      text: 'Which room for the Thursday review?',
      ref: 'mail-7',
      id: 'x1',
    });
    const s2 = await agent.file(t2, { newName: 'Review slot' });
    const o3 = await agent.propose(t2, 'nudge', { text: 'Any news on the room?' });
    await page.goto(`/inbox/${wid}/t/${t2}`);
    const nudge = page.locator(`[data-outcome="${o3}"]`);
    await nudge.getByRole('button', { name: 'Reject' }).click();
    await nudge.getByRole('button', { name: 'Undo' }).click();
    await nudge.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator(`[data-outcome="${o3}"][data-outcome-state="rejected"]`)).toBeVisible(
      {
        timeout: UNDO_WAIT + 5000,
      },
    );
    await expect(chip(page, 'investigating')).toBeVisible();

    // Merge "Review slot" into "Review dates (Payments)".
    await page.goto(`/inbox/${wid}/s/${s2}`);
    await page.getByRole('button', { name: 'Merge…' }).click();
    await page.getByRole('combobox', { name: 'Merge into' }).selectOption(s1);
    await page.getByRole('dialog').getByRole('button', { name: 'Merge' }).click();
    await expect(page).toHaveURL(new RegExp(`/inbox/${wid}/s/${s1}$`));
    await expect(page.locator(`[data-thread="${t2}"]`)).toBeVisible();
    await expect(page.locator(`[data-thread="${t1}"]`)).toBeVisible();

    // Rename, then split the second thread off, then move it back.
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByLabel('Subject name').fill('Payments review (Thursday)');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByRole('heading', { name: 'Payments review (Thursday)', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Split…' }).click();
    const split = page.getByRole('dialog');
    await split.getByLabel('New subject name').fill('Review room');
    await split.getByLabel('Which room for the Thursday review?').check();
    await split.getByRole('button', { name: 'Split' }).click();
    await expect(page.getByRole('heading', { name: 'Review room', level: 1 })).toBeVisible();
    await expect(page.locator(`[data-thread="${t1}"]`)).toHaveCount(0);
    const room = new URL(page.url()).pathname.split('/').pop()!;

    // Related subjects: an agent's suggestion is OKed, unlinked, then linked again by hand.
    await agent.relate(s1, room, 'Same review, the room side');
    await page.goto(`/inbox/${wid}/s/${s1}`);
    const suggestion = page.locator('[data-relation-state="proposed"]');
    await expect(suggestion.getByText('Same review, the room side')).toBeVisible();
    await look(page, 'subject', info.project.name);
    await suggestion.getByRole('button', { name: 'OK' }).click();
    const linked = page.locator('[data-relation-state="related"]');
    await expect(linked.getByRole('link', { name: 'Review room' })).toBeVisible();
    await linked.getByRole('button', { name: 'Unlink Review room' }).click();
    await expect(page.getByText('No related subjects.')).toBeVisible();
    await page.getByRole('button', { name: 'Link a subject…' }).click();
    await page.getByRole('dialog').getByLabel('Note (optional)').fill('Room booking');
    await page.getByRole('dialog').getByRole('button', { name: 'Link' }).click();
    await expect(linked.getByText('Room booking')).toBeVisible();
    await page.goto(`/inbox/${wid}/s/${room}`);
    await expect(linked.getByRole('link', { name: 'Payments review (Thursday)' })).toBeVisible();
    await page.locator(`[data-thread="${t2}"]`).click();
    await page.getByRole('combobox', { name: 'Move to subject' }).selectOption(s1);
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Payments review (Thursday)' })).toBeVisible();

    // Make it work: an item made by the member, linked on the thread.
    await page.getByRole('button', { name: 'Make it work' }).click();
    const mw = page.getByRole('dialog');
    await mw.getByLabel('Item title').fill('Book a room for the payments review');
    await mw.getByRole('button', { name: 'Create item' }).click();
    await expect(page.getByText(/You made an item of it: .Book a room/)).toBeVisible();

    // Urgent: the agent flags it, the member takes it off.
    await agent.flag(t2, true);
    await expect(page.locator('[data-urgent]')).toBeVisible();
    await page.getByRole('button', { name: 'Not urgent' }).click();
    await expect(page.locator('[data-urgent]')).toHaveCount(0);

    // Ignore.
    await page.getByRole('button', { name: 'Ignore' }).click();
    await expect(chip(page, 'ignored')).toBeVisible();

    // Find: by person, by channel, by words; the waiting filter.
    await page.goto('/inbox');
    const find = page.getByLabel('Find subjects');
    await find.fill('rita');
    await expect(page.locator(`[data-subject="${s1}"]`)).toBeVisible();
    await find.fill('nothing like this');
    await expect(page.getByText('No subject matches.')).toBeVisible();
    await find.fill('');
    await page.getByRole('button', { name: 'Waiting for me' }).click();
    await expect(page.getByText('No subject matches.')).toBeVisible();

    if (info.project.name === 'iphone-se') {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/inbox/${wid}/t/${t1}`);
      await expect(chip(page, 'waiting')).toBeVisible();
      await look(page, 'thread-390', 'iphone-se');
    }
  } finally {
    await agent.stop();
  }
});

test('Inbox: subjects group by area; a quiet subject folds away and comes back', async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await fastTimers(page);
  const me = person('Dora Areas');
  await page.goto('/');
  await signIn(page, me);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const agent = await agentOf(wid, uid, 'Areas agent');
  const days = (n: number) => new Date(Date.now() - n * 86_400_000);
  const brought = (ref: string, from: string, at: Date) =>
    agent.add(uid, { source: 'mail', from, text: `About ${ref}`, ref, id: `m-${ref}`, at });
  try {
    const t1 = await brought('refunds', 'Sam Example', days(1));
    const t2 = await brought('payouts', 'Rita Ops', days(2));
    const t3 = await brought('vpn', 'Ian Admin', days(3));
    const t4 = await brought('lunch', 'Lia Plain', days(4));
    const t5 = await brought('old', 'Olga Old', days(70));
    const s1 = await agent.file(t1, { newName: 'Refunds', area: 'Payments' });
    const s2 = await agent.file(t2, { newName: 'Payouts', area: ' payments ' });
    const s3 = await agent.file(t3, { newName: 'VPN access', area: 'Admin' });
    const s4 = await agent.file(t4, { newName: 'Lunch plans' });
    const s5 = await agent.file(t5, { newName: 'Old contract', area: 'Admin' });

    await page.goto('/inbox');
    const areaOf = (name: string) => page.locator(`section[data-area="${name}"]`);
    await expect(areaOf('Admin').locator(`[data-subject="${s3}"]`)).toBeVisible();
    await expect(areaOf('Payments').locator(`[data-subject="${s1}"]`)).toBeVisible();
    await expect(areaOf('Payments').locator(`[data-subject="${s2}"]`)).toBeVisible();
    await expect(areaOf('').locator(`[data-subject="${s4}"]`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No area', level: 2 })).toBeVisible();
    const order = await page.locator('section[data-area] > h2').allTextContents();
    expect(order).toEqual(['Admin', 'Payments', 'No area']);

    // 70 days without a message: folded into Quiet, closed by default; never deleted.
    const quiet = page.locator('details[data-quiet]');
    await expect(quiet.getByText('Quiet (1)')).toBeVisible();
    await expect(page.locator(`section[data-area] [data-subject="${s5}"]`)).toHaveCount(0);
    await expect(quiet.locator(`[data-subject="${s5}"]`)).toBeHidden();
    await look(page, 'areas', info.project.name);
    await quiet.getByText('Quiet (1)').click();
    await expect(quiet.locator(`[data-subject="${s5}"]`)).toBeVisible();
    await look(page, 'areas-quiet', info.project.name);

    // The quiet threshold is configurable (and can be turned off).
    await page.getByLabel('Quiet subjects').selectOption('30');
    await expect(quiet.getByText('Quiet (1)')).toBeVisible();
    await page.getByLabel('Quiet subjects').selectOption('0');
    await expect(page.locator('details[data-quiet]')).toHaveCount(0);
    await expect(areaOf('Admin').locator(`[data-subject="${s5}"]`)).toBeVisible();
    await page.getByLabel('Quiet subjects').selectOption('60');
    await expect(quiet.getByText('Quiet (1)')).toBeVisible();

    // The member sets an area on the subject page.
    await page.goto(`/inbox/${wid}/s/${s4}`);
    await page.getByRole('button', { name: 'Set area' }).click();
    await page.getByLabel('Area or tag').fill('Admin');
    await page.getByRole('button', { name: 'Save area' }).click();
    await expect(page.getByRole('button', { name: 'Area: Admin' })).toBeVisible();
    await page.goto('/inbox');
    await expect(areaOf('Admin').locator(`[data-subject="${s4}"]`)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No area', level: 2 })).toHaveCount(0);

    // A new message brings the quiet subject back.
    await agent.add(uid, {
      source: 'mail',
      from: 'Olga Old',
      text: 'Back again about the contract',
      ref: 'old',
      id: 'm-old-2',
    });
    await expect(page.locator('details[data-quiet]')).toHaveCount(0);
    await expect(areaOf('Admin').locator(`[data-subject="${s5}"]`)).toBeVisible();
  } finally {
    await agent.stop();
  }
});

test('another member of the organization never sees my Inbox', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const cara = person('Cara Private');
  await page.goto('/');
  await signIn(page, cara);
  await expect(page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  const caraUid = await uidOf(cara.email);
  const bob = await newPerson(browser);
  const bobP = person('Bob Other');
  await bob.page.goto('/');
  await signIn(bob.page, bobP);
  await expect(bob.page.getByRole('heading', { name: /^Hi / })).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => workspaceOf(bobP.email).catch(() => ''), { timeout: 20_000 })
    .not.toBe('');
  const bobUid = await uidOf(bobP.email);
  const bobHome = await workspaceOf(bobP.email);

  // A client organization both are in; its agent brings a message in for Cara.
  const client = `client${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await adminSet(`workspaces/${client}`, {
    name: 'Client Org',
    ownerUid: bobUid,
    memberRoles: { [caraUid]: 'member', [bobUid]: 'admin' },
    adminUids: [bobUid],
    createdAt: new Date(),
    lastEventId: 'seed',
  });
  const before = (await adminDoc(`users/${bobUid}`))!.fields;
  await adminSet(`users/${bobUid}`, {
    name: before.name!.stringValue,
    email: before.email!.stringValue,
    photoURL: before.photoURL?.stringValue ?? null,
    color: before.color!.stringValue,
    workspaceId: bobHome,
    workspaceIds: [bobHome, client],
    theme: null,
  });
  const agent = await agentOf(client, bobUid, 'Client agent');
  try {
    const tid = await agent.add(caraUid, {
      source: 'mail',
      from: 'Zoe Client',
      text: 'Private question for Cara',
      ref: 'm-1',
      id: '1',
    });
    await agent.file(tid, { newName: 'Cara only' });
    await bob.page.goto(`/inbox?org=${client}`);
    await expect(bob.page.getByText('Nothing in your Inbox yet')).toBeVisible();
    await expect(bob.page.getByText('Cara only')).toHaveCount(0);
    await bob.page.goto(`/inbox/${client}/t/${tid}`);
    await expect(bob.page.getByText('This thread is not in your Inbox.')).toBeVisible();
    await expect(bob.page.getByText('Private question for Cara')).toHaveCount(0);
  } finally {
    await agent.stop();
    await bob.ctx.close();
  }
});
