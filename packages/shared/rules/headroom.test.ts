/**
 * Card CZwdWD3H: the rules' expression budget. Firestore evaluates at most 1000 expressions per
 * rule evaluation and denies the write when that is reached, so a rule that grows past it breaks
 * real actions; this suite notices before that happens.
 *
 * How headroom is measured (with the emulator; there is no counter to read):
 *  - An instrumented copy of firestore.rules puts `hrPad() &&` in front of every item update
 *    statement. hrPad() evaluates k trivial comparisons (`1 == 1`, in functions of 10) and is
 *    always true, so it can only make a write fail by using up the budget.
 *  - For each of the heaviest real writes, a binary search finds the largest k with which the
 *    write still succeeds. That k is the headroom, in pad units. A failure must be the budget
 *    ("maximum of 1000 expressions"); any other denial fails the test (a broken scenario).
 *  - Calibration: the same search on a rule that is nothing but hrPad() gives the k that fills
 *    an empty budget (~196), so one unit is about 5 expressions.
 * All allow statements of a document share one budget, in order (checked below), so splitting
 * the item update into statements would not help: instead each write is routed by a cheap test
 * to the few paths that can match it (see humanUpdate in firestore.rules).
 */
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { decidePathChange, shapeItem, fullProcessPlan } from '../src/pathActions';
import {
  approve,
  attach,
  claimItem,
  completeStep,
  releaseStale,
  resumeWork,
  sendBack,
  stop,
  stopWork,
  updateItem,
  type ActionPlan,
  type ItemState,
  type ProjectState,
} from '../src/actions';
import { agentSendBack } from '../src/sendback';
import { buildStepIndex, paths, type Gate, type Step } from '../src/schema';
import {
  AGENTS,
  as,
  atGate,
  gate,
  I,
  itemDoc,
  minutesAgo,
  now,
  P,
  projectDoc,
  put,
  reset,
  RULES,
  setRules,
  snap,
  useEmulator,
  W,
  type As,
} from './harness';

useEmulator();

/** Fail when a heavy path has fewer pad units than this to spare (~100 expressions, 10%). */
const MIN_UNITS = 20;
const BUDGET = /maximum of 1000 expressions/;

/** hrPad() evaluates k cheap comparisons, in functions of 10 (one long chain does not compile). */
function pad(k: number, name = 'hrPad') {
  const chunks: string[] = [];
  for (let i = 0; i < k; i += 10) {
    chunks.push(Array.from({ length: Math.min(10, k - i) }, () => '1 == 1').join(' && '));
  }
  const fns = chunks.map((c, i) => `    function ${name}${i}() { return ${c}; }`).join('\n');
  const call = chunks.length ? chunks.map((_, i) => `${name}${i}()`).join(' && ') : 'true';
  return `${fns}\n    function ${name}() { return ${call}; }`;
}

const TOP = 'match /databases/{database}/documents {';
const ITEM_RULES = /match \/items\/\{iid\} \{[\s\S]*?\n {10}allow delete/;

/**
 * RULES with hrPad() (k units) in front of every item update statement, plus a probe rule.
 * `extraItemStatement` adds one more item update statement first (xPad() is 20 units).
 */
function instrument(k: number, extraItemStatement = '') {
  const withPad = RULES.replace(
    TOP,
    `${TOP}\n${pad(k)}\n${pad(20, 'xPad')}\n    match /hrprobe/{x} { allow get: if hrPad(); }`,
  );
  const m = withPad.match(ITEM_RULES);
  if (!m) throw new Error('item rules not found');
  const items = m[0]
    .replaceAll('allow update: if ', 'allow update: if hrPad() && ')
    .replace('allow update: if ', `${extraItemStatement}allow update: if `);
  return withPad.replace(m[0], items);
}

/** Largest pad (units) with which the write prepared by `prepare` still succeeds. */
async function headroom(
  prepare: () => Promise<() => Promise<unknown>>,
  hi = 250,
  extraItemStatement = '',
) {
  const tryWith = async (k: number) => {
    await reset();
    await setRules(RULES);
    const write = await prepare();
    await setRules(instrument(k, extraItemStatement));
    try {
      await write();
      return true;
    } catch (e) {
      const msg = String((e as Error).message);
      if (!BUDGET.test(msg))
        throw new Error(`Denied for another reason (k=${k}): ${msg}`, { cause: e });
      return false;
    }
  };
  try {
    if (!(await tryWith(0))) return 0;
    let lo = 0;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (await tryWith(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  } finally {
    await setRules(RULES);
  }
}

// ---------- a 30-step process (the maximum) with gates at steps 10 and 28 ----------

const DECIDERS = ['alice', 'bob', 'carol'];
function longSteps(g: Partial<Gate> = {}): Step[] {
  return Array.from({ length: 30 }, (_, i): Step => {
    const id = i === 0 ? 'intake' : i === 28 ? 'review' : `s${i}`;
    return i === 10 || i === 28
      ? {
          id,
          name: `Step ${i}`,
          kind: 'human',
          description: 'Decide',
          gate: gate({ deciderUids: DECIDERS, ...(i === 28 ? g : {}) }),
        }
      : { id, name: `Step ${i}`, kind: 'agent', description: 'Work' };
  });
}
const longProject = (g: Partial<Gate> = {}, extra: Record<string, unknown> = {}) => {
  const s = longSteps(g);
  return projectDoc({}, { steps: s, stepIndex: buildStepIndex(s), ...extra });
};
const project = (g: Partial<Gate> = {}) => ({ steps: longSteps(g) }) as ProjectState;

/** Item `gated` waiting at the review gate (step 28) with these votes. */
async function atReview(g: Partial<Gate>, approvals: string[] = [], rejections: string[] = []) {
  await put({ [P('p1')]: longProject(g), [I('gated')]: atGate(approvals, rejections) });
  const item = (await snap(I('gated'))) as unknown as ItemState;
  return { project: project(g), item, projectId: 'p1', itemId: 'gated' };
}

/** Item i1 at agent step s27, claimed by agent A with the open run r1. */
async function claimed(heartbeat = now(), extra: Record<string, unknown> = {}) {
  await put({
    [P('p1')]: longProject({}, extra),
    [I('i1')]: itemDoc({
      stepId: 's27',
      status: 'working',
      claim: { runId: 'r1', agentUid: AGENTS.a, heartbeatAt: heartbeat },
    }),
    [paths.run(W, 'r1')]: {
      agentUid: AGENTS.a,
      projectId: 'p1',
      itemId: 'i1',
      stepId: 's27',
      startedAt: heartbeat,
      heartbeatAt: heartbeat,
      heartbeatEventAt: heartbeat,
      endedAt: null,
      status: 'running',
      costEur: 0,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'seed',
    },
  });
  return (await snap(I('i1'))) as unknown as ItemState;
}

const runAs = (a: As, plan: Pick<ActionPlan, 'ops'>) => () => a.run(plan);
const reason = 'Not doing this any more';
const stopAs = async (mode: 'back' | 'cancel') => {
  const item = await claimed();
  const b = as('bob');
  return runAs(
    b,
    stopWork(b.ctx, {
      project: project(),
      projectId: 'p1',
      itemId: 'i1',
      item,
      mode,
      reason,
      gateStepId: 'review',
      run: { costEur: 0, endedAt: null },
    }),
  );
};

const SCENARIOS: [string, () => Promise<() => Promise<unknown>>][] = [
  [
    'approve and pass the gate (all + mustInclude, 30 steps)',
    async () => {
      const g = await atReview({ rule: 'all', mustInclude: ['alice'] }, ['alice', 'bob']);
      const c = as('carol');
      return runAs(c, approve(c.ctx, g));
    },
  ],
  [
    'approve, gate not passed yet (atLeast 3)',
    async () => {
      const g = await atReview({ rule: 'atLeast', n: 3 });
      const a = as('alice');
      return runAs(a, approve(a.ctx, g));
    },
  ],
  [
    'majority: record a rejection',
    async () => {
      const g = await atReview({ rejectPolicy: 'majority' });
      const a = as('alice');
      return runAs(a, sendBack(a.ctx, { ...g, toStepId: 'intake', rationale: reason }));
    },
  ],
  [
    'majority: send back to the first step',
    async () => {
      const g = await atReview({ rejectPolicy: 'majority' }, [], ['alice']);
      const b = as('bob');
      return runAs(b, sendBack(b.ctx, { ...g, toStepId: 'intake', rationale: reason }));
    },
  ],
  [
    'majority: stop',
    async () => {
      const g = await atReview({ rejectPolicy: 'majority' }, [], ['alice']);
      const b = as('bob');
      return runAs(b, stop(b.ctx, { ...g, rationale: reason }));
    },
  ],
  ['stop work (a decider, go back)', () => stopAs('back')],
  ['stop work (a decider, cancel)', () => stopAs('cancel')],
  [
    'resume (a decider)',
    async () => {
      await put({
        [P('p1')]: longProject(),
        [I('i1')]: itemDoc({
          stepId: 's27',
          workStopped: { mode: 'back', byUid: 'bob', at: now(), reason, runId: 'r1' },
        }),
      });
      const item = (await snap(I('i1'))) as unknown as ItemState;
      const b = as('bob');
      return runAs(
        b,
        resumeWork(b.ctx, { projectId: 'p1', itemId: 'i1', item, gateStepId: 'review' }),
      );
    },
  ],
  [
    'claim (agent, step limited to some agents, stale claim taken over)',
    async () => {
      const item = await claimed(minutesAgo(11), { stepAgents: { s27: [AGENTS.a, AGENTS.star] } });
      const a = as(AGENTS.star);
      return runAs(
        a,
        claimItem(a.ctx, { projectId: 'p1', itemId: 'i1', item, takeover: { runId: 'r1' } }),
      );
    },
  ],
  [
    'complete into a gate (agent, 30 steps)',
    async () => {
      const item = await claimed();
      const a = as(AGENTS.a);
      return runAs(
        a,
        completeStep(a.ctx, { project: project(), projectId: 'p1', itemId: 'i1', item }),
      );
    },
  ],
  [
    'agent send-back over 12 agent steps, the most (s27 to s14, 30 steps)',
    async () => {
      const item = await claimed();
      const a = as(AGENTS.a);
      return runAs(
        a,
        agentSendBack(a.ctx, {
          project: project(),
          projectId: 'p1',
          itemId: 'i1',
          item,
          toStepId: 's14',
          reason: 'The tests fail',
        }),
      );
    },
  ],
  [
    'attach a file to an item at a gate (human)',
    async () => {
      await atReview({});
      const a = as('alice');
      return runAs(
        a,
        attach(a.ctx, { projectId: 'p1', itemId: 'gated', kind: 'text', name: 'n', content: 'x' }),
      );
    },
  ],
  [
    'edit an item at a gate (human)',
    async () => {
      await atReview({});
      const a = as('alice');
      return runAs(
        a,
        updateItem(a.ctx, { projectId: 'p1', itemId: 'gated', changes: { title: 'New' } }),
      );
    },
  ],
  [
    'release a stale claim (admin)',
    async () => {
      await claimed(minutesAgo(11));
      const o = as('owner');
      return runAs(
        o,
        releaseStale(o.ctx, { projectId: 'p1', itemId: 'i1', runId: 'r1', agentUid: AGENTS.a }),
      );
    },
  ],
  // ----- per-item paths (card st5INNZj), 30-step library -----
  [
    'shape: use the full process (human, 30 steps)',
    async () => {
      await put({
        [P('p1')]: longProject(),
        [I('i1')]: itemDoc({ stepId: 'intake', status: 'queued', shape: null }),
      });
      const item = (await snap(I('i1'))) as unknown as ItemState;
      const d = as('dave');
      return runAs(
        d,
        fullProcessPlan(d.ctx, { project: project(), projectId: 'p1', itemId: 'i1', item }),
      );
    },
  ],
  [
    'shape a short path (agent, 30 steps)',
    async () => {
      await claimed(now());
      await put({
        [I('i1')]: itemDoc({
          stepId: 'intake',
          status: 'working',
          shape: null,
          claim: { runId: 'r1', agentUid: AGENTS.a, heartbeatAt: now() },
        }),
      });
      const item = (await snap(I('i1'))) as unknown as ItemState;
      const a = as(AGENTS.a);
      return runAs(
        a,
        shapeItem(a.ctx, {
          project: project(),
          projectId: 'p1',
          itemId: 'i1',
          item,
          // Skip the agent steps 1-9 (to the gate at 10) and 11-26: the longest jumps there are.
          skips: Object.fromEntries(
            Array.from({ length: 27 }, (_, i) => i)
              .filter((i) => i > 0 && i !== 10)
              .map((i) => [`s${i}`, 'not needed']),
          ),
          note: 'short',
        }),
      );
    },
  ],
  [
    'complete along a path into a gate (agent, 30 steps)',
    async () => {
      await claimed(now());
      // From s25 over the skipped s26 and s27 into the review gate.
      await put({
        [I('i1')]: itemDoc({
          status: 'working',
          claim: { runId: 'r1', agentUid: AGENTS.a, heartbeatAt: now() },
          shape: { by: { type: 'agent', id: AGENTS.a }, at: now(), note: '' },
          stepId: 's25',
          pathSkips: { s26: '', s27: '' },
          pathRev: 1,
        }),
      });
      const item = (await snap(I('i1'))) as unknown as ItemState;
      const a = as(AGENTS.a);
      return runAs(
        a,
        completeStep(a.ctx, { project: project(), projectId: 'p1', itemId: 'i1', item }),
      );
    },
  ],
  [
    'approve along a path (all + mustInclude, 30 steps)',
    async () => {
      const g = await atReview({ rule: 'all', mustInclude: ['alice'] }, ['alice', 'bob']);
      await put({
        [I('gated')]: { ...(await snap(I('gated'))), pathSkips: { s29: '' }, pathRev: 1 },
      });
      const item = (await snap(I('gated'))) as unknown as ItemState;
      const c = as('carol');
      return runAs(c, approve(c.ctx, { ...g, item }));
    },
  ],
  [
    'approve the skip of the gate the item waits at (30 steps)',
    async () => {
      const g = await atReview({});
      await put({
        [I('gated')]: {
          ...(await snap(I('gated'))),
          pathSkips: {},
          pathRev: 1,
          pathRequests: {
            review: { op: 'drop', by: { type: 'agent', id: AGENTS.a }, reason, at: now() },
          },
        },
      });
      const item = (await snap(I('gated'))) as unknown as ItemState;
      const c = as('carol');
      return runAs(c, decidePathChange(c.ctx, { ...g, item, stepId: 'review', approve: true }));
    },
  ],
];

describe('expression budget: headroom on the heaviest item writes', () => {
  it('calibration: an empty rule fits ~200 pad units', async () => {
    const units = await headroom(async () => {
      const a = as('alice');
      return () => getDoc(doc(a.db, 'hrprobe/x'));
    }, 400);
    console.log(
      `calibration: ${units} units fill an empty budget (1 unit ≈ ${(1000 / units).toFixed(1)} expressions)`,
    );
    expect(units).toBeGreaterThan(150);
    expect(units).toBeLessThan(300);
  }, 120_000);

  it('allow statements share the budget: an earlier false statement uses it up', async () => {
    const edit = async () => {
      await atReview({});
      const a = as('alice');
      return runAs(
        a,
        updateItem(a.ctx, { projectId: 'p1', itemId: 'gated', changes: { title: 'New' } }),
      );
    };
    const alone = await headroom(edit);
    // A statement before the real one that spends 20 units and then is false costs 20 units.
    const after = await headroom(edit, 250, 'allow update: if xPad() && false;\n          ');
    // One unit is ~5 expressions: the search is exact only to a unit, so allow one either way.
    expect(Math.abs(after - (alone - 20))).toBeLessThanOrEqual(1);
  }, 120_000);

  it('a padded write fails on the budget, not on anything else (the probe works)', async () => {
    await setRules(instrument(400));
    const a = as('alice');
    try {
      await expect(updateDoc(doc(a.db, I('i1')), { title: 'x' })).rejects.toThrow(BUDGET);
    } finally {
      await setRules(RULES);
    }
  });

  it.each(SCENARIOS)(
    `%s: at least ${MIN_UNITS} units to spare`,
    async (name, prepare) => {
      const units = await headroom(prepare);
      console.log(`headroom ${String(units).padStart(3)} units  ${name}`);
      expect(units).toBeGreaterThanOrEqual(MIN_UNITS);
    },
    120_000,
  );
});
