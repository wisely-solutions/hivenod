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

export type OutcomeFieldKind = 'text' | 'line' | 'datetime' | 'boolean';
export interface OutcomeField {
  kind: OutcomeFieldKind;
  label: string;
  required?: boolean;
  /** Characters, for text and line (defaults: text 20000, line 300). */
  max?: number;
  /** For the agent: what goes in it. */
  help: string;
}
export type WaitingOn = 'them' | 'thirdParty' | 'date' | 'item';
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
   * proposed with high confidence). Never on a type that sends or books.
   */
  batchable?: boolean;
}

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
  },
  reply_book: {
    label: 'Reply and book',
    approve: 'Send and book',
    description:
      "Answer them and book a meeting (pick the time with calendar_free). On approval Hivenod puts the meeting in the member's calendar (source hivenod, sourceEventId = this outcome's id); you then create it in the member's own calendar with your own access and call calendar_mirror with its id, send the reply and report outcome_done.",
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
      title: line('Title', 'What the calendar shows; by default "Meeting with <with>"', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
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
    label: 'Make it work',
    approve: 'Create item',
    description:
      'It needs real work: a Hivenod item. When the item is done, propose a reply saying so.',
    fields: {
      title: line('Item title', 'The work, as an item title'),
      brief: text('Brief', 'What is asked, by whom, and what done looks like', false),
      project: line('Project', 'The project id or name', false),
    },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'item' },
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
  },
  nudge: {
    label: 'Nudge',
    approve: 'Send nudge',
    description: 'They have not answered for a while: a short reminder.',
    fields: { text: text('Nudge', 'The reminder, ready to send as written') },
    executor: 'agent',
    after: { state: 'waiting', waitingOn: 'them' },
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
} as const satisfies Record<string, OutcomeType>;

export type OutcomeTypeId = keyof typeof OUTCOMES;
export const OUTCOME_TYPES = Object.keys(OUTCOMES) as OutcomeTypeId[];
export const MAX_OUTCOME_FIELDS = 10;

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
    out[k] = s;
  }
  return out;
}

/** The generated rules block (see the header). */
export function outcomeRulesBlock(): string {
  const q = (s: string) => `'${s}'`;
  const list = (xs: string[]) => `[${xs.map(q).join(', ')}]`;
  const entries = Object.entries(OUTCOMES as Record<string, OutcomeType>);
  const map = (f: (t: OutcomeType) => string) =>
    `{${entries.map(([k, t]) => `${q(k)}: ${f(t)}`).join(', ')}}`;
  return [
    '      // BEGIN outcome registry (generated from packages/shared/src/outcomes.ts by',
    '      // UPDATE_GO_CONTRACT=1 pnpm test:scripts; do not edit by hand)',
    `      function outcomeTypes() { return ${list(entries.map(([k]) => k))}; }`,
    `      function outcomeImmediate() { return ${list(entries.filter(([, t]) => t.executor === 'none').map(([k]) => k))}; }`,
    `      function outcomeAfter() { return ${map((t) => q(t.after.state))}; }`,
    `      function outcomeWaitingOn() { return ${map((t) => (t.after.waitingOn ? q(t.after.waitingOn) : 'null'))}; }`,
    `      function outcomeFieldKeys() { return ${map((t) => list(Object.keys(t.fields)))}; }`,
    `      function outcomeRequired() { return ${map((t) =>
      list(
        Object.entries(t.fields)
          .filter(([, f]) => f.required)
          .map(([k]) => k),
      ),
    )}; }`,
    '      // END outcome registry',
  ].join('\n');
}

/** For the agent's outcome_propose tool description: every type and its fields. */
export function outcomeGuide(): string {
  return Object.entries(OUTCOMES as Record<string, OutcomeType>)
    .map(([k, t]) => {
      const fs = Object.entries(t.fields)
        .map(([n, f]) => `${n}${f.required ? '' : '?'} (${f.kind}: ${f.help})`)
        .join('; ');
      return `${k}: ${t.description} Fields: ${fs}.`;
    })
    .join('\n');
}
