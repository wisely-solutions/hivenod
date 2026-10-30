/**
 * Their reply: a plan step that waits on one person outside Hivenod (outcome type `their_reply`,
 * kind 'external', ./outcomes.ts). The member approves every message that goes out:
 *
 *   its turn (carry_out)  → the agent drafts the ask (stepAsk)            thread: Your call
 *   the member approves   → (approveStepAsk, maybe edited)                thread: waiting on the agent
 *   the agent sends it    → (stepSent: outAt, sent + 1)                   thread: waiting on them
 *   their reply comes in  → inbox_add reopens the thread; the CLI pushes reason external_reply
 *   a clear yes           → outcome_done with evidence (an inbound message newer than outAt)
 *   unclear or partial    → a follow-up ask (stepAsk kind follow_up), or the member's Mark done
 *   no reply in N working days → the notifier's one timer writes remindDue = the ask's n; the
 *                           CLI pushes nudge_due with the step: the agent drafts a nudge ask.
 *
 * Every change is one batch with one `step.external` event (data.op), checked by firestore.rules
 * (inboxStepMove → inboxExt). Pure: no SDK.
 */
import {
  ActionError,
  requireAgent,
  requireHuman,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import {
  advance,
  inboxPaths,
  inboxPlan,
  planFor,
  planWrites,
  type OutcomeStateOf,
  type PlanInput,
  type ThreadStateOf,
} from './inbox';

export const THEIR_REPLY = 'their_reply';
export const EXT_ASK_KINDS = ['ask', 'follow_up', 'nudge'] as const;
export type ExtAskKind = (typeof EXT_ASK_KINDS)[number];
export const EXT_LIMITS = { text: 20_000, quote: 1000 } as const;
/** Working days without a reply before the one reminder (the step's remindAfterDays). */
export const REMIND_AFTER_DAYS = 3;

type Ms = { toMillis(): number } | null | undefined;
/** The step's `ext` as listeners and actions read it. */
export interface ExtStateOf {
  ask: {
    n: number;
    kind: ExtAskKind;
    text: string;
    state: 'proposed' | 'approved' | 'sent';
    by: string;
    at?: Ms | typeof SERVER_TIME;
  } | null;
  outAt: Ms | typeof SERVER_TIME;
  sent: number;
  reply: { messageDocId: string; quote: string } | null;
}

const need = (c: boolean, m: string) => {
  if (!c) throw new ActionError(m);
};
const upd = (path: string, data: Record<string, unknown>, eventId: string): WriteOp => ({
  kind: 'update',
  path,
  data: { ...data, updatedAt: SERVER_TIME, lastEventId: eventId },
});

/** The step, its turn in a live plan; returns the plan. */
function atTurn(o: OutcomeStateOf, oid: string, pl: PlanInput | undefined): PlanInput {
  need(o.type === THEIR_REPLY, 'This is for a Their reply step only.');
  const p = planFor(pl, o, oid);
  need(
    (p.plan.state === 'proposed' || p.plan.state === 'active') &&
      p.plan.steps[p.plan.cursor] === oid,
    'Not its turn: this step is not the one the plan runs now.',
  );
  return p;
}
const extOf = (o: OutcomeStateOf): ExtStateOf =>
  o.ext ?? { ask: null, outAt: null, sent: 0, reply: null };

function writes(
  ctx: ActionContext,
  oid: string,
  o: OutcomeStateOf,
  outcome: Record<string, unknown>,
  thread: Record<string, unknown>,
  data: Record<string, unknown>,
  input: { thread: ThreadStateOf },
): ActionPlan {
  return inboxPlan(
    ctx,
    'step.external',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: oid, ...data },
    (eventId) => [
      upd(inboxPaths.outcome(ctx.workspaceId, oid), outcome, eventId),
      upd(inboxPaths.thread(ctx.workspaceId, o.threadId), thread, eventId),
    ],
  );
}

export interface StepAskInput {
  outcomeId: string;
  outcome: OutcomeStateOf;
  thread: ThreadStateOf;
  plan: PlanInput;
  kind: ExtAskKind;
  text: string;
  /** The inbound reply this ask answers (a follow-up), quoted on the step. */
  reply?: { messageDocId: string; quote: string } | null;
  /** That message as read (its thread and direction), when a reply is given. */
  replyMessage?: { threadId: string; direction: 'in' | 'out' } | null;
}

/**
 * step_ask: the executing agent drafts the next message to them (the first ask, a follow-up or a
 * nudge) for the member's approval. The step runs from here; the thread is the member's call.
 * A draft not yet approved may be replaced; an approved one must be sent first.
 */
export function stepAsk(ctx: ActionContext, input: StepAskInput): ActionPlan & { n: number } {
  requireAgent(ctx);
  const o = input.outcome;
  need(
    o.executor === ctx.actor.id,
    'Only the agent that carries this step out drafts its messages.',
  );
  const pl = atTurn(o, input.outcomeId, input.plan);
  need(
    o.state === 'approved' || o.state === 'running',
    o.state === 'proposed' || o.state === 'revising'
      ? 'Not approved: the step runs only once the person approved the plan.'
      : `This step is ${o.state}.`,
  );
  const ext = extOf(o);
  need(
    ext.ask?.state !== 'approved',
    'The approved message is not sent yet: send it, then step_sent.',
  );
  need(
    (EXT_ASK_KINDS as readonly string[]).includes(input.kind),
    'The kind is ask, follow_up or nudge.',
  );
  need(ext.sent > 0 || input.kind === 'ask', 'Nothing was sent yet: the first message is the ask.');
  const text = (input.text ?? '').trim();
  need(text.length > 0, 'Write the message (text).');
  need(text.length <= EXT_LIMITS.text, `The message is at most ${EXT_LIMITS.text} characters.`);
  let reply = ext.reply;
  if (input.reply) {
    const quote = input.reply.quote.trim().replace(/\s+/g, ' ');
    need(
      quote.length > 0 && quote.length <= EXT_LIMITS.quote,
      `The quote is 1 to ${EXT_LIMITS.quote} characters.`,
    );
    const m = input.replyMessage;
    need(
      !!m && m.threadId === o.threadId && m.direction === 'in',
      'The reply is a message from them on this thread (its messageId as thread_read shows it).',
    );
    reply = { messageDocId: input.reply.messageDocId, quote };
  }
  const n = (ext.ask?.n ?? 0) + 1;
  const ask = { n, kind: input.kind, text, state: 'proposed', by: ctx.actor.id, at: SERVER_TIME };
  const p = writes(
    ctx,
    input.outcomeId,
    o,
    { state: 'running', ext: { ask, outAt: ext.outAt ?? null, sent: ext.sent, reply } },
    { state: 'yourCall', waiting: null },
    { planId: pl.planId, op: 'ask', n, kind: input.kind },
    input,
  );
  return { ...p, n };
}

/** The member approves the drafted message (maybe edited): the agent sends it. */
export function approveStepAsk(
  ctx: ActionContext,
  input: {
    outcomeId: string;
    outcome: OutcomeStateOf;
    thread: ThreadStateOf;
    plan: PlanInput;
    text?: string | null;
  },
): ActionPlan {
  requireHuman(ctx);
  const o = input.outcome;
  need(o.memberUid === ctx.actor.id, 'Only the person this is for can do this.');
  const pl = atTurn(o, input.outcomeId, input.plan);
  const ext = extOf(o);
  need(
    o.state === 'running' && ext.ask?.state === 'proposed',
    'No message waits for your approval.',
  );
  const edited = input.text != null && input.text.trim() !== ext.ask!.text;
  const text = edited ? input.text!.trim() : ext.ask!.text;
  need(
    text.length > 0 && text.length <= EXT_LIMITS.text,
    `The message is 1 to ${EXT_LIMITS.text} characters.`,
  );
  return writes(
    ctx,
    input.outcomeId,
    o,
    { ext: { ...ext, ask: { ...ext.ask!, text, state: 'approved' } } },
    { state: 'waiting', waiting: { on: 'agent', until: null } },
    { planId: pl.planId, op: 'approve', n: ext.ask!.n, edited },
    input,
  );
}

/** step_sent: the agent sent the approved message, exactly as approved; the step waits on them. */
export function stepSent(
  ctx: ActionContext,
  input: { outcomeId: string; outcome: OutcomeStateOf; thread: ThreadStateOf; plan: PlanInput },
): ActionPlan {
  requireAgent(ctx);
  const o = input.outcome;
  need(o.executor === ctx.actor.id, 'Only the agent that carries this step out reports it.');
  const pl = atTurn(o, input.outcomeId, input.plan);
  const ext = extOf(o);
  need(
    o.state === 'running' && ext.ask?.state === 'approved',
    ext.ask?.state === 'proposed'
      ? 'Not approved: nothing is sent before the person approves it.'
      : 'No approved message waits to be sent.',
  );
  return writes(
    ctx,
    input.outcomeId,
    o,
    {
      ext: { ...ext, ask: { ...ext.ask!, state: 'sent' }, outAt: SERVER_TIME, sent: ext.sent + 1 },
    },
    { state: 'waiting', waiting: { on: 'them', until: null } },
    { planId: pl.planId, op: 'sent', n: ext.ask!.n },
    input,
  );
}

/** Mark done anyway: the member counts the step as done (whatever they answered); the plan moves on. */
export function markStepDone(
  ctx: ActionContext,
  input: { outcomeId: string; outcome: OutcomeStateOf; thread: ThreadStateOf; plan: PlanInput },
): ActionPlan {
  requireHuman(ctx);
  const o = input.outcome;
  need(o.memberUid === ctx.actor.id, 'Only the person this is for can do this.');
  const pl = atTurn(o, input.outcomeId, input.plan);
  need(o.state === 'approved' || o.state === 'running', `This step is ${o.state}.`);
  const next = advance(pl, input.outcomeId, 'done', true);
  return inboxPlan(
    ctx,
    'step.external',
    { memberUid: o.memberUid, threadId: o.threadId, subjectId: input.thread.subjectId },
    { outcomeId: input.outcomeId, planId: pl.planId, op: 'done' },
    (eventId) => [
      upd(inboxPaths.outcome(ctx.workspaceId, input.outcomeId), { state: 'done' }, eventId),
      ...planWrites(ctx, pl, next, null, eventId),
    ],
  );
}

// ---------- what the pages and the notifier show ----------

const DAY = 86_400_000;
/** `fromMs` plus `n` working days (Monday to Friday, UTC). */
export function addWorkingDays(fromMs: number, n: number): number {
  let t = fromMs;
  let left = n;
  while (left > 0) {
    t += DAY;
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) left--;
  }
  return t;
}
/** Whole days from `fromMs` to `nowMs` (0 the same day). */
export const daysSince = (fromMs: number, nowMs: number) =>
  Math.max(0, Math.floor((nowMs - fromMs) / DAY));

export function remindAfterDays(fields: Readonly<Record<string, unknown>>): number {
  const v = Number(fields.remindAfterDays);
  return Number.isInteger(v) && v >= 1 && v <= 30 ? v : REMIND_AFTER_DAYS;
}

export type TheirReplyPhase = 'ready' | 'approve' | 'sending' | 'waiting' | 'done';
export interface TheirReplyView {
  who: string;
  org: string | null;
  need: string;
  channel: string;
  phase: TheirReplyPhase;
  /** The message in hand (to approve, being sent, or the last one sent). */
  ask: { n: number; kind: ExtAskKind; text: string } | null;
  /** Days since the last message went out (null: nothing sent yet). */
  days: number | null;
  /** "waiting on Ana · 2 d" while it waits on them, else null. */
  pill: string | null;
  /** Their latest reply the agent quoted. */
  quote: string | null;
  /** When the one reminder is due (ms), while it waits on them. */
  remindAtMs: number | null;
}

const millis = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: unknown }).toMillis === 'function'
    ? (v as { toMillis(): number }).toMillis()
    : null;

/** What a Their reply step shows (decision page, plan rail, notifier). */
export function theirReplyView(
  o: {
    type: string;
    state: string;
    fields: Readonly<Record<string, unknown>>;
    ext?: ExtStateOf | null;
  },
  nowMs: number,
): TheirReplyView | null {
  if (o.type !== THEIR_REPLY) return null;
  const f = o.fields;
  const s = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : '');
  const ext = o.ext ?? null;
  const ask = ext?.ask ?? null;
  const outMs = millis(ext?.outAt);
  const phase: TheirReplyPhase =
    o.state === 'done'
      ? 'done'
      : ask?.state === 'proposed'
        ? 'approve'
        : ask?.state === 'approved'
          ? 'sending'
          : ask?.state === 'sent'
            ? 'waiting'
            : 'ready';
  const who = s('who') || 'them';
  const days = outMs === null ? null : daysSince(outMs, nowMs);
  return {
    who,
    org: s('org') || null,
    need: s('need'),
    channel: s('channel'),
    phase,
    ask: ask ? { n: ask.n, kind: ask.kind, text: ask.text } : null,
    days,
    pill: phase === 'waiting' ? `waiting on ${who} · ${days ?? 0} d` : null,
    quote: ext?.reply?.quote ?? null,
    remindAtMs:
      phase === 'waiting' && outMs !== null ? addWorkingDays(outMs, remindAfterDays(f)) : null,
  };
}
