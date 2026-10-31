/**
 * Inbox outcomes (item 4PEHrOW5IfXBQWgOK9wo): what can come of a thread. THE ONE registry, used
 * by the web app, the agent tools (TypeScript and Go) and the rules:
 *  - the Go CLI embeds it as cli/internal/actions/outcomes.json;
 *  - firestore.rules holds the generated block between "BEGIN outcome registry" and "END";
 * both are kept equal to this file by scripts/inbox-outcomes.test.mjs (UPDATE_GO_CONTRACT=1 pnpm
 * test:scripts rewrites them). Adding a type is one entry here plus that command.
 *
 * An agent proposes an outcome; the member approves (maybe after editing its fields) or rejects
 * it; nothing is carried out before the approval. `executor: 'agent'` outcomes are then carried
 * out by the thread's home agent (the one that brought it in), which reports outcome_done;
 * `executor: 'none'` ones take effect on the approval itself. `after` is the thread's state once
 * the outcome is done.
 */

import { ActionError } from './actions';
import type { ThreadState } from './inbox';

/** How sure the agent is of a proposed outcome (item kt3E7u9EliL3q2veDDI0). */
export const OUTCOME_CONFIDENCE = ['high', 'medium', 'low'] as const;
export type OutcomeConfidence = (typeof OUTCOME_CONFIDENCE)[number];

export type OutcomeFieldKind = 'text' | 'line' | 'datetime' | 'boolean';
export interface OutcomeField {
  kind: OutcomeFieldKind;
  label: string;
  required?: boolean;
  /** Characters, for text and line (defaults: text 20000, line 300). */
  max?: number;
  /** For the agent: what goes in it. */
  help: string;
  /** A line must match it (a JavaScript and Go regular expression), e.g. a number of days. */
  pattern?: string;
}
/** 'agent': an approved outcome or plan step the agent has yet to carry out. */
export type WaitingOn = 'them' | 'thirdParty' | 'date' | 'item' | 'agent';
export interface OutcomeType {
  /** UI name. */
  label: string;
  /** The approve button. */
  approve: string;
  /** For the agent: when to propose it. */
  description: string;
  fields: Record<string, OutcomeField>;
  executor: 'agent' | 'none';
  after: { state: 'waiting' | 'done' | 'ignored'; waitingOn?: WaitingOn };
  /** For waitingOn 'date': the datetime field the thread waits until. */
  untilField?: string;
  /**
   * A tidy-up type (item kt3E7u9EliL3q2veDDI0): it takes effect on approval and sends nothing,
   * so the member may approve it in one batch with others (the web app's tidy-ups card, when
   * proposed with high confidence). Never on a type that sends.
   */
  batchable?: boolean;
  /**
   * Who does the step (item qwFAWxZM5xkcE7PPjAzi, plans): 'agent' (an action, the default) or
   * 'human' (a person-approval gate the member decides; never carried out by an agent). The same
   * words as a process step's kind.
   */
  kind?: OutcomeKind;
  /** Allowed as a step of a plan. */
  plan?: boolean;
  /** Only as a step of a plan: outcome_propose refuses it alone. */
  planOnly?: boolean;
  /**
   * Retired (item OE8FmrTaIxFVGcaeGG3N, slice 5: Calendar removed): kept so old records still
   * read and render ("Booking (retired)"), never proposed again (not a plan step, not alone) and
   * never approved.
   */
  retired?: boolean;
  /**
   * External (Their reply, ./theirreply.ts): an agent step that waits on someone outside Hivenod;
   * the agent drafts each message for the member's approval and judges their reply.
   */
  external?: boolean;
  /**
   * A long step (item OE8FmrTaIxFVGcaeGG3N, slice 6: development plans): hours of agent work
   * (Build, Release), reported started, with progress, then done.
   */
  long?: boolean;
  /**
   * Proposed only through its own agent tool (scheduled tasks: `schedule_propose`, which writes
   * the schedule doc in the same batch): never by outcome_propose alone, never a plan step.
   */
  ownTool?: string;
}
export type OutcomeKind = 'agent' | 'human';

const text = (label: string, help: string, required = true): OutcomeField => ({
  kind: 'text',
  label,
  help,
  ...(required ? { required } : {}),
});
const line = (label: string, help: string, required = true): OutcomeField => ({
  kind: 'line',
  label,
  help,
  ...(required ? { required } : {}),
});

export const OUTCOMES = {
  reply: {
    label: 'Reply',
    approve: 'Send',
    description:
      "Answer them in the member's voice. Also for a holding reply that keeps the thread open (holding: true).",
    fields: {
      text: text('Reply', 'The answer, ready to send as written'),
      holding: {
        kind: 'boolean',
        label: 'Holding reply',
        help: 'true when it only says you are on it',
      },
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
    plan: true,
  },
  reply_book: {
    label: 'Booking (retired)',
    approve: 'Retired',
    description:
      'Retired with Calendar (2026-10-30): never propose it. Propose a reply that suggests times instead.',
    fields: {
      text: text('Reply', 'The answer, ready to send as written'),
      start: {
        kind: 'datetime',
        label: 'Starts',
        required: true,
        help: 'ISO 8601 with its offset, e.g. 2026-11-03T10:00:00+00:00',
      },
      end: {
        kind: 'datetime',
        label: 'Ends',
        required: true,
        help: 'ISO 8601 with its offset, after start',
      },
      with: line('With', 'Who is invited: names or emails, separated by commas'),
      title: line('Title', 'The meeting title', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
    planOnly: true,
    retired: true,
  },
  book: {
    label: 'Booking (retired)',
    approve: 'Retired',
    description:
      'Retired with Calendar (2026-10-30): never propose it. Propose a reply that suggests times instead.',
    fields: {
      start: {
        kind: 'datetime',
        label: 'Starts',
        required: true,
        help: 'ISO 8601 with its offset, e.g. 2026-11-03T10:00:00+00:00',
      },
      end: {
        kind: 'datetime',
        label: 'Ends',
        required: true,
        help: 'ISO 8601 with its offset, after start',
      },
      with: line('With', 'Who is invited: names or emails, separated by commas'),
      title: line('Title', 'The meeting title', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
    planOnly: true,
    retired: true,
  },
  no_reply: {
    label: 'No reply needed',
    approve: 'Close',
    description:
      'Nothing to answer: an FYI, already handled, or the member answered outside Hivenod.',
    fields: { reason: line('Why', 'One line on why no answer is needed', false) },
    executor: 'none',
    after: { state: 'done' },
    batchable: true,
  },
  make_it_work: {
    label: 'Make it work (retired)',
    approve: 'Retired',
    description:
      'Retired with Projects (2026-10-30): never propose it. Propose a Development plan (plan_propose template dev) instead.',
    fields: {
      title: line('Item title', 'The work, as an item title'),
      brief: text('Brief', 'What is asked, by whom, and what done looks like', false),
      project: line('Project', 'The project id or name', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'item' },
    planOnly: true,
    retired: true,
  },
  handover: {
    label: 'Hand over',
    approve: 'Hand over',
    description: "Loop in someone else, or another organization's agent.",
    fields: {
      to: line('To', 'Who takes it over'),
      note: text('Note', 'What you tell them', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'thirdParty' },
    plan: true,
  },
  snooze: {
    label: 'Snooze',
    approve: 'Snooze',
    description: 'Come back to it later: the thread waits until the date, then wakes up.',
    fields: {
      until: {
        kind: 'datetime',
        label: 'Until',
        required: true,
        help: 'ISO 8601, e.g. 2026-11-03T09:00:00Z',
      },
      reason: line('Why', 'What you are waiting for', false),
    },
    executor: 'none',
    after: { state: 'waiting', waitingOn: 'date' },
    untilField: 'until',
    batchable: true,
    plan: true,
  },
  nudge: {
    label: 'Nudge',
    approve: 'Send nudge',
    description: 'They have not answered for a while: a short reminder.',
    fields: { text: text('Nudge', 'The reminder, ready to send as written') },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
    plan: true,
  },
  ignore: {
    label: 'Ignore',
    approve: 'Ignore',
    description: 'Not for the member: spam, noise, not theirs.',
    fields: { reason: line('Why', 'One line', false) },
    executor: 'none',
    after: { state: 'ignored' },
    batchable: true,
  },
  // Development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6, ./planTemplates.ts): the agent steps
  // of the Development template. While one runs after another, the thread waits on the work.
  shape: {
    label: 'Shape',
    approve: 'Approve',
    description:
      'Development, step 1: research the idea, write the proposal into the summary (ask: build this?), attach drafts, give the size S/M/L.',
    fields: { idea: text('Idea', 'What is to be built, as the member asked it', false) },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'item' },
    plan: true,
    planOnly: true,
  },
  build: {
    label: 'Build',
    approve: 'Approve',
    description:
      'Development: build what the approved idea says in a worktree; end with an open pull request, local checks green, NOT merged (Release merges it). Report the PR link and what changed.',
    fields: { brief: text('Brief', 'What to build (default: what Approve idea approved)', false) },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'item' },
    plan: true,
    planOnly: true,
    long: true,
  },
  // Keep green (slice 6c): after Build, the agent keeps the open pull request green and current
  // with main (rebase, local checks, fixes) until Ship it? is approved. It reports done once green
  // and current (Ship it? is offered), and while Ship it? waits it reports re-checks on the done
  // step (step_progress check: rechecking, green, blocked).
  keepgreen: {
    label: 'Keep green',
    approve: 'Approve',
    description:
      'Development: keep the open pull request green and current with main: rebase it when main moves, rerun the local checks, fix failures, until it is green and up to date (report done: Ship it? is offered). While Ship it? waits, re-green it whenever main moves (step_progress check rechecking, then green). Unsolvable (a conflict that needs a product decision, the same check failing after 3 fixes, an infrastructure failure): report failed with the evidence.',
    fields: {},
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'item' },
    plan: true,
    planOnly: true,
    long: true,
  },
  release: {
    label: 'Release + live check',
    approve: 'Approve',
    description:
      'Development: merge the approved pull request(s), run the release checks, release, check it live; report the merge sha, release number, live commit, production URL and screenshots.',
    fields: { notes: text('Notes', 'Anything the release must know', false) },
    executor: 'agent',
    after: { state: 'done' },
    plan: true,
    planOnly: true,
    long: true,
  },
  // Their reply (./theirreply.ts): a step that waits on someone outside Hivenod. At its turn the
  // agent drafts the ask (step_ask) for the member's approval, sends it, and the step waits on them;
  // their reply wakes the agent (reason external_reply), which reports it done with the reply as
  // evidence, or drafts a follow-up. No reply after remindAfterDays working days: one reminder.
  their_reply: {
    label: 'Their reply',
    approve: 'Approve',
    description:
      "A plan step that waits on one person outside Hivenod (a client, a supplier) reached by a message: at its turn draft the ask in the member's voice with step_ask (nothing is sent before the member approves it), send it, report step_sent; their reply wakes you (external_reply): a clear yes is outcome_done with evidence (the inbound messageId and the quote), anything else a follow-up step_ask. One person per step.",
    fields: {
      who: line('Who', 'Their name'),
      org: line('Organization', 'Their company or team', false),
      channel: line('Channel', 'Where you reach them: mail, teams, slack… (one you can send on)'),
      address: line('Address', 'Their address or handle on that channel'),
      need: line('Need', 'One line: what we need from them'),
      remindAfterDays: {
        kind: 'line',
        label: 'Remind after (working days)',
        help: 'Working days without a reply before one reminder is drafted, 1-30 (default 3)',
        max: 2,
        pattern: '^([1-9]|[12][0-9]|30)$',
      },
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
    external: true,
    plan: true,
    planOnly: true,
  },
  approval: {
    label: 'Your approval',
    approve: 'Approve',
    description:
      'A plan step for the member: a gate they decide before the next steps run. Put one before anything that changes money, prices, contracts or public content. Never carried out by an agent.',
    fields: {
      what: line('What you approve', 'One line: what the member approves'),
      detail: text('Detail', 'The change, e.g. old → new prices', false),
      link: line('Link', 'Where to look, an http(s) link', false),
    },
    executor: 'none',
    after: { state: 'done' },
    kind: 'human',
    plan: true,
    planOnly: true,
  },
  // Scheduled tasks (design ~/drafts/schedules, slice 2, ./scheduleDocs.ts): the agent proposes a
  // schedule (a `proposed` schedules/{sid} doc); the member's approval activates it in the same
  // batch (approveOutcome). Nothing to carry out.
  schedule: {
    label: 'Schedule',
    approve: 'Set up schedule',
    description:
      'A recurring or later task the member asked for: proposed with schedule_propose (never outcome_propose), with the plan each run follows.',
    fields: {
      scheduleId: line('Schedule', 'The proposed schedule (set by schedule_propose)'),
      sentence: line('When', 'The rule in words, e.g. "Monthly · day 1 · 09:00 Lisbon"'),
      ends: line(
        'Also ends',
        'Other schedules of this agent that the same approval ends (a merge): their ids, comma separated (set by schedule_propose with replaces as a list)',
        false,
      ),
    },
    executor: 'none',
    after: { state: 'done' },
    ownTool: 'schedule_propose',
  },
  // End a schedule (scheduled tasks): the agent proposes it with schedule_end; the member's
  // approval ends the schedule (state ended: no future runs, past runs and their threads stay) in
  // the same batch (approveOutcome). Nothing to carry out.
  schedule_end: {
    label: 'End schedule',
    approve: 'End schedule',
    description:
      'Stop a schedule the agent runs for good: proposed with schedule_end (never outcome_propose), with the reason. Past runs stay.',
    fields: {
      scheduleId: line('Schedule', 'The schedule to end (set by schedule_end)'),
      reason: line('Why', 'One line: why it should end'),
    },
    executor: 'none',
    after: { state: 'done' },
    ownTool: 'schedule_end',
  },
} as const satisfies Record<string, OutcomeType>;

/** The outcome types of scheduled tasks (their own tools): a schedule's proposal, ending one. */
export const isScheduleType = (t: string) => t === 'schedule' || t === 'schedule_end';

export type OutcomeTypeId = keyof typeof OUTCOMES;
export const OUTCOME_TYPES = Object.keys(OUTCOMES) as OutcomeTypeId[];
export const MAX_OUTCOME_FIELDS = 10;

/** A type's kind (default 'agent'). */
export function outcomeKind(id: string): OutcomeKind {
  return outcomeType(id)?.kind ?? 'agent';
}
/** The types allowed as plan steps, in registry order. */
export const PLAN_TYPES = OUTCOME_TYPES.filter(
  (k) => (OUTCOMES as Record<string, OutcomeType>)[k]!.plan === true,
);
/** The types an agent may propose alone (outcome_propose). */
export const SINGLE_TYPES = OUTCOME_TYPES.filter(
  (k) =>
    (OUTCOMES as Record<string, OutcomeType>)[k]!.planOnly !== true &&
    (OUTCOMES as Record<string, OutcomeType>)[k]!.ownTool === undefined,
);
/** Retired types (bookings, slice 5): old records only. */
export function isRetiredOutcome(id: string): boolean {
  return outcomeType(id)?.retired === true;
}

export function outcomeType(id: string): OutcomeType | null {
  return Object.prototype.hasOwnProperty.call(OUTCOMES, id)
    ? (OUTCOMES as Record<string, OutcomeType>)[id]!
    : null;
}

/** A bad outcome field: an ActionError, so callers show its message. */
export class OutcomeFieldError extends ActionError {}

/**
 * Checks and cleans an outcome's fields against its type: strings trimmed and within bounds,
 * datetimes normalized to ISO with milliseconds, unknown fields refused, required ones present.
 */
export function cleanOutcomeFields(
  typeId: string,
  fields: Readonly<Record<string, unknown>>,
): Record<string, string | boolean> {
  const t = outcomeType(typeId);
  if (!t)
    throw new OutcomeFieldError(
      `Unknown outcome type ${typeId}. Types: ${OUTCOME_TYPES.join(', ')}.`,
    );
  const out: Record<string, string | boolean> = {};
  for (const k of Object.keys(fields).sort())
    if (!Object.prototype.hasOwnProperty.call(t.fields, k))
      throw new OutcomeFieldError(
        `${typeId} has no field ${k}. Its fields: ${Object.keys(t.fields).join(', ')}.`,
      );
  for (const [k, f] of Object.entries(t.fields)) {
    const v = fields[k];
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      if (f.required) throw new OutcomeFieldError(`${typeId} needs ${k}.`);
      continue;
    }
    if (f.kind === 'boolean') {
      if (typeof v !== 'boolean') throw new OutcomeFieldError(`${k} is true or false.`);
      out[k] = v;
      continue;
    }
    if (typeof v !== 'string') throw new OutcomeFieldError(`${k} is text.`);
    const s = v.trim();
    if (f.kind === 'datetime') {
      const ms = Date.parse(s);
      if (Number.isNaN(ms) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(s))
        throw new OutcomeFieldError(
          `${k} is an ISO 8601 time with its offset, e.g. 2026-11-03T09:00:00Z.`,
        );
      out[k] = new Date(ms).toISOString();
      continue;
    }
    const max = f.max ?? (f.kind === 'text' ? 20_000 : 300);
    if (s.length > max) throw new OutcomeFieldError(`${k} is at most ${max} characters.`);
    if (f.pattern && !new RegExp(f.pattern).test(s))
      throw new OutcomeFieldError(`${k}: ${f.help}.`);
    out[k] = s;
  }
  return out;
}

/** The generated rules block (see the header). */
export function outcomeRulesBlock(): string {
  const q = (s: string) => `'${s}'`;
  const list = (xs: string[]) => `[${xs.map(q).join(', ')}]`;
  const entries = Object.entries(OUTCOMES as Record<string, OutcomeType>);
  const map = (f: (t: OutcomeType) => string, live = false) =>
    `{${entries
      .filter(([, t]) => !live || !t.retired)
      .map(([k, t]) => `${q(k)}: ${f(t)}`)
      .join(', ')}}`;
  return [
    '      // BEGIN outcome registry (generated from packages/shared/src/outcomes.ts by',
    '      // UPDATE_GO_CONTRACT=1 pnpm test:scripts; do not edit by hand)',
    `      function outcomeTypes() { return ${list(entries.map(([k]) => k))}; }`,
    `      function outcomeSingle() { return ${list(entries.filter(([, t]) => !t.planOnly && !t.ownTool).map(([k]) => k))}; }`,
    `      function outcomePlanTypes() { return ${list(entries.filter(([, t]) => t.plan).map(([k]) => k))}; }`,
    `      function outcomeHuman() { return ${list(entries.filter(([, t]) => t.kind === 'human').map(([k]) => k))}; }`,
    `      function outcomeImmediate() { return ${list(entries.filter(([, t]) => t.executor === 'none').map(([k]) => k))}; }`,
    `      function outcomeLong() { return ${list(entries.filter(([, t]) => t.long).map(([k]) => k))}; }`,
    `      function outcomeAfter() { return ${map((t) => q(t.after.state))}; }`,
    `      function outcomeWaitingOn() { return ${map((t) => (t.after.waitingOn ? q(t.after.waitingOn) : 'null'))}; }`,
    // Retired types have no field lists: proposing, revising and approving them is refused.
    `      function outcomeFieldKeys() { return ${map((t) => list(Object.keys(t.fields)), true)}; }`,
    `      function outcomeRequired() { return ${map(
      (t) =>
        list(
          Object.entries(t.fields)
            .filter(([, f]) => f.required)
            .map(([k]) => k),
        ),
      true,
    )}; }`,
    '      // END outcome registry',
  ].join('\n');
}

/**
 * For the agent's tool descriptions: every type and its fields. `plan`: the plan step types
 * (plan_propose); otherwise the types proposed alone (outcome_propose).
 */
export function outcomeGuide(which: 'single' | 'plan' = 'single'): string {
  return Object.entries(OUTCOMES as Record<string, OutcomeType>)
    .filter(([, t]) =>
      which === 'plan' ? t.plan === true : t.planOnly !== true && t.ownTool === undefined,
    )
    .map(([k, t]) => {
      const fs = Object.entries(t.fields)
        .map(([n, f]) => `${n}${f.required ? '' : '?'} (${f.kind}: ${f.help})`)
        .join('; ');
      return `${k}: ${t.description} Fields: ${fs}.`;
    })
    .join('\n');
}

/** The thread's state once an outcome of `type` is done. */
export function threadAfter(
  type: string,
  fields: Readonly<Record<string, string | boolean>>,
): { state: ThreadState; waiting: { on: WaitingOn; until: Date | null } | null } {
  const t = outcomeType(type);
  if (!t) throw new ActionError(`Unknown outcome type ${type}.`);
  if (t.after.state !== 'waiting') return { state: t.after.state, waiting: null };
  const f = t.untilField;
  const until = f && typeof fields[f] === 'string' ? new Date(fields[f]) : null;
  return { state: 'waiting', waiting: { on: t.after.waitingOn!, until } };
}
