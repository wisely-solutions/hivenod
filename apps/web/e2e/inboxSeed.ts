/**
 * The Inbox redesign seed (item kt3E7u9EliL3q2veDDI0, design section 5), written
 * with the shared actions as the agent tools do: 2 organizations, 6 subjects, 8 threads (1 urgent
 * with a due date in 2 days, 1 reply proposed with high confidence and 2 checks, 1 question
 * with 2 options, 3 tidy-ups). Calendar events went with Calendar (OE8Fm slice 5). Times follow the frozen NOW (helpers.ts):
 * call freezeClock(page) before the first goto.
 */
import { expect, type Page } from '@playwright/test';
import {
  addInboxMessage,
  addThreadNote,
  askMember,
  assignSubject,
  digest24,
  dueThread,
  flagThread,
  inboxMessageKey,
  inboxPaths,
  inboxThreadKey,
  finishOutcome,
  proposeOutcome,
  proposePlan,
  stepProgress,
  recheckDone,
  answerInstruction,
  suggestChips,
  reviseOutcome,
  threadAttach,
  writeSummary,
  type PlanInput,
  type PlanStepInput,
  type ActionContext,
  type ActionPlan,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '@hive/shared';
import { applyPlan } from '@hive/shared/firestore';
import { createAgentIdentity, signInWithToken } from '@hive/shared/agent-auth';
import { deleteApp, initializeApp } from 'firebase/app';
import { connectAuthEmulator, initializeAuth, inMemoryPersistence } from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';
import { createHash } from 'node:crypto';
import {
  adminDoc,
  adminSet,
  adminUpdate,
  AUTH_PORT,
  FIRESTORE_PORT,
  NOW,
  person,
  signIn,
  uidOf,
  workspaceOf,
} from './helpers';

const OPTIONS = { apiKey: 'fake', projectId: 'hive-board-43be' };
const h = (s: string) => digest24(createHash('sha256').update(s, 'utf8').digest('hex'));
const H = 3_600_000;

/** A new agent of `wid` that works the inbox with the shared actions, as the agent tools do. */
export async function agentOf(wid: string, ownerUid: string, name: string) {
  const { uid: aid, token } = await createAgentIdentity(OPTIONS, wid, {
    authEmulatorUrl: `http://localhost:${AUTH_PORT}`,
  });
  await adminSet(`workspaces/${wid}/agents/${aid}`, {
    name,
    color: '#2F5FD0',
    projectIds: '*',
    createdBy: ownerUid,
    createdAt: new Date(NOW),
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
  return {
    aid,
    async add(
      member: string,
      m: { source: string; from: string; text: string; ref: string; id: string; at: Date },
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
        receivedAt: m.at,
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
    async ask(tid: string, question: string, options?: string[]) {
      await run(askMember(ctx, { threadId: tid, thread: await thread(tid), question, options }));
    },
    async propose(
      tid: string,
      type: string,
      fields: Record<string, unknown>,
      note = '',
      extra: { confidence?: string; checks?: string[] } = {},
    ) {
      const p = proposeOutcome(ctx, {
        threadId: tid,
        thread: await thread(tid),
        type,
        fields,
        note,
        ...extra,
      });
      await run(p);
      return p.outcomeId;
    },
    /** Ask for changes: the next version of an outcome the member asked changes for. */
    async revise(
      oid: string,
      fields: Record<string, unknown>,
      note = '',
      /** A stale read of the outcome (a revision that arrives late). */
      snapshot?: OutcomeStateOf,
    ) {
      const o =
        snapshot ??
        ((await getDoc(doc(db, inboxPaths.outcome(wid, oid)))).data() as OutcomeStateOf);
      const p = reviseOutcome(ctx, {
        outcomeId: oid,
        outcome: o,
        thread: await thread(o.threadId),
        fields,
        note,
      });
      await run(p);
      return p.version;
    },
    /** Re-check (item bmNoIvvqKCdAorLSShE9): answers the member's request (thread_recheck_done). */
    async recheck(tid: string, result: string, note?: string) {
      const of = (coll: string) =>
        getDocs(query(collection(db, `workspaces/${wid}/${coll}`), where('threadId', '==', tid)));
      const [os, ps] = await Promise.all([of('inboxOutcomes'), of('inboxPlans')]);
      const p = recheckDone(ctx, {
        threadId: tid,
        thread: await thread(tid),
        result,
        note,
        outcomes: Object.fromEntries(os.docs.map((d) => [d.id, d.data() as OutcomeStateOf])),
        plans: Object.fromEntries(ps.docs.map((d) => [d.id, d.data() as PlanInput['plan']])),
      });
      await run(p);
      return p.checked;
    },
    /** Ask the agent (item w6O2KOw4ys70TQv9I1xD): answers the member's request once. */
    async answer(tid: string, instructionId: string, kind: string, refId?: string, note?: string) {
      await run(
        answerInstruction(ctx, {
          threadId: tid,
          thread: await thread(tid),
          instructionId,
          kind,
          refId: refId ?? null,
          note: note ?? null,
        }),
      );
    },
    async chips(tid: string, chips: string[]) {
      await run(suggestChips(ctx, { threadId: tid, thread: await thread(tid), chips }));
    },
    async flag(tid: string, urgent: boolean) {
      await run(flagThread(ctx, { threadId: tid, thread: await thread(tid), urgent }));
    },
    async due(tid: string, due: string | null, reason?: string) {
      await run(dueThread(ctx, { threadId: tid, thread: await thread(tid), due, reason }));
    },
    /** Plans (item qwFAWxZM5xkcE7PPjAzi): one call proposes the steps, as plan_propose does. */
    async plan(tid: string, steps: PlanStepInput[], note = '') {
      const p = proposePlan(ctx, { threadId: tid, thread: await thread(tid), steps, note });
      await run(p);
      return { planId: p.planId, stepIds: p.stepIds };
    },
    /** Reports the plan step at its turn done, failed or started (outcome_done). */
    async finishStep(
      pid: string,
      status: 'done' | 'failed' | 'started',
      result: { error?: string; itemId?: string; permalink?: string } = {},
    ) {
      const plan = (await getDoc(doc(db, inboxPaths.plan(wid, pid)))).data() as PlanInput['plan'];
      const outcomes: Record<string, OutcomeStateOf> = {};
      for (const id of plan.steps)
        outcomes[id] = (
          await getDoc(doc(db, inboxPaths.outcome(wid, id)))
        ).data() as OutcomeStateOf;
      const oid = plan.steps[plan.cursor]!;
      await run(
        finishOutcome(ctx, {
          outcomeId: oid,
          outcome: outcomes[oid]!,
          thread: await thread(plan.threadId),
          status,
          result,
          plan: { planId: pid, plan, outcomes },
        }),
      );
      return oid;
    },
    /**
     * Reports where the running long step at the plan's turn stands (step_progress, slice 6b).
     * With a check (Keep green, slice 6c), on the done Keep green step before the gate at the turn.
     */
    async progress(
      pid: string,
      line: string,
      percent: number | null = null,
      check: 'rechecking' | 'green' | 'blocked' | null = null,
    ) {
      const plan = (await getDoc(doc(db, inboxPaths.plan(wid, pid)))).data() as PlanInput['plan'];
      const outcomes: Record<string, OutcomeStateOf> = {};
      for (const id of plan.steps)
        outcomes[id] = (
          await getDoc(doc(db, inboxPaths.outcome(wid, id)))
        ).data() as OutcomeStateOf;
      const at = plan.steps[plan.cursor]!;
      const oid = check && outcomes[at]?.type === 'approval' ? plan.steps[plan.cursor - 1]! : at;
      await run(
        stepProgress(ctx, {
          outcomeId: oid,
          outcome: outcomes[oid]!,
          thread: await thread(plan.threadId),
          line,
          percent,
          check,
          plan: { planId: pid, plan, outcomes },
        }),
      );
    },
    /** Attaches a file to the thread (thread_attach, slice 4); returns its attachment id. */
    async attach(
      tid: string,
      file: {
        kind: 'image' | 'html' | 'markdown' | 'text' | 'pdf' | 'link';
        name: string;
        content?: string;
        url?: string;
      },
    ) {
      const p = threadAttach(ctx, { threadId: tid, thread: await thread(tid), ...file });
      await run(p);
      return p.attachmentId;
    },
    /** Writes the thread's next summary (thread_summary, item OE8FmrTaIxFVGcaeGG3N). */
    async summary(
      tid: string,
      content: Record<string, unknown>,
      /** The thread's attachments as {id: kind} (image visuals, slice 4). */
      attachments: Record<string, string> = {},
    ) {
      const th = await thread(tid);
      const v = (th as { summary?: { version: number } }).summary?.version ?? 0;
      const p = writeSummary(ctx, {
        threadId: tid,
        thread: th,
        current: v ? { version: v } : null,
        baseVersion: v,
        summary: content,
        basis: { lastEventId: null, planCursor: null },
        attachments,
      });
      await run(p);
      return p.version;
    },
    /** A thread's plans (ids, any state), e.g. one the member made with New thread (slice 6). */
    async plansOf(tid: string) {
      const q = query(collection(db, `workspaces/${wid}/inboxPlans`), where('threadId', '==', tid));
      return (await getDocs(q)).docs.map((d) => d.id);
    },
    /** A plan's step ids, in order. */
    async stepsOf(pid: string) {
      return ((await getDoc(doc(db, inboxPaths.plan(wid, pid)))).data() as PlanInput['plan']).steps;
    },
    outcome: async (oid: string) =>
      (await getDoc(doc(db, inboxPaths.outcome(wid, oid)))).data() as OutcomeStateOf,
    stop: () => deleteApp(app),
  };
}

/** A local time on the day `offset` days from NOW's day (the browser runs in UTC). */
export const at = (offset: number, hour: number, minute = 0) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
};
const ago = (hours: number) => new Date(NOW - hours * H);

export type Seed = Awaited<ReturnType<typeof seedInbox>>;

/**
 * Turns the seed's `book` proposal into an old booking (reply_book, retired with Calendar in
 * OE8Fm slice 5), as records from before the removal are: written as the emulator's admin, since
 * no agent may propose one now.
 */
export async function makeOldBooking(s: Seed, state = 'proposed') {
  await adminUpdate(`workspaces/${s.wid}/inboxOutcomes/${s.outcomes.book}`, {
    type: 'reply_book',
    state,
    fields: {
      text: 'Tuesday works. I booked 10:00-11:00 and sent the invite. See you then.',
      start: at(1, 10).toISOString(),
      end: at(1, 11).toISOString(),
      with: 'Sam Okafor',
    },
  });
}

/** Signs a new person in and seeds their two organizations. The page ends on Today. */
export async function seedInbox(page: Page, name = 'Cara Lindqvist') {
  const me = person(name);
  await page.goto('/');
  await signIn(page, me);
  await expect(page.locator('#today-greeting')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => workspaceOf(me.email).catch(() => ''), { timeout: 20_000 }).not.toBe('');
  const wid = await workspaceOf(me.email);
  const uid = await uidOf(me.email);
  const client = `client${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await adminSet(`workspaces/${client}`, {
    name: 'Northwind',
    ownerUid: uid,
    memberRoles: { [uid]: 'member', zoe: 'admin' },
    adminUids: ['zoe'],
    createdAt: new Date(NOW),
    lastEventId: 'seed',
  });
  const before = (await adminDoc(`users/${uid}`))!.fields;
  await adminSet(`users/${uid}`, {
    name: before.name!.stringValue,
    email: before.email!.stringValue,
    photoURL: before.photoURL?.stringValue ?? null,
    color: before.color!.stringValue,
    workspaceId: wid,
    workspaceIds: [wid, client],
    theme: null,
  });

  const agent = await agentOf(wid, uid, 'Desk agent');
  const other = await agentOf(client, uid, 'Northwind agent');

  // 1. Urgent, due in 2 days: the first decision.
  const price = await agent.add(uid, {
    source: 'mail',
    from: 'Ava Brennan',
    text: 'Sign off the Q4 price list by Wednesday\nHi Cara, attached is the Q4 price list. We need your sign-off by Wednesday noon to make the catalogue print run.',
    ref: 'price',
    id: 'p1',
    at: ago(5),
  });
  const sPrice = await agent.file(price, { newName: 'Q4 price list', area: 'Sales' });
  await agent.flag(price, true);
  await agent.due(price, at(2, 12).toISOString(), 'Ava: sign-off by Wednesday noon');
  const oPrice = await agent.propose(
    price,
    'handover',
    { to: 'Finance', note: 'Review and sign off the Q4 price list' },
    'A real review, not a reply: 38 lines changed and 4 are below margin.',
    {
      confidence: 'high',
      checks: ['The proposal: 38 lines changed', 'Margins: 4 lines below 20%'],
    },
  );

  // 2. A reply about a meeting, with confidence and checks.
  const review = await agent.add(uid, {
    source: 'teams',
    from: 'Sam Okafor',
    text: 'Move the payments review to Tuesday\nCan we move the payments review to Tuesday? The team is out on Wednesday.',
    ref: 'review',
    id: 'r1',
    at: ago(3),
  });
  const sReview = await agent.file(review, { newName: 'Payments review', area: 'Finance' });
  await agent.note(review, 'Tuesday 10:00-11:00 and 14:00-15:00 are free in your calendar.');
  // Bookings were retired with Calendar (OE8Fm slice 5): a plain reply now (the key stays `book`).
  const oBook = await agent.propose(
    review,
    'reply',
    {
      text: 'Tuesday works. I booked 10:00-11:00 and sent the invite. See you then.',
    },
    'Sam asked for a new date; Tuesday 10:00 is free and Rita agreed.',
    {
      confidence: 'high',
      checks: ['Your calendar: Tue 10:00-11:00 free', 'Asked Rita by mail: either works'],
    },
  );

  // 3. A question with 2 answer chips.
  const room = await agent.add(uid, {
    source: 'mail',
    from: 'Rita Johansson',
    text: 'Which room for the payments review?\nThe big one is taken in the morning.',
    ref: 'room',
    id: 'x1',
    at: ago(2),
  });
  await agent.file(room, { subjectId: sReview });
  await agent.ask(room, 'Book the small room (6 seats) or move to the afternoon?', [
    'Small room',
    'Afternoon',
  ]);

  // 4. The agent is still on it (Agents working).
  const visit = await agent.add(uid, {
    source: 'telegram',
    from: 'Tom Reyes',
    text: 'Supplier visit next week\nAre you still coming to the supplier visit next week?',
    ref: 'visit',
    id: 'tg1',
    at: ago(1),
  });
  await agent.file(visit, { newName: 'Supplier visit', area: 'Operations' });
  await agent.note(visit, 'Checking the travel booking for the supplier visit.');

  // 5-7. Three tidy-ups (send nothing, high confidence).
  const ops = await agent.add(uid, {
    source: 'jira',
    from: 'Jira',
    text: 'OPS-221 moved to Done: replace the meeting room screens.',
    ref: 'ops221',
    id: 'j1',
    at: ago(8),
  });
  await agent.file(ops, { newName: 'Office facilities', area: 'Operations' });
  const oOps = await agent.propose(ops, 'ignore', { reason: 'Status update' }, 'Nothing to do.', {
    confidence: 'high',
  });
  const omar = await agent.add(uid, {
    source: 'teams',
    from: 'Omar Haddad',
    text: 'Thanks for the notes yesterday, I will send the summary by Monday.',
    ref: 'omar',
    id: 'c8',
    at: ago(30),
  });
  await agent.file(omar, { newName: 'Hiring: ops lead', area: 'People' });
  const oOmar = await agent.propose(
    omar,
    'snooze',
    { until: at(7, 9).toISOString() },
    'Omar sends the summary by Monday.',
    { confidence: 'high' },
  );
  const news = await agent.add(uid, {
    source: 'mail',
    from: 'Fieldnotes',
    text: 'This week in design: five essays on calm software.',
    ref: 'news',
    id: 'n1',
    at: ago(26),
  });
  const oNews = await agent.propose(news, 'no_reply', { reason: 'A newsletter' }, 'An FYI.', {
    confidence: 'high',
  });

  // 8. The other organization: a reply, less sure.
  const steer = await other.add(uid, {
    source: 'mail',
    from: 'Zoe Park',
    text: 'Agenda for the Northwind steering\nCould you send an agenda for the Northwind steering?',
    ref: 'steer',
    id: 's1',
    at: ago(4),
  });
  await other.file(steer, { newName: 'Northwind steering', area: 'Client' });
  const oSteer = await other.propose(
    steer,
    'reply',
    { text: 'Here is a 4-point agenda: status, budget, risks, next steps.' },
    'Zoe asked for an agenda; this follows last month’s.',
    { confidence: 'medium' },
  );

  return {
    me,
    wid,
    client,
    uid,
    agent,
    other,
    threads: { price, review, room, visit, ops, omar, news, steer },
    subjects: { price: sPrice, review: sReview },
    outcomes: { price: oPrice, book: oBook, ops: oOps, omar: oOmar, news: oNews, steer: oSteer },
    stop: async () => {
      await agent.stop();
      await other.stop();
    },
  };
}
