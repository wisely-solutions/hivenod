import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type ActionContext, type WriteOp } from './actions';
import {
  approveOutcome,
  inboxEventSchema,
  inboxMessageSchema,
  inboxOutcomeSchema,
  inboxThreadSchema,
  proposeOutcome,
  rejectOutcome,
  requestRevision,
  reviseOutcome,
  type OutcomeStateOf,
  type ThreadStateOf,
} from './inbox';
import { inboxPlanSchema } from './plans';
import {
  cleanRule,
  cleanSchedule,
  createSchedule,
  decideRun,
  deleteSchedule,
  editSchedule,
  fireScheduledRun,
  pauseSchedule,
  proposeSchedule,
  resumeSchedule,
  reviseSchedule,
  setAgentsOff,
  type ScheduleInput,
} from './scheduleActions';
import {
  agentsOffSchema,
  isOffFor,
  runDocId,
  scheduleDeleteEventId,
  scheduleRunSchema,
  scheduleSchema,
  type ScheduleOf,
} from './scheduleDocs';
import { nextRun } from './schedules';

let n = 0;
const human: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'alice', name: 'Alice' },
  newId: () => `id${++n}`,
};
const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Hive' },
  newId: () => `id${++n}`,
};
const INPUT: ScheduleInput = {
  title: 'Send invoices',
  what: 'Prepare the invoices and ask me before sending.',
  rule: { freq: 'monthly', at: '09:00', tz: 'Europe/Lisbon', monthDay: 1 },
  steps: [
    { type: 'reply', fields: { text: 'Invoices for {period}.' } },
    { type: 'approval', fields: { what: 'Send the invoices for {month}' } },
  ],
};
const ts = { seconds: 1, nanoseconds: 0, toMillis: () => 1000 };
/** The data as Firestore would store it (server times resolved). */
const stored = (v: unknown): unknown =>
  v === SERVER_TIME
    ? ts
    : v instanceof Date
      ? { seconds: Math.floor(v.getTime() / 1000), nanoseconds: 0, toMillis: () => v.getTime() }
      : Array.isArray(v)
        ? v.map(stored)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stored(x)]))
          : v;
const op = (ops: WriteOp[], part: string) => ops.find((o) => o.path.includes(part))!;
const asSchedule = (data: Record<string, unknown>) => stored(data) as unknown as ScheduleOf;

describe('cleaning a schedule', () => {
  it('keeps only the rule keys it knows and refuses a bad rule in plain words', () => {
    expect(cleanRule({ freq: 'daily', at: '08:00', until: undefined })).toEqual({
      freq: 'daily',
      at: '08:00',
    });
    expect(() => cleanRule({ freq: 'weekly', at: '08:00' })).toThrow(/weekly needs weekdays/);
    expect(() => cleanRule({ freq: 'daily', at: '24:00' })).toThrow(/at: HH:MM/);
    expect(() => cleanRule({ freq: 'daily', at: '08:00', cron: '* *' } as never)).toThrow(
      /no cron/,
    );
  });
  it('defaults the run title, checks the steps as plan steps and the template', () => {
    const c = cleanSchedule(INPUT);
    expect(c.runTitle).toBe('Send invoices · {period}');
    expect(c.steps).toEqual([
      { type: 'reply', fields: { text: 'Invoices for {period}.' } },
      { type: 'approval', fields: { what: 'Send the invoices for {month}' } },
    ]);
    expect(() => cleanSchedule({ ...INPUT, steps: [{ type: 'ignore', fields: {} }] })).toThrow(
      /not a plan step/,
    );
    expect(() => cleanSchedule({ ...INPUT, steps: [] })).toThrow(/1 to 8 steps/);
    expect(() => cleanSchedule({ ...INPUT, templateId: 'nope' })).toThrow(/no template/);
    expect(() => cleanSchedule({ ...INPUT, title: ' ' })).toThrow(/title is empty/);
    expect(() => cleanSchedule({ ...INPUT, what: 'x'.repeat(4001) })).toThrow(/4000/);
  });
});

describe('the member’s schedules', () => {
  it('creates an active one from now, a valid schedule doc', () => {
    const p = createSchedule(human, { ...INPUT, agentUid: 'agentA', scheduleId: 's1' });
    const d = op(p.ops, 'schedules/s1').data!;
    expect(d).toMatchObject({
      state: 'active',
      activeFrom: SERVER_TIME,
      version: 1,
      proposal: null,
    });
    expect(scheduleSchema.parse(stored(d))).toBeTruthy();
    expect(op(p.ops, 'inboxEvents').data!).toMatchObject({
      type: 'schedule.created',
      memberUid: 'alice',
      data: { scheduleId: 's1' },
    });
    expect(() => createSchedule(agent, { ...INPUT, agentUid: 'agentA' })).toThrow(/people/);
  });
  it('a new rule moves activeFrom; a text edit does not', () => {
    const s = asSchedule(
      op(createSchedule(human, { ...INPUT, agentUid: 'agentA' }).ops, 'schedules').data!,
    );
    const moved = editSchedule(human, {
      scheduleId: 's1',
      schedule: s,
      changes: { rule: { ...INPUT.rule, at: '10:00' } },
    });
    expect(op(moved.ops, 'schedules').data).toMatchObject({ activeFrom: SERVER_TIME, version: 2 });
    const text = editSchedule(human, {
      scheduleId: 's1',
      schedule: s,
      changes: { what: 'Other.' },
    });
    expect(op(text.ops, 'schedules').data!.activeFrom).toBeUndefined();
    expect(() =>
      editSchedule(
        { ...human, actor: { ...human.actor, id: 'bob' } },
        { scheduleId: 's1', schedule: s, changes: {} },
      ),
    ).toThrow(/Only the person/);
  });
  it('pauses an active one, resumes a paused one from now, deletes with its fixed event', () => {
    const s = asSchedule(
      op(createSchedule(human, { ...INPUT, agentUid: 'agentA' }).ops, 'schedules').data!,
    );
    expect(
      op(pauseSchedule(human, { scheduleId: 's1', schedule: s }).ops, 'schedules').data,
    ).toMatchObject({
      state: 'paused',
    });
    expect(() => resumeSchedule(human, { scheduleId: 's1', schedule: s })).toThrow(/paused/);
    const paused = { ...s, state: 'paused' as const };
    expect(
      op(resumeSchedule(human, { scheduleId: 's1', schedule: paused }).ops, 'schedules').data,
    ).toMatchObject({
      state: 'active',
      activeFrom: SERVER_TIME,
    });
    const del = deleteSchedule(human, { scheduleId: 's1', schedule: s });
    expect(del.eventId).toBe(scheduleDeleteEventId('s1'));
    expect(() =>
      deleteSchedule(human, { scheduleId: 's1', schedule: { ...s, state: 'proposed' } }),
    ).toThrow(/proposal/);
  });
});

describe('an agent proposes, the member decides', () => {
  const thread: ThreadStateOf = {
    memberUid: 'alice',
    subjectId: null,
    state: 'investigating',
    fetchedBy: 'agentA',
    refs: [],
  };
  const proposed = () =>
    proposeSchedule(agent, {
      ...INPUT,
      threadId: 't1',
      thread,
      scheduleId: 'sp1',
      outcomeId: 'o1',
    });

  it('writes a proposed schedule and its schedule outcome; the thread goes to Your call', () => {
    const p = proposed();
    const s = op(p.ops, 'schedules/sp1').data!;
    expect(s).toMatchObject({ state: 'proposed', activeFrom: null, agentUid: 'agentA' });
    expect(scheduleSchema.parse(stored(s))).toBeTruthy();
    expect(op(p.ops, 'inboxOutcomes/o1').data).toMatchObject({
      type: 'schedule',
      fields: { scheduleId: 'sp1', sentence: p.sentence },
      executor: null,
    });
    expect(op(p.ops, 'inboxThreads/t1').data).toMatchObject({ state: 'yourCall' });
    expect(() =>
      proposeSchedule(agent, { ...INPUT, threadId: 't1', thread: { ...thread, fetchedBy: 'x' } }),
    ).toThrow(/home agent/);
    expect(() =>
      proposeOutcome(agent, {
        threadId: 't1',
        thread,
        type: 'schedule',
        fields: { scheduleId: 'sp1', sentence: 'x' },
      }),
    ).toThrow(/schedule_propose/);
  });

  it('approving activates it in the same batch; a change rewrites the active one', () => {
    const p = proposed();
    const o = stored(op(p.ops, 'inboxOutcomes').data!) as unknown as OutcomeStateOf;
    const s = asSchedule(op(p.ops, 'schedules').data!);
    expect(() => approveOutcome(human, { outcomeId: 'o1', outcome: o, thread })).toThrow(
      /schedule/,
    );
    const a = approveOutcome(human, {
      outcomeId: 'o1',
      outcome: o,
      thread,
      schedule: { id: 'sp1', data: s },
    });
    expect(op(a.ops, 'schedules/sp1').data).toMatchObject({
      state: 'active',
      activeFrom: SERVER_TIME,
      version: 2,
    });
    expect(op(a.ops, 'inboxEvents').data!.data).toMatchObject({ scheduleId: 'sp1' });
    const change = { ...s, replaces: 's1' };
    expect(() =>
      approveOutcome(human, {
        outcomeId: 'o1',
        outcome: o,
        thread,
        schedule: { id: 'sp1', data: change },
      }),
    ).toThrow(/replaces/);
    const c = approveOutcome(human, {
      outcomeId: 'o1',
      outcome: o,
      thread,
      schedule: { id: 'sp1', data: change, replaced: { version: 4 } },
    });
    expect(c.eventId).toBe(scheduleDeleteEventId('sp1'));
    expect(op(c.ops, 'schedules/s1').data).toMatchObject({ version: 5, activeFrom: SERVER_TIME });
    expect(c.ops.find((x) => x.path.endsWith('schedules/sp1'))!.kind).toBe('delete');
    expect(op(c.ops, 'inboxEvents').data!.data).toMatchObject({ scheduleId: 's1' });
  });

  it('carries confidence and checks like outcome_propose', () => {
    const p = proposeSchedule(agent, {
      ...INPUT,
      threadId: 't1',
      thread,
      confidence: 'high',
      checks: ['Same steps as I did by hand on 1 Oct'],
    });
    expect(op(p.ops, 'inboxOutcomes').data).toMatchObject({
      confidence: 'high',
      checks: ['Same steps as I did by hand on 1 Oct'],
    });
    expect(inboxOutcomeSchema.parse(stored(op(p.ops, 'inboxOutcomes').data))).toBeTruthy();
    expect(() =>
      proposeSchedule(agent, { ...INPUT, threadId: 't1', thread, confidence: 'sure' }),
    ).toThrow(/high, medium or low/);
  });

  it('Ask for changes, then the agent revises its schedule and the outcome in one batch', () => {
    const p = proposed();
    const o = stored(op(p.ops, 'inboxOutcomes').data!) as unknown as OutcomeStateOf;
    const s = asSchedule(op(p.ops, 'schedules').data!);
    const ask = requestRevision(human, {
      outcomeId: 'o1',
      outcome: o,
      thread,
      instruction: 'Make it 08:30',
    });
    expect(op(ask.ops, 'inboxOutcomes/o1').data).toMatchObject({ state: 'revising' });
    const revising = {
      ...o,
      state: 'revising',
      revise: { instruction: 'Make it 08:30', chips: [] },
    } as OutcomeStateOf;
    const input = {
      ...INPUT,
      rule: { ...INPUT.rule, at: '08:30' },
      outcomeId: 'o1',
      outcome: revising,
      thread,
      schedule: { id: 'sp1', data: s },
      note: 'Moved to 08:30.',
    };
    const r = reviseSchedule(agent, input);
    expect(r.version).toBe(2);
    expect(r.sentence).toBe('Monthly · day 1 · 08:30');
    expect(op(r.ops, 'schedules/sp1')).toMatchObject({
      kind: 'update',
      data: { rule: { at: '08:30' }, version: 2, lastEventId: r.eventId },
    });
    expect(op(r.ops, 'inboxOutcomes/o1').data).toMatchObject({
      state: 'proposed',
      fields: { scheduleId: 'sp1', sentence: 'Monthly · day 1 · 08:30' },
    });
    const ev = r.ops[r.ops.length - 1]!;
    expect(ev.data).toMatchObject({ type: 'outcome.revised', data: { outcomeId: 'o1' } });
    // outcome_propose cannot revise it (the schedule doc would not follow).
    expect(() =>
      reviseOutcome(agent, { outcomeId: 'o1', outcome: revising, thread, fields: {} }),
    ).toThrow(/schedule_propose/);
    expect(() => reviseSchedule(agent, { ...input, outcome: o })).toThrow(/Nobody asked/);
    expect(() =>
      reviseSchedule(agent, { ...input, schedule: { id: 'sp1', data: { ...s, state: 'active' } } }),
    ).toThrow(/no longer a proposal/);
    expect(() => reviseSchedule(agent, { ...input, schedule: { id: 'other', data: s } })).toThrow(
      /names/,
    );
  });

  it('rejecting it deletes the proposal under its delete event', () => {
    const p = proposed();
    const o = stored(op(p.ops, 'inboxOutcomes').data!) as unknown as OutcomeStateOf;
    const r = rejectOutcome(human, { outcomeId: 'o1', outcome: o, thread, othersPending: false });
    expect(r.eventId).toBe(scheduleDeleteEventId('sp1'));
    expect(r.ops.find((x) => x.path.endsWith('schedules/sp1'))!.kind).toBe('delete');
  });
});

describe('runs and the Off switch', () => {
  const run = { memberUid: 'alice', scheduleId: 's1', state: 'cantRun' as const, threadId: null };
  it('decides a run that could not happen, within 35 days for later', () => {
    const now = Date.parse('2026-11-01T10:00:00Z');
    const d = decideRun(human, { runId: 's1_2026-11', run, choice: 'skip', nowMs: now });
    expect(op(d.ops, 'scheduleRuns').data).toMatchObject({
      state: 'skipped',
      decision: { choice: 'skip', by: 'alice', via: 'web' },
    });
    expect(op(d.ops, 'inboxEvents').data).toMatchObject({ type: 'run.decided' });
    const later = new Date(now + 3_600_000);
    expect(
      op(
        decideRun(human, { runId: 'r', run, choice: 'later', laterAt: later, nowMs: now }).ops,
        'scheduleRuns',
      ).data,
    ).toMatchObject({ state: 'later', laterAt: later });
    expect(() =>
      decideRun(human, {
        runId: 'r',
        run,
        choice: 'later',
        laterAt: new Date(now - 1),
        nowMs: now,
      }),
    ).toThrow(/35 days/);
    expect(() =>
      decideRun(human, { runId: 'r', run: { ...run, state: 'fired' }, choice: 'skip', nowMs: now }),
    ).toThrow(/already decided/);
    expect(
      op(
        decideRun({ ...human, via: 'telegram' }, { runId: 'r', run, choice: 'runNow', nowMs: now })
          .ops,
        'scheduleRuns',
      ).data,
    ).toMatchObject({ state: 'runNow', decision: { via: 'telegram' } });
  });
  it('turns agents off from now and on again', () => {
    const off = setAgentsOff(human, { all: false, agents: ['agentA', 'agentA'] });
    const d = op(off.ops, 'agentsOff/alice').data!;
    expect(d).toMatchObject({ all: false, agents: ['agentA'], since: SERVER_TIME });
    expect(agentsOffSchema.parse(stored(d))).toBeTruthy();
    expect(isOffFor(d as never, 'agentA')).toBe(true);
    expect(isOffFor(d as never, 'agentB')).toBe(false);
    expect(isOffFor({ all: true, agents: [] }, 'agentB')).toBe(true);
    expect(isOffFor(null, 'agentB')).toBe(false);
    const on = setAgentsOff(human, { all: false });
    expect(on.off).toBe(false);
    expect(op(on.ops, 'agentsOff').data).toMatchObject({ since: null });
    expect(op(on.ops, 'inboxEvents').data).toMatchObject({ type: 'agents.on' });
    expect(() =>
      setAgentsOff(human, { all: false, agents: Array.from({ length: 21 }, (_, i) => `a${i}`) }),
    ).toThrow(/At most 20/);
  });
});

describe('the scheduler fires a run (Admin SDK)', () => {
  const yearly = asSchedule({
    ...op(
      createSchedule(human, { ...INPUT, agentUid: 'agentA', scheduleId: 's1' }).ops,
      'schedules',
    ).data!,
    rule: { freq: 'yearly', at: '09:00', tz: 'Europe/Lisbon', month: 3, monthDay: 2 },
    runTitle: 'Renew the domain · {year}',
  });
  const occ = nextRun(yearly.rule, Date.parse('2026-10-30T00:00:00Z'))!;
  const fire = (runExists?: { attempts: number }) =>
    fireScheduledRun({
      workspaceId: 'w1',
      scheduleId: 's1',
      schedule: yearly,
      occurrence: occ,
      threadId: 'tsabc',
      planId: 'p1',
      stepIds: ['x1', 'x2'],
      messageId: 'm1',
      eventId: 'e1',
      ...(runExists ? { runExists } : {}),
    });

  it('creates the run, thread, message, steps, plan and event in one batch with create()', () => {
    const p = fire();
    expect(p.runId).toBe(runDocId('s1', '2027'));
    for (const o of p.ops) expect(o.kind).toBe('create');
    const run = op(p.ops, 'scheduleRuns/s1_2027').data!;
    expect(scheduleRunSchema.parse(stored(run))).toMatchObject({
      state: 'fired',
      key: '2027',
      period: '2027',
      title: 'Renew the domain · 2027',
      threadId: 'tsabc',
      attempts: 1,
    });
    const t = inboxThreadSchema.parse(stored(op(p.ops, 'inboxThreads/tsabc').data!));
    expect(t).toMatchObject({
      fetchedBy: 'agentA',
      urgent: true,
      schedule: { scheduleId: 's1', runKey: '2027' },
      title: 'Renew the domain · 2027',
    });
    const m = inboxMessageSchema.parse(stored(op(p.ops, 'inboxMessages/m1').data!));
    expect(m.source).toBe('schedule');
    expect(m.text).toMatch(/Due Tue 2 Mar 2027 09:00 \(Europe\/Lisbon\)/);
    const s1 = inboxOutcomeSchema.parse(stored(op(p.ops, 'inboxOutcomes/x1').data!));
    const s2 = inboxOutcomeSchema.parse(stored(op(p.ops, 'inboxOutcomes/x2').data!));
    expect(s1).toMatchObject({ state: 'approved', executor: 'agentA', proposedBy: 'alice' });
    expect(s1.fields).toEqual({ text: 'Invoices for 2027.' });
    expect(s2).toMatchObject({ state: 'proposed', executor: null });
    expect(s2.fields).toEqual({ what: 'Send the invoices for Mar' });
    expect(inboxPlanSchema.parse(stored(op(p.ops, 'inboxPlans/p1').data!))).toMatchObject({
      state: 'active',
      cursor: 0,
      steps: ['x1', 'x2'],
    });
    const e = inboxEventSchema.parse(stored(op(p.ops, 'inboxEvents/e1').data!));
    expect(e).toMatchObject({
      type: 'thread.created',
      actor: { type: 'system', id: 'scheduler' },
      data: { scheduleId: 's1', runKey: '2027', planId: 'p1' },
    });
  });

  it('updates a run that waited for its agent, refuses paused schedules and step id mismatches', () => {
    const p = fire({ attempts: 1 });
    const r = p.ops.find((o) => o.path.includes('scheduleRuns'))!;
    expect(r.kind).toBe('update');
    expect(r.data).toMatchObject({ state: 'fired', attempts: 2, threadId: 'tsabc' });
    expect(() =>
      fireScheduledRun({
        workspaceId: 'w1',
        scheduleId: 's1',
        schedule: { ...yearly, state: 'paused' },
        occurrence: occ,
        threadId: 't',
        planId: 'p',
        stepIds: ['a', 'b'],
        messageId: 'm',
        eventId: 'e',
      }),
    ).toThrow(/active/);
    expect(() =>
      fireScheduledRun({
        workspaceId: 'w1',
        scheduleId: 's1',
        schedule: yearly,
        occurrence: occ,
        threadId: 't',
        planId: 'p',
        stepIds: ['a', 'a'],
        messageId: 'm',
        eventId: 'e',
      }),
    ).toThrow(/distinct/);
  });
});
