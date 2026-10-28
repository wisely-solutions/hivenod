import {
  EVENT_TYPES,
  formatTokens,
  newTokens,
  type Attachment,
  STALE_CLAIM_MINUTES,
  type Decision,
  type EventType,
  type HiveEvent,
  type Run,
} from '@hive/shared';
import type { Row } from '../lib/live';
import { isSentBack } from '../lib/outcomes';

export const PAGE_SIZE = 50;

/** `Live` error code for a query that needs a Firestore index which is still being built. */
export const INDEX_BUILDING = 'index-building';

/** Firestore answers failed-precondition while a composite index is CREATING (or missing). */
export function isIndexBuilding(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'failed-precondition'
  );
}

export const INDEX_BUILDING_TEXT =
  'Hivenod was just updated and is still preparing this view. Try again in a few minutes.';
const DAY = 86_400_000;

// ---------- sentences ----------

type Data = Record<string, unknown>;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const quote = (t: string | null | undefined) => (t ? `“${t}”` : 'an item');

/**
 * What each event type says, in plain words, after the actor's name. `title` is the item's
 * title when known. Exhaustive on purpose: a new event type does not compile until it has a label.
 */
const PHRASES: Record<EventType, (d: Data, title: string | null) => string> = {
  'item.created': (d, t) => `added ${quote(text(d.title) || t)}`,
  'item.moved': (_d, t) => `moved ${quote(t)} to another step`,
  'item.claimed': (_d, t) => `picked up ${quote(t)}`,
  'item.released': (d, t) =>
    (d.stalled
      ? `released the stalled claim on ${quote(t)}`
      : d.runStatus === 'failed'
        ? `stopped and let go of ${quote(t)}`
        : `let go of ${quote(t)}`) + (d.agentPaused ? ', and paused itself' : ''),
  'item.completed': (_d, t) => `finished their step on ${quote(t)}`,
  // An agent sent it back to an earlier agent step (card KLCTVnX8).
  'item.sentBack': (d, t) => {
    const r = text(d.reason);
    const short = r.length > 140 ? `${r.slice(0, 139)}…` : r;
    const to = text(d.toStepName);
    return `sent ${quote(t)} back to ${to || 'an earlier step'}${short ? `: “${short}”` : ''}`;
  },
  'item.updated': (d, t) => {
    const said: string[] = [];
    const title = d.title as { from?: unknown; to?: unknown } | undefined;
    const type = d.type as { to?: unknown } | undefined;
    if (title && text(title.to)) {
      const from = text(title.from);
      said.push(from ? `renamed ${quote(from)} to ${quote(text(title.to))}` : '');
    }
    if (type && text(type.to)) said.push(`changed the type of ${quote(t)} to ${text(type.to)}`);
    if (typeof d.summaryLength === 'number')
      said.push(`${d.summaryLength === 0 ? 'cleared' : 'changed'} the description of ${quote(t)}`);
    const out = said.filter(Boolean);
    return out.length ? out.join(' and ') : `updated ${quote(t)}`;
  },
  'item.deleted': (d, t) =>
    d.forever ? `deleted ${quote(text(d.title) || t)}` : `took back ${quote(t)}`,
  'item.workStopped': (d, t) => {
    const r = text(d.reason);
    const short = r.length > 140 ? `${r.slice(0, 139)}…` : r;
    return (
      (d.mode === 'cancel'
        ? `stopped the work on ${quote(t)} and cancelled it`
        : `stopped the work on ${quote(t)} and put it on hold`) + (short ? `: “${short}”` : '')
    );
  },
  'item.archived': (_d, t) => `archived ${quote(t)}`,
  'item.restored': (_d, t) => `restored ${quote(t)}`,
  'item.erasing': (_d, t) => `started deleting ${quote(t)}`,
  'item.resumed': (_d, t) => `resumed ${quote(t)}: agents may take it again`,
  'attachment.added': (d, t) => `attached ${text(d.name) || 'a file'} to ${quote(t)}`,
  'message.posted': (d, t) =>
    d.kind === 'question' ? `asked a question on ${quote(t)}` : `left a note on ${quote(t)}`,
  'decision.approved': (d, t) =>
    d.advanced === false ? `approved ${quote(t)} (more approvals needed)` : `approved ${quote(t)}`,
  'decision.sentBack': (d, t) =>
    d.moved === false ? `voted to send ${quote(t)} back` : `sent ${quote(t)} back`,
  'decision.stopped': (d, t) =>
    d.moved === false ? `voted to stop ${quote(t)}` : `stopped ${quote(t)}`,
  'decision.answered': (_d, t) => `answered a question on ${quote(t)}`,
  'finding.raised': (d, t) => `suggested ${quote(text(d.title) || t)}`,
  'finding.triaged': (d, t) => {
    const title = quote(text(d.title) || t);
    switch (text(d.outcome)) {
      case 'intake':
        return `added the suggestion ${title} to ${text(d.stepName) || 'the first step'}`;
      case 'addedToItem':
        return `added the suggestion ${title} to its item`;
      case 'dismissed': {
        const r = text(d.reason);
        const short = r.length > 140 ? `${r.slice(0, 139)}…` : r;
        return r
          ? `dismissed the suggestion ${title}: “${short}”`
          : `dismissed the suggestion ${title}`;
      }
      default:
        return `triaged the suggestion ${title}`;
    }
  },
  // Per-item paths (card st5INNZj)
  'item.shaped': (d, t) => {
    const skipped = Array.isArray(d.skipped) ? d.skipped.length : 0;
    const pending = Array.isArray(d.pending) ? d.pending.length : 0;
    return (
      (skipped
        ? `set the path of ${quote(t)}, skipping ${skipped} step${skipped === 1 ? '' : 's'}`
        : `set the path of ${quote(t)}: every step`) +
      (pending ? `, and asked to skip ${pending} people step${pending === 1 ? '' : 's'}` : '')
    );
  },
  'item.pathChanged': (d, t) => {
    const step = text(d.stepName);
    const r = text(d.reason);
    const why = r ? `: “${r.length > 140 ? `${r.slice(0, 139)}…` : r}”` : '';
    return (
      (d.change === 'ask'
        ? d.op === 'add'
          ? `asked to add ${step || 'a people step'} to ${quote(t)}`
          : `asked to skip ${step || 'a people step'} on ${quote(t)}`
        : d.change === 'unskip'
          ? `put ${step || 'a step'} back on the path of ${quote(t)}`
          : `skipped ${step || 'a step'} on ${quote(t)}`) + why
    );
  },
  'item.pathChangeDecided': (d, t) => {
    const step = text(d.stepName);
    return d.outcome === 'refused'
      ? `kept the path of ${quote(t)} as it was`
      : d.op === 'add'
        ? `added ${step || 'a people step'} to ${quote(t)}`
        : `approved skipping ${step || 'a people step'} on ${quote(t)}`;
  },
  'step.proposed': (d) => `proposed a new step ${quote(text(d.name) || null)}`,
  'step.accepted': (d) => `added the step ${quote(text(d.name) || null)} to the process`,
  'step.rejected': () => 'turned down a proposed step',
  'run.started': (_d, t) => `started a run on ${quote(t)}`,
  'run.heartbeat': (_d, t) => `is still working on ${quote(t)}`,
  'run.ended': (d, t) => {
    const how: Record<string, string> = {
      done: 'finished a run on',
      failed: 'failed a run on',
      released: 'released a run on',
      stopped: 'had a run stopped on',
    };
    return `${how[text(d.status)] ?? 'ended a run on'} ${quote(t)}${d.agentPaused ? ', and paused itself' : ''}`;
  },
  'agent.created': () => 'created an agent',
  'agent.revoked': () => 'revoked an agent',
  'agent.removed': () => 'removed an agent',
  'agent.renamed': (d) =>
    text(d.oldName) && text(d.newName)
      ? `renamed ${text(d.oldName)} to ${text(d.newName)}`
      : 'renamed an agent',
  'agent.rotated': (d) => `rotated the token of ${text(d.name) || 'an agent'}`,
  'agent.updated': (d) =>
    d.resumed
      ? `resumed ${text(d.name) || 'an agent'}`
      : `changed the settings of ${text(d.name) || 'an agent'}`,
  'project.created': (d) => `created the project ${text(d.name) ? quote(text(d.name)) : ''}`.trim(),
  'project.updated': (d) =>
    d.restored ? `restored the project ${quote(text(d.name))}` : 'updated a project',
  'project.processChanged': () => 'changed the process',
  'project.archived': (d) =>
    `archived the project ${text(d.name) ? quote(text(d.name)) : ''}`.trim(),
  'project.deleted': () => 'deleted a project',
  'project.membersChanged': (d) =>
    d.reason === 'decider' && Array.isArray(d.added)
      ? `added ${d.added.length === 1 ? 'a decider' : `${d.added.length} deciders`} to a project`
      : 'changed who is on a project',
  'workspace.created': (d) => `created the organization ${quote(text(d.name))}`,
  'workspace.updated': () => 'updated the organization',
  'workspace.deleting': () => 'started deleting the organization',
  'member.invited': () => 'invited someone',
  'member.joined': () => 'joined the organization',
  'member.roleChanged': (d) => (d.role ? `made someone ${text(d.role)}` : 'changed a role'),
  'member.removed': () => 'removed a member',
  'member.left': () => 'left the organization',
  'member.inviteRevoked': () => 'revoked an invite',
  'group.created': () => 'created a group',
  'group.updated': () => 'updated a group',
  'group.deleted': () => 'deleted a group',
};

/** "Research agent attached report.html to “Market analysis”". */
export function eventSentence(
  e: Pick<HiveEvent, 'actor' | 'type' | 'data'>,
  itemTitle: string | null = null,
): string {
  // Item DhsO9: an agent's create_item reads "<agent> created …" (the row also says "agent").
  const phrase =
    e.type === 'item.created' && e.actor.type === 'agent'
      ? `created ${quote(text(e.data?.title) || itemTitle)}`
      : (PHRASES[e.type]?.(e.data ?? {}, itemTitle) ?? 'did something');
  const via = e.type.startsWith('decision.') && e.data?.via === 'telegram' ? ' via Telegram' : '';
  return `${e.actor.name || 'Someone'} ${phrase}${via}`;
}

// ---------- filters ----------

export const TYPE_GROUPS = [
  {
    id: 'work',
    label: 'Items and suggestions',
    types: [
      'item.created',
      'item.moved',
      'item.updated',
      'item.deleted',
      'finding.raised',
      'finding.triaged',
      'item.shaped',
      'item.pathChanged',
    ],
  },
  {
    // A run starts with item.claimed and normally ends with item.completed or item.released (the
    // claim, completion and release actions write those, not run.started); run.* cover the rest.
    id: 'runs',
    label: 'Agent runs',
    types: [
      'item.claimed',
      'item.released',
      'item.completed',
      'item.sentBack',
      'run.started',
      'run.heartbeat',
      'run.ended',
      'item.workStopped',
      'item.resumed',
      'item.archived',
      'item.restored',
      'item.erasing',
    ],
  },
  {
    id: 'decisions',
    label: 'Decisions',
    types: [
      'decision.approved',
      'decision.sentBack',
      'decision.stopped',
      'decision.answered',
      'item.pathChangeDecided',
    ],
  },
  { id: 'files', label: 'Files and messages', types: ['attachment.added', 'message.posted'] },
  {
    id: 'setup',
    label: 'Setup and people',
    types: [
      'agent.created',
      'agent.revoked',
      'agent.removed',
      'agent.renamed',
      'agent.rotated',
      'agent.updated',
      'project.created',
      'project.updated',
      'project.processChanged',
      'project.archived',
      'project.deleted',
      'project.membersChanged',
      'workspace.created',
      'workspace.updated',
      'workspace.deleting',
      'member.invited',
      'member.joined',
      'member.roleChanged',
      'member.removed',
      'member.left',
      'member.inviteRevoked',
      'group.created',
      'group.updated',
      'group.deleted',
      'step.proposed',
      'step.accepted',
      'step.rejected',
    ],
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; types: readonly EventType[] }>;
export type TypeGroupId = (typeof TYPE_GROUPS)[number]['id'];

export interface FeedFilters {
  /** '' = every project. */
  projectId: string;
  /** 'all' | 'people' | 'agents' | an actor uid. */
  actor: string;
  /** '' = every type. */
  group: '' | TypeGroupId;
}
export const NO_FILTERS: FeedFilters = { projectId: '', actor: 'all', group: '' };

export type Constraint = readonly [field: string, op: '==' | 'in', value: unknown];

/** The Firestore `where` clauses of a filter set. Each combination has a composite index. */
export function feedConstraints(f: FeedFilters): Constraint[] {
  const out: Constraint[] = [];
  if (f.projectId) out.push(['projectId', '==', f.projectId]);
  if (f.actor === 'people') out.push(['actor.type', '==', 'human']);
  else if (f.actor === 'agents') out.push(['actor.type', '==', 'agent']);
  else if (f.actor !== 'all') out.push(['actor.id', '==', f.actor]);
  if (f.group) {
    const g = TYPE_GROUPS.find((x) => x.id === f.group);
    if (g) out.push(['type', 'in', [...g.types]]);
  }
  return out;
}

// ---------- days and times ----------

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - DAY)) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(new Date(ms).getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function groupByDay<T extends { data: { at: { toMillis: () => number } } }>(
  rows: T[],
  now: number,
): Array<{ key: string; label: string; rows: T[] }> {
  const out: Array<{ key: string; label: string; rows: T[] }> = [];
  for (const r of rows) {
    const ms = r.data.at.toMillis();
    const key = dayKey(ms);
    const last = out[out.length - 1];
    if (last && last.key === key) last.rows.push(r);
    else out.push({ key, label: dayLabel(ms, now), rows: [r] });
  }
  return out;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** A ticking stopwatch, "12:05" or "1:02:05". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

// ---------- runs ----------

export type RunState = 'running' | 'stalled' | 'done' | 'failed' | 'released' | 'stopped';

/** A run with no heartbeat for 10 minutes is stalled, not running. */
export function runState(run: Run, now: number): RunState {
  if (run.status !== 'running' || run.endedAt)
    return run.status === 'running' ? 'done' : run.status;
  return now - run.heartbeatAt.toMillis() >= STALE_CLAIM_MINUTES * 60_000 ? 'stalled' : 'running';
}

/** How long a run worked: to its end, to now while alive, to its last heartbeat when stalled. */
export function runWorkMs(run: Run, now: number): number {
  const state = runState(run, now);
  const end = run.endedAt?.toMillis() ?? (state === 'running' ? now : run.heartbeatAt.toMillis());
  return Math.max(0, end - run.startedAt.toMillis());
}

// ---------- agent KPIs ----------

export type WindowId = 'today' | '7d' | '30d';
export const WINDOWS: ReadonlyArray<{ id: WindowId; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
];

export function windowStart(w: WindowId, now: number): number {
  if (w === 'today') {
    const d = new Date(now);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  return now - (w === '7d' ? 7 : 30) * DAY;
}

export interface AgentStats {
  runs: number;
  completed: number;
  workMs: number;
  costEur: number;
  /** Finished runs a person has judged (approved, sent back or stopped). */
  judged: number;
  firstTimeApproved: number;
  /** 0..1, or null while nothing has been judged. */
  approvalRate: number | null;
  sendBacks: number;
  reasons: Array<{ text: string; count: number }>;
}

/** The first decision on the item after the run ended: the verdict on that run's work. */
export function verdictFor(run: Run, decisions: Row<Decision>[]): Row<Decision> | null {
  if (run.status !== 'done' || !run.endedAt) return null;
  const end = run.endedAt.toMillis();
  let best: Row<Decision> | null = null;
  for (const d of decisions) {
    if (d.data.itemId !== run.itemId || d.data.outcome === 'answered') continue;
    const at = d.data.at.toMillis();
    if (at < end) continue;
    if (!best || at < best.data.at.toMillis()) best = d;
  }
  return best;
}

export function agentStats(
  runs: Row<Run>[],
  decisions: Row<Decision>[],
  from: number,
  now: number,
): AgentStats {
  const mine = runs.filter((r) => r.data.startedAt.toMillis() >= from);
  let judged = 0;
  let firstTimeApproved = 0;
  let sendBacks = 0;
  const reasons = new Map<string, number>();
  for (const r of mine) {
    const v = verdictFor(r.data, decisions);
    if (!v) continue;
    judged += 1;
    if (v.data.outcome === 'approved') {
      const earlierSendBack = decisions.some(
        (d) =>
          d.data.itemId === r.data.itemId &&
          (d.data.outcome === 'sentBack' || d.data.outcome === 'stopped') &&
          d.data.at.toMillis() < r.data.startedAt.toMillis(),
      );
      if (!earlierSendBack) firstTimeApproved += 1;
    } else if (isSentBack(v.data.outcome)) {
      sendBacks += 1;
      const why = v.data.tags.length
        ? v.data.tags
        : v.data.rationale.trim()
          ? [v.data.rationale.trim().slice(0, 80)]
          : ['No reason given'];
      for (const t of why) reasons.set(t, (reasons.get(t) ?? 0) + 1);
    }
  }
  return {
    runs: mine.length,
    completed: mine.filter((r) => r.data.status === 'done').length,
    workMs: mine.reduce((sum, r) => sum + runWorkMs(r.data, now), 0),
    costEur: mine.reduce((sum, r) => sum + r.data.costEur, 0),
    judged,
    firstTimeApproved,
    approvalRate: judged ? firstTimeApproved / judged : null,
    sendBacks,
    reasons: [...reasons.entries()]
      .map(([t, count]) => ({ text: t, count }))
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
      .slice(0, 3),
  };
}

export const ALL_EVENT_TYPES: readonly EventType[] = EVENT_TYPES;

// ---------- one story per item (card EmDyZyfC) ----------

export interface EventDetail {
  /** What was said or concluded: a decision's reason, a run's summary. */
  note: string | null;
  /** A short fact line: where an item came from, what a run cost. */
  facts: string | null;
  /** Files the run produced (or the event attached). */
  files: Array<{ id: string; name: string; at: number }>;
}

export interface DetailContext {
  decisions: ReadonlyArray<Row<Decision>>;
  runs: ReadonlyArray<Row<Run>>;
  attachments: ReadonlyArray<Row<Attachment>>;
  /** The item's source ("Telegram", "Manual"…), for the created event. */
  source: { kind: string; label: string } | null;
}

const RUN_END_EVENTS: ReadonlySet<string> = new Set([
  'run.ended',
  'item.completed',
  'item.sentBack',
  'item.released',
  // A run stopped from the web ends with this event, not run.ended (it has the run's result too).
  'item.workStopped',
]);

/** An `item.updated` an agent wrote only to report progress or cost on the run it holds. */
export function isProgressEvent(e: HiveEvent): boolean {
  if (e.type !== 'item.updated' || !e.runId || e.actor?.type === 'human') return false;
  const d = e.data ?? {};
  const keys = Object.keys(d);
  return keys.length > 0 && keys.every((k) => k === 'progress' || k === 'costEur');
}

/**
 * Folds the progress calls of each run under one row of that run: its end row, else its claim.
 * Progress with no such row in the list stays where it is. Order is kept.
 */
export function foldProgress(rows: Row<HiveEvent>[]): {
  rows: Row<HiveEvent>[];
  byAnchor: Map<string, Row<HiveEvent>[]>;
} {
  const anchors = new Map<string, string>();
  for (const pass of [['item.claimed'], [...RUN_END_EVENTS]]) {
    for (const r of rows)
      if (r.data.runId && pass.includes(r.data.type)) anchors.set(r.data.runId, r.id);
  }
  const byAnchor = new Map<string, Row<HiveEvent>[]>();
  const kept: Row<HiveEvent>[] = [];
  for (const r of rows) {
    const anchor = isProgressEvent(r.data) && r.data.runId ? anchors.get(r.data.runId) : undefined;
    if (!anchor) {
      kept.push(r);
      continue;
    }
    byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), r]);
  }
  return { rows: kept, byAnchor };
}

/** The extra lines under one event of an item's History: reasons, results, attachments. */
export function eventDetail(event: Row<HiveEvent>, ctx: DetailContext): EventDetail {
  const e = event.data;
  const out: EventDetail = { note: null, facts: null, files: [] };
  if (e.type === 'item.created' && ctx.source?.label && ctx.source.kind !== 'agent') {
    out.facts = `from ${ctx.source.label}`;
  } else if (e.type.startsWith('decision.')) {
    out.note = ctx.decisions.find((d) => d.id === event.id)?.data.rationale || null;
  } else if (RUN_END_EVENTS.has(e.type) && e.runId) {
    const run = ctx.runs.find((r) => r.id === e.runId);
    if (run) {
      out.note = run.data.summary || null;
      const bits = [`€${run.data.costEur.toFixed(2)}`];
      if (run.data.tokensIn || run.data.tokensOut)
        bits.push(`${formatTokens(newTokens(run.data))} tokens`);
      out.facts = bits.join(' · ');
    }
    out.files = ctx.attachments
      .filter((a) => a.data.runId === e.runId)
      .map((a) => ({ id: a.id, name: a.data.name, at: a.data.at.toMillis() }));
  } else if (e.type === 'attachment.added') {
    const name = typeof e.data?.name === 'string' ? e.data.name : '';
    out.files = ctx.attachments
      .filter(
        (a) => a.data.name === name && Math.abs(a.data.at.toMillis() - e.at.toMillis()) < 5000,
      )
      .map((a) => ({ id: a.id, name: a.data.name, at: a.data.at.toMillis() }));
  }
  return out;
}

type Prog = { progress?: { done?: number; total?: number } | null; costEur?: number };
/** "2 of 6" or "cost updated" for one progress call. */
export function progressText(d: unknown): string {
  const x = (d ?? {}) as Prog;
  const p = x.progress;
  const bits: string[] = [];
  if (p && typeof p.done === 'number' && typeof p.total === 'number')
    bits.push(`step ${p.done} of ${p.total}`);
  if (typeof x.costEur === 'number') bits.push(`cost €${x.costEur.toFixed(2)}`);
  return bits.join(' · ') || 'progress reported';
}

/** "Progress 6 of 6 · 5 updates": the latest figure of a run's folded progress calls (newest first). */
export function progressSummary(rows: ReadonlyArray<Row<HiveEvent>>): string {
  const latest = rows.find((r) => {
    const p = (r.data.data as Prog | undefined)?.progress;
    return p && typeof p.done === 'number';
  });
  const p = (latest?.data.data as Prog | undefined)?.progress;
  const n = rows.length;
  const count = `${n} update${n === 1 ? '' : 's'}`;
  return p ? `Progress ${p.done} of ${p.total} · ${count}` : `Progress · ${count}`;
}
