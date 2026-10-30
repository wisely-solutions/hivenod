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
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  types: readonly InboxEventType[];
}>;
export type ThreadGroupId = (typeof THREAD_GROUPS)[number]['id'];

/** Every type the feed shows (Firestore takes at most 30 values in an `in`). */
export const FEED_TYPES: readonly InboxEventType[] = [
  ...new Set(THREAD_GROUPS.flatMap((g) => g.types as readonly InboxEventType[])),
];

export interface ThreadFeedFilters {
  /** '' = every group. */
  group: '' | ThreadGroupId;
  /** 'all' | 'people' | 'agents' | an actor uid. */
  actor: string;
}
export const NO_THREAD_FILTERS: ThreadFeedFilters = { group: '', actor: 'all' };

export type Constraint = readonly [field: string, op: '==' | 'in', value: unknown];

/** The `where` clauses of the feed (one composite index: memberUid, type, at). */
export function threadFeedConstraints(uid: string, group: '' | ThreadGroupId): Constraint[] {
  const g = THREAD_GROUPS.find((x) => x.id === group);
  return [
    ['memberUid', '==', uid],
    ['type', 'in', [...(g ? g.types : FEED_TYPES)]],
  ];
}

type Ev = Pick<InboxEvent, 'actor' | 'type' | 'data'>;

/** Whether a row belongs in the view: the actor filter, and a send back's side (a person's is a decision). */
export function matches(e: Ev, f: ThreadFeedFilters): boolean {
  if (f.actor === 'people' && e.actor.type !== 'human') return false;
  if (f.actor === 'agents' && e.actor.type !== 'agent') return false;
  if (!['all', 'people', 'agents'].includes(f.actor) && e.actor.id !== f.actor) return false;
  if (e.type === 'plan.sent_back') {
    if (f.group === 'decisions' && e.actor.type !== 'human') return false;
    if (f.group === 'plans' && e.actor.type === 'human') return false;
  }
  return true;
}

/** The group a row is shown in (its dot colour). */
export function groupOf(e: Ev): ThreadGroupId {
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
}
export function threadSentence(e: Ev, folded = 0): Sentence {
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
