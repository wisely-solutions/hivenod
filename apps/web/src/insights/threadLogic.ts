/**
 * Decision insights on threads (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7): a decision is a
 * person's decision on a thread, at a person step of a plan (approve, ask for changes, not
 * approved), on a plan (approve, reject, stop) or on a single proposal (approve, edit + approve,
 * reject, ask for changes). Read from the member's `inboxEvents`; the facts (stepLabel, waitedMs,
 * recommended, summaryVersion) are on each event (decisionFacts in @hive/shared).
 */
import type { InboxEvent, InboxEventType } from '@hive/shared';
import { recommendationKind } from '../activity/threadLogic';
import { median } from './logic';

/** The event types a person's decision writes (the insights query asks for these). */
export const DECISION_TYPES = [
  'outcome.approved',
  'outcome.rejected',
  'outcome.revise_requested',
  'plan.approved',
  'plan.rejected',
  'plan.stopped',
  'plan.sent_back',
] as const satisfies readonly InboxEventType[];

export type DecisionKind = 'approved' | 'changes' | 'rejected' | 'stopped';

export interface ThreadDecision {
  id: string;
  at: number;
  threadId: string | null;
  byUid: string;
  kind: DecisionKind;
  /** The step decided ("Ship it?", "Approve plan", "Reply"). */
  step: string;
  /** Ask for changes on a plan step: the step it went back to. */
  toStep: string | null;
  edited: boolean;
  waitedMs: number | null;
  recommended: string | null;
  /** Whether the decision did what the summary recommended (null: no usable recommendation). */
  followed: boolean | null;
  reason: string;
  /** What groups the decisions on one thing (first-time approval is counted per key). */
  key: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : '');

type Ev = Pick<InboxEvent, 'actor' | 'type' | 'data' | 'threadId'> & {
  at: { toMillis(): number };
};

/** A person's decision from an event, or null (an agent's send back, a cancelled request). */
export function toDecision(id: string, e: Ev): ThreadDecision | null {
  if (e.actor.type !== 'human') return null;
  const d = e.data;
  let kind: DecisionKind;
  switch (e.type) {
    case 'outcome.approved':
    case 'plan.approved':
      kind = 'approved';
      break;
    case 'outcome.revise_requested':
      // Cancelling a request writes the same type with nothing asked.
      if (d.instruction === null && Array.isArray(d.chips) && d.chips.length === 0) return null;
      kind = 'changes';
      break;
    case 'plan.sent_back':
      kind = 'changes';
      break;
    case 'outcome.rejected':
      // On a plan step, not approved stops the plan.
      kind = d.planId ? 'stopped' : 'rejected';
      break;
    case 'plan.rejected':
      kind = 'rejected';
      break;
    case 'plan.stopped':
      kind = 'stopped';
      break;
    default:
      return null;
  }
  const step = str(d.stepLabel) || (e.type.startsWith('plan.') ? 'Plan' : str(d.type) || 'Step');
  const planId = str(d.planId);
  const key = planId ? `p:${planId}:${step}` : `o:${str(d.outcomeId) || id}`;
  const recommended = str(d.recommended) || null;
  const rec = recommended ? recommendationKind(recommended) : null;
  const want: Record<DecisionKind, string> = {
    approved: 'approve',
    changes: 'changes',
    rejected: 'reject',
    stopped: 'reject',
  };
  return {
    id,
    at: e.at.toMillis(),
    threadId: e.threadId,
    byUid: e.actor.id,
    kind,
    step,
    toStep: e.type === 'plan.sent_back' ? str(d.toLabel) || 'an earlier step' : null,
    edited: d.edited === true,
    waitedMs: typeof d.waitedMs === 'number' ? d.waitedMs : null,
    recommended,
    followed: rec === null ? null : rec === want[kind],
    reason: str(d.reason) || str(d.instruction),
    key,
  };
}

export interface ThreadKpis {
  made: number;
  approved: number;
  /** Share (0-100) of the things decided whose first decision in the range was an approval. */
  firstTimePct: number | null;
  /** Asked for changes or sent back. */
  sentBack: number;
  stopped: number;
  /** Where things went back, most first: "Ship it? → Build". */
  sentBackTo: Array<{ step: string; count: number }>;
  medianWaitMs: number | null;
  /** Share (0-100) of decisions with a recommendation that followed it. */
  followedPct: number | null;
}

/** "Ship it? → Build" for a plan send back; "Reply → changes" for a proposal. */
export function backLabel(d: ThreadDecision): string {
  return `${d.step} → ${d.toStep ?? 'changes'}`;
}

export function threadKpis(rows: readonly ThreadDecision[]): ThreadKpis {
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  const first = new Map<string, ThreadDecision>();
  for (const r of sorted) if (!first.has(r.key)) first.set(r.key, r);
  const firstApproved = [...first.values()].filter((r) => r.kind === 'approved').length;
  const to = new Map<string, number>();
  for (const r of rows)
    if (r.kind === 'changes') to.set(backLabel(r), (to.get(backLabel(r)) ?? 0) + 1);
  const withRec = rows.filter((r) => r.followed !== null);
  return {
    made: rows.length,
    approved: rows.filter((r) => r.kind === 'approved').length,
    firstTimePct: first.size ? Math.round((firstApproved / first.size) * 100) : null,
    sentBack: rows.filter((r) => r.kind === 'changes').length,
    stopped: rows.filter((r) => r.kind === 'stopped').length,
    sentBackTo: [...to]
      .map(([step, count]) => ({ step, count }))
      .sort((a, b) => b.count - a.count || a.step.localeCompare(b.step)),
    medianWaitMs: median(rows.flatMap((r) => (r.waitedMs === null ? [] : [r.waitedMs]))),
    followedPct: withRec.length
      ? Math.round((withRec.filter((r) => r.followed).length / withRec.length) * 100)
      : null,
  };
}

/** Per step: how its decisions went (the table). */
export interface StepRow {
  step: string;
  made: number;
  approved: number;
  sentBack: number;
  stopped: number;
  rejected: number;
  medianWaitMs: number | null;
}
export function byStep(rows: readonly ThreadDecision[]): StepRow[] {
  const m = new Map<string, ThreadDecision[]>();
  for (const r of rows) m.set(r.step, [...(m.get(r.step) ?? []), r]);
  return [...m]
    .map(([step, rs]) => ({
      step,
      made: rs.length,
      approved: rs.filter((r) => r.kind === 'approved').length,
      sentBack: rs.filter((r) => r.kind === 'changes').length,
      stopped: rs.filter((r) => r.kind === 'stopped').length,
      rejected: rs.filter((r) => r.kind === 'rejected').length,
      medianWaitMs: median(rs.flatMap((r) => (r.waitedMs === null ? [] : [r.waitedMs]))),
    }))
    .sort((a, b) => b.made - a.made || a.step.localeCompare(b.step));
}

export const KIND_LABEL: Record<DecisionKind, string> = {
  approved: 'Approved',
  changes: 'Asked for changes',
  rejected: 'Not approved',
  stopped: 'Stopped',
};

export function decisionText(d: ThreadDecision): string {
  if (d.kind === 'changes') return d.toStep ? `Sent back to ${d.toStep}` : 'Asked for changes';
  if (d.kind === 'approved' && d.edited) return 'Edited and approved';
  return KIND_LABEL[d.kind];
}

/** A CSV cell. Quotes when needed, and defuses spreadsheet formulas (=, +, -, @ at the start). */
function cell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const CSV_BOM = '﻿';

/** The table as CSV: UTF-8 BOM, ISO 8601 UTC dates, CRLF; one line per decision. */
export function threadCsv(
  rows: readonly ThreadDecision[],
  names: { thread: (tid: string | null) => string; person: (uid: string) => string },
): string {
  const head = [
    'When (UTC)',
    'Thread',
    'Step',
    'Decision',
    'Sent back to',
    'By',
    'Waited (min)',
    'Recommended',
    'Followed',
    'Reason',
  ];
  const lines = [head.map(cell).join(',')];
  for (const r of [...rows].sort((a, b) => b.at - a.at))
    lines.push(
      [
        new Date(r.at).toISOString(),
        names.thread(r.threadId),
        r.step,
        decisionText(r),
        r.toStep ?? '',
        names.person(r.byUid),
        r.waitedMs === null ? '' : String(Math.round(r.waitedMs / 60_000)),
        r.recommended ?? '',
        r.followed === null ? '' : r.followed ? 'yes' : 'no',
        r.reason,
      ]
        .map(cell)
        .join(','),
    );
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
