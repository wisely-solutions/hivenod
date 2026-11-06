/**
 * Plans on the thread page (item qwFAWxZM5xkcE7PPjAzi, slice 4): what the plan checklist needs
 * beside planView (packages/shared/src/plans.ts): the action input of a plan, the steps that may
 * still move, a step's one-line title, and the plan's main action (the phone sheet's button).
 */
import {
  outcomeKind,
  outcomeType,
  type InboxOutcome,
  type InboxPlan,
  type PlanInput,
  type PlanStepView,
  type PlanView,
  sendBackTarget,
  type SendBackOf,
} from '@hive/shared';
import type { Row } from '../lib/live';
import type { Tone } from '../ui/badge';
import { dayLabel, hhmm } from '../today/logic';

/** A plan with its steps' outcomes, as the plan actions take it. */
export function planInputOf(
  plan: Row<InboxPlan>,
  outcomes: readonly Row<InboxOutcome>[],
): PlanInput & { plan: SendBackOf } {
  const by: Record<string, PlanInput['outcomes'][string]> = {};
  for (const o of outcomes) if (plan.data.steps.includes(o.id)) by[o.id] = o.data;
  return {
    planId: plan.id,
    plan: {
      memberUid: plan.data.memberUid,
      threadId: plan.data.threadId,
      steps: [...plan.data.steps],
      cursor: plan.data.cursor,
      state: plan.data.state,
      // Development plans (slice 6): where a gate sends back to, and how often it was.
      ...(plan.data.sendBackTo ? { sendBackTo: plan.data.sendBackTo } : {}),
      ...(plan.data.sentBack ? { sentBack: { n: plan.data.sentBack.n } } : {}),
    },
    outcomes: by,
  };
}

/**
 * Ask for changes on the gate at `index` (slice 6): the steps it may send the plan back to (the
 * earlier agent steps that are done, nearest first) and the default one; empty when there is
 * none (a plain approval with no agent step before it).
 */
export function sendBackChoices(
  pl: PlanInput & { plan: SendBackOf },
  index: number,
): { choices: { index: number; label: string }[]; target: number | null } {
  const types = Object.fromEntries(pl.plan.steps.map((id) => [id, pl.outcomes[id]?.type]));
  const target = sendBackTarget(pl.plan.steps, types, index, pl.plan.sendBackTo ?? null);
  const choices: { index: number; label: string }[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const o = pl.outcomes[pl.plan.steps[i]!];
    if (o && o.state === 'done' && outcomeKind(o.type) === 'agent')
      choices.push({ index: i, label: `Step ${i + 1}: ${outcomeType(o.type)?.label ?? o.type}` });
  }
  return {
    choices,
    target:
      target !== null && choices.some((c) => c.index === target)
        ? target
        : (choices[0]?.index ?? null),
  };
}

export const planLive = (state: InboxPlan['state']) =>
  state === 'proposed' || state === 'active' || state === 'blocked';

/** The first step that may still move or be removed (the one being carried out never moves). */
export function firstFree(pl: PlanInput): number {
  const id = pl.plan.steps[pl.plan.cursor];
  const st = id !== undefined ? pl.outcomes[id]?.state : undefined;
  const started = st === 'approved' || st === 'running' || st === 'failed';
  return pl.plan.cursor + (started ? 1 : 0);
}

const HEADLINE_MAX = 100;
/**
 * A short title from a long text: the first non-empty line (skipping `---` rules), its first
 * sentence, Markdown marks stripped, at most 100 characters, cut on a word boundary with "…".
 */
export function headline(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '' && !/^[-*_=\s]{3,}$/.test(l)) ?? '';
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(plain)?.[1] ?? plain;
  if (sentence.length <= HEADLINE_MAX) return sentence;
  const cut = sentence.slice(0, HEADLINE_MAX - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > 20 ? cut.slice(0, at) : cut).replace(/[\s,;:.-]+$/, '')}…`;
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
export function when(iso: unknown): string {
  const t = Date.parse(str(iso));
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${dayLabel(d)}, ${hhmm(d)}`;
}

/** A step's one-line title: what it does, from its fields. */
export function stepTitle(type: string | null, fields: Readonly<Record<string, unknown>>): string {
  switch (type) {
    case 'reply':
      return str(fields.text) ? `Reply: “${headline(str(fields.text))}”` : 'Reply';
    // Retired with Calendar (slice 5): old records only.
    case 'reply_book':
    case 'book':
      return `Booking (retired) ${when(fields.start)}`.trim();
    case 'approval':
      return `You approve: ${headline(str(fields.what))}`;
    // Development plans: the real titles, as the plan's steps are called.
    case 'shape':
      return str(fields.idea) ? `Shape: ${headline(str(fields.idea))}` : 'Shape';
    case 'build':
      return str(fields.brief) ? `Build: ${headline(str(fields.brief))}` : 'Build';
    case 'keepgreen':
      return 'Keep green: PR rebased and green';
    case 'release':
      return 'Release + live check';
    case 'make_it_work':
      return str(fields.title) ? `Build it: ${headline(str(fields.title))}` : 'Build it';
    case 'handover':
      return `Hand over to ${headline(str(fields.to))}`;
    case 'their_reply':
      return `${headline(str(fields.who))}${str(fields.org) ? ` (${headline(str(fields.org))})` : ''}: ${headline(str(fields.need))}`;
    case 'snooze':
      return `Wait until ${when(fields.until)}`.trim();
    case 'nudge':
      return str(fields.text) ? `Nudge: “${headline(str(fields.text))}”` : 'Nudge';
    case null:
      return '…';
    default:
      return outcomeType(type)?.label ?? type;
  }
}

/** The state word on a step's pill. */
export const STEP_UI_TEXT: Record<PlanView['steps'][number]['ui'], string> = {
  proposed: 'Proposed',
  revising: 'Revising…',
  approved: 'Approved',
  running: 'Running',
  done: 'Done',
  waitingForYou: 'Waiting for you',
  blocked: 'Blocked',
  skipped: 'Skipped',
  stopped: 'Stopped',
};

/** "1 approved · 1 needs you on the way" for a plan being decided. */
export function planSummary(pl: PlanInput): string {
  const ids = pl.plan.steps;
  const approved = ids.filter((id) => pl.outcomes[id]?.state === 'approved').length;
  const done = ids.filter((id) => pl.outcomes[id]?.state === 'done').length;
  const gates = ids.filter(
    (id) =>
      pl.outcomes[id] &&
      outcomeKind(pl.outcomes[id]!.type) === 'human' &&
      pl.outcomes[id]!.state === 'proposed',
  ).length;
  const parts: string[] = [];
  if (done) parts.push(`${done} done`);
  if (approved) parts.push(`${approved} approved`);
  if (gates) parts.push(`${gates} ${gates === 1 ? 'needs' : 'need'} you on the way`);
  return parts.join(' · ');
}

// The plan's main action moved to the shared package (slice 3: the notifier uses it too).
export { planMain, type PlanMain } from '@hive/shared';
import { planMain } from '@hive/shared';

/** Whether the member has something to decide on the plan (it then needs the panel open). */
export function planWaits(pl: PlanInput): boolean {
  return planMain(pl) !== null;
}

/** How each step state is drawn: its pill tone, number circle and progress bar segment. */
export const PILL: Record<PlanStepView['ui'], Tone> = {
  proposed: 'neutral',
  revising: 'agent',
  approved: 'approve',
  running: 'agent',
  done: 'approve',
  waitingForYou: 'gate',
  blocked: 'sendback',
  skipped: 'neutral',
  stopped: 'neutral',
};
export const CIRCLE: Record<PlanStepView['ui'], string> = {
  proposed: 'border-line-strong text-text-2',
  revising: 'border-dashed border-agent text-agent',
  approved: 'border-approve text-approve-text',
  running: 'border-agent text-agent',
  done: 'border-approve-solid bg-approve-solid text-on-solid',
  waitingForYou: 'border-gate bg-gate text-on-gate',
  blocked: 'border-sendback text-sendback',
  skipped: 'border-line text-text-3 line-through',
  stopped: 'border-line text-text-3',
};
export const BAR: Record<PlanStepView['ui'], string> = {
  proposed: 'bg-line',
  revising: 'bg-agent/40',
  approved: 'border border-approve bg-transparent',
  running: 'bg-agent',
  done: 'bg-approve-solid',
  waitingForYou: 'bg-gate',
  blocked: 'bg-sendback',
  skipped: 'bg-line',
  stopped: 'bg-line',
};

/**
 * The project and item of a Build it step's link (<site>/p/<project>?item=<item>, filled in by
 * the CLI when the agent reports the item made), or null.
 */
export function itemLinkParts(
  link: string | null | undefined,
): { pid: string; iid: string } | null {
  const m = /\/p\/([^/?#]+)\?item=([^&#]+)/.exec(link ?? '');
  if (!m) return null;
  try {
    return { pid: decodeURIComponent(m[1]!), iid: decodeURIComponent(m[2]!) };
  } catch {
    return null;
  }
}

/** Keep green re-checking while a gate waits (slice 6c): what the gate shows. */
export interface KeepGreenRecheck {
  check: 'rechecking' | 'blocked';
  line: string;
  outcomeId: string;
}

/**
 * The Keep green step right before the gate at `index` (Ship it?), when it is done (green and
 * current) but has reported a re-check since: main moved (rechecking) or it cannot re-green
 * (blocked). Null while it is green, or when the step before the gate is not Keep green.
 */
export function keepGreenRecheck(
  steps: readonly string[],
  outcomes: readonly Row<InboxOutcome>[],
  index: number,
): KeepGreenRecheck | null {
  const id = steps[index - 1];
  const o = id !== undefined ? outcomes.find((r) => r.id === id)?.data : undefined;
  const p = o?.progress;
  if (!o || o.type !== 'keepgreen' || o.state !== 'done' || !p) return null;
  if (p.check !== 'rechecking' && p.check !== 'blocked') return null;
  // A line from before it was done (an earlier round) is not a re-check.
  if (o.result?.at && p.at.toMillis() <= o.result.at.toMillis()) return null;
  return { check: p.check, line: p.line, outcomeId: id! };
}

/** What each step type produces, in the member's words (shown as "Produces:" on a step). */
export const PRODUCES: Record<string, string> = {
  shape: 'a proposal with a size for your OK',
  build: 'an open pull request, checks green, not merged',
  keepgreen: 'the PR kept current with main',
  release: 'the change live and checked',
  reply: 'the message sent',
  approval: 'your decision',
  their_reply: 'their answer',
  nudge: 'a reminder sent',
  snooze: 'a wait until the date',
  handover: 'it is handed over',
};

/** What a step produces: from PRODUCES, else null (retired and unknown types say nothing). */
export const producesOf = (type: string | null): string | null => (type && PRODUCES[type]) || null;

/** Who does a step: "You decide", "Their reply", or "Agent · <type label>". */
export function whoOf(type: string | null): string {
  if (type && outcomeKind(type) === 'human') return 'You decide';
  if (type === 'their_reply') return 'Their reply';
  return `Agent · ${(type && outcomeType(type)?.label) || type || 'step'}`;
}

/**
 * The open questions in a field's text (documented rule, kept simple): a line that starts with
 * "Open:" (any case) or ends with "?". They are drawn highlighted so the member answers them.
 */
export function openQuestionLines(value: string): { text: string; open: boolean }[] {
  return value.split('\n').map((text) => {
    const t = text.trim();
    return { text, open: /^open:/i.test(t) || t.endsWith('?') };
  });
}

/** A step of a plan, as the version diff reads it. */
export interface DiffStep {
  type: string;
  fields: Readonly<Record<string, unknown>>;
}
export interface FieldChange {
  name: string;
  label: string;
  before: string;
  after: string;
}
export interface StepChange {
  /** Step position, from 0. */
  index: number;
  kind: 'added' | 'removed' | 'changed' | 'same';
  /** The step's type label (the new one; the old one for a removed step). */
  label: string;
  /** Type words before and after, when the type changed. */
  type?: { before: string; after: string };
  fields: FieldChange[];
}

const fieldText = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'boolean'
      ? v
        ? 'Yes'
        : ''
      : v == null
        ? ''
        : String(v);
const typeLabel = (t: string) => outcomeType(t)?.label ?? t;

/**
 * What changed from the previous plan to this one, per step position: a step added or removed, a
 * changed type, and each field whose text differs (before to after).
 */
export function planDiff(prev: readonly DiffStep[], cur: readonly DiffStep[]): StepChange[] {
  const out: StepChange[] = [];
  const n = Math.max(prev.length, cur.length);
  for (let index = 0; index < n; index++) {
    const a = prev[index];
    const b = cur[index];
    if (!a && b) {
      out.push({
        index,
        kind: 'added',
        label: typeLabel(b.type),
        fields: fieldChanges(undefined, b),
      });
    } else if (a && !b) {
      out.push({
        index,
        kind: 'removed',
        label: typeLabel(a.type),
        fields: fieldChanges(a, undefined),
      });
    } else if (a && b) {
      const typeChanged = a.type !== b.type;
      const fields = fieldChanges(a, b);
      out.push({
        index,
        kind: typeChanged || fields.length ? 'changed' : 'same',
        label: typeLabel(b.type),
        ...(typeChanged ? { type: { before: typeLabel(a.type), after: typeLabel(b.type) } } : {}),
        fields,
      });
    }
  }
  return out;
}

function fieldChanges(a: DiffStep | undefined, b: DiffStep | undefined): FieldChange[] {
  const names = new Set([...Object.keys(a?.fields ?? {}), ...Object.keys(b?.fields ?? {})]);
  const out: FieldChange[] = [];
  for (const name of names) {
    const before = fieldText(a?.fields[name]);
    const after = fieldText(b?.fields[name]);
    if (before === after) continue;
    const label =
      (b && outcomeType(b.type)?.fields[name]?.label) ||
      (a && outcomeType(a.type)?.fields[name]?.label) ||
      name;
    out.push({ name, label, before, after });
  }
  return out;
}

/** The plans of one thread numbered v1..vN by creation time (a tie goes by id). */
export function planVersions(
  plans: readonly { id: string; createdAtMs: number }[],
): { id: string; n: number }[] {
  return [...plans]
    .sort((a, b) => a.createdAtMs - b.createdAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p, i) => ({ id: p.id, n: i + 1 }));
}
