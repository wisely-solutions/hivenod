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
  unparkItem,
  requireSendBackReason,
  shapeItem,
  skipStep,
  stepsOnPath,
  streakAfter,
  STUCK_QUESTION_PREFIX,
  stuckQuestion,
  type ActionContext,
  type Actor,
  type AgentGuardState,
  type ItemState,
  type Step,
} from '../../packages/shared/src/index';

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

  return cases;
}
