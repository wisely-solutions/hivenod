/**
 * Activity on threads (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7): the feed reads the
 * member's `inboxEvents` (the rules let a member read only their own threads' events, plus what
 * the organization's agents did on them; there is no admin view of other members' threads).
 * One query shape for every filter: memberUid ==, type in (a group's types), at desc. The actor
 * filter is applied to the rows (it needs no index).
 */
import { outcomeType, type InboxEvent, type InboxEventType } from '@hive/shared';
import type { Row } from '../lib/live';

export const THREAD_GROUPS = [
  {
    id: 'threads',
    label: 'Threads',
    types: [
      'thread.created',
      'inbox.added',
      'thread.filed',
      'thread.moved',
      'thread.flagged',
      'thread.due',
      'thread.closed',
      'thread.restored',
      'thread.ignored',
    ],
  },
  {
    id: 'plans',
    label: 'Plans and steps',
    types: [
      'plan.proposed',
      'outcome.proposed',
      'plan.edited',
      'outcome.started',
      'step.progress',
      'outcome.done',
      'outcome.failed',
      'plan.sent_back',
    ],
  },
  {
    id: 'decisions',
    label: 'Decisions',
    types: [
      'outcome.approved',
      'outcome.rejected',
      'outcome.revise_requested',
      'plan.approved',
      'plan.rejected',
      'plan.stopped',
      'plan.sent_back',
      'thread.not_now',
      'thread.answered',
    ],
  },
  { id: 'summaries', label: 'Summaries', types: ['summary.written'] },
  {
    // Scheduled tasks (slice 8): the member's schedules, their runs, the Off switch. A proposal
    // and its decision are the schedule outcome's events (`data.type === 'schedule'`, see
    // `isScheduleEvent`); the rows of the other outcome types are dropped on the client.
    id: 'schedules',
    label: 'Schedules',
    types: [
      'outcome.proposed',
      'outcome.approved',
      'outcome.rejected',
      'schedule.created',
      'schedule.updated',
      'schedule.paused',
      'schedule.resumed',
      'schedule.deleted',
      'run.fired',
      'run.done',
      'run.cantRun',
      'run.decided',
      'run.expired',
      'agents.off',
      'agents.on',
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  types: readonly InboxEventType[];
}>;
export type ThreadGroupId = (typeof THREAD_GROUPS)[number]['id'];

/** Every type the feed shows. */
export const FEED_TYPES: readonly InboxEventType[] = [
  ...new Set(THREAD_GROUPS.flatMap((g) => g.types as readonly InboxEventType[])),
];

/** Firestore takes at most 30 values in an `in`: a view with more types asks in chunks. */
export const IN_LIMIT = 30;
export function typeChunks(types: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < types.length; i += IN_LIMIT) out.push(types.slice(i, i + IN_LIMIT));
  return out;
}
/** The most queries any view makes (the feed hook runs this many listeners). */
export const MAX_CHUNKS = 2;

export interface ThreadFeedFilters {
  /** '' = every group. */
  group: '' | ThreadGroupId;
  /** 'all' | 'people' | 'agents' | an actor uid. */
  actor: string;
}
export const NO_THREAD_FILTERS: ThreadFeedFilters = { group: '', actor: 'all' };

export type Constraint = readonly [field: string, op: '==' | 'in', value: unknown];

/** The `where` clauses of the feed (one composite index: memberUid, type, at). */
export function threadFeedConstraints(
  uid: string,
  group: '' | ThreadGroupId,
  chunk = 0,
): Constraint[] {
  const g = THREAD_GROUPS.find((x) => x.id === group);
  return [
    ['memberUid', '==', uid],
    ['type', 'in', typeChunks(g ? g.types : FEED_TYPES)[chunk] ?? []],
  ];
}
/** How many queries a view needs (the all view is more than one `in`). */
export function feedChunks(group: '' | ThreadGroupId): number {
  const g = THREAD_GROUPS.find((x) => x.id === group);
  return typeChunks(g ? g.types : FEED_TYPES).length;
}

/** A row of the schedule outcome (proposal, approval, turn down), not of another outcome type. */
export function isScheduleEvent(e: Ev): boolean {
  if (e.type.startsWith('schedule.') || e.type.startsWith('run.') || e.type.startsWith('agents.'))
    return true;
  return /^outcome\./.test(e.type) && e.data.type === 'schedule';
}

type Ev = Pick<InboxEvent, 'actor' | 'type' | 'data'>;

/** Whether a row belongs in the view: the actor filter, and a send back's side (a person's is a decision). */
export function matches(e: Ev, f: ThreadFeedFilters): boolean {
  if (f.actor === 'people' && e.actor.type !== 'human') return false;
  if (f.actor === 'agents' && e.actor.type !== 'agent') return false;
  if (!['all', 'people', 'agents'].includes(f.actor) && e.actor.id !== f.actor) return false;
  const sched = isScheduleEvent(e);
  if (f.group === 'schedules') return sched;
  // The other outcome types' rows are not schedule rows; in a plans or decisions view the
  // schedule outcome's rows belong to Schedules.
  if (/^outcome\./.test(e.type) && f.group !== '' && sched) return false;
  if (e.type === 'plan.sent_back') {
    if (f.group === 'decisions' && e.actor.type !== 'human') return false;
    if (f.group === 'plans' && e.actor.type === 'human') return false;
  }
  return true;
}

/** The group a row is shown in (its dot colour). */
export function groupOf(e: Ev): ThreadGroupId {
  if (isScheduleEvent(e)) return 'schedules';
  if (e.type === 'plan.sent_back') return e.actor.type === 'human' ? 'decisions' : 'plans';
  return (
    THREAD_GROUPS.find((g) => (g.types as readonly string[]).includes(e.type))?.id ?? 'threads'
  );
}

/**
 * Progress lines are a heartbeat (every few minutes on a running step): consecutive ones of the
 * same step are folded into the newest, which counts them.
 */
export function foldProgress<T extends Row<Ev>>(rows: readonly T[]): Array<T & { folded: number }> {
  const out: Array<T & { folded: number }> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (
      r.data.type === 'step.progress' &&
      last?.data.type === 'step.progress' &&
      last.data.data.outcomeId === r.data.data.outcomeId
    ) {
      last.folded += 1;
      continue;
    }
    out.push({ ...r, folded: 0 });
  }
  return out;
}

// ---------- sentences ----------

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const clip = (t: string, n = 120) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** A step's name from its outcome type ("Build"), else what the event recorded. */
export function stepName(d: Record<string, unknown>): string {
  return str(d.stepLabel) || outcomeType(str(d.type))?.label || str(d.type) || 'a step';
}

/** "PR #86" for a pull request link, else "link". */
export function linkLabel(url: string): string {
  const pr = /\/pull\/(\d+)/.exec(url) ?? /\/merge_requests\/(\d+)/.exec(url);
  return pr ? `PR #${pr[1]}` : 'link';
}

/**
 * One row in words: `before` and `after` go round the thread's title (the link). The actor's
 * name comes first, outside these. Exhaustive over the feed's types.
 */
export interface Sentence {
  before: string;
  after: string;
  /** A link shown after the sentence (a PR, the result). */
  link?: { href: string; label: string } | null;
  /**
   * What the sentence's link is: the thread (default), the schedule (its page), or nothing (the
   * sentence is complete without it).
   */
  target?: 'thread' | 'schedule' | 'none';
}

/** Why a run could not happen, in words (the run's `why.code`). */
export const WHY_TEXT: Record<string, string> = {
  offline: 'the agent was offline',
  off: 'the agent is turned Off',
  paused: 'the agent is paused',
  hostDown: 'the agent’s computer was not running',
  noStart: 'the agent did not start it',
  failed: 'the run failed',
  cliOld: 'the agent’s Hivenod is out of date',
};
const RUN_CHOICE: Record<string, string> = {
  runNow: 'Run now',
  later: 'Try later',
  skip: 'Skip this one',
};

/** The sentence of a schedule, run or Off event (null for any other type). */
function scheduleSentence(e: Ev, sched: string | null | undefined): Sentence | null {
  const d = e.data;
  const name = sched ? ` · ${sched}` : '';
  switch (e.type as string) {
    case 'schedule.created':
      return { before: 'added the schedule ', after: '', target: 'schedule' };
    case 'schedule.updated':
      return {
        before: 'edited the schedule ',
        after: d.ruleChanged ? ' · new times' : '',
        target: 'schedule',
      };
    case 'schedule.paused':
      return { before: 'paused the schedule ', after: '', target: 'schedule' };
    case 'schedule.resumed':
      return { before: 'resumed the schedule ', after: '', target: 'schedule' };
    case 'schedule.deleted':
      return { before: 'deleted the schedule ', after: '', target: 'schedule' };
    case 'outcome.proposed':
      if (d.type !== 'schedule') return null;
      return {
        before: 'proposed the schedule ',
        after: str((d.fields as Record<string, unknown> | undefined)?.sentence)
          ? ` · ${clip(str((d.fields as Record<string, unknown>).sentence), 80)}`
          : '',
        target: 'schedule',
      };
    case 'outcome.approved':
      if (d.type !== 'schedule') return null;
      return {
        before: `${d.edited ? 'edited and approved' : 'approved'} the schedule `,
        after: '',
        target: 'schedule',
      };
    case 'outcome.rejected':
      if (d.type !== 'schedule') return null;
      return { before: 'turned down the schedule ', after: '', target: 'schedule' };
    case 'run.fired':
      return { before: 'started the scheduled run ', after: name };
    case 'run.done':
      return { before: 'finished the scheduled run ', after: name };
    case 'run.expired':
      return { before: 'let the scheduled run ', after: ` expire${name}` };
    case 'run.cantRun': {
      const why = WHY_TEXT[str(d.why)];
      return {
        before: 'could not run ',
        after: `${why ? `: ${why}` : ''} · asked what to do${name}`,
      };
    }
    case 'run.decided':
      return {
        before: `chose “${RUN_CHOICE[str(d.choice)] ?? 'an option'}” for `,
        after: name,
      };
    case 'agents.off': {
      const n = Array.isArray(d.agents) ? d.agents.length : 0;
      return {
        before: d.all ? 'turned all agents Off' : `turned ${n} agent${n === 1 ? '' : 's'} Off`,
        after: ' · no scheduled runs start',
        target: 'none',
      };
    }
    case 'agents.on': {
      return { before: 'turned agents back On', after: '', target: 'none' };
    }
    default:
      return null;
  }
}

export function threadSentence(e: Ev, folded = 0, schedule?: string | null): Sentence {
  const sch = scheduleSentence(e, schedule);
  if (sch) return sch;
  const d = e.data;
  const human = e.actor.type === 'human';
  const reason = clip(str(d.reason) || str(d.instruction));
  const followed = (decision: 'approve' | 'changes' | 'reject') => {
    const rec = recommendationKind(str(d.recommended));
    if (!rec) return '';
    return rec === decision ? ' · followed the recommendation' : ' · against the recommendation';
  };
  switch (e.type as string) {
    case 'thread.created':
      return { before: 'started a new thread: ', after: d.templateId ? ' · Development' : '' };
    case 'inbox.added':
      return d.newThread
        ? { before: 'brought in a new thread: ', after: '' }
        : { before: 'added a message to ', after: d.reopened ? ' and reopened it' : '' };
    case 'thread.filed':
      return {
        before: 'filed ',
        after: str(d.name) ? ` under ${str(d.name)}` : '',
      };
    case 'thread.moved':
      return { before: 'moved ', after: ' to another subject' };
    case 'thread.flagged':
      return { before: d.urgent ? 'flagged ' : 'unflagged ', after: '' };
    case 'thread.due':
      return { before: d.due ? 'set a due date on ' : 'cleared the due date of ', after: '' };
    case 'thread.closed':
      return { before: 'closed ', after: '' };
    case 'thread.restored':
      return { before: 'reopened ', after: '' };
    case 'thread.ignored':
      return { before: 'ignored ', after: '' };
    case 'plan.proposed': {
      const n = Array.isArray(d.steps) ? d.steps.length : 0;
      return {
        before: `proposed a ${d.templateId ? 'Development ' : ''}plan on `,
        after: n ? ` · ${n} steps` : '',
      };
    }
    case 'outcome.proposed':
      return { before: `proposed ${stepName(d)} on `, after: '' };
    case 'plan.edited':
      return { before: 'edited the plan on ', after: '' };
    case 'outcome.started':
      return { before: `started ${stepName(d)} on `, after: '' };
    case 'step.progress': {
      const pct = typeof d.percent === 'number' ? ` · ${d.percent}%` : '';
      return {
        before: 'is working on ',
        after: `: “${clip(str(d.line))}”${pct}${folded ? ` · ${folded + 1} updates` : ''}`,
      };
    }
    case 'outcome.done':
      return {
        before: `finished ${stepName(d)} on `,
        after: '',
        link: str(d.permalink)
          ? { href: str(d.permalink), label: linkLabel(str(d.permalink)) }
          : null,
      };
    case 'outcome.failed':
      return {
        before: `could not finish ${stepName(d)} on `,
        after: str(d.error) ? `: “${clip(str(d.error))}”` : '',
      };
    case 'plan.sent_back':
      return human
        ? {
            before: `asked for changes at ${str(d.stepLabel) || 'a step'} on `,
            after: ` → back to ${str(d.toLabel) || 'an earlier step'}${reason ? `: “${reason}”` : ''}${followed('changes')}`,
          }
        : {
            before: 'sent ',
            after: ` back to an earlier step${reason ? `: “${reason}”` : ''}`,
          };
    case 'outcome.approved':
      return {
        before: `${d.edited ? 'edited and approved' : 'approved'} ${stepName(d)} on `,
        after: followed('approve'),
      };
    case 'outcome.rejected':
      return {
        before: `${d.planId ? 'did not approve' : 'turned down'} ${stepName(d)} on `,
        after: (reason ? `: “${reason}”` : '') + followed('reject'),
      };
    case 'outcome.revise_requested':
      return d.instruction === null && Array.isArray(d.chips) && d.chips.length === 0
        ? { before: `took back the request for changes to ${stepName(d)} on `, after: '' }
        : {
            before: `asked for changes to ${stepName(d)} on `,
            after: (reason ? `: “${reason}”` : '') + followed('changes'),
          };
    case 'plan.approved':
      return { before: 'approved the plan on ', after: followed('approve') };
    case 'plan.rejected':
      return {
        before: 'rejected the plan on ',
        after: (reason ? `: “${reason}”` : '') + followed('reject'),
      };
    case 'plan.stopped':
      return { before: 'stopped the plan on ', after: '' };
    case 'thread.not_now':
      return { before: 'put ', after: ' off until tomorrow (Not now)' };
    case 'thread.answered':
      return { before: 'answered the question on ', after: `: “${clip(str(d.answer))}”` };
    case 'summary.written':
      return {
        before: 'wrote the summary of ',
        after: d.version ? ` · v${String(d.version)}` : '',
      };
    default:
      return { before: 'updated ', after: '' };
  }
}

/**
 * What a recommended action asks for, from its words ("Approve", "Ship it", "Send back to
 * Build", "Reject"): approve, changes or reject; null when the words say none of these.
 */
export function recommendationKind(action: string): 'approve' | 'changes' | 'reject' | null {
  const a = action.toLowerCase();
  if (!a.trim()) return null;
  if (/\b(changes?|send (it )?back|revise|rework|fix|redo)\b/.test(a)) return 'changes';
  if (/\b(reject|decline|don'?t|do not|stop|drop|no\b|not approve|turn down)/.test(a))
    return 'reject';
  if (
    /\b(approve|accept|ship|merge|go|yes|build|release|send|reply|book|ok|proceed|start)\b/.test(a)
  )
    return 'approve';
  return null;
}
