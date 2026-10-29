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
  agentMayTakeStep,
  agentRounds,
  agentSendBack,
  agentSendBackTargets,
  allowedAgentsFor,
  askPathChange,
  attach,
  checkSendBackTarget,
  claimItem,
  completeStep,
  createItem,
  endRun,
  firstOnPath,
  guardrailsOf,
  heartbeat,
  HEARTBEAT_EVENT_AFTER_MS,
  isOnHold,
  isPaused,
  isUnshaped,
  liveTerminal,
  logLine,
  MAX_AGENT_SEND_BACKS,
  newTokens,
  nextOnPath,
  pathOf,
  planPathChange,
  postMessage,
  proposeStep,
  raiseFinding,
  parkItem,
  releaseClaim,
  reportProgress,
  reportStatus,
  statusEveryOf,
  unparkItem,
  requireSendBackReason,
  shapeItem,
  skipStep,
  stepsOnPath,
  streakAfter,
  STUCK_QUESTION_PREFIX,
  stuckQuestion,
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
  planThreadState,
  planView,
  type PlanInput,
  type ActionContext,
  type Actor,
  type OutcomeStateOf,
  type ThreadStateOf,
  type AgentGuardState,
  type ItemState,
  type Step,
} from '../../packages/shared/src/index';

import { calendarCases } from './calendarCases';
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
const MARIA: Actor = { type: 'human', id: 'maria', name: 'Maria' };

const ts = (ms: number) => Timestamp.fromMillis(ms);
const T0 = ts(NOW_MS - 60_000);

const gate = (deciders: string[]) => ({
  deciderUids: deciders,
  groupIds: [],
  rule: 'any' as const,
  n: 1,
  mustInclude: [],
  rejectPolicy: 'one' as const,
  remindAfterHours: 0,
});
const agentStep = (id: string, name: string): Step => ({
  id,
  name,
  kind: 'agent',
  description: '',
});
const humanStep = (id: string, name: string, deciders = ['joao']): Step => ({
  id,
  name,
  kind: 'human',
  description: '',
  gate: gate(deciders),
});

/** shape · Approve (people) · build · review · test · Accept (people) · release */
const LIB = [
  agentStep('shape', 'Shape'),
  humanStep('approve', 'Approve'),
  agentStep('build', 'Build'),
  agentStep('review', 'Review'),
  agentStep('test', 'Test'),
  humanStep('accept', 'Accept'),
  agentStep('release', 'Release'),
];
const PROJECT = { steps: LIB };
/** 15 agent steps a0…a14 (send-back span). */
const LONG = { steps: Array.from({ length: 15 }, (_, i) => agentStep(`a${i}`, `A${i}`)) };

const claimOf = (agentUid = AGENT.id, runId = 'run1') => ({ runId, agentUid, heartbeatAt: T0 });
const SHAPED = { by: { type: 'agent' as const, id: 'agentA' }, at: T0, note: 'Full path' };

function item(over: Partial<ItemState> = {}): ItemState {
  return {
    title: 'Fix login',
    type: 'task',
    stepId: 'build',
    status: 'working',
    claim: claimOf(),
    gate: null,
    sendBackCount: 0,
    costEur: 0.25,
    triage: null,
    ...over,
  };
}
const unshaped = (over: Partial<ItemState> = {}) => item({ stepId: 'shape', shape: null, ...over });

const STREAK2: AgentGuardState = {
  failStreak: 2,
  pausedAt: null,
  guardrails: { maxFailedRuns: 3 },
};
const STREAK0: AgentGuardState = { failStreak: 0, pausedAt: null };
const PAUSED: AgentGuardState = { failStreak: 4, pausedAt: T0 };
const RESULT = {
  costEur: 0.1,
  tokensIn: 100,
  tokensOut: 5,
  tokensCached: 150,
  model: 'claude-x',
  summary: 'Did it',
};

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
  const W = { projectId: 'p1', itemId: 'i1' };

  // ---------- claimItem ----------
  const claim = (name: string, actor: Actor, input: Parameters<typeof claimItem>[1]) =>
    act(`claimItem/${name}`, 'claimItem', actor, input, claimItem);
  claim('unclaimed', AGENT, { ...W, item: item({ claim: null, status: 'queued' }) });
  claim('given run id', AGENT, {
    ...W,
    item: item({ claim: null, status: 'queued' }),
    runId: 'runX',
  });
  claim('takeover', AGENT, {
    ...W,
    item: item({ claim: claimOf('agentB', 'runOld') }),
    takeover: { runId: 'runOld' },
  });
  claim('takeover of the same run', AGENT, {
    ...W,
    item: item({ claim: claimOf('agentB', 'runOld') }),
    runId: 'runOld',
    takeover: { runId: 'runOld' },
  });
  claim('stale claim without open run', AGENT, {
    ...W,
    item: item({ claim: claimOf('agentB', 'runOld') }),
  });
  claim('shaping job', AGENT, { ...W, item: unshaped({ claim: null }), job: 'shape' });
  claim('person refused', HUMAN, { ...W, item: item({ claim: null }) });

  // ---------- heartbeat ----------
  const beat = (name: string, actor: Actor, input: Parameters<typeof heartbeat>[1]) =>
    act(`heartbeat/${name}`, 'heartbeat', actor, input, heartbeat);
  const R = { ...W, runId: 'run1' };
  beat('not due', AGENT, { ...R, lastHeartbeatEventAtMs: NOW_MS - 60_000, nowMs: NOW_MS });
  beat('due exactly', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - HEARTBEAT_EVENT_AFTER_MS,
    nowMs: NOW_MS,
  });
  beat('just not due', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - HEARTBEAT_EVENT_AFTER_MS + 1,
    nowMs: NOW_MS,
  });
  beat('due with usage', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - 10 * 60_000,
    nowMs: NOW_MS,
    usage: {
      tokensIn: 1234.5,
      tokensOut: 10.4,
      tokensCached: 2000,
      model: 'claude-x',
      costEur: 0.123,
    },
  });
  beat('not due with usage', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - 1000,
    nowMs: NOW_MS,
    usage: { tokensIn: 2.5, tokensOut: -3, model: null, costEur: -1 },
  });
  beat('usage rounding and empty model', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - 1000,
    nowMs: NOW_MS,
    usage: { tokensIn: -2.5, tokensOut: 0.49999999999999994, tokensCached: 0.5, model: '' },
  });
  beat('long model name', AGENT, {
    ...R,
    lastHeartbeatEventAtMs: NOW_MS - 1000,
    nowMs: NOW_MS,
    usage: { tokensIn: 1, tokensOut: 1, model: 'm'.repeat(100) },
  });
  beat('clock from context (due)', AGENT, { ...R, lastHeartbeatEventAtMs: NOW_MS - 400_000 });
  beat('clock from context (not due)', AGENT, { ...R, lastHeartbeatEventAtMs: NOW_MS - 1000 });
  beat('person refused', HUMAN, { ...R, lastHeartbeatEventAtMs: 0 });

  // ---------- logLine ----------
  const log = (name: string, actor: Actor, input: Parameters<typeof logLine>[1]) =>
    act(`logLine/${name}`, 'logLine', actor, input, logLine);
  log('first', AGENT, { runId: 'run1', n: 0, level: 'info', text: 'Started' });
  log('last allowed', AGENT, { runId: 'run1', n: 499, level: 'warn', text: 'é😀 almost done' });
  log('long text', AGENT, { runId: 'run1', n: 7, level: 'error', text: 'x'.repeat(4005) });
  log('too many', AGENT, { runId: 'run1', n: 500, level: 'info', text: 'no' });
  log('negative', AGENT, { runId: 'run1', n: -1, level: 'info', text: 'no' });
  log('person refused', HUMAN, { runId: 'run1', n: 0, level: 'info', text: 'no' });

  // ---------- releaseClaim ----------
  const rel = (name: string, actor: Actor, input: Parameters<typeof releaseClaim>[1]) =>
    act(`releaseClaim/${name}`, 'releaseClaim', actor, input, releaseClaim);
  rel('plain', AGENT, { ...W, item: item() });
  rel('with result', AGENT, { ...W, item: item(), result: RESULT, agent: STREAK0 });
  rel('failed pauses the agent', AGENT, {
    ...W,
    item: item(),
    status: 'failed',
    agent: STREAK2,
    result: { costEur: 0.5 },
  });
  rel('failed while paused', AGENT, { ...W, item: item(), status: 'failed', agent: PAUSED });
  rel('failed with default guardrails', AGENT, {
    ...W,
    item: item(),
    status: 'failed',
    agent: STREAK0,
  });
  rel('released keeps the streak', AGENT, {
    ...W,
    item: item(),
    status: 'released',
    agent: STREAK2,
  });
  rel('hold for a question', AGENT, { ...W, item: item(), holdFor: 'q1', result: { costEur: 1 } });
  rel('run already ended', AGENT, {
    ...W,
    item: item(),
    runEnded: true,
    result: { costEur: 1 },
    agent: STREAK2,
    status: 'failed',
  });
  rel('not holding', AGENT, { ...W, item: item({ claim: claimOf('agentB') }) });
  rel('no claim', AGENT, { ...W, item: item({ claim: null }) });
  rel('another agent holds it', OTHER, { ...W, item: item() });
  rel('person refused', HUMAN, { ...W, item: item() });

  // ---------- reportProgress ----------
  const prog = (name: string, actor: Actor, input: Parameters<typeof reportProgress>[1]) =>
    act(`reportProgress/${name}`, 'reportProgress', actor, input, reportProgress);
  prog('progress', AGENT, { ...W, item: item(), progress: { done: 2, total: 5 } });
  prog('cleared', AGENT, { ...W, item: item(), progress: null, costEur: 1.5 });
  prog('cost only', AGENT, { ...W, item: item(), costEur: 0.3 });
  prog('nothing', AGENT, { ...W, item: item() });
  prog('not holding', AGENT, { ...W, item: item({ claim: null }), costEur: 1 });
  prog('person refused', HUMAN, { ...W, item: item(), costEur: 1 });

  // ---------- reportStatus (item AzveC) ----------
  const status = (name: string, actor: Actor, input: Parameters<typeof reportStatus>[1]) =>
    act(`reportStatus/${name}`, 'reportStatus', actor, input, reportStatus);
  const prev = (text: string, pct: number | null, agoMs: number, runId = 'run1') => ({
    runId,
    text,
    pct,
    at: ts(NOW_MS - agoMs),
    by: AGENT.id,
  });
  status('reports', AGENT, { ...W, item: item(), text: '  Running   release checks ', pct: 70 });
  status('no pct', AGENT, { ...W, item: item(), text: 'Reading the brief' });
  status('pct null', AGENT, { ...W, item: item(), text: 'Reading', pct: null });
  status('pct 0', AGENT, { ...W, item: item(), text: 'Start', pct: 0 });
  status('pct 100', AGENT, { ...W, item: item(), text: 'Done', pct: 100 });
  status('pct 101', AGENT, { ...W, item: item(), text: 'x', pct: 101 });
  status('pct -1', AGENT, { ...W, item: item(), text: 'x', pct: -1 });
  status('pct 1.5', AGENT, { ...W, item: item(), text: 'x', pct: 1.5 });
  status('empty', AGENT, { ...W, item: item(), text: '  \n ' });
  status('200 chars', AGENT, { ...W, item: item(), text: '😀'.repeat(100) });
  status('long', AGENT, { ...W, item: item(), text: 'é'.repeat(201) });
  status('repeat', AGENT, {
    ...W,
    item: item({ statusUpdate: prev('Tests', 50, 60_000) }),
    text: 'Tests',
    pct: 50,
  });
  status('changed', AGENT, {
    ...W,
    item: item({ statusUpdate: prev('Tests', 50, 60_000) }),
    text: 'Tests',
    pct: 60,
  });
  status('too soon', AGENT, {
    ...W,
    item: item({ statusUpdate: prev('Tests', 50, 29_000) }),
    text: 'More tests',
  });
  status('old run too soon is fine', AGENT, {
    ...W,
    item: item({ statusUpdate: prev('Tests', 50, 1_000, 'runOld') }),
    text: 'Tests',
    pct: 50,
  });
  status('not holding', AGENT, { ...W, item: item({ claim: null }), text: 'x' });
  status('person refused', HUMAN, { ...W, item: item(), text: 'x' });
  for (const v of [undefined, 0, 15, 30, 60, 45])
    pure(`statusEveryOf/${String(v)}`, 'statusEveryOf', { statusEvery: v }, (p) =>
      statusEveryOf(p),
    );

  // ---------- parkItem / unparkItem (item QjTTL) ----------
  const park = (name: string, actor: Actor, input: Parameters<typeof parkItem>[1]) =>
    act(`parkItem/${name}`, 'parkItem', actor, input, parkItem);
  park('parks', AGENT, { ...W, item: item(), reason: '  release batch  ' });
  park('empty reason', AGENT, { ...W, item: item(), reason: '   ' });
  park('long reason', AGENT, { ...W, item: item(), reason: 'é'.repeat(201) });
  park('200 chars', AGENT, { ...W, item: item(), reason: '😀'.repeat(100) });
  park('not holding', AGENT, { ...W, item: item({ claim: null }), reason: 'review' });
  park('person refused', HUMAN, { ...W, item: item(), reason: 'review' });
  const unpark = (name: string, actor: Actor, input: Parameters<typeof unparkItem>[1]) =>
    act(`unparkItem/${name}`, 'unparkItem', actor, input, unparkItem);
  unpark('wakes', AGENT, { ...W, item: item() });
  unpark('not holding', AGENT, { ...W, item: item({ claim: null }) });
  unpark('person refused', HUMAN, { ...W, item: item() });

  // ---------- completeStep ----------
  const done = (name: string, actor: Actor, input: Parameters<typeof completeStep>[1]) =>
    act(`completeStep/${name}`, 'completeStep', actor, input, completeStep);
  const P = { ...W, project: PROJECT };
  done('to the next agent step', AGENT, { ...P, item: item(), result: RESULT });
  done('to a people step', AGENT, { ...P, item: item({ stepId: 'test' }) });
  done('last step finishes', AGENT, { ...P, item: item({ stepId: 'release' }), agent: STREAK0 });
  done('skips an agent step', AGENT, {
    ...P,
    item: item({ pathSkips: { review: 'not needed' } }),
  });
  done('skips a people step', AGENT, {
    ...P,
    item: item({ stepId: 'test', gateSkips: { accept: '' } }),
  });
  done('people step in pathSkips stays', AGENT, {
    ...P,
    item: item({ stepId: 'test', pathSkips: { accept: 'x' } }),
  });
  done('resets the streak', AGENT, {
    ...P,
    item: item(),
    agent: STREAK2,
    result: { costEur: 0.05 },
  });
  done('paused agent keeps its streak', AGENT, { ...P, item: item(), agent: PAUSED });
  done('at a people step', AGENT, { ...P, item: item({ stepId: 'approve' }) });
  done('unknown step', AGENT, { ...P, item: item({ stepId: 'gone' }) });
  done('not holding', AGENT, { ...P, item: item({ claim: claimOf('agentB') }) });
  done('person refused', HUMAN, { ...P, item: item() });

  // ---------- endRun ----------
  const end = (name: string, actor: Actor, input: Parameters<typeof endRun>[1]) =>
    act(`endRun/${name}`, 'endRun', actor, input, endRun);
  const E = { ...W, runId: 'run1' };
  end('done', AGENT, { ...E, result: { status: 'done' } });
  end('done resets', AGENT, { ...E, result: { status: 'done', ...RESULT }, agent: STREAK2 });
  end('failed pauses', AGENT, { ...E, result: { status: 'failed', model: null }, agent: STREAK2 });
  end('failed counts', AGENT, {
    ...E,
    result: { status: 'failed', tokensIn: 10, tokensCached: 4, summary: '' },
    agent: STREAK0,
  });
  end('released', AGENT, { ...E, result: { status: 'released' }, agent: STREAK2 });
  end('person refused', HUMAN, { ...E, result: { status: 'done' } });

  // ---------- attach ----------
  const att = (name: string, actor: Actor, input: Parameters<typeof attach>[1]) =>
    act(`attach/${name}`, 'attach', actor, input, attach);
  att('html by an agent', AGENT, {
    ...W,
    kind: 'html',
    name: 'plan.html',
    content: '<h1>Plan é😀€</h1>',
    runId: 'run1',
  });
  att('text without run', AGENT, { ...W, kind: 'text', name: 'a.txt', content: '' });
  att('link', AGENT, { ...W, kind: 'link', name: 'PR', url: 'https://example.com/pr/1' });
  att('by a person ignores the run', HUMAN, {
    ...W,
    kind: 'markdown',
    name: 'n.md',
    content: '# hi',
    runId: 'run1',
    attachmentId: 'att9',
  });
  att('link without url', AGENT, { ...W, kind: 'link', name: 'PR' });
  att('link with empty url', AGENT, { ...W, kind: 'link', name: 'PR', url: '' });
  att('content missing', AGENT, { ...W, kind: 'pdf', name: 'x.pdf' });

  // ---------- postMessage ----------
  const post = (name: string, actor: Actor, input: Parameters<typeof postMessage>[1]) =>
    act(`postMessage/${name}`, 'postMessage', actor, input, postMessage);
  post('question', AGENT, { ...W, kind: 'question', text: 'Which color?', runId: 'run1' });
  post('note by a person', HUMAN, { ...W, kind: 'note', text: 'FYI', messageId: 'm7' });
  post('note by an agent', AGENT, { ...W, kind: 'note', text: 'Done', runId: null });
  post('question by a person', HUMAN, { ...W, kind: 'question', text: 'Why?' });

  // ---------- raiseFinding ----------
  const find = (name: string, actor: Actor, input: Parameters<typeof raiseFinding>[1]) =>
    act(`raiseFinding/${name}`, 'raiseFinding', actor, input, raiseFinding);
  const F = { project: PROJECT, projectId: 'p1', parentItemId: 'i1' };
  find('while holding', AGENT, {
    ...F,
    parent: { title: 'Fix login', claim: claimOf() },
    title: '  Flaky test  ',
    details: 'It fails one run in ten.',
  });
  find('not holding', AGENT, {
    ...F,
    parent: { title: 'Fix login', claim: claimOf('agentB') },
    title: 'Typo',
    details: '',
    itemId: 'f1',
  });
  find('long title and label', AGENT, {
    ...F,
    parent: { title: 'P'.repeat(250), claim: null },
    title: 'T'.repeat(320),
    details: 'd'.repeat(20010),
  });
  find('blank title', AGENT, {
    ...F,
    parent: { title: 'x', claim: null },
    title: ' \t\u00a0\ufeff ',
    details: '',
  });
  find('no steps', AGENT, {
    ...F,
    project: { steps: [] },
    parent: { title: 'x', claim: null },
    title: 'A',
    details: '',
  });
  find('person refused', HUMAN, {
    ...F,
    parent: { title: 'x', claim: null },
    title: 'A',
    details: '',
  });

  // ---------- createItem (item DhsO9: agents create items) ----------
  const make = (name: string, actor: Actor, input: Parameters<typeof createItem>[1]) =>
    act(`createItem/${name}`, 'createItem', actor, input, createItem);
  const OPEN = { steps: LIB, agentsMayCreateItems: true };
  make('by an agent', AGENT, {
    project: OPEN,
    projectId: 'p1',
    title: 'Fix the checkout timeout',
    type: 'task',
    summary: 'Asked on Telegram.',
  });
  make('by an agent, unshaped, own id', AGENT, {
    project: { ...OPEN, shapeNewItems: true },
    projectId: 'p1',
    itemId: 'n1',
    title: 'Look at the logs',
    type: 'bug',
    unshaped: true,
  });
  make('by an agent at a people first step', AGENT, {
    project: {
      steps: [humanStep('approve', 'Approve'), agentStep('build', 'Build')],
      agentsMayCreateItems: true,
    },
    projectId: 'p1',
    title: 'Approve the banner',
    type: 'request',
    parentItemId: 'i1',
    order: 5,
  });
  make('by an agent, setting off', AGENT, {
    project: { steps: LIB, agentsMayCreateItems: false },
    projectId: 'p1',
    title: 'x',
    type: 'task',
  });
  make('by an agent, setting absent', AGENT, {
    project: PROJECT,
    projectId: 'p1',
    title: 'x',
    type: 'task',
  });
  make('by an agent, no steps', AGENT, {
    project: { steps: [], agentsMayCreateItems: true },
    projectId: 'p1',
    title: 'x',
    type: 'task',
  });
  make('by a person', HUMAN, {
    project: PROJECT,
    projectId: 'p1',
    title: 'Quick one',
    type: 'idea',
    source: { kind: 'telegram', label: 'Telegram' },
  });

  // ---------- agentSendBack ----------
  const back = (name: string, actor: Actor, input: Parameters<typeof agentSendBack>[1]) =>
    act(`agentSendBack/${name}`, 'agentSendBack', actor, input, agentSendBack);
  const atTest = (over: Partial<ItemState> = {}) => item({ stepId: 'test', ...over });
  const reason = 'The login test fails on Safari.';
  back('round 0 to build', AGENT, {
    ...P,
    item: atTest(),
    toStepId: 'build',
    reason: ` ${reason} `,
  });
  back('round 2 to review', AGENT, {
    ...P,
    item: atTest({ agentSendBacks: 2 }),
    toStepId: 'review',
    reason,
    result: RESULT,
    agent: STREAK2,
  });
  back('round 3 refused', AGENT, {
    ...P,
    item: atTest({ agentSendBacks: 3 }),
    toStepId: 'build',
    reason,
  });
  back('over a skipped step', AGENT, {
    ...P,
    item: atTest({ pathSkips: { review: '' } }),
    toStepId: 'build',
    reason,
  });
  back('to a skipped step', AGENT, {
    ...P,
    item: atTest({ pathSkips: { review: '' } }),
    toStepId: 'review',
    reason,
  });
  back('to a people step', AGENT, { ...P, item: atTest(), toStepId: 'approve', reason });
  back('across a people step', AGENT, { ...P, item: atTest(), toStepId: 'shape', reason });
  back('forward', AGENT, { ...P, item: atTest(), toStepId: 'release', reason });
  back('same step', AGENT, { ...P, item: atTest(), toStepId: 'test', reason });
  back('unknown target', AGENT, { ...P, item: atTest(), toStepId: 'nope', reason });
  back('blank reason', AGENT, { ...P, item: atTest(), toStepId: 'build', reason: ' \n ' });
  back('reason too long', AGENT, {
    ...P,
    item: atTest(),
    toStepId: 'build',
    reason: 'r'.repeat(2001),
  });
  back('reason at the limit', AGENT, {
    ...P,
    item: atTest(),
    toStepId: 'build',
    reason: '😀'.repeat(1000),
  });
  back('from a people step', AGENT, {
    ...P,
    item: atTest({ stepId: 'accept' }),
    toStepId: 'test',
    reason,
  });
  back('too far back', AGENT, {
    ...W,
    project: LONG,
    item: item({ stepId: 'a14' }),
    toStepId: 'a0',
    reason,
  });
  back('as far as allowed', AGENT, {
    ...W,
    project: LONG,
    item: item({ stepId: 'a14' }),
    toStepId: 'a1',
    reason,
  });
  back('not holding', AGENT, {
    ...P,
    item: atTest({ claim: claimOf('agentB') }),
    toStepId: 'build',
    reason,
  });
  back('person refused', HUMAN, { ...P, item: atTest(), toStepId: 'build', reason });

  // ---------- send-back helpers ----------
  const targets = (name: string, input: { project: { steps: Step[] }; item: ItemState }) =>
    pure(`agentSendBackTargets/${name}`, 'agentSendBackTargets', input, (i) =>
      agentSendBackTargets(i.project, i.item).map((s) => s.id),
    );
  targets('from test', { project: PROJECT, item: atTest() });
  targets('with a skip', { project: PROJECT, item: atTest({ pathSkips: { review: '' } }) });
  targets('people step skipped', {
    project: PROJECT,
    item: item({ stepId: 'build', gateSkips: { approve: '' } }),
  });
  targets('span', { project: LONG, item: item({ stepId: 'a14' }) });
  targets('first step', { project: PROJECT, item: item({ stepId: 'shape' }) });
  targets('unknown step', { project: PROJECT, item: item({ stepId: 'gone' }) });
  const check = (
    name: string,
    input: { project: { steps: Step[] }; item: ItemState; toStepId: string },
  ) =>
    pure(
      `checkSendBackTarget/${name}`,
      'checkSendBackTarget',
      input,
      (i) => checkSendBackTarget(i.project, i.item, i.toStepId).id,
    );
  check('valid', { project: PROJECT, item: atTest(), toStepId: 'build' });
  check('people step', { project: PROJECT, item: atTest(), toStepId: 'accept' });
  check('item at an unknown step', {
    project: PROJECT,
    item: item({ stepId: 'gone' }),
    toStepId: 'build',
  });
  const reasonCheck = (name: string, input: { reason: string }) =>
    pure(`requireSendBackReason/${name}`, 'requireSendBackReason', input, (i) => {
      requireSendBackReason(i.reason);
      return null;
    });
  reasonCheck('ok', { reason: 'x' });
  reasonCheck('blank', { reason: '\u2028\u3000' });
  reasonCheck('long', { reason: 'é'.repeat(2001) });
  pure('agentRounds/absent', 'agentRounds', { item: item() }, (i) => agentRounds(i.item));
  pure('agentRounds/two', 'agentRounds', { item: item({ agentSendBacks: 2 }) }, (i) =>
    agentRounds(i.item),
  );
  pure('stuckQuestion/short', 'stuckQuestion', { reasons: ['one', 'two'], next: 'three' }, (i) =>
    stuckQuestion(i.reasons, i.next),
  );
  pure('stuckQuestion/none', 'stuckQuestion', { reasons: [], next: 'first' }, (i) =>
    stuckQuestion(i.reasons, i.next),
  );
  pure(
    'stuckQuestion/truncated',
    'stuckQuestion',
    { reasons: ['a'.repeat(4000), 'b'.repeat(4000)], next: 'c' },
    (i) => stuckQuestion(i.reasons, i.next),
  );
  pure('constants/all', 'constants', {}, () => ({
    MAX_AGENT_SEND_BACKS,
    STUCK_QUESTION_PREFIX,
    HEARTBEAT_EVENT_AFTER_MS,
    AGENT_ONLINE_MS,
  }));

  // ---------- shapeItem ----------
  const shape = (name: string, actor: Actor, input: Parameters<typeof shapeItem>[1]) =>
    act(`shapeItem/${name}`, 'shapeItem', actor, input, shapeItem);
  shape('agent skips agent steps', AGENT, {
    ...P,
    item: unshaped(),
    skips: { shape: 'shaped now', review: ' small change ', release: '' },
    note: '  Copy change: no review  ',
    result: RESULT,
    agent: STREAK2,
  });
  shape('full path', AGENT, { ...P, item: unshaped(), skips: {}, note: 'Full process' });
  shape('people steps pending', AGENT, {
    ...P,
    item: unshaped({ pathRev: 4 }),
    skips: { accept: 'Tiny copy change, nothing to accept', approve: 'short', review: '' },
    note: 'n'.repeat(310),
  });
  shape('person shapes', HUMAN, {
    ...P,
    item: unshaped({ claim: null, status: 'queued' }),
    skips: { test: 'nothing to test', accept: '' },
    note: 'By hand',
  });
  shape('person while an agent shapes', HUMAN, {
    ...P,
    item: unshaped(),
    skips: {},
    note: '',
  });
  shape('already shaped', AGENT, { ...P, item: item({ shape: SHAPED }), skips: {}, note: '' });
  shape('item from before paths', AGENT, { ...P, item: item(), skips: {}, note: '' });
  shape('not holding', AGENT, {
    ...P,
    item: unshaped({ claim: claimOf('agentB') }),
    skips: {},
    note: '',
  });
  shape('no step left', AGENT, {
    ...W,
    project: { steps: [agentStep('a', 'A'), agentStep('b', 'B')] },
    item: unshaped({ stepId: 'a' }),
    skips: { a: '', b: '' },
    note: '',
  });
  shape('people step not ahead', AGENT, {
    ...W,
    project: { steps: [humanStep('g', 'Gate'), agentStep('a', 'A')] },
    item: unshaped({ stepId: 'g' }),
    skips: { g: 'not needed at all here' },
    note: '',
  });
  shape('refused before', AGENT, {
    ...P,
    item: unshaped({ pathRefused: ['accept'] }),
    skips: { accept: '' },
    note: '',
  });
  shape('already pending', AGENT, {
    ...P,
    item: unshaped({
      pathRequests: {
        accept: { op: 'drop', by: { type: 'agent', id: 'agentA' }, reason: 'r', at: T0 },
      },
    }),
    skips: { accept: '' },
    note: '',
  });
  shape('inherited step ids, none skipped', AGENT, {
    ...W,
    project: {
      steps: [
        agentStep('s', 'S'),
        agentStep('constructor', 'C'),
        agentStep('toString', 'T'),
        agentStep('__proto__', 'P'),
        humanStep('accept', 'Accept'),
      ],
    },
    item: unshaped({ stepId: 's' }),
    skips: { accept: '' },
    note: '',
  });
  shape('inherited step ids, really skipped', AGENT, {
    ...W,
    project: {
      steps: [
        agentStep('s', 'S'),
        agentStep('constructor', 'C'),
        agentStep('toString', 'T'),
        agentStep('__proto__', 'P'),
        humanStep('accept', 'Accept'),
      ],
    },
    item: unshaped({ stepId: 's' }),
    skips: Object.fromEntries(['constructor', 'toString', 'accept'].map((k) => [k, ''])),
    note: '',
  });
  shape('numeric step ids', AGENT, {
    ...W,
    project: {
      steps: [
        agentStep('s', 'S'),
        agentStep('x', 'X'),
        agentStep('10', 'Ten'),
        agentStep('2', 'Two'),
      ],
    },
    item: unshaped({ stepId: 's' }),
    skips: { x: '', '10': '', '2': '' },
    note: '',
  });
  shape('unknown skip ignored', AGENT, {
    ...P,
    item: unshaped(),
    skips: { gone: 'whatever' },
    note: '',
  });

  // ---------- skipStep ----------
  const skip = (name: string, actor: Actor, input: Parameters<typeof skipStep>[1]) =>
    act(`skipStep/${name}`, 'skipStep', actor, input, skipStep);
  const shapedItem = (over: Partial<ItemState> = {}) =>
    item({ shape: SHAPED, pathSkips: {}, pathRev: 2, ...over });
  skip('agent skips', AGENT, {
    ...P,
    item: shapedItem(),
    stepId: 'review',
    skip: true,
    reason: ' covered by tests ',
  });
  skip('item from before paths', AGENT, { ...P, item: item(), stepId: 'test', skip: true });
  skip('agent unskips', AGENT, {
    ...P,
    item: shapedItem({ pathSkips: { review: 'x' } }),
    stepId: 'review',
    skip: false,
    reason: 'needed after all',
  });
  skip('already skipped', AGENT, {
    ...P,
    item: shapedItem({ pathSkips: { review: 'x' } }),
    stepId: 'review',
    skip: true,
  });
  skip('already on the path', AGENT, { ...P, item: shapedItem(), stepId: 'review', skip: false });
  skip('agent on a people step', AGENT, { ...P, item: shapedItem(), stepId: 'accept', skip: true });
  skip('decider skips a people step', HUMAN, {
    ...P,
    item: shapedItem({ claim: null }),
    stepId: 'accept',
    skip: true,
    reason: 'r'.repeat(400),
  });
  skip('decider unskips a people step', HUMAN, {
    ...P,
    item: shapedItem({ claim: null, gateSkips: { accept: '' } }),
    stepId: 'accept',
    skip: false,
  });
  skip('person not a decider', MARIA, {
    ...P,
    item: shapedItem({ claim: null }),
    stepId: 'accept',
    skip: true,
  });
  skip('person skips an agent step', MARIA, {
    ...P,
    item: shapedItem({ claim: null }),
    stepId: 'release',
    skip: true,
  });
  skip('behind', AGENT, { ...P, item: shapedItem(), stepId: 'shape', skip: true });
  skip('current step', AGENT, { ...P, item: shapedItem(), stepId: 'build', skip: true });
  skip('closed item', AGENT, {
    ...P,
    item: shapedItem({ status: 'done' }),
    stepId: 'review',
    skip: true,
  });
  skip('unshaped', AGENT, { ...P, item: unshaped(), stepId: 'review', skip: true });
  skip('not holding', AGENT, {
    ...P,
    item: shapedItem({ claim: claimOf('agentB') }),
    stepId: 'review',
    skip: true,
  });
  skip('unknown step', AGENT, { ...P, item: shapedItem(), stepId: 'gone', skip: true });

  // ---------- planPathChange ----------
  const ppc = (
    name: string,
    input: {
      project: { steps: Step[] };
      item: ItemState;
      actor: { type: 'human' | 'agent'; id: string };
      wanted: string[];
    },
  ) =>
    pure(`planPathChange/${name}`, 'planPathChange', input, (i) =>
      planPathChange(i.project, i.item, i.actor, i.wanted),
    );
  const without = (...ids: string[]) => LIB.map((s) => s.id).filter((id) => !ids.includes(id));
  ppc('agent', {
    project: PROJECT,
    item: shapedItem(),
    actor: { type: 'agent', id: 'agentA' },
    wanted: without('review', 'accept'),
  });
  ppc('decider', {
    project: PROJECT,
    item: shapedItem(),
    actor: { type: 'human', id: 'joao' },
    wanted: without('review', 'accept'),
  });
  ppc('unskips', {
    project: PROJECT,
    item: shapedItem({ pathSkips: { review: '', shape: '' }, gateSkips: { accept: '' } }),
    actor: { type: 'human', id: 'joao' },
    wanted: without(),
  });
  ppc('agent asks to add', {
    project: PROJECT,
    item: shapedItem({ gateSkips: { accept: '' } }),
    actor: { type: 'agent', id: 'agentA' },
    wanted: without(),
  });
  ppc('unknown current step', {
    project: PROJECT,
    item: shapedItem({ stepId: 'gone' }),
    actor: { type: 'agent', id: 'agentA' },
    wanted: [],
  });

  // ---------- askPathChange ----------
  const ask = (name: string, actor: Actor, input: Parameters<typeof askPathChange>[1]) =>
    act(`askPathChange/${name}`, 'askPathChange', actor, input, askPathChange);
  const why = '  Tiny change, nobody needs to accept it  ';
  ask('agent asks to drop', AGENT, { ...P, item: shapedItem(), stepId: 'accept', reason: why });
  ask('agent asks to add', AGENT, {
    ...P,
    item: shapedItem({ gateSkips: { accept: '' } }),
    stepId: 'accept',
    reason: 'x'.repeat(1100),
  });
  ask('short reason', AGENT, { ...P, item: shapedItem(), stepId: 'accept', reason: ' too short ' });
  ask('agent step', AGENT, { ...P, item: shapedItem(), stepId: 'review', reason: why });
  ask('behind', AGENT, { ...P, item: shapedItem(), stepId: 'approve', reason: why });
  ask('pending', AGENT, {
    ...P,
    item: shapedItem({
      pathRequests: {
        accept: { op: 'drop', by: { type: 'human', id: 'maria' }, reason: 'r', at: T0 },
      },
    }),
    stepId: 'accept',
    reason: why,
  });
  ask('refused for agents', AGENT, {
    ...P,
    item: shapedItem({ pathRefused: ['accept'] }),
    stepId: 'accept',
    reason: why,
  });
  ask('refused does not stop people', MARIA, {
    ...P,
    item: shapedItem({ claim: null, pathRefused: ['accept'] }),
    stepId: 'accept',
    reason: why,
  });
  ask('closed item', AGENT, {
    ...P,
    item: shapedItem({ status: 'stopped' }),
    stepId: 'accept',
    reason: why,
  });
  ask('not holding', AGENT, {
    ...P,
    item: shapedItem({ claim: null }),
    stepId: 'accept',
    reason: why,
  });
  ask('unknown step', AGENT, { ...P, item: shapedItem(), stepId: 'gone', reason: why });

  // ---------- proposeStep ----------
  const prop = (name: string, actor: Actor, input: Parameters<typeof proposeStep>[1]) =>
    act(`proposeStep/${name}`, 'proposeStep', actor, input, proposeStep);
  prop('agent step', AGENT, {
    ...P,
    item: item(),
    proposal: {
      name: '  Security review  ',
      kind: 'agent',
      description: 'Check for secrets',
      instructions: 'Run the scanner',
      outputs: ['report', 'o'.repeat(210)],
      afterStepId: 'build',
      deciderUids: ['joao'],
      reason: '  Two leaks last month  ',
    },
  });
  prop('people step first', AGENT, {
    ...P,
    item: item(),
    proposalId: 'prop1',
    proposal: {
      name: 'N'.repeat(70),
      kind: 'human',
      description: 'd'.repeat(2005),
      afterStepId: '',
      deciderUids: ['joao', 'maria'],
      reason: 'Someone must sign off',
    },
  });
  prop('people step without deciders', AGENT, {
    ...P,
    item: item(),
    proposal: {
      name: 'Legal',
      kind: 'human',
      description: '',
      afterStepId: 'accept',
      reason: 'Contracts need legal',
    },
  });
  prop('blank name', AGENT, {
    ...P,
    item: item(),
    proposal: {
      name: ' ',
      kind: 'agent',
      description: '',
      afterStepId: '',
      reason: 'long enough reason',
    },
  });
  prop('short reason', AGENT, {
    ...P,
    item: item(),
    proposal: { name: 'X', kind: 'agent', description: '', afterStepId: '', reason: 'short' },
  });
  prop('unknown after', AGENT, {
    ...P,
    item: item(),
    proposal: {
      name: 'X',
      kind: 'agent',
      description: '',
      afterStepId: 'gone',
      reason: 'long enough reason',
    },
  });
  prop('not holding', AGENT, {
    ...P,
    item: item({ claim: null }),
    proposal: {
      name: 'X',
      kind: 'agent',
      description: '',
      afterStepId: '',
      reason: 'long enough reason',
    },
  });
  prop('person refused', HUMAN, {
    ...P,
    item: item(),
    proposal: {
      name: 'X',
      kind: 'agent',
      description: '',
      afterStepId: '',
      reason: 'long enough reason',
    },
  });

  // ---------- itempath ----------
  pure('isUnshaped/null', 'isUnshaped', { item: unshaped() }, (i) => isUnshaped(i.item));
  pure('isUnshaped/absent', 'isUnshaped', { item: item() }, (i) => isUnshaped(i.item));
  pure('isUnshaped/shaped', 'isUnshaped', { item: item({ shape: SHAPED }) }, (i) =>
    isUnshaped(i.item),
  );
  const pathItem = item({
    stepId: 'test',
    pathSkips: { review: 'not needed', accept: 'ignored here' },
    gateSkips: { approve: 'pre-approved' },
    pathRequests: {
      approve: { op: 'add', by: { type: 'human', id: 'maria' }, reason: 'please', at: T0 },
      accept: { op: 'drop', by: { type: 'agent', id: 'agentA' }, reason: 'tiny', at: T0 },
    },
  });
  pure('pathOf/skips', 'pathOf', { project: PROJECT, item: pathItem }, (i) =>
    pathOf(i.project, i.item),
  );
  pure('pathOf/full', 'pathOf', { project: PROJECT, item: item() }, (i) =>
    pathOf(i.project, i.item),
  );
  const sop = (name: string, input: { project: { steps: Step[] }; item: ItemState }) =>
    pure(`stepsOnPath/${name}`, 'stepsOnPath', input, (i) =>
      stepsOnPath(i.project, i.item).map((p) => ({ ...p, step: p.step.id })),
    );
  sop('mixed', { project: PROJECT, item: pathItem });
  sop('finished', { project: PROJECT, item: item({ stepId: 'release', status: 'done' }) });
  sop('unknown step', {
    project: PROJECT,
    item: item({ stepId: 'gone', gateSkips: { accept: '' } }),
  });
  const nop = (
    name: string,
    input: { project: { steps: Step[] }; item: ItemState; stepId?: string },
  ) =>
    pure(
      `nextOnPath/${name}`,
      'nextOnPath',
      input,
      (i) =>
        (i.stepId === undefined
          ? nextOnPath(i.project, i.item)
          : nextOnPath(i.project, i.item, i.stepId)
        )?.id ?? null,
    );
  nop('next', { project: PROJECT, item: item() });
  nop('over skips', {
    project: PROJECT,
    item: item({ stepId: 'build', pathSkips: { review: '', test: '' } }),
  });
  nop('last', { project: PROJECT, item: item({ stepId: 'release' }) });
  nop('from a given step', { project: PROJECT, item: item(), stepId: 'test' });
  nop('from an unknown step', { project: PROJECT, item: item({ stepId: 'gone' }) });
  const fop = (name: string, input: { project: { steps: Step[] }; item: ItemState }) =>
    pure(
      `firstOnPath/${name}`,
      'firstOnPath',
      input,
      (i) => firstOnPath(i.project, i.item)?.id ?? null,
    );
  fop('first', { project: PROJECT, item: item() });
  fop('first skipped', { project: PROJECT, item: item({ pathSkips: { shape: '' } }) });
  fop('none', { project: { steps: [agentStep('a', 'A')] }, item: item({ pathSkips: { a: '' } }) });
  // Step ids that are also names on Object.prototype must not count as skipped or pending.
  const INHERITED = ['constructor', 'toString', '__proto__'];
  const inhProject = {
    steps: [
      agentStep('first', 'First'),
      ...INHERITED.map((id) => agentStep(id, `A ${id}`)),
      ...INHERITED.map((id) => humanStep(`${id}-gate`, `G ${id}`)),
    ],
  };
  const own = (id: string, v: unknown) =>
    Object.defineProperty({}, id, { value: v, enumerable: true });
  for (const id of INHERITED) {
    const gateId = `${id}-gate`;
    pure(`pathOf/inherited ${id}`, 'pathOf', { project: inhProject, item: item() }, (i) =>
      pathOf(i.project, i.item),
    );
    pure(
      `stepsOnPath/inherited ${id}`,
      'stepsOnPath',
      { project: inhProject, item: item({ pathSkips: {}, gateSkips: {}, pathRequests: {} }) },
      (i) => stepsOnPath(i.project, i.item).map((p) => ({ ...p, step: p.step.id })),
    );
    pure(
      `stepsOnPath/real skip of ${id}`,
      'stepsOnPath',
      {
        project: inhProject,
        item: item({ pathSkips: own(id, 'no') as never, gateSkips: own(gateId, '') as never }),
      },
      (i) => stepsOnPath(i.project, i.item).map((p) => ({ ...p, step: p.step.id })),
    );
    pure(
      `nextOnPath/inherited ${id}`,
      'nextOnPath',
      { project: inhProject, item: item({ stepId: 'first' }) },
      (i) => nextOnPath(i.project, i.item)?.id ?? null,
    );
  }
  pure(
    'firstOnPath/inherited ids',
    'firstOnPath',
    { project: { steps: inhProject.steps.slice(1) }, item: item({ pathSkips: {} }) },
    (i) => firstOnPath(i.project, i.item)?.id ?? null,
  );
  pure(
    'isOnHold/back',
    'isOnHold',
    {
      item: item({
        status: 'queued',
        workStopped: { mode: 'back', byUid: 'joao', at: T0, reason: '', runId: 'run1' },
      }),
    },
    (i) => isOnHold(i.item),
  );
  pure(
    'isOnHold/cancelled',
    'isOnHold',
    {
      item: item({
        status: 'stopped',
        workStopped: { mode: 'cancel', byUid: 'joao', at: T0, reason: 'no', runId: 'run1' },
      }),
    },
    (i) => isOnHold(i.item),
  );
  pure(
    'isOnHold/back but stopped',
    'isOnHold',
    {
      item: item({
        status: 'stopped',
        workStopped: { mode: 'back', byUid: 'joao', at: T0, reason: '', runId: 'run1' },
      }),
    },
    (i) => isOnHold(i.item),
  );
  pure('isOnHold/none', 'isOnHold', { item: item({ workStopped: null }) }, (i) => isOnHold(i.item));

  // ---------- agents ----------
  pure('guardrailsOf/default', 'guardrailsOf', { agent: {} }, (i) => guardrailsOf(i.agent));
  pure('guardrailsOf/set', 'guardrailsOf', { agent: { guardrails: { maxFailedRuns: 5 } } }, (i) =>
    guardrailsOf(i.agent),
  );
  pure('isPaused/paused', 'isPaused', { agent: { pausedAt: T0 } }, (i) => isPaused(i.agent));
  pure('isPaused/null', 'isPaused', { agent: { pausedAt: null } }, (i) => isPaused(i.agent));
  pure('isPaused/absent', 'isPaused', { agent: {} }, (i) => isPaused(i.agent));
  const SA = { steps: LIB, stepAgents: { build: ['agentB'], test: [] } };
  /** A project without stepAgents (the schema defaults it; the helpers must cope). */
  const NO_LIMITS = PROJECT as unknown as typeof SA;
  const may = (name: string, input: { project: typeof SA; stepId: string; agentUid: string }) =>
    pure(`agentMayTakeStep/${name}`, 'agentMayTakeStep', input, (i) =>
      agentMayTakeStep(i.project, i.stepId, i.agentUid),
    );
  may('limited to another', { project: SA, stepId: 'build', agentUid: 'agentA' });
  may('limited to me', { project: SA, stepId: 'build', agentUid: 'agentB' });
  may('empty list', { project: SA, stepId: 'test', agentUid: 'agentA' });
  may('not listed', { project: SA, stepId: 'review', agentUid: 'agentA' });
  may('no limits', { project: NO_LIMITS, stepId: 'build', agentUid: 'agentA' });
  const allowed = (name: string, input: { project: typeof SA; stepId: string }) =>
    pure(`allowedAgentsFor/${name}`, 'allowedAgentsFor', input, (i) =>
      allowedAgentsFor(i.project, i.stepId),
    );
  allowed('listed', { project: SA, stepId: 'build' });
  allowed('not listed', { project: SA, stepId: 'review' });
  allowed('no limits', { project: NO_LIMITS, stepId: 'build' });
  const nt = (name: string, input: Parameters<typeof newTokens>[0]) =>
    pure(`newTokens/${name}`, 'newTokens', input, newTokens);
  nt('with cache', { tokensIn: 1000, tokensOut: 50, tokensCached: 800 });
  nt('cache over input', { tokensIn: 10, tokensOut: 5, tokensCached: 20 });
  nt('no cache', { tokensIn: 7, tokensOut: 3 });
  const sa = (
    name: string,
    input: { agent: AgentGuardState; status: 'done' | 'failed' | 'released' },
  ) => pure(`streakAfter/${name}`, 'streakAfter', input, (i) => streakAfter(i.agent, i.status));
  sa('released', { agent: STREAK2, status: 'released' });
  sa('done from 0', { agent: STREAK0, status: 'done' });
  sa('done from 2', { agent: STREAK2, status: 'done' });
  sa('done while paused', { agent: PAUSED, status: 'done' });
  sa('failed reaches the limit', { agent: STREAK2, status: 'failed' });
  sa('failed while paused', { agent: PAUSED, status: 'failed' });
  sa('failed with defaults', { agent: { failStreak: 1, pausedAt: null }, status: 'failed' });
  sa('failed with no streak', { agent: { pausedAt: null }, status: 'failed' });
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
  propose('missing field', AGENT, {
    type: 'reply_book',
    fields: { text: 'x', start: '2026-11-05T10:00:00Z', with: 'y' },
  });
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
      type: 'book',
      fields: { start: '2026-11-05T10:00:00+01:00', end: '2026-11-05T11:00:00+01:00', with: 'Sam' },
      checks: [' Thu 10:00-11:00 free '],
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
      {
        type: 'reply_book',
        fields: {
          text: 'Booked.',
          start: '2026-11-05T10:00:00Z',
          end: '2026-11-05T10:30:00Z',
          with: 'Sam',
        },
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
  calendarCases(act, pure, { agent: AGENT, human: HUMAN });
  summaryCases(act, pure, { agent: AGENT, other: OTHER, human: HUMAN });

  return cases;
}
