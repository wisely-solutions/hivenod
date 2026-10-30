/**
 * What a thread asks its member right now (item OE8FmrTaIxFVGcaeGG3N, slice 3): one pure answer
 * shared by the web (Today's card, Not now) and the notifier (Hivenod Notifier's quick actions),
 * so a button pressed on the phone decides exactly what the page shows.
 *
 * - `planMain`: the plan's main action (Retry, Approve plan, the step at its turn).
 * - `threadAsk`: the person step that waits (a question, a plan, a plan step, a proposal) with a
 *   stable `key`: a new arrival is a new key, so an old button (or an old Not now) no longer
 *   matches once the thing it was about was decided.
 * - `notNowUntil` / `notNowHides`: Not now hides the decision from Today until 09:00 the next
 *   day in the member's time zone, while the same thing waits.
 * - `decisionLines`: the notifier's bold one-liner and its second line (recommendation and
 *   confidence), from the summary mirror when it is fresh.
 */
import { outcomeKind, outcomeType } from './outcomes';
import { planView, type PlanStateOf, type PlanOutcomeOf } from './plans';

// ---------- the plan's main action ----------

export type PlanMain =
  | { kind: 'approvePlan' }
  | { kind: 'step'; index: number; outcomeId: string; gate: boolean }
  | { kind: 'retry'; index: number }
  | null;

/**
 * The plan's main action: Retry a blocked step; Approve plan while the plan is proposed and
 * agent steps wait; the step at its turn that waits for the member (a gate, or an agent step not
 * approved yet); else Approve plan while agent steps still wait. Steps whose outcome is not
 * given count as not waiting (the notifier passes only the open ones).
 */
export function planMain(pl: {
  plan: PlanStateOf;
  outcomes: Readonly<Record<string, PlanOutcomeOf | null | undefined>>;
}): PlanMain {
  const v = planView(pl.plan, pl.outcomes);
  if (v.state === 'blocked' && v.current) return { kind: 'retry', index: v.current.index };
  const agentWaits = v.steps.some((s) => s.kind === 'agent' && s.outcome?.state === 'proposed');
  if (v.state === 'proposed' && agentWaits) return { kind: 'approvePlan' };
  // A proposed step, or a Their reply step whose drafted message waits for approval.
  if (
    v.waitingForYou &&
    (v.waitingForYou.outcome?.state === 'proposed' || v.waitingForYou.type === 'their_reply')
  )
    return {
      kind: 'step',
      index: v.waitingForYou.index,
      outcomeId: v.waitingForYou.outcomeId,
      gate: v.waitingForYou.kind === 'human',
    };
  if ((v.state === 'proposed' || v.state === 'active' || v.state === 'blocked') && agentWaits)
    return { kind: 'approvePlan' };
  return null;
}

// ---------- what the thread asks ----------

export interface AskInput {
  thread: {
    state: string;
    question: { text: string; atMs: number; answer: string | null; options?: string[] } | null;
  };
  /** The thread's newest live plan (proposed, active, blocked), if any. */
  plan: { id: string; plan: PlanStateOf } | null;
  /** The thread's open outcomes (proposed or revising), plan steps included. */
  open: ReadonlyArray<{
    id: string;
    type: string;
    state: string;
    planId?: string | null;
    createdAtMs: number;
    fields?: Readonly<Record<string, unknown>>;
    /** A running Their reply step whose drafted message waits for approval (its number, kind). */
    ext?: { n: number; kind: string } | null;
  }>;
}

export type ThreadAsk =
  | { kind: 'question'; key: string; text: string; options: string[] }
  | { kind: 'approvePlan'; key: string; planId: string; total: number }
  | {
      kind: 'step';
      key: string;
      planId: string;
      outcomeId: string;
      gate: boolean;
      number: number;
      total: number;
      type: string;
      what: string;
      /** Their reply: the drafted message waiting for approval (ask, follow_up, nudge). */
      ext?: { n: number; kind: string };
    }
  | { kind: 'retry'; key: string; planId: string; number: number; total: number }
  | { kind: 'proposal'; key: string; outcomeId: string; type: string; count: number };

/**
 * The person step that waits on a thread, or null. Same order as the decision page's top card:
 * a blocked plan, an open question, the plan's main action, then the oldest single proposal.
 */
export function threadAsk(i: AskInput): ThreadAsk | null {
  const t = i.thread;
  const pl = i.plan;
  const main = pl
    ? planMain({
        plan: pl.plan,
        outcomes: Object.fromEntries(
          i.open
            .filter((o) => o.planId === pl.id)
            .map((o) => [
              o.id,
              {
                type: o.type,
                state: o.state as PlanOutcomeOf['state'],
                fields: {},
                ...(o.ext
                  ? {
                      ext: {
                        ask: { n: o.ext.n, kind: 'ask', text: '', state: 'proposed', by: '' },
                        outAt: null,
                        sent: 0,
                        reply: null,
                      } as const,
                    }
                  : {}),
              },
            ]),
        ),
      })
    : null;
  const total = pl ? pl.plan.steps.length : 0;
  if (pl && main?.kind === 'retry')
    return {
      kind: 'retry',
      key: `r:${pl.id}:${main.index}`,
      planId: pl.id,
      number: main.index + 1,
      total,
    };
  if (t.state === 'needsYou' && t.question && t.question.answer === null)
    return {
      kind: 'question',
      key: `q${t.question.atMs}`,
      text: t.question.text,
      options: [...(t.question.options ?? [])],
    };
  if (pl && main?.kind === 'approvePlan')
    return { kind: 'approvePlan', key: `p:${pl.id}`, planId: pl.id, total };
  if (pl && main?.kind === 'step') {
    const o = i.open.find((x) => x.id === main.outcomeId);
    const what = typeof o?.fields?.what === 'string' ? o.fields.what.trim() : '';
    return {
      kind: 'step',
      // Each drafted message of a Their reply step is a new arrival.
      key: `s:${pl.id}:${main.outcomeId}${o?.ext ? `:${o.ext.n}` : ''}`,
      planId: pl.id,
      outcomeId: main.outcomeId,
      gate: main.gate,
      number: main.index + 1,
      total,
      type: o?.type ?? '',
      what,
      ...(o?.ext ? { ext: { n: o.ext.n, kind: o.ext.kind } } : {}),
    };
  }
  const singles = i.open
    .filter((o) => !o.planId && o.state === 'proposed')
    .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : 1));
  const first = singles[0];
  if (t.state === 'yourCall' && first)
    return {
      kind: 'proposal',
      // The same key the notifier used before slice 3 ("c" + the oldest proposal's time).
      key: `c${first.createdAtMs}`,
      outcomeId: first.id,
      type: first.type,
      count: singles.length,
    };
  return null;
}

/** Their reply: what a drafted message is called (its Approve button says it too). */
export const EXT_ASK_LABEL: Readonly<Record<string, string>> = {
  ask: 'Ask',
  follow_up: 'Follow-up',
  nudge: 'Reminder',
};

/** Whether the quick actions Approve and Ask for changes apply (else only answers or Open). */
export function askApproves(a: ThreadAsk | null): boolean {
  return !!a && (a.kind === 'approvePlan' || a.kind === 'step' || a.kind === 'proposal');
}

/** The app's own line for what waits (no summary, or an out-of-date one). */
export function askFallback(a: ThreadAsk, title: string): string {
  const named = title.trim() || 'an Inbox thread';
  switch (a.kind) {
    case 'question':
      return a.text;
    case 'approvePlan':
      return `Approve the plan for “${named}”? ${a.total} ${a.total === 1 ? 'step' : 'steps'}`;
    case 'step':
      if (a.ext)
        return `${EXT_ASK_LABEL[a.ext.kind] ?? 'Message'} to approve · step ${a.number} of ${a.total}`;
      return a.gate
        ? `${a.what || 'Your approval'} · step ${a.number} of ${a.total}`
        : `Step ${a.number} of ${a.total}: ${outcomeType(a.type)?.label ?? a.type}`;
    case 'retry':
      return `Step ${a.number} of ${a.total} failed: retry, skip or stop`;
    case 'proposal':
      return `${outcomeType(a.type)?.label ?? a.type}${a.count > 1 ? ` (+${a.count - 1} more)` : ''}`;
  }
}

/** A gate or an agent step at its turn: is it a person step (human kind)? */
export const isPersonStep = (type: string) => outcomeKind(type) === 'human';

// ---------- Not now ----------

/** Not now lasts until this hour (local) the next day. */
export const NOT_NOW_HOUR = 9;

/** The offset of `tz` from UTC at `ms`, in ms (0 for an unknown zone). */
function tzOffset(ms: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms));
    const get = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? 0);
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  } catch {
    return 0;
  }
}

/** 09:00 of the day after `nowMs`, in the member's time zone `tz` (an IANA name), as ms. */
export function notNowUntil(nowMs: number, tz: string): number {
  const off = tzOffset(nowMs, tz);
  const local = new Date(nowMs + off);
  const target = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() + 1,
    NOT_NOW_HOUR,
    0,
    0,
  );
  // The offset at the target itself (a daylight saving change overnight).
  return target - tzOffset(target - off, tz);
}

/** Whether Not now still hides this thread from Today: not expired, and about what waits now. */
export function notNowHides(
  notNow: { until: { toMillis(): number }; key: string } | null | undefined,
  ask: Pick<ThreadAsk, 'key'> | null,
  nowMs: number,
): boolean {
  return !!notNow && !!ask && notNow.key === ask.key && notNow.until.toMillis() > nowMs;
}

// ---------- the notifier's lines ----------

/** The bold one-liner is at most this long (a phone's lock screen). */
export const ONE_LINER_MAX = 90;
const clip = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export interface DecisionLinesInput {
  ask: ThreadAsk;
  title: string;
  subjectName: string;
  agentName: string;
  summary: {
    headline: string;
    ask: string | null;
    answer: string | null;
    recAction: string | null;
    confidence: string | null;
  } | null;
  /** The summary was written after the thread's last change. */
  fresh: boolean;
}

/**
 * The one-liner (the summary's ask, else its headline; the app's line when there is no fresh
 * summary) and the second line: "<agent> recommends Approve · confidence high", else the
 * summary's answer, else the subject and title.
 */
export function decisionLines(i: DecisionLinesInput): { line: string; detail: string } {
  const s = i.fresh ? i.summary : null;
  const line = clip(s ? s.ask || s.headline : askFallback(i.ask, i.title), ONE_LINER_MAX);
  const rec = s?.recAction ? `${i.agentName || 'Your agent'} recommends ${s.recAction}` : '';
  const conf = s?.confidence ? `confidence ${s.confidence}` : '';
  const where = [i.subjectName, i.title].filter((x) => x.trim()).join(' · ');
  const detail = rec || conf ? [rec, conf].filter(Boolean).join(' · ') : s?.answer || where;
  return { line, detail: clip(detail, 160) };
}
