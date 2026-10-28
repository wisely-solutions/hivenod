import {
  approve,
  attach,
  claimItem,
  completeStep,
  EVENT_TYPES,
  SERVER_TIME,
  sendBack,
  type ActionContext,
  type ActionPlan,
  type Decision,
  type HiveEvent,
  type Run,
} from '@hive/shared';
import { describe, expect, it } from 'vitest';
import type { Row } from '../lib/live';
import {
  agentStats,
  isIndexBuilding,
  clock,
  eventDetail,
  foldProgress,
  eventSentence,
  feedConstraints,
  formatDuration,
  formatElapsed,
  groupByDay,
  NO_FILTERS,
  runState,
  runWorkMs,
  TYPE_GROUPS,
  verdictFor,
  windowStart,
} from './logic';

const ts = (ms: number) => ({ seconds: ms / 1000, nanoseconds: 0, toMillis: () => ms });
const MIN = 60_000;
const NOW = new Date('2026-10-24T12:00:00').getTime();

function event(type: HiveEvent['type'], data: Record<string, unknown> = {}, name = 'Scout') {
  return { actor: { type: 'agent', id: 'a1', name }, type, data } as Pick<
    HiveEvent,
    'actor' | 'type' | 'data'
  >;
}

describe('event labels', () => {
  it('gives every event type a human sentence (no raw type, no fallback)', () => {
    for (const t of EVENT_TYPES) {
      const s = eventSentence(event(t), 'Market analysis');
      expect(s, t).toMatch(/^Scout \S/);
      expect(s, t).not.toContain('did something');
      expect(s, t).not.toMatch(/[a-z]+\.[a-zA-Z]+/);
      expect(s, t).not.toContain('undefined');
      expect(eventSentence(event(t), null), t).not.toContain('undefined');
    }
  });
  it('says where an agent sent an item back, and why (card KLCTVnX8)', () => {
    expect(
      eventSentence(
        event('item.sentBack', { toStepName: 'Build', reason: 'The login test fails' }),
        'Login',
      ),
    ).toBe('Scout sent “Login” back to Build: “The login test fails”');
  });
  it('says an item was deleted for good, and keeps "took back" for the capture Undo (card rHjaDFEK)', () => {
    expect(eventSentence(event('item.deleted', { title: 'Bees', forever: true }), 'Bees')).toBe(
      'Scout deleted “Bees”',
    );
    expect(eventSentence(event('item.deleted', { title: 'Bees' }), 'Bees')).toBe(
      'Scout took back “Bees”',
    );
  });
  it('says an agent created an item, and a person added one (item DhsO9)', () => {
    expect(eventSentence(event('item.created', { title: 'Checkout timeout' }), null)).toBe(
      'Scout created “Checkout timeout”',
    );
    const person = {
      actor: { type: 'human', id: 'u1', name: 'Ana' },
      type: 'item.created',
      data: { title: 'Bees' },
    } as Pick<HiveEvent, 'actor' | 'type' | 'data'>;
    expect(eventSentence(person, null)).toBe('Ana added “Bees”');
  });
  it('says when a decision came from Telegram, and nothing extra from the app', () => {
    const ana = (data: Record<string, unknown>) =>
      eventSentence(
        { actor: { type: 'human', id: 'u1', name: 'Ana' }, type: 'decision.approved', data },
        'Plan',
      );
    expect(ana({ via: 'telegram' })).toMatch(/ via Telegram$/);
    expect(ana({})).not.toContain('Telegram');
  });
  it('says what was edited on an item (card mpWuccjl)', () => {
    const upd = (data: Record<string, unknown>) =>
      eventSentence(
        { actor: { type: 'human', id: 'u1', name: 'Ana' }, type: 'item.updated', data },
        'New',
      );
    expect(upd({ fields: ['title'], title: { from: 'Old', to: 'New' } })).toBe(
      'Ana renamed “Old” to “New”',
    );
    expect(upd({ fields: ['type'], type: { from: 'idea', to: 'bug' } })).toBe(
      'Ana changed the type of “New” to bug',
    );
    expect(upd({ fields: ['summary'], summaryLength: 12 })).toBe(
      'Ana changed the description of “New”',
    );
    expect(upd({ fields: ['order'] })).toBe('Ana updated “New”');
  });
  it('says who stopped work, how, and why (card BrK0r2FE)', () => {
    const human = (type: HiveEvent['type'], data: Record<string, unknown>) =>
      ({ actor: { type: 'human', id: 'u1', name: 'Ana' }, type, data }) as Pick<
        HiveEvent,
        'actor' | 'type' | 'data'
      >;
    expect(
      eventSentence(human('item.workStopped', { mode: 'back', reason: 'Wrong brief' }), 'Post'),
    ).toBe('Ana stopped the work on “Post” and put it on hold: “Wrong brief”');
    expect(eventSentence(human('item.workStopped', { mode: 'cancel', reason: '' }), 'Post')).toBe(
      'Ana stopped the work on “Post” and cancelled it',
    );
    expect(eventSentence(human('item.resumed', {}), 'Post')).toBe(
      'Ana resumed “Post”: agents may take it again',
    );
  });
  it('puts every event type in exactly one filter group', () => {
    const all = TYPE_GROUPS.flatMap((g) => [...g.types]);
    expect(all.sort()).toEqual([...EVENT_TYPES].sort());
  });
  it('says what happened to a suggestion in plain words', () => {
    const human = (data: Record<string, unknown>) => ({
      ...event('finding.triaged', { title: 'Alt text', ...data }),
      actor: { type: 'human' as const, id: 'jo', name: 'João' },
    });
    expect(eventSentence(event('finding.raised', { title: 'Alt text' }))).toBe(
      'Scout suggested “Alt text”',
    );
    expect(eventSentence(human({ outcome: 'intake', stepName: 'Ideas' }))).toBe(
      'João added the suggestion “Alt text” to Ideas',
    );
    expect(eventSentence(human({ outcome: 'dismissed', reason: 'Not this quarter' }))).toBe(
      'João dismissed the suggestion “Alt text”: “Not this quarter”',
    );
  });
  it('names the file and the item', () => {
    expect(
      eventSentence(
        {
          ...event('attachment.added', { name: 'report.html' }),
          actor: { type: 'agent', id: 'a', name: 'Research agent' },
        },
        'Market analysis',
      ),
    ).toBe('Research agent attached report.html to “Market analysis”');
  });
  it('says when a claim was released because it stalled', () => {
    expect(eventSentence(event('item.released', { stalled: true }), 'X')).toContain('stalled');
    expect(eventSentence(event('item.released'), 'X')).toContain('let go');
    expect(
      eventSentence(event('item.released', { runStatus: 'failed', agentPaused: true }), 'X'),
    ).toContain('stopped and let go of “X”, and paused itself');
    expect(eventSentence(event('run.ended', { status: 'failed', agentPaused: true }), 'X')).toMatch(
      /failed a run on “X”, and paused itself$/,
    );
    expect(eventSentence(event('agent.updated', { resumed: true, name: 'Scout' }), null)).toMatch(
      /resumed Scout$/,
    );
    expect(eventSentence(event('agent.updated', { name: 'Scout' }), null)).toMatch(
      /changed the settings of Scout$/,
    );
  });
  it('path changes name the step and keep the reason', () => {
    const human = (type: HiveEvent['type'], data: Record<string, unknown>) =>
      ({ actor: { type: 'human', id: 'u1', name: 'Ana' }, type, data }) as Pick<
        HiveEvent,
        'actor' | 'type' | 'data'
      >;
    expect(
      eventSentence(
        human('item.pathChanged', { change: 'skip', stepName: 'Research', reason: 'Not needed' }),
        'Post',
      ),
    ).toBe('Ana skipped Research on “Post”: “Not needed”');
    expect(
      eventSentence(
        human('item.pathChanged', { change: 'ask', op: 'add', stepName: 'Spec' }),
        'Post',
      ),
    ).toBe('Ana asked to add Spec to “Post”');
  });
});

describe('filters', () => {
  it('builds no clauses for no filters', () => {
    expect(feedConstraints(NO_FILTERS)).toEqual([]);
  });
  it('maps project, actor kind and type group', () => {
    expect(feedConstraints({ projectId: 'p', actor: 'agents', group: 'runs' })).toEqual([
      ['projectId', '==', 'p'],
      ['actor.type', '==', 'agent'],
      [
        'type',
        'in',
        [
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
      ],
    ]);
    expect(feedConstraints({ projectId: '', actor: 'people', group: '' })).toEqual([
      ['actor.type', '==', 'human'],
    ]);
    expect(feedConstraints({ projectId: '', actor: 'u1', group: '' })).toEqual([
      ['actor.id', '==', 'u1'],
    ]);
  });
});

describe('days and times', () => {
  const row = (ms: number) => ({ id: String(ms), data: { at: ts(ms) } });
  it('groups newest-first rows under Today, Yesterday and dates', () => {
    const groups = groupByDay(
      [row(NOW - MIN), row(NOW - 2 * MIN), row(NOW - 24 * 60 * MIN), row(NOW - 5 * 24 * 60 * MIN)],
      NOW,
    );
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(['Today', 'Yesterday']);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups).toHaveLength(3);
  });
  it('formats clocks and durations', () => {
    expect(clock(new Date('2026-10-24T09:05:00').getTime())).toBe('09:05');
    expect(formatDuration(40_000)).toBe('40 s');
    expect(formatDuration(5 * MIN)).toBe('5 min');
    expect(formatDuration(65 * MIN)).toBe('1 h 5 min');
    expect(formatElapsed(125_000)).toBe('2:05');
    expect(formatElapsed(3725_000)).toBe('1:02:05');
  });
  it('starts today at local midnight', () => {
    expect(windowStart('today', NOW)).toBe(new Date('2026-10-24T00:00:00').getTime());
    expect(windowStart('7d', NOW)).toBe(NOW - 7 * 86_400_000);
  });
});

function run(over: Partial<Run> & { start: number; end?: number | null }): Row<Run> {
  const { start, end = null, ...rest } = over;
  return {
    id: `r${start}`,
    data: {
      agentUid: 'a1',
      projectId: 'p1',
      itemId: 'i1',
      stepId: 'draft',
      startedAt: ts(start),
      heartbeatAt: ts(end ?? start),
      heartbeatEventAt: ts(start),
      endedAt: end === null ? null : ts(end),
      status: end === null ? 'running' : 'done',
      costEur: 0,
      tokensIn: 0,
      tokensOut: 0,
      model: null,
      summary: null,
      lastEventId: 'e',
      ...rest,
    } as Run,
  };
}
function decision(
  itemId: string,
  outcome: Decision['outcome'],
  at: number,
  extra = {},
): Row<Decision> {
  return {
    id: `d${at}`,
    data: {
      workspaceId: 'w',
      projectId: 'p1',
      itemId,
      itemTitle: 't',
      stepId: 'review',
      outcome,
      toStepId: null,
      byUid: 'u',
      rationale: '',
      tags: [],
      at: ts(at),
      lastEventId: 'e',
      ...extra,
    } as Decision,
  };
}

describe('runs', () => {
  it('is stalled after 10 minutes without a heartbeat', () => {
    const fresh = run({ start: NOW - 20 * MIN, heartbeatAt: ts(NOW - 2 * MIN) });
    const stale = run({ start: NOW - 20 * MIN, heartbeatAt: ts(NOW - 11 * MIN) });
    expect(runState(fresh.data, NOW)).toBe('running');
    expect(runState(stale.data, NOW)).toBe('stalled');
    expect(runState(run({ start: 1, end: 2 }).data, NOW)).toBe('done');
  });
  it('counts a live run to now, a stalled one to its last heartbeat', () => {
    const live = run({ start: NOW - 20 * MIN, heartbeatAt: ts(NOW - MIN) });
    const dead = run({ start: NOW - 60 * MIN, heartbeatAt: ts(NOW - 30 * MIN) });
    expect(runWorkMs(live.data, NOW)).toBe(20 * MIN);
    expect(runWorkMs(dead.data, NOW)).toBe(30 * MIN);
  });
});

describe('agent stats', () => {
  const runs = [
    run({ start: NOW - 50 * MIN, end: NOW - 40 * MIN, itemId: 'a', costEur: 0.5 }),
    run({ start: NOW - 35 * MIN, end: NOW - 30 * MIN, itemId: 'b', costEur: 0.25 }),
    run({ start: NOW - 25 * MIN, end: NOW - 20 * MIN, itemId: 'c', costEur: 1, status: 'failed' }),
    run({ start: NOW - 10 * MIN, itemId: 'd', heartbeatAt: ts(NOW - MIN) }),
    run({
      start: NOW - 3 * 86_400_000,
      end: NOW - 3 * 86_400_000 + 5 * MIN,
      itemId: 'e',
      costEur: 2,
    }),
  ];
  const decisions = [
    decision('a', 'approved', NOW - 39 * MIN),
    decision('b', 'sentBack', NOW - 29 * MIN, { tags: ['Too long'], rationale: 'cut it down' }),
    decision('e', 'sentBack', NOW - 3 * 86_400_000 + 10 * MIN, {
      rationale: 'Wrong tone entirely',
    }),
  ];
  it('adds up today', () => {
    const s = agentStats(runs, decisions, windowStart('today', NOW), NOW);
    expect(s.runs).toBe(4);
    expect(s.completed).toBe(2);
    expect(s.workMs).toBe((10 + 5 + 5 + 10) * MIN);
    expect(s.costEur).toBeCloseTo(1.75);
    expect(s.judged).toBe(2);
    expect(s.firstTimeApproved).toBe(1);
    expect(s.approvalRate).toBe(0.5);
    expect(s.sendBacks).toBe(1);
    expect(s.reasons).toEqual([{ text: 'Too long', count: 1 }]);
  });
  it('adds up 7 days, with reasons from the written rationale', () => {
    const s = agentStats(runs, decisions, windowStart('7d', NOW), NOW);
    expect(s.runs).toBe(5);
    expect(s.costEur).toBeCloseTo(3.75);
    expect(s.sendBacks).toBe(2);
    expect(s.reasons.map((r) => r.text).sort()).toEqual(['Too long', 'Wrong tone entirely']);
  });
  it('does not count a stop as a send back, nor list its reasons', () => {
    const r = run({ start: NOW - 90 * MIN, end: NOW - 80 * MIN, itemId: 'z' });
    const ds = [decision('z', 'stopped', NOW - 70 * MIN, { tags: ['Off brief'] })];
    const s = agentStats([r], ds, 0, NOW);
    expect(s.judged).toBe(1);
    expect(s.sendBacks).toBe(0);
    expect(s.reasons).toEqual([]);
  });
  it('has no approval rate before anything is judged', () => {
    expect(agentStats([runs[3]!], [], 0, NOW).approvalRate).toBeNull();
  });
  it('is not first-time after an earlier send-back', () => {
    const r1 = run({ start: NOW - 90 * MIN, end: NOW - 80 * MIN, itemId: 'x' });
    const r2 = run({ start: NOW - 60 * MIN, end: NOW - 50 * MIN, itemId: 'x' });
    const ds = [
      decision('x', 'sentBack', NOW - 70 * MIN),
      decision('x', 'approved', NOW - 40 * MIN),
    ];
    const s = agentStats([r1, r2], ds, 0, NOW);
    expect(s.judged).toBe(2);
    expect(s.firstTimeApproved).toBe(0);
    expect(verdictFor(r2.data, ds)?.data.outcome).toBe('approved');
  });
});

// The integration flow (card #7) through the real actions, applied to an in-memory store.
describe('numbers after the integration flow', () => {
  it('adds up the runs, cost and verdicts the actions produce', () => {
    let clockMs = NOW - 3 * 60 * MIN;
    const docs = new Map<string, Record<string, unknown>>();
    let n = 0;
    const ids = () => `id${++n}`;
    const apply = (p: ActionPlan) => {
      clockMs += MIN;
      for (const op of p.ops) {
        const fix = (v: unknown): unknown =>
          v === SERVER_TIME
            ? ts(clockMs)
            : v && typeof v === 'object' && !Array.isArray(v) && !('toMillis' in v)
              ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]))
              : v;
        const data = fix(op.data) as Record<string, unknown>;
        docs.set(op.path, op.kind === 'set' ? data : { ...docs.get(op.path), ...data });
      }
    };
    const agent: ActionContext = {
      workspaceId: 'w',
      actor: { type: 'agent', id: 'a1', name: 'Scout' },
      newId: ids,
    };
    const human: ActionContext = {
      workspaceId: 'w',
      actor: { type: 'human', id: 'u', name: 'Ana' },
      newId: ids,
    };
    const steps = [
      { id: 'draft', name: 'Draft', kind: 'agent', description: '' },
      {
        id: 'review',
        name: 'Review',
        kind: 'human',
        description: '',
        gate: {
          deciderUids: ['u'],
          groupIds: [],
          rule: 'any',
          mustInclude: [],
          rejectPolicy: 'one',
          remindAfterHours: 24,
        },
      },
    ] as never;
    const project = { steps } as never;
    const item0 = {
      title: 'Market analysis',
      type: 'task',
      stepId: 'draft',
      status: 'queued',
      claim: null,
      gate: null,
      sendBackCount: 0,
      costEur: 0,
      triage: null,
    } as never;

    // run 1: claim, attach, complete (cost 0.40), approved
    const c1 = claimItem(agent, { projectId: 'p1', itemId: 'i1', item: item0 });
    apply(c1);
    apply(
      attach(agent, {
        projectId: 'p1',
        itemId: 'i1',
        kind: 'text',
        name: 'report.txt',
        content: 'x',
        runId: c1.runId,
      }),
    );
    const claimed = {
      ...(item0 as object),
      status: 'working',
      claim: { runId: c1.runId, agentUid: 'a1' },
    } as never;
    apply(
      completeStep(agent, {
        project,
        projectId: 'p1',
        itemId: 'i1',
        item: claimed,
        result: { costEur: 0.4 },
      }),
    );
    const gated = {
      ...(item0 as object),
      stepId: 'review',
      status: 'waiting',
      gate: { stepId: 'review', approvals: {}, rejections: {} },
    } as never;
    apply(approve(human, { project, projectId: 'p1', itemId: 'i1', item: gated }));
    // run 2 on another item: completed (cost 0.60), sent back
    const c2 = claimItem(agent, { projectId: 'p1', itemId: 'i2', item: item0 });
    apply(c2);
    const claimed2 = {
      ...(item0 as object),
      status: 'working',
      claim: { runId: c2.runId, agentUid: 'a1' },
    } as never;
    apply(
      completeStep(agent, {
        project,
        projectId: 'p1',
        itemId: 'i2',
        item: claimed2,
        result: { costEur: 0.6 },
      }),
    );
    apply(
      sendBack(human, {
        project,
        projectId: 'p1',
        itemId: 'i2',
        item: gated,
        toStepId: 'draft',
        rationale: 'Too long, cut it down',
        tags: ['Too long'],
      }),
    );

    const runs = [...docs.entries()]
      .filter(([p]) => p.includes('/runs/'))
      .map(([p, d]) => ({ id: p.split('/').pop()!, data: d as unknown as Run }));
    const decisions = [...docs.entries()]
      .filter(([p]) => p.includes('/decisions/'))
      .map(([p, d]) => ({ id: p.split('/').pop()!, data: d as unknown as Decision }));
    const events = [...docs.entries()].filter(([p]) => p.includes('/events/'));

    const s = agentStats(runs, decisions, 0, clockMs + MIN);
    expect(s.runs).toBe(2);
    expect(s.completed).toBe(2);
    expect(s.costEur).toBeCloseTo(1.0);
    expect(s.judged).toBe(2);
    expect(s.firstTimeApproved).toBe(1);
    expect(s.sendBacks).toBe(1);
    expect(s.reasons).toEqual([{ text: 'Too long', count: 1 }]);
    // every action left an event: 2 claims, 1 attach, 2 completes, 1 approve, 1 send back
    expect(events).toHaveLength(7);
    expect(new Set(events.map(([, e]) => (e as { type: string }).type))).toEqual(
      new Set([
        'item.claimed',
        'attachment.added',
        'item.completed',
        'decision.approved',
        'decision.sentBack',
      ]),
    );
  });
});

describe('isIndexBuilding', () => {
  it('is true only for failed-precondition errors', () => {
    expect(isIndexBuilding({ code: 'failed-precondition' })).toBe(true);
    expect(isIndexBuilding({ code: 'permission-denied' })).toBe(false);
    expect(isIndexBuilding(null)).toBe(false);
  });
});

describe('agent runs filter', () => {
  it('covers the events the claim, complete and release actions write', () => {
    const runs = TYPE_GROUPS.find((g) => g.id === 'runs')!.types as readonly string[];
    for (const t of ['item.claimed', 'item.completed', 'item.released']) expect(runs).toContain(t);
  });
});

describe('item history detail', () => {
  const T = (ms: number) => ({ toMillis: () => ms }) as never;
  const ev = (id: string, type: string, extra: object = {}): Row<HiveEvent> =>
    ({
      id,
      data: { type, at: T(1000), data: {}, runId: null, ...extra },
    }) as never;
  const ctx = {
    decisions: [{ id: 'd1', data: { rationale: 'Top request from support.' } }] as never,
    runs: [
      {
        id: 'r1',
        data: { summary: 'Report ready', costEur: 0.12, tokensIn: 12_000, tokensOut: 800 },
      },
    ] as never,
    attachments: [{ id: 'a1', data: { name: 'report.html', runId: 'r1', at: T(2000) } }] as never,
    source: { kind: 'telegram', label: 'Telegram' },
  };
  it('says where an item came from', () => {
    expect(eventDetail(ev('e', 'item.created'), ctx).facts).toBe('from Telegram');
  });
  it('shows the reason of a decision', () => {
    expect(eventDetail(ev('d1', 'decision.approved'), ctx).note).toBe('Top request from support.');
  });
  it('shows a run result with cost, tokens and its files', () => {
    const d = eventDetail(ev('e2', 'run.ended', { runId: 'r1' }), ctx);
    expect(d.note).toBe('Report ready');
    expect(d.facts).toBe('€0.12 · 13k tokens');
    expect(d.files.map((f) => f.name)).toEqual(['report.html']);
  });
  it('gives a run stopped from the web the same result row as a finished one', () => {
    const d = eventDetail(ev('e3', 'item.workStopped', { runId: 'r1' }), ctx);
    expect(d.note).toBe('Report ready');
    expect(d.facts).toBe('€0.12 · 13k tokens');
    expect(d.files.map((f) => f.name)).toEqual(['report.html']);
  });
});

describe('foldProgress', () => {
  const T = (ms: number) => ({ toMillis: () => ms }) as never;
  const row = (id: string, type: string, ms: number, runId: string | null, data: object = {}) =>
    ({ id, data: { type, at: T(ms), runId, data } }) as never as Row<HiveEvent>;
  const prog = (id: string, ms: number, done: number, runId = 'r1') =>
    row(id, 'item.updated', ms, runId, { progress: { done, total: 6 } });
  it('folds progress calls under the end row of their run, newest first', () => {
    const rows = [
      row('end', 'item.completed', 60, 'r1'),
      prog('p2', 50, 2),
      prog('p1', 40, 1),
      row('claim', 'item.claimed', 10, 'r1'),
    ];
    const f = foldProgress(rows);
    expect(f.rows.map((r) => r.id)).toEqual(['end', 'claim']);
    expect(f.byAnchor.get('end')?.map((r) => r.id)).toEqual(['p2', 'p1']);
  });
  it('anchors a stopped run on its workStopped row and a live run on its claim', () => {
    const f = foldProgress([
      row('stop', 'item.workStopped', 60, 'r1'),
      prog('p1', 40, 1),
      row('c2', 'item.claimed', 30, 'r2'),
      prog('p3', 35, 1, 'r2'),
    ]);
    expect(f.byAnchor.get('stop')?.length).toBe(1);
    expect(f.byAnchor.get('c2')?.length).toBe(1);
  });
  it('keeps real edits and progress without a run visible', () => {
    const edit = row('t', 'item.updated', 5, 'r1', { title: { from: 'a', to: 'b' } });
    const orphan = prog('p', 6, 1, 'gone');
    const f = foldProgress([edit, orphan]);
    expect(f.rows.map((r) => r.id)).toEqual(['t', 'p']);
  });
});
