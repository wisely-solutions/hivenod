/**
 * Quick actions on an Inbox thread from Hivenod Notifier (item OE8FmrTaIxFVGcaeGG3N, slice 3):
 * Approve, Not now, Ask for changes, an answer to an agent's question. The button carries a code
 * that points at (org, thread, member, the arrival it was sent for); the decision is the same
 * ActionPlan the app builds (approvePlan, approveOutcome, notNowThread, requestRevision,
 * instructThread, answerQuestion), applied with the Admin SDK. Admin writes skip the security
 * rules, so what the rules would check is checked here first: the person is the thread's member
 * and still in the organization, and the thread still asks the very thing the button was sent
 * for (same threadAsk key). Anything else answers "Already decided at HH:MM".
 */
import {
  ActionError,
  answerQuestion,
  approveOutcome,
  approvePlan,
  askApproves,
  inboxOutcomeSchema,
  inboxPaths,
  inboxPlanSchema,
  inboxThreadSchema,
  instructThread,
  notifyPath,
  notNowThread,
  notNowUntil,
  outcomeType,
  paths,
  REVISABLE_TYPES,
  requestRevision,
  sendBackPlan,
  sendBackTarget,
  threadAsk,
  versionCount,
  INBOX_LIMITS,
  type ActionContext,
  type InboxOutcome,
  type InboxPlan,
  type InboxThread,
  type PlanInput,
  type SendBackOf,
  type ThreadAsk,
} from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';

/** What a thread button points at (telegramActions/{code}, with the chat it was sent to). */
export interface ThreadAction {
  kind: 'thread';
  wid: string;
  tid: string;
  uid: string;
  /** The threadAsk key the message was sent for. */
  arrival: string;
}

export type ThreadDecision =
  | { kind: 'approve' }
  | { kind: 'notNow' }
  | { kind: 'changes'; text: string }
  | { kind: 'answer'; text: string }
  | { kind: 'option'; index: number };

export type ThreadResult = { ok: true; text: string } | { ok: false; text: string };

type Ts = { toMillis(): number };
const ms = (v: unknown) => (v as Ts | undefined)?.toMillis?.() ?? 0;

interface Loaded {
  thread: InboxThread;
  plan: { id: string; data: InboxPlan } | null;
  outcomes: { id: string; data: InboxOutcome }[];
  name: string;
  tz: string;
  ask: ThreadAsk | null;
}

async function load(db: Firestore, a: ThreadAction): Promise<Loaded | null> {
  const [tSnap, mSnap, prefs, plans, outs] = await Promise.all([
    db.doc(inboxPaths.thread(a.wid, a.tid)).get(),
    db.doc(paths.member(a.wid, a.uid)).get(),
    db.doc(notifyPath.prefs(a.uid)).get(),
    db
      .collection(`workspaces/${a.wid}/inboxPlans`)
      .where('threadId', '==', a.tid)
      .where('memberUid', '==', a.uid)
      .get(),
    db
      .collection(`workspaces/${a.wid}/inboxOutcomes`)
      .where('threadId', '==', a.tid)
      .where('memberUid', '==', a.uid)
      .get(),
  ]);
  if (!tSnap.exists || !mSnap.exists) return null;
  const t = inboxThreadSchema.safeParse(tSnap.data());
  if (!t.success) return null;
  const outcomes = outs.docs.flatMap((d) => {
    const r = inboxOutcomeSchema.safeParse(d.data());
    return r.success ? [{ id: d.id, data: r.data }] : [];
  });
  const live = plans.docs
    .flatMap((d) => {
      const r = inboxPlanSchema.safeParse(d.data());
      return r.success ? [{ id: d.id, data: r.data }] : [];
    })
    .filter((p) => ['proposed', 'active', 'blocked'].includes(p.data.state))
    .sort((x, y) => ms(y.data.createdAt) - ms(x.data.createdAt));
  const plan = live[0] ?? null;
  const q = t.data.question;
  const open = outcomes.filter((o) => o.data.state === 'proposed' || o.data.state === 'revising');
  const ask = threadAsk({
    thread: {
      state: t.data.state,
      question: q ? { text: q.text, atMs: ms(q.at), answer: q.answer, options: q.options } : null,
    },
    plan: plan ? { id: plan.id, plan: plan.data } : null,
    open: open.map((o) => ({
      id: o.id,
      type: o.data.type,
      state: o.data.state,
      planId: o.data.planId ?? null,
      createdAtMs: ms(o.data.createdAt),
      fields: o.data.fields,
    })),
  });
  const tz = (prefs.data()?.quiet?.tz as string | undefined) || 'UTC';
  const name = (mSnap.data()?.name as string | undefined) ?? 'Someone';
  return { thread: t.data, plan, outcomes, name, tz, ask };
}

/** "14:05" in the member's time zone. */
export function clock(atMs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(atMs));
  } catch {
    return new Date(atMs).toISOString().slice(11, 16);
  }
}

/** When what the button was about was decided: its decision time, else the thread's last change. */
function decidedAt(s: Loaded, arrival: string): number {
  const t = s.thread;
  if (arrival.startsWith('q') && t.question?.answeredAt) return ms(t.question.answeredAt);
  const oid = arrival.startsWith('s:') ? arrival.split(':')[2] : null;
  const o = oid ? s.outcomes.find((x) => x.id === oid) : null;
  if (o?.data.decision) return ms(o.data.decision.at);
  if (arrival.startsWith('p:')) {
    const pid = arrival.slice(2);
    const steps = s.outcomes.filter((x) => x.data.planId === pid && x.data.decision);
    const at = Math.max(0, ...steps.map((x) => ms(x.data.decision!.at)));
    if (at) return at;
  }
  return ms(t.updatedAt);
}

/** Why the person may not use this button now, in words for the chat; null when they may. */
export function threadWhyNot(s: Loaded | null, a: ThreadAction): string | null {
  if (!s) return 'I could not find that thread any more.';
  if (s.thread.memberUid !== a.uid) return 'You can no longer decide this one.';
  if (!s.ask || s.ask.key !== a.arrival)
    return `Already decided at ${clock(decidedAt(s, a.arrival), s.tz)}.`;
  return null;
}

function planInput(s: Loaded): (PlanInput & { plan: SendBackOf }) | undefined {
  if (!s.plan) return undefined;
  const by: Record<string, InboxOutcome> = {};
  for (const o of s.outcomes) if (s.plan.data.steps.includes(o.id)) by[o.id] = o.data;
  return {
    planId: s.plan.id,
    plan: {
      memberUid: s.plan.data.memberUid,
      threadId: s.plan.data.threadId,
      steps: [...s.plan.data.steps],
      cursor: s.plan.data.cursor,
      state: s.plan.data.state,
      ...(s.plan.data.sendBackTo ? { sendBackTo: s.plan.data.sendBackTo } : {}),
      ...(s.plan.data.sentBack ? { sentBack: { n: s.plan.data.sentBack.n } } : {}),
    },
    outcomes: by,
  };
}

/** Loads the thread and says why not, without deciding (the prompt for a reason checks first). */
export async function threadCheck(db: Firestore, a: ThreadAction): Promise<string | null> {
  return threadWhyNot(await load(db, a), a);
}

export async function decideThread(
  db: Firestore,
  a: ThreadAction,
  d: ThreadDecision,
  nowMs: number,
): Promise<ThreadResult> {
  const s = await load(db, a);
  const blocked = threadWhyNot(s, a);
  if (blocked || !s || !s.ask) return { ok: false, text: blocked ?? 'Nothing waits here.' };
  const ask = s.ask;
  const ctx: ActionContext = {
    workspaceId: a.wid,
    actor: { type: 'human', id: a.uid, name: s.name },
    via: 'telegram',
  };
  const thread = { ...s.thread };
  const title = s.thread.title || 'the thread';
  const outcome = (id: string) => s.outcomes.find((o) => o.id === id)?.data;
  try {
    if (d.kind === 'notNow') {
      const until = notNowUntil(nowMs, s.tz);
      await applyPlanAdmin(
        db,
        notNowThread(ctx, {
          threadId: a.tid,
          thread,
          key: ask.key,
          until: new Date(until),
          nowMs,
        }),
      );
      return { ok: true, text: `Not now: back on Today tomorrow at ${clock(until, s.tz)}.` };
    }
    if (d.kind === 'option' || d.kind === 'answer') {
      if (ask.kind !== 'question') return { ok: false, text: 'There is no question to answer.' };
      const text = d.kind === 'option' ? ask.options[d.index] : d.text;
      if (!text?.trim()) return { ok: false, text: 'That answer is no longer offered.' };
      await applyPlanAdmin(db, answerQuestion(ctx, { threadId: a.tid, thread, answer: text }));
      return { ok: true, text: `Answered “${text.trim()}”: ${title}` };
    }
    if (!askApproves(ask)) return { ok: false, text: 'Open the thread to decide this one.' };
    if (d.kind === 'approve') {
      if (ask.kind === 'approvePlan') {
        const pl = planInput(s)!;
        await applyPlanAdmin(db, approvePlan(ctx, { ...pl, thread }));
        return { ok: true, text: `Plan approved: ${title}` };
      }
      const oid = ask.kind === 'step' || ask.kind === 'proposal' ? ask.outcomeId : '';
      const o = outcome(oid);
      if (!o) return { ok: false, text: 'I could not find that proposal any more.' };
      await applyPlanAdmin(
        db,
        approveOutcome(ctx, {
          outcomeId: oid,
          outcome: o,
          thread,
          ...(o.planId ? { plan: planInput(s) } : {}),
          // A gate pins the summary version the person decided on (slice 6).
          ...(s.thread.summary ? { summaryVersion: s.thread.summary.version } : {}),
        }),
      );
      const what =
        ask.kind === 'step'
          ? `step ${ask.number} of ${ask.total}`
          : (outcomeType(o.type)?.label ?? o.type);
      return { ok: true, text: `Approved ${what}: ${title}` };
    }
    // Ask for changes: a gate with an earlier agent step sends the plan back to it (slice 6,
    // design 6.5); a revisable proposal (or agent step) is revised by its agent; anything else
    // (a plan, a plain gate) goes to the home agent as an instruction (Ask the agent).
    const text = d.text.trim();
    if (text.length < 3) return { ok: false, text: 'Please say what should change.' };
    const oid = ask.kind === 'step' || ask.kind === 'proposal' ? ask.outcomeId : '';
    const o = oid ? outcome(oid) : undefined;
    const pl = planInput(s);
    if (ask.kind === 'step' && o && pl && o.type === 'approval') {
      const types = Object.fromEntries(pl.plan.steps.map((id) => [id, pl.outcomes[id]?.type]));
      const at = pl.plan.steps.indexOf(oid);
      const to = sendBackTarget(pl.plan.steps, types, at, pl.plan.sendBackTo ?? null);
      if (to !== null && pl.outcomes[pl.plan.steps[to]!]?.state === 'done') {
        const r = sendBackPlan(ctx, {
          ...pl,
          thread,
          reason: text.slice(0, INBOX_LIMITS.reason),
          toStep: to,
        });
        await applyPlanAdmin(db, r);
        return {
          ok: true,
          text: r.blocked
            ? `Sent back to step ${to + 1}, the third time: the plan now waits for you. ${title}`
            : `Sent back to step ${to + 1}: ${title}`,
        };
      }
    }
    if (
      o &&
      o.state === 'proposed' &&
      REVISABLE_TYPES.includes(o.type) &&
      versionCount(o) < INBOX_LIMITS.versions
    ) {
      await applyPlanAdmin(
        db,
        requestRevision(ctx, {
          outcomeId: oid,
          outcome: o,
          thread,
          instruction: text.slice(0, INBOX_LIMITS.reviseInstruction),
        }),
      );
      return { ok: true, text: `Asked for changes: ${title}` };
    }
    await applyPlanAdmin(
      db,
      instructThread(ctx, {
        threadId: a.tid,
        thread,
        text: `Changes asked: ${text}`.slice(0, INBOX_LIMITS.instruction),
        nowMs,
      }),
    );
    return { ok: true, text: `Asked for changes: ${title}` };
  } catch (e) {
    if (e instanceof ActionError) return { ok: false, text: e.message };
    throw e;
  }
}
