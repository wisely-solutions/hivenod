/**
 * Contract cases for the Go port of the agent's shared actions (cli/internal/actions). Each case
 * runs a TypeScript action (the source of truth) on a fixed input with a deterministic context
 * (ids id01, id02, … per case; Date.now frozen at NOW_MS) and records what it returns, or the
 * ActionError it throws. scripts/go-contract.test.mjs keeps cli/internal/actions/testdata/
 * contract.json equal to these cases; cli/internal/actions/contract_test.go runs the Go action
 * on every case and wants the same output.
 *
 * Timestamps (in inputs and outputs) are written as {"__hive":"timestamp","ms":n}.
 */
import { Timestamp } from 'firebase/firestore';
import {
  ActionError,
  AGENT_ONLINE_MS,
  guardrailsOf,
  isPaused,
  liveTerminal,
  addInboxMessage,
  addThreadNote,
  askMember,
  assignSubject,
  cleanOutcomeFields,
  finishOutcome,
  inboxMessageKey,
  inboxThreadKey,
  flagThread,
  dueThread,
  proposeRelation,
  relationId,
  searchSubjects,
  proposeOutcome,
  reviseOutcome,
  recheckDone,
  answerInstruction,
  suggestChips,
  retitleThread,
  threadAfter,
  titleFrom,
  wakeThread,
  proposePlan,
  sendBackPlan,
  stepProgress,
  planThreadState,
  planView,
  type PlanInput,
  type ActionContext,
  type Actor,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '../../packages/shared/src/index';

import { summaryCases } from './summaryCases';

export const NOW_MS = 1_800_000_000_000;
export const WORKSPACE_ID = 'w1';

export interface ContractCase {
  name: string;
  /** The Go runner (cli/internal/actions/contract_test.go). */
  action: string;
  /** Absent for pure helpers that take no context. */
  ctx?: { workspaceId: string; actor: Actor };
  input: unknown;
  output: unknown;
}

/** JSON form: Timestamps and Dates as placeholders, undefined dropped. */
export function serialize(v: unknown): unknown {
  if (v instanceof Timestamp) return { __hive: 'timestamp', ms: v.toMillis() };
  if (v instanceof Date) return { __hive: 'timestamp', ms: v.getTime() };
  if (Array.isArray(v)) return v.map((e) => (e === undefined ? null : serialize(e)));
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(v))
      if (e !== undefined)
        // defineProperty: `out['__proto__'] = x` would set the prototype and drop the key.
        Object.defineProperty(out, k, {
          value: serialize(e),
          enumerable: true,
          writable: true,
          configurable: true,
        });
    return out;
  }
  return v === undefined ? null : v;
}

// ---------- fixtures ----------

const AGENT: Actor = { type: 'agent', id: 'agentA', name: 'Hive' };
const OTHER: Actor = { type: 'agent', id: 'agentB', name: 'Bee' };
const HUMAN: Actor = { type: 'human', id: 'joao', name: 'João' };

const ts = (ms: number) => Timestamp.fromMillis(ms);
const T0 = ts(NOW_MS - 60_000);

// ---------- building ----------

/** Builds every case; Date.now is frozen at NOW_MS meanwhile. */
export function buildCases(): { nowMs: number; workspaceId: string; cases: ContractCase[] } {
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    return { nowMs: NOW_MS, workspaceId: WORKSPACE_ID, cases: build() };
  } finally {
    Date.now = realNow;
  }
}

function build(): ContractCase[] {
  const cases: ContractCase[] = [];
  const names = new Set<string>();

  function record(
    name: string,
    action: string,
    actor: Actor | null,
    input: unknown,
    fn: (ctx: ActionContext) => unknown,
  ) {
    if (names.has(name)) throw new Error(`duplicate case ${name}`);
    names.add(name);
    let n = 0;
    const ctx: ActionContext = {
      workspaceId: WORKSPACE_ID,
      actor: actor ?? AGENT,
      newId: () => `id${String(++n).padStart(2, '0')}`,
    };
    let output: unknown;
    try {
      output = serialize(fn(ctx));
    } catch (e) {
      if (!(e instanceof ActionError)) throw e;
      output = { error: e.message };
    }
    cases.push({
      name,
      action,
      ...(actor ? { ctx: { workspaceId: WORKSPACE_ID, actor } } : {}),
      input: serialize(input),
      output,
    });
  }
  /** An action called as `fn(ctx, input)`. */
  function act<I>(
    name: string,
    action: string,
    actor: Actor,
    input: I,
    fn: (ctx: ActionContext, input: I) => unknown,
  ) {
    record(name, action, actor, input, (ctx) => fn(ctx, input));
  }
  /** A pure helper (no context). */
  function pure<I>(name: string, action: string, input: I, fn: (input: I) => unknown) {
    record(name, action, null, input, () => fn(input));
  }
  // ---------- agents ----------
  pure('constants/all', 'constants', {}, () => ({ AGENT_ONLINE_MS }));
  pure('guardrailsOf/default', 'guardrailsOf', { agent: {} }, (i) => guardrailsOf(i.agent));
  pure('guardrailsOf/set', 'guardrailsOf', { agent: { guardrails: { maxFailedRuns: 5 } } }, (i) =>
    guardrailsOf(i.agent),
  );
  pure('isPaused/paused', 'isPaused', { agent: { pausedAt: T0 } }, (i) => isPaused(i.agent));
  pure('isPaused/null', 'isPaused', { agent: { pausedAt: null } }, (i) => isPaused(i.agent));
  pure('isPaused/absent', 'isPaused', { agent: {} }, (i) => isPaused(i.agent));
  const live = (name: string, agent: Record<string, unknown>, now = NOW_MS) =>
    pure(`liveTerminal/${name}`, 'liveTerminal', { agent, now }, (i) =>
      liveTerminal(i.agent as Parameters<typeof liveTerminal>[0], i.now),
    );
  live('alive', { lastSeenAt: ts(NOW_MS - 30_000), signedOutAt: null, seenHost: 'box' });
  live('alive without host', { lastSeenAt: ts(NOW_MS - 30_000) });
  live('signed out since', { lastSeenAt: ts(NOW_MS - 30_000), signedOutAt: ts(NOW_MS - 10_000) });
  live('signed out before', {
    lastSeenAt: ts(NOW_MS - 30_000),
    signedOutAt: ts(NOW_MS - 90_000),
    seenHost: 'box',
  });
  live('window passed', { lastSeenAt: ts(NOW_MS - AGENT_ONLINE_MS) });
  live('never seen', { lastSeenAt: null });

  // ---------- inbox (item 4PEHrOW5IfXBQWgOK9wo): the agent actions ----------
  const TH = (over: Partial<ThreadStateOf> = {}): ThreadStateOf => ({
    memberUid: 'joao',
    subjectId: null,
    state: 'investigating',
    fetchedBy: 'agentA',
    refs: ['r1'],
    waiting: null,
    ...over,
  });
  const inAdd = (
    name: string,
    actor: Actor,
    over: Partial<Parameters<typeof addInboxMessage>[1]>,
  ) =>
    act(
      `addInboxMessage/${name}`,
      'addInboxMessage',
      actor,
      {
        messageDocId: 'im1',
        ref: 'r1',
        memberUid: 'joao',
        source: 'teams',
        sender: { name: ' Sam Example ', handle: 'sam@example.com' },
        text: '\n  Can we move   the review to Thursday?\nThanks',
        threadRef: 'thread-1',
        messageId: 'm-1',
        permalink: 'https://teams.example.com/m/1',
        replyRef: 'conv:1',
        receivedAt: new Date(NOW_MS - 3_600_000),
        attachments: [{ name: ' agenda.pdf ', url: 'https://files.example.com/a.pdf' }],
        ...over,
      },
      addInboxMessage,
    );
  inAdd('new thread', AGENT, {});
  inAdd('new thread, own id and title', AGENT, { newThreadId: 'itX', title: '  Review   date ' });
  inAdd('minimal', AGENT, {
    sender: { name: 'Sam' },
    permalink: null,
    replyRef: '  ',
    attachments: undefined,
  });
  inAdd('joins its thread', AGENT, {
    thread: { threadId: 'it1', state: TH({ subjectId: 's1', state: 'yourCall' }) },
  });
  inAdd('another channel joins', AGENT, { ref: 'r2', thread: { threadId: 'it1', state: TH() } });
  inAdd('reopens a waiting thread', AGENT, {
    thread: { threadId: 'it1', state: TH({ state: 'waiting' }) },
  });
  inAdd('reopens a done thread', AGENT, {
    thread: { threadId: 'it1', state: TH({ state: 'done' }) },
  });
  inAdd('reopens an ignored thread', AGENT, {
    thread: { threadId: 'it1', state: TH({ state: 'ignored' }) },
  });
  inAdd('own reply does not reopen', AGENT, {
    direction: 'out',
    thread: { threadId: 'it1', state: TH({ state: 'done' }) },
  });
  inAdd('someone else’s thread', AGENT, {
    thread: { threadId: 'it1', state: TH({ memberUid: 'maria' }) },
  });
  inAdd('too many refs', AGENT, {
    ref: 'rNew',
    thread: { threadId: 'it1', state: TH({ refs: Array.from({ length: 50 }, (_, i) => `r${i}`) }) },
  });
  inAdd('person refused', HUMAN, {});
  inAdd('bad source', AGENT, { source: 'Teams' });
  inAdd('no sender', AGENT, { sender: { name: '  ' } });
  inAdd('no text', AGENT, { text: ' \n ' });
  inAdd('text too long', AGENT, { text: 'x'.repeat(50_001) });
  inAdd('no thread ref', AGENT, { threadRef: '' });
  inAdd('no message id', AGENT, { messageId: '' });
  inAdd('bad permalink', AGENT, { permalink: 'teams://m/1' });
  inAdd('bad attachment', AGENT, { attachments: [{ name: 'a', url: 'file:///etc/passwd' }] });
  inAdd('too many attachments', AGENT, {
    attachments: Array.from({ length: 21 }, (_, i) => ({
      name: `f${i}`,
      url: 'https://x.example/f',
    })),
  });
  const file = (name: string, actor: Actor, input: Parameters<typeof assignSubject>[1]) =>
    act(`assignSubject/${name}`, 'assignSubject', actor, input, assignSubject);
  file('new subject', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: '  Klarna   refunds (Payments) ',
  });
  file('existing subject', AGENT, {
    threadId: 'it1',
    thread: TH({ subjectId: 's0' }),
    subjectId: 's1',
  });
  file('new subject with an area', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'Refunds',
    area: '  Payments   team ',
  });
  file('existing subject, area set', AGENT, {
    threadId: 'it1',
    thread: TH({ subjectId: 's0' }),
    subjectId: 's1',
    area: 'Admin',
  });
  file('existing subject, area cleared', AGENT, {
    threadId: 'it1',
    thread: TH({ subjectId: 's0' }),
    subjectId: 's1',
    area: '   ',
  });
  file('area too long', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'x',
    area: 'a'.repeat(61),
  });
  file('new subject with a label', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'Acme renewal',
    label: ' sales ',
  });
  file('new subject, area and label', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'Acme renewal',
    area: 'Acme',
    label: 'Support',
  });
  file('existing subject without a label gets one', AGENT, {
    threadId: 'it1',
    thread: TH({ subjectId: 's0' }),
    subjectId: 's1',
    label: 'Billing',
    existing: { label: null },
  });
  file('existing subject keeps its label', AGENT, {
    threadId: 'it1',
    thread: TH({ subjectId: 's0' }),
    subjectId: 's1',
    label: 'Billing',
    existing: { label: 'Sales', labelBy: 'member' },
  });
  file('label from the workspace list', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'x',
    label: 'ops',
    labels: ['Ops', 'Sales'],
  });
  file('label not in the list', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'x',
    label: 'Foo',
  });
  file('label not in the workspace list', AGENT, {
    threadId: 'it1',
    thread: TH(),
    newName: 'x',
    label: 'Support',
    labels: ['Ops'],
  });
  file('both given', AGENT, { threadId: 'it1', thread: TH(), subjectId: 's1', newName: 'x' });
  file('neither given', AGENT, { threadId: 'it1', thread: TH() });
  file('blank name', AGENT, { threadId: 'it1', thread: TH(), newName: '   ' });
  file('name too long', AGENT, { threadId: 'it1', thread: TH(), newName: 'n'.repeat(121) });
  file('person refused', HUMAN, { threadId: 'it1', thread: TH(), subjectId: 's1' });
  const text =
    (action: string, fn: (ctx: ActionContext, input: never) => unknown) =>
    (name: string, actor: Actor, input: Record<string, unknown>) =>
      act(
        `${action}/${name}`,
        action,
        actor,
        { threadId: 'it1', thread: TH({ subjectId: 's1' }), ...input },
        fn as never,
      );
  const note = text('addThreadNote', addThreadNote);
  note('plain', AGENT, { text: '  Checked the calendar. ' });
  note('empty', AGENT, { text: ' ' });
  note('too long', AGENT, { text: 'n'.repeat(8001) });
  note('person refused', HUMAN, { text: 'x' });
  const askM = text('askMember', askMember);
  askM('plain', AGENT, { question: ' Thursday or Friday? ' });
  askM('while waiting', AGENT, { question: 'Still on?', thread: TH({ state: 'waiting' }) });
  askM('ignored', AGENT, { question: 'x', thread: TH({ state: 'ignored' }) });
  askM('empty', AGENT, { question: '' });
  askM('person refused', HUMAN, { question: 'x' });
  // Answer chips (item kt3E7u9EliL3q2veDDI0)
  askM('with options', AGENT, {
    question: 'Thursday or Friday?',
    options: [' Thursday ', 'Friday'],
  });
  askM('no options', AGENT, { question: 'Which day?', options: [] });
  askM('five options', AGENT, { question: 'x', options: ['a', 'b', 'c', 'd', 'e'] });
  askM('blank option', AGENT, { question: 'x', options: ['a', '  '] });
  askM('option too long', AGENT, { question: 'x', options: ['é'.repeat(81)] });
  const title = text('retitleThread', retitleThread);
  title('plain', AGENT, { title: '  Review   on Thursday ' });
  title('empty', AGENT, { title: '   ' });
  title('too long', AGENT, { title: 't'.repeat(201) });
  const propose = (
    name: string,
    actor: Actor,
    input: Partial<Parameters<typeof proposeOutcome>[1]>,
  ) =>
    act(
      `proposeOutcome/${name}`,
      'proposeOutcome',
      actor,
      {
        threadId: 'it1',
        thread: TH({ subjectId: 's1', fetchedBy: 'agentB' }),
        type: 'reply',
        fields: { text: '  Thursday works. ' },
        ...input,
      },
      proposeOutcome,
    );
  propose('reply', AGENT, {});
  propose('holding reply with a note', AGENT, {
    fields: { text: 'On it.', holding: true },
    note: ' Buying time ',
  });
  // Retired with Calendar (item OE8FmrTaIxFVGcaeGG3N, slice 5): refused.
  propose('reply_book', AGENT, {
    type: 'reply_book',
    fields: {
      text: 'Booked.',
      start: '2026-11-05T10:00:00+01:00',
      end: '2026-11-05T10:30:00+01:00',
      with: 'Sam',
    },
  });
  propose('no_reply', AGENT, { type: 'no_reply', fields: {} });
  propose('make_it_work', AGENT, {
    type: 'make_it_work',
    fields: { title: 'Fix the export', brief: '', project: 'Blog' },
  });
  propose('handover', AGENT, { type: 'handover', fields: { to: 'Maria' } });
  propose('snooze', AGENT, { type: 'snooze', fields: { until: '2026-11-03T09:00:00+01:00' } });
  propose('nudge', AGENT, { type: 'nudge', fields: { text: 'Any news?' } });
  propose('ignore', AGENT, { type: 'ignore', fields: { reason: null } });
  propose('own id, from waiting', AGENT, { outcomeId: 'o9', thread: TH({ state: 'waiting' }) });
  propose('unknown type', AGENT, { type: 'launch' });
  // Plan-only types (item qwFAWxZM5xkcE7PPjAzi): only as plan steps
  propose('approval alone', AGENT, { type: 'approval', fields: { what: 'New prices' } });
  propose('book alone', AGENT, {
    type: 'book',
    fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', with: 'Sam' },
  });
  propose('unknown field', AGENT, { fields: { text: 'x', bcc: 'all' } });
  propose('missing field', AGENT, { type: 'handover', fields: { note: 'x' } });
  propose('field not text', AGENT, { fields: { text: 3 } });
  propose('field not boolean', AGENT, { fields: { text: 'x', holding: 'yes' } });
  propose('field too long', AGENT, { type: 'handover', fields: { to: 't'.repeat(301) } });
  propose('bad datetime', AGENT, { type: 'snooze', fields: { until: 'next week' } });
  propose('datetime without offset', AGENT, {
    type: 'snooze',
    fields: { until: '2026-11-03T09:00:00' },
  });
  propose('note too long', AGENT, { note: 'n'.repeat(2001) });
  propose('ignored thread', AGENT, { thread: TH({ state: 'ignored' }) });
  propose('person refused', HUMAN, {});
  // Confidence and checks (item kt3E7u9EliL3q2veDDI0)
  propose('high confidence with checks', AGENT, {
    confidence: 'high',
    checks: ['  Your calendar: Thu 10:00-11:00 free ', 'Asked Rita by mail: either works'],
  });
  propose('low confidence, no checks', AGENT, { confidence: 'low', checks: [] });
  propose('bad confidence', AGENT, { confidence: 'sure' });
  propose('seven checks', AGENT, { checks: Array.from({ length: 7 }, (_, i) => `c${i}`) });
  propose('blank check', AGENT, { checks: [' '] });
  propose('check too long', AGENT, { checks: ['c'.repeat(201)] });
  const OC = (over: Partial<OutcomeStateOf> = {}): OutcomeStateOf => ({
    memberUid: 'joao',
    threadId: 'it1',
    type: 'reply',
    fields: { text: 'Thursday works.' },
    state: 'approved',
    executor: 'agentA',
    ...over,
  });
  const fin = (name: string, actor: Actor, input: Partial<Parameters<typeof finishOutcome>[1]>) =>
    act(
      `finishOutcome/${name}`,
      'finishOutcome',
      actor,
      {
        outcomeId: 'o1',
        outcome: OC(),
        thread: TH({ subjectId: 's1', state: 'yourCall' }),
        status: 'done',
        ...input,
      },
      finishOutcome,
    );
  fin('reply done', AGENT, {
    result: { permalink: ' https://teams.example.com/m/2 ', text: ' Sent ' },
  });
  fin('make_it_work done', AGENT, {
    outcome: OC({ type: 'make_it_work', fields: { title: 'x' } }),
    result: { itemId: 'i9' },
  });
  fin('handover done', AGENT, { outcome: OC({ type: 'handover', fields: { to: 'Maria' } }) });
  fin('failed', AGENT, { status: 'failed', result: { error: ' Teams said 403 ' } });
  fin('failed without why', AGENT, { status: 'failed' });
  fin('not approved', AGENT, { outcome: OC({ state: 'proposed' }) });
  fin('already done', AGENT, { outcome: OC({ state: 'done' }) });
  fin('rejected', AGENT, { outcome: OC({ state: 'rejected' }) });
  fin('another agent', OTHER, {});
  fin('no executor', AGENT, { outcome: OC({ executor: null }) });
  fin('bad link', AGENT, { result: { permalink: 'nope' } });
  fin('person refused', HUMAN, {});
  // Ask for changes (item L7OzWKMYZ1O2dX33Xkrj): the proposing agent writes the next version.
  const REV = OC({
    state: 'revising',
    proposedBy: 'agentA',
    note: 'They asked to move it.',
    confidence: 'high',
    revise: { instruction: 'Mention 14:00', chips: ['shorter'], byUid: 'joao', at: ts(NOW_MS) },
  });
  const V = (n: number, text: string) => ({
    n,
    fields: { text },
    note: '',
    confidence: null,
    checks: [],
    by: 'agentA',
    eventId: n === 1 ? null : `ev${n}`,
    asked: n === 1 ? null : { instruction: null, chips: ['warmer' as const] },
  });
  const rev = (name: string, actor: Actor, input: Partial<Parameters<typeof reviseOutcome>[1]>) =>
    act(
      `reviseOutcome/${name}`,
      'reviseOutcome',
      actor,
      {
        outcomeId: 'o1',
        outcome: REV,
        thread: TH({ subjectId: 's1', state: 'yourCall' }),
        fields: { text: '  Thursday 10:00, or 14:00. ' },
        ...input,
      },
      reviseOutcome,
    );
  rev('first revision keeps v1', AGENT, {
    note: ' Shorter ',
    confidence: 'medium',
    checks: [' Thu 14:00 free '],
  });
  rev('third version', AGENT, {
    outcome: { ...REV, versions: [V(1, 'a'), V(2, 'b')], checks: ['x'] },
    type: 'reply',
    threadId: 'it1',
  });
  rev('without a note or confidence', AGENT, { outcome: { ...REV, revise: undefined } });
  rev('nobody asked', AGENT, { outcome: { ...REV, state: 'proposed' } });
  rev('already approved', AGENT, { outcome: { ...REV, state: 'approved' } });
  rev('another agent', OTHER, {});
  rev('another type', AGENT, { type: 'nudge' });
  rev('another thread', AGENT, { threadId: 'it2' });
  rev('bad fields', AGENT, { fields: { text: 'x', bcc: 'all' } });
  rev('ten versions', AGENT, {
    outcome: { ...REV, versions: Array.from({ length: 10 }, (_, i) => V(i + 1, `v${i}`)) },
  });
  rev('person refused', HUMAN, {});
  const wake = (name: string, input: Partial<Parameters<typeof wakeThread>[1]>) =>
    act(
      `wakeThread/${name}`,
      'wakeThread',
      AGENT,
      {
        threadId: 'it1',
        thread: TH({ state: 'waiting', waiting: { on: 'date', until: ts(NOW_MS - 1000) } }),
        nowMs: NOW_MS,
        ...input,
      },
      wakeThread,
    );
  wake('due', {});
  wake('not yet', { nowMs: NOW_MS - 5000 });
  wake('not a date', { thread: TH({ state: 'waiting', waiting: { on: 'them', until: null } }) });
  wake('not waiting', { thread: TH() });
  // ---------- plans (item qwFAWxZM5xkcE7PPjAzi) ----------
  const STEPS = [
    {
      type: 'reply',
      fields: { text: ' Thursday works. ' },
      note: ' Sam asked ',
      confidence: 'high',
    },
    {
      type: 'nudge',
      fields: { text: 'Any news on Thursday?' },
      checks: [' Sam asked twice '],
    },
    { type: 'approval', fields: { what: ' New price list ', detail: 'A 10 → 12' } },
    { type: 'make_it_work', fields: { title: 'Update prices', project: 'Website' } },
    { type: 'reply', fields: { text: 'Done.' } },
  ];
  const pp = (name: string, actor: Actor, input: Partial<Parameters<typeof proposePlan>[1]>) =>
    act(
      `proposePlan/${name}`,
      'proposePlan',
      actor,
      {
        threadId: 'it1',
        thread: TH({ subjectId: 's1', fetchedBy: 'agentB' }),
        note: '  Reply, book, then the prices. ',
        confidence: 'medium',
        steps: STEPS,
        ...input,
      },
      proposePlan,
    );
  pp('five steps', AGENT, {});
  pp('one step, no note', AGENT, { steps: [STEPS[0]!], note: undefined, confidence: undefined });
  pp('own ids', AGENT, { planId: 'pl9', stepIds: ['s1', 's2', 's3', 's4', 's5'] });
  pp('snooze and nudge', AGENT, {
    steps: [
      { type: 'snooze', fields: { until: '2026-11-03T09:00:00+01:00' } },
      { type: 'nudge', fields: { text: 'Any news?' } },
      { type: 'handover', fields: { to: 'Maria' } },
    ],
  });
  // Retired with Calendar (item OE8FmrTaIxFVGcaeGG3N, slice 5): no booking steps.
  pp('booking step', AGENT, {
    steps: [
      STEPS[0]!,
      {
        type: 'book',
        fields: { start: '2026-11-05T10:00:00Z', end: '2026-11-05T10:30:00Z', with: 'Sam' },
      },
    ],
  });
  pp('no steps', AGENT, { steps: [] });
  pp('nine steps', AGENT, { steps: Array.from({ length: 9 }, () => STEPS[0]!) });
  pp('not a plan type', AGENT, { steps: [STEPS[0]!, { type: 'no_reply', fields: {} }] });
  pp('unknown type', AGENT, { steps: [{ type: 'launch', fields: {} }] });
  pp('bad step fields', AGENT, { steps: [STEPS[0]!, { type: 'approval', fields: {} }] });
  pp('step note too long', AGENT, { steps: [{ ...STEPS[0]!, note: 'n'.repeat(2001) }] });
  pp('bad step confidence', AGENT, { steps: [{ ...STEPS[0]!, confidence: 'sure' }] });
  pp('bad step checks', AGENT, { steps: [{ ...STEPS[0]!, checks: [' '] }] });
  pp('plan note too long', AGENT, { note: 'n'.repeat(2001) });
  pp('bad confidence', AGENT, { confidence: 'sure' });
  pp('ids do not match', AGENT, { stepIds: ['s1', 's1', 's3', 's4', 's5'] });
  pp('ignored thread', AGENT, { thread: TH({ state: 'ignored' }) });
  pp('person refused', HUMAN, {});

  /** A plan input: steps o1..oN with the given types and states. */
  const PL = (
    steps: [string, OutcomeStateOf['state'], Record<string, unknown>?][],
    cursor: number,
    state: PlanInput['plan']['state'] = 'active',
  ): PlanInput => ({
    planId: 'pl1',
    plan: {
      memberUid: 'joao',
      threadId: 'it1',
      steps: steps.map((_, i) => `o${i + 1}`),
      cursor,
      state,
    },
    outcomes: Object.fromEntries(
      steps.map(([type, st, fields], i) => [
        `o${i + 1}`,
        OC({
          type,
          state: st,
          fields: (fields ?? (type === 'reply' ? { text: 'x' } : {})) as Record<string, string>,
          planId: 'pl1',
          executor: type === 'approval' || type === 'snooze' ? null : 'agentA',
        }),
      ]),
    ),
  });
  const SNOOZE = { until: '2026-11-03T09:00:00.000Z' };
  // ---------- Re-check (item bmNoIvvqKCdAorLSShE9) ----------
  const RC_PENDING = TH({
    subjectId: 's1',
    state: 'yourCall',
    recheck: { state: 'pending', requestedAt: ts(NOW_MS - 60_000) },
  });
  const RC_OPEN = OC({ state: 'proposed', proposedBy: 'agentA', note: 'They asked.' });
  rev('re-check: an open proposal unasked', AGENT, {
    outcome: RC_OPEN,
    thread: RC_PENDING,
  });
  rev('re-check: not the home agent', OTHER, {
    outcome: { ...RC_OPEN, proposedBy: 'agentB' },
    thread: RC_PENDING,
  });
  rev('re-check: answered already', AGENT, {
    outcome: RC_OPEN,
    thread: TH({ state: 'yourCall', recheck: { state: 'done' } }),
  });
  rev('re-check: while asked for changes keeps the ask', AGENT, { thread: RC_PENDING });
  const RPL = PL(
    [
      ['reply', 'done'],
      ['reply', 'approved'],
      ['reply', 'approved'],
    ],
    1,
  );
  for (const o of Object.values(RPL.outcomes)) Object.assign(o, { proposedBy: 'agentA', note: '' });
  rev('re-check: an unrun approved step', AGENT, {
    outcomeId: 'o3',
    outcome: RPL.outcomes.o3,
    thread: RC_PENDING,
    plan: RPL,
  });
  rev('re-check: the step at its turn', AGENT, {
    outcomeId: 'o2',
    outcome: RPL.outcomes.o2,
    thread: RC_PENDING,
    plan: RPL,
  });
  rev('re-check: an approved step without its plan', AGENT, {
    outcomeId: 'o3',
    outcome: RPL.outcomes.o3,
    thread: RC_PENDING,
  });
  const rdone = (name: string, actor: Actor, input: Partial<Parameters<typeof recheckDone>[1]>) =>
    act(
      `recheckDone/${name}`,
      'recheckDone',
      actor,
      {
        threadId: 'it1',
        thread: RC_PENDING,
        result: 'still_good',
        note: '  Nothing new. ',
        outcomes: {
          o9: RC_OPEN,
          o8: OC({ state: 'rejected' }),
          o7: OC({ state: 'proposed', threadId: 'it2' }),
          ...RPL.outcomes,
        },
        plans: { pl1: RPL.plan },
        ...input,
      },
      recheckDone,
    );
  rdone('still good stamps the open ones', AGENT, {});
  rdone('revised', AGENT, { result: 'revised', note: null });
  rdone('asked', AGENT, { result: 'asked', outcomes: {}, plans: undefined });
  rdone('without the plans', AGENT, { plans: undefined });
  rdone('bad result', AGENT, { result: 'fine' });
  rdone('long note', AGENT, { note: 'x'.repeat(501) });
  rdone('nothing pending', AGENT, { thread: TH({ state: 'yourCall' }) });
  rdone('answered already', AGENT, {
    thread: TH({ state: 'yourCall', recheck: { state: 'done' } }),
  });
  rdone('not the home agent', OTHER, {});
  rdone('person refused', HUMAN, {});
  // ---------- Ask the agent (item w6O2KOw4ys70TQv9I1xD) ----------
  const IN_PENDING = TH({
    subjectId: 's1',
    state: 'waiting',
    instructions: {
      i1: { state: 'pending', at: ts(NOW_MS - 60_000) },
      i0: { state: 'answered', at: ts(NOW_MS - 120_000) },
    },
    instruct: { state: 'pending', id: 'i1', at: ts(NOW_MS - 60_000) },
  });
  const ans = (
    name: string,
    actor: Actor,
    input: Partial<Parameters<typeof answerInstruction>[1]>,
  ) =>
    act(
      `answerInstruction/${name}`,
      'answerInstruction',
      actor,
      {
        threadId: 'it1',
        thread: IN_PENDING,
        instructionId: 'i1',
        kind: 'note',
        refId: null,
        note: '  The meeting is with Sam at 10:00. ',
        ...input,
      },
      answerInstruction,
    );
  ans('a note', AGENT, {});
  ans('an outcome', AGENT, { kind: 'outcome', refId: ' o9 ', note: null });
  ans('a plan', AGENT, { kind: 'plan', refId: 'pl1' });
  ans('a question', AGENT, { kind: 'ask', note: undefined });
  ans('an older one', AGENT, {
    thread: TH({
      ...IN_PENDING,
      instructions: { ...IN_PENDING.instructions, i2: { state: 'pending', at: ts(NOW_MS) } },
      instruct: { state: 'pending', id: 'i2', at: ts(NOW_MS) },
    }),
  });
  ans('a note without text', AGENT, { note: '  ' });
  ans('an outcome without its id', AGENT, { kind: 'outcome', note: null });
  ans('a question with an id', AGENT, { kind: 'ask', refId: 'o1' });
  ans('bad kind', AGENT, { kind: 'shrug' });
  ans('long note', AGENT, { note: 'x'.repeat(501) });
  ans('unknown', AGENT, { instructionId: 'zz' });
  ans('answered already', AGENT, { instructionId: 'i0' });
  ans('not the home agent', OTHER, {});
  ans('person refused', HUMAN, {});
  const chips = (name: string, actor: Actor, list: unknown) =>
    act(
      `suggestChips/${name}`,
      'suggestChips',
      actor,
      { threadId: 'it1', thread: IN_PENDING, chips: list as string[] },
      suggestChips,
    );
  chips('two', AGENT, ['summarize', 'recheck']);
  chips('none', AGENT, []);
  chips('unknown chip', AGENT, ['dance']);
  chips('twice', AGENT, ['follow_up', 'follow_up']);
  chips('six', AGENT, ['prepare_meeting', 'recheck', 'follow_up', 'summarize', 'draft_reply', 'x']);
  chips('not the home agent', OTHER, ['summarize']);
  const finP = (name: string, input: Partial<Parameters<typeof finishOutcome>[1]>) => {
    const pl = input.plan;
    const oid = input.outcomeId ?? (pl ? pl.plan.steps[pl.plan.cursor] : undefined) ?? 'o1';
    fin(`plan/${name}`, AGENT, {
      outcomeId: oid,
      outcome: pl?.outcomes[oid] ?? OC({ planId: 'pl1' }),
      ...input,
    });
  };
  finP('first step done', {
    plan: PL(
      [
        ['reply', 'approved'],
        ['reply', 'approved'],
      ],
      0,
      'proposed',
    ),
    result: { permalink: 'https://teams.example.com/m/2' },
  });
  finP('next step not approved', {
    plan: PL(
      [
        ['reply', 'done'],
        ['reply', 'approved'],
        ['nudge', 'proposed', { text: 'y' }],
      ],
      1,
    ),
  });
  finP('next step a gate', {
    plan: PL(
      [
        ['reply', 'approved'],
        ['approval', 'proposed', { what: 'x' }],
        ['reply', 'approved'],
      ],
      0,
    ),
  });
  finP('next a wait-until', {
    plan: PL(
      [
        ['reply', 'approved'],
        ['snooze', 'approved', SNOOZE],
      ],
      0,
    ),
  });
  finP('last step done', {
    plan: PL(
      [
        ['reply', 'done'],
        ['approval', 'done', { what: 'x' }],
        ['handover', 'approved', { to: 'M' }],
      ],
      2,
    ),
  });
  finP('last after a gate and a skip', {
    plan: PL(
      [
        ['reply', 'done'],
        ['nudge', 'rejected', { text: 'y' }],
        [
          'book',
          'approved',
          { start: '2026-11-05T10:00:00.000Z', end: '2026-11-05T11:00:00.000Z' },
        ],
      ],
      2,
    ),
  });
  finP('failed blocks', {
    plan: PL(
      [
        ['reply', 'done'],
        ['reply', 'approved'],
      ],
      1,
    ),
    status: 'failed',
    result: { error: 'Teams said 403' },
  });
  finP('build it started', {
    plan: PL(
      [
        ['make_it_work', 'approved', { title: 'x' }],
        ['reply', 'approved'],
      ],
      0,
    ),
    status: 'started',
    result: { itemId: ' i9 ' },
  });
  finP('build it done after running', {
    plan: PL(
      [
        ['make_it_work', 'running', { title: 'x' }],
        ['reply', 'approved'],
      ],
      0,
    ),
    result: { itemId: 'i9', permalink: 'https://hivenod.com/p/x/i9' },
  });
  finP('started without item', {
    plan: PL([['make_it_work', 'approved', { title: 'x' }]], 0),
    status: 'started',
  });
  finP('started a reply', { plan: PL([['reply', 'approved']], 0), status: 'started' });
  finP('started twice', {
    plan: PL([['make_it_work', 'running', { title: 'x' }]], 0),
    status: 'started',
    result: { itemId: 'i9' },
  });
  finP('not its turn', {
    plan: PL(
      [
        ['reply', 'proposed'],
        ['reply', 'approved'],
      ],
      0,
    ),
    outcomeId: 'o2',
  });
  finP('blocked plan', { plan: PL([['reply', 'approved']], 0, 'blocked') });
  finP('stopped plan', { plan: PL([['reply', 'approved']], 0, 'stopped') });
  finP('without its plan', { plan: undefined, outcome: OC({ planId: 'pl1' }) });
  finP('another plan', {
    plan: { ...PL([['reply', 'approved']], 0), planId: 'pl2' },
  });
  fin('single started', AGENT, { status: 'started', result: { itemId: 'i9' } });
  fin('single running', AGENT, { outcome: OC({ state: 'running' }) });
  const wakeP = (name: string, plan: PlanInput) => wake(`plan/${name}`, { plan });
  wakeP(
    'wait-until done',
    PL(
      [
        ['reply', 'done'],
        ['snooze', 'approved', SNOOZE],
        ['nudge', 'approved', { text: 'y' }],
      ],
      1,
    ),
  );
  wakeP(
    'last wait-until',
    PL(
      [
        ['handover', 'done', { to: 'M' }],
        ['snooze', 'approved', SNOOZE],
      ],
      1,
    ),
  );
  wakeP('not a snooze', PL([['reply', 'approved']], 0));
  wakeP('snooze not approved', PL([['snooze', 'proposed', SNOOZE]], 0));
  wakeP('through', PL([['snooze', 'done', SNOOZE]], 1, 'done'));
  wakeP('another thread', {
    ...PL([['snooze', 'approved', SNOOZE]], 0),
    plan: { ...PL([['snooze', 'approved', SNOOZE]], 0).plan, threadId: 'it2' },
  });
  const pts = (name: string, pl: PlanInput) =>
    pure(
      `planThreadState/${name}`,
      'planThreadState',
      { plan: pl.plan, outcomes: pl.outcomes },
      (i) => planThreadState(i.plan, i.outcomes),
    );
  pts(
    'proposed',
    PL(
      [
        ['reply', 'proposed'],
        ['reply', 'proposed'],
      ],
      0,
      'proposed',
    ),
  );
  pts('first approved', PL([['reply', 'approved']], 0));
  pts(
    'gate',
    PL(
      [
        ['reply', 'done'],
        ['approval', 'proposed', { what: 'x' }],
      ],
      1,
    ),
  );
  pts('running', PL([['make_it_work', 'running', { title: 'x' }]], 0));
  pts(
    'wait until',
    PL(
      [
        ['reply', 'done'],
        ['snooze', 'approved', SNOOZE],
      ],
      1,
    ),
  );
  pts(
    'after a reply',
    PL(
      [
        ['handover', 'done', { to: 'M' }],
        ['reply', 'approved'],
      ],
      1,
    ),
  );
  pts('failed', PL([['reply', 'failed']], 0, 'blocked'));
  pts(
    'all done',
    PL(
      [
        ['reply', 'done'],
        ['approval', 'done', { what: 'x' }],
      ],
      2,
      'done',
    ),
  );
  pts('only a gate done', PL([['approval', 'done', { what: 'x' }]], 1, 'done'));
  pts('stopped', PL([['reply', 'rejected']], 0, 'stopped'));
  pts('missing step', {
    ...PL([['reply', 'done']], 1),
    plan: { ...PL([['reply', 'done']], 1).plan, steps: ['o1', 'oX'] },
  });
  // ---------- development plans (item OE8FmrTaIxFVGcaeGG3N, slice 6) ----------
  pts(
    'blocked by send backs',
    PL(
      [
        ['reply', 'done'],
        ['build', 'approved'],
      ],
      1,
      'blocked',
    ),
  );
  pp('dev template', AGENT, {
    template: 'dev',
    steps: [{ type: 'shape', fields: { idea: ' Dark mode ' }, note: ' Size M ' }],
  });
  pp('dev template, own ids, no steps', AGENT, {
    template: 'dev',
    steps: [],
    planId: 'pl9',
    stepIds: ['s1', 's2', 's3', 's4', 's5', 's6'],
  });
  pp('dev template, another type', AGENT, {
    template: 'dev',
    steps: [{ type: 'reply', fields: { text: 'x' } }],
  });
  pp('dev template, too many steps', AGENT, {
    template: 'dev',
    steps: Array.from({ length: 7 }, () => ({ type: '', fields: {} })),
  });
  pp('dev template, bad field', AGENT, {
    template: 'dev',
    steps: [{ type: 'shape', fields: { title: 'x' } }],
  });
  pp('unknown template', AGENT, { template: 'launch', steps: [] });
  const DEV: [string, OutcomeStateOf['state'], Record<string, unknown>?][] = [
    ['shape', 'done'],
    ['approval', 'done', { what: 'Approve idea' }],
    ['build', 'done'],
    ['approval', 'done', { what: 'Ship it?' }],
    ['release', 'approved'],
    ['approval', 'proposed', { what: 'Accept on live' }],
  ];
  const devPl = (
    states: OutcomeStateOf['state'][],
    cursor: number,
    state: PlanInput['plan']['state'] = 'active',
    sent = 0,
  ) => {
    const pl = PL(
      DEV.map(([t, , f], i) => [t, states[i]!, f]),
      cursor,
      state,
    );
    return {
      ...pl,
      plan: {
        ...pl.plan,
        sendBackTo: { o2: 'o1', o4: 'o3', o6: 'o3' },
        ...(sent ? { sentBack: { n: sent } } : {}),
      },
    };
  };
  const sb = (name: string, actor: Actor, input: Partial<Parameters<typeof sendBackPlan>[1]>) =>
    act(
      `sendBackPlan/${name}`,
      'sendBackPlan',
      actor,
      {
        ...devPl(['done', 'done', 'done', 'done', 'approved', 'proposed'], 4),
        thread: TH({ subjectId: 's1', state: 'waiting' }),
        reason: ' The e2e fails on main ',
        ...input,
      },
      sendBackPlan,
    );
  sb('release to build', AGENT, { toStep: 2 });
  sb('default target', AGENT, {});
  sb('to shape', AGENT, { toStep: 0 });
  sb('running step', AGENT, {
    ...devPl(['done', 'done', 'done', 'done', 'running', 'proposed'], 4),
    toStep: 2,
  });
  sb('third blocks', AGENT, {
    ...devPl(['done', 'done', 'done', 'done', 'approved', 'proposed'], 4, 'active', 2),
  });
  // ---------- long steps (slice 6b) ----------
  finP('build started without an item', {
    plan: devPl(['done', 'done', 'approved', 'proposed', 'approved', 'proposed'], 2),
    status: 'started',
  });
  finP('shape started without an item', {
    plan: devPl(['approved', 'proposed', 'approved', 'proposed', 'approved', 'proposed'], 0),
    status: 'started',
  });
  finP('build done with usage', {
    plan: devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 2),
    status: 'done',
    result: { permalink: 'https://github.com/example/board/pull/86' },
    usage: { tokens: 123456, costEur: 1.234567 },
  });
  finP('bad usage', {
    plan: devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 2),
    status: 'done',
    usage: { tokens: 1.5 },
  });
  finP('bad cost', {
    plan: devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 2),
    status: 'done',
    usage: { costEur: -1 },
  });
  const sprog = (
    name: string,
    actor: Actor,
    input: Partial<Parameters<typeof stepProgress>[1]>,
  ) => {
    const pl =
      input.plan ?? devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 2);
    const oid = input.outcomeId ?? 'o3';
    act(
      `stepProgress/${name}`,
      'stepProgress',
      actor,
      {
        outcomeId: oid,
        outcome: pl.outcomes[oid]!,
        thread: TH({ subjectId: 's1', state: 'waiting' }),
        line: '  Tests   green, writing the PR ',
        percent: 70,
        plan: pl,
        ...input,
      },
      stepProgress,
    );
  };
  sprog('line and percent', AGENT, {});
  sprog('no percent', AGENT, { percent: null });
  sprog('empty line', AGENT, { line: '  ' });
  sprog('line too long', AGENT, { line: 'x'.repeat(141) });
  sprog('percent 101', AGENT, { percent: 101 });
  sprog('percent 2.5', AGENT, { percent: 2.5 });
  sprog('not its executor', OTHER, {});
  sprog('not started', AGENT, {
    plan: devPl(['done', 'done', 'approved', 'proposed', 'approved', 'proposed'], 2),
  });
  sprog('a short step', AGENT, {
    plan: devPl(['running', 'proposed', 'approved', 'proposed', 'approved', 'proposed'], 0),
    outcomeId: 'o1',
  });
  sprog('not its turn', AGENT, {
    plan: devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 3),
  });
  sprog('blocked plan', AGENT, {
    plan: devPl(['done', 'done', 'running', 'proposed', 'approved', 'proposed'], 2, 'blocked'),
  });
  sb('to a gate', AGENT, { toStep: 3 });
  sb('to a later step', AGENT, { toStep: 5 });
  sb('to itself', AGENT, { toStep: 4 });
  sb('no reason', AGENT, { reason: '  ' });
  sb('reason too long', AGENT, { reason: 'r'.repeat(1001) });
  sb('not its executor', OTHER, {});
  sb('at a gate', AGENT, {
    ...devPl(['done', 'done', 'done', 'proposed', 'approved', 'proposed'], 3),
  });
  sb('step not approved', AGENT, {
    ...devPl(['done', 'proposed', 'proposed', 'proposed', 'proposed', 'proposed'], 2),
  });
  sb('blocked', AGENT, {
    ...devPl(['done', 'done', 'approved', 'proposed', 'approved', 'proposed'], 2, 'blocked', 3),
  });
  sb('stopped', AGENT, {
    ...devPl(['done', 'done', 'done', 'done', 'approved', 'proposed'], 4, 'stopped'),
  });
  sb('nothing to go back to', AGENT, {
    ...PL([['release', 'approved']], 0),
  });
  const pv = (name: string, pl: PlanInput) =>
    pure(`planView/${name}`, 'planView', { plan: pl.plan, outcomes: pl.outcomes }, (i) => {
      const v = planView(i.plan, i.outcomes);
      return {
        state: v.state,
        cursor: v.cursor,
        total: v.total,
        through: v.through,
        progress: v.progress,
        steps: v.steps.map((s) => ({
          number: s.number,
          outcomeId: s.outcomeId,
          type: s.type,
          kind: s.kind,
          label: s.label,
          ui: s.ui,
          atCursor: s.atCursor,
        })),
      };
    });
  pv(
    'blocked by send backs',
    PL(
      [
        ['reply', 'done'],
        ['build', 'approved'],
      ],
      1,
      'blocked',
    ),
  );
  pv(
    'mixed',
    PL(
      [
        ['reply', 'done'],
        ['nudge', 'rejected', { text: 'y' }],
        ['approval', 'proposed', { what: 'x' }],
        ['reply', 'approved'],
        ['make_it_work', 'revising', { title: 't' }],
      ],
      2,
    ),
  );
  pv(
    'running',
    PL(
      [
        ['reply', 'approved'],
        ['make_it_work', 'running', { title: 't' }],
      ],
      1,
    ),
  );
  pv('blocked', PL([['reply', 'failed']], 0, 'blocked'));
  pv(
    'stopped',
    PL(
      [
        ['reply', 'done'],
        ['approval', 'rejected', { what: 'x' }],
        ['reply', 'approved'],
      ],
      1,
      'stopped',
    ),
  );
  pv('done', PL([['reply', 'done']], 1, 'done'));
  pv('missing step', { ...PL([['reply', 'proposed']], 0), outcomes: {} });
  const clean = (name: string, input: { type: string; fields: Record<string, unknown> }) =>
    pure(`cleanOutcomeFields/${name}`, 'cleanOutcomeFields', input, (i) =>
      cleanOutcomeFields(i.type, i.fields),
    );
  clean('snooze', {
    type: 'snooze',
    fields: { until: '2026-11-03T09:00:00.1234Z', reason: ' freeze ' },
  });
  clean('empty optional dropped', {
    type: 'make_it_work',
    fields: { title: 'T', brief: '  ', project: null },
  });
  clean('unknown type', { type: 'x', fields: {} });
  const after = (name: string, input: { type: string; fields: Record<string, string | boolean> }) =>
    pure(`threadAfter/${name}`, 'threadAfter', input, (i) => threadAfter(i.type, i.fields));
  for (const t of ['reply', 'no_reply', 'make_it_work', 'handover', 'nudge', 'ignore'])
    after(t, { type: t, fields: {} });
  after('snooze', { type: 'snooze', fields: { until: '2026-11-03T08:00:00.000Z' } });
  const keys = (
    name: string,
    input: { member: string; source: string; threadRef: string; messageId: string },
  ) =>
    pure(`inboxKeys/${name}`, 'inboxKeys', input, (i) => ({
      message: inboxMessageKey(i.member, i.source, i.threadRef, i.messageId),
      thread: inboxThreadKey(i.member, i.source, i.threadRef),
    }));
  keys('plain', { member: 'joao', source: 'teams', threadRef: 'thread-1', messageId: 'm-1' });
  keys('unicode', {
    member: 'joao',
    source: 'mail',
    threadRef: '<a&b@example.com>',
    messageId: 'ação',
  });
  const tf = (name: string, input: { text: string }) =>
    pure(`titleFrom/${name}`, 'titleFrom', input, (i) => titleFrom(i.text));
  tf('first line', { text: '\n\n  Hello   there \nsecond' });
  tf('long', { text: 'é'.repeat(130) });
  tf('blank', { text: ' \n ' });
  const flag = (name: string, actor: Actor, input: Partial<Parameters<typeof flagThread>[1]>) =>
    act(
      `flagThread/${name}`,
      'flagThread',
      actor,
      { threadId: 'it1', thread: TH({ subjectId: 's1' }), urgent: true, ...input },
      flagThread,
    );
  flag('urgent with a reason', AGENT, { reason: '  Production is down ' });
  flag('not urgent', AGENT, { urgent: false, reason: '  ' });
  flag('reason too long', AGENT, { reason: 'r'.repeat(1001) });
  // Due dates (thread_due, item kt3E7u9EliL3q2veDDI0)
  const due = (name: string, actor: Actor, input: Partial<Parameters<typeof dueThread>[1]>) =>
    act(
      `dueThread/${name}`,
      'dueThread',
      actor,
      {
        threadId: 'it1',
        thread: TH({ subjectId: 's1' }),
        due: '2026-10-30T12:00:00+01:00',
        ...input,
      },
      dueThread,
    );
  due('set with a reason', AGENT, { reason: '  Sam: by Friday noon ' });
  due('fractional seconds', AGENT, { due: '2026-10-30T12:00:00.1239Z' });
  due('cleared', AGENT, { due: null, reason: ' ' });
  due('not iso', AGENT, { due: 'Friday' });
  due('no offset', AGENT, { due: '2026-10-30T12:00:00' });
  due('reason too long', AGENT, { reason: 'r'.repeat(1001) });
  // Related subjects and search (item 4PEHr, scope addition 2026-10-28)
  const J = { memberUid: 'joao' };
  const relate = (
    name: string,
    actor: Actor,
    input: Partial<Parameters<typeof proposeRelation>[1]>,
  ) =>
    act(
      `proposeRelation/${name}`,
      'proposeRelation',
      actor,
      {
        a: 'sB',
        b: 'sA',
        subjectA: J,
        subjectB: J,
        existing: null,
        note: '  same   client ',
        ...input,
      },
      proposeRelation,
    );
  const REL = (state: string) => ({ memberUid: 'joao', a: 'sA', b: 'sB', note: '', state });
  relate('proposed, sorted', AGENT, {});
  relate('no note', AGENT, { a: 'sA', b: 'sB', note: null });
  relate('same subject', AGENT, { b: 'sB' });
  relate('two people', AGENT, { subjectB: { memberUid: 'maria' } });
  relate('related already', AGENT, { existing: REL('related') as never });
  relate('proposed already', AGENT, { existing: REL('proposed') as never });
  relate('turned down', AGENT, { existing: REL('rejected') as never });
  relate('note too long', AGENT, { note: 'n'.repeat(501) });
  relate('person refused', HUMAN, {});
  pure('relationId/either way', 'relationId', { a: 'zeta', b: 'alpha' }, (i) =>
    relationId(i.a, i.b),
  );
  const DAY = 86_400_000;
  const SEARCH = {
    query: '',
    filters: {},
    nowMs: NOW_MS,
    subjects: [
      { id: 's1', name: 'Klarna refunds (Payments)' },
      { id: 's2', name: 'Grafana access' },
      { id: 's3', name: 'Quiet one' },
      { id: 's4', name: 'Ação (Lisboa)' },
    ],
    threads: [
      {
        id: 't1',
        subjectId: 's1',
        state: 'yourCall',
        title: 'Refund for order 12',
        lastMessageAtMs: NOW_MS - DAY,
      },
      {
        id: 't2',
        subjectId: 's2',
        state: 'waiting',
        title: 'Need a Grafana login',
        lastMessageAtMs: NOW_MS - 2 * DAY,
      },
      {
        id: 't3',
        subjectId: 's3',
        state: 'done',
        title: 'Old',
        lastMessageAtMs: NOW_MS - 90 * DAY,
      },
      {
        id: 't5',
        subjectId: 's1',
        state: 'needsYou',
        title: 'Klarna payout',
        lastMessageAtMs: NOW_MS - 3 * DAY,
      },
      {
        id: 't4',
        subjectId: null,
        state: 'investigating',
        title: 'Unfiled',
        lastMessageAtMs: NOW_MS,
      },
      {
        id: 't6',
        subjectId: 'gone',
        state: 'investigating',
        title: 'Lost',
        lastMessageAtMs: NOW_MS,
      },
    ],
    messages: [
      {
        threadId: 't1',
        direction: 'in',
        source: 'teams',
        senderName: 'Sam Example',
        senderHandle: 'sam@example.com',
        text: 'Klarna refund stuck',
      },
      {
        threadId: 't1',
        direction: 'out',
        source: 'teams',
        senderName: 'João',
        senderHandle: null,
        text: 'Looking',
      },
      {
        threadId: 't5',
        direction: 'in',
        source: 'mail',
        senderName: 'Ana',
        senderHandle: 'ana@example.com',
        text: 'Payout?',
      },
      {
        threadId: 't2',
        direction: 'in',
        source: 'jira',
        senderName: 'Ana',
        senderHandle: null,
        text: 'Please give me Grafana',
      },
      {
        threadId: 't4',
        direction: 'in',
        source: 'mail',
        senderName: 'Zed',
        senderHandle: null,
        text: 'klarna',
      },
    ],
    relations: [
      { a: 's1', b: 's2', state: 'related', note: 'same team' },
      { a: 's1', b: 'gone', state: 'related', note: '' },
      { a: 's2', b: 's3', state: 'proposed', note: '' },
      { a: 's3', b: 's4', state: 'rejected', note: '' },
    ],
  };
  const search = (
    name: string,
    over: Partial<typeof SEARCH> & { filters?: Record<string, unknown> },
  ) =>
    pure(`searchSubjects/${name}`, 'searchSubjects', { ...SEARCH, ...over }, (i) =>
      searchSubjects(i as never),
    );
  search('everything', {});
  search('a name', { query: 'klarna' });
  search('a handle', { query: 'SAM@' });
  search('a channel', { query: 'jira' });
  search('a person in two subjects', { query: 'ana' });
  search('two words', { query: '  grafana   ana ' });
  search('no match', { query: 'grafana klarna' });
  search('accents', { query: 'AÇÃO' });
  search('waiting for me', { filters: { waitingForMe: true } });
  search('has open', { filters: { hasOpen: true } });
  search('active 30 days', { filters: { activeDays: 30 } });
  search('active 1 day', { filters: { activeDays: 1 } });
  search('limit', { filters: { limit: 2 } });
  search('limit 0 is the default', { filters: { limit: 0 } });
  search('limit over the top', { filters: { limit: 500 } });
  summaryCases(act, pure, { agent: AGENT, other: OTHER, human: HUMAN });

  return cases;
}
