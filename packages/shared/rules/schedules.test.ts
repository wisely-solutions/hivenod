/**
 * Scheduled tasks, slice 2 (src/scheduleDocs.ts, src/scheduleActions.ts): a schedule is the
 * member's. He makes, edits, pauses, resumes and deletes his own and activates an agent's
 * proposal only by approving its `schedule` outcome; agents only propose; runs are the
 * scheduler's (Admin SDK) and the member only decides one that could not happen; the Off switch
 * is the member's own.
 */
import { Timestamp } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type ActionPlan, type WriteOp } from '../src/actions';
import {
  addInboxMessage,
  approveOutcome,
  inboxPaths,
  proposeOutcome,
  rejectOutcome,
  requestRevision,
  reviseOutcome,
  type OutcomeStateOf,
  type ThreadStateOf,
} from '../src/inbox';
import {
  createSchedule,
  decideRun,
  deleteSchedule,
  editSchedule,
  pauseSchedule,
  proposeSchedule,
  resumeSchedule,
  reviseSchedule,
  setAgentsOff,
  type ScheduleInput,
} from '../src/scheduleActions';
import { schedulePaths, type ScheduleOf, type ScheduleRunOf } from '../src/scheduleDocs';
import { AGENTS, as, denied, ok, put, snap, useEmulator, W, type As } from './harness';

useEmulator();

const S = (sid: string) => schedulePaths.schedule(W, sid);
const R = (rid: string) => schedulePaths.run(W, rid);
const OFF = (uid: string) => schedulePaths.off(W, uid);
const T = (tid: string) => inboxPaths.thread(W, tid);
const O = (oid: string) => inboxPaths.outcome(W, oid);

const INVOICES: ScheduleInput = {
  title: 'Send invoices',
  what: 'Prepare the invoices of last month and ask me before sending.',
  rule: { freq: 'monthly', at: '09:00', tz: 'Europe/Lisbon', monthDay: 1 },
  runTitle: 'Send invoices · {month} {year}',
  steps: [
    { type: 'reply', fields: { text: 'Invoices for {period} are ready.' } },
    { type: 'approval', fields: { what: 'Send the invoices for {period}' } },
  ],
};

/** Hand-built attack: the plan's ops with one doc's data changed (or the doc dropped). */
function tamper(
  p: Pick<ActionPlan, 'ops'>,
  path: string,
  change: ((d: Record<string, unknown>) => Record<string, unknown>) | null,
): WriteOp[] {
  return p.ops.flatMap((op) =>
    op.path !== path ? [op] : change === null ? [] : [{ ...op, data: change({ ...op.data }) }],
  );
}
const eventPath = (p: ActionPlan) => inboxPaths.event(W, p.eventId);

async function threadFor(member = 'alice', ref = 'r1') {
  const a = as(AGENTS.a);
  await ok(
    a.run(
      addInboxMessage(a.ctx, {
        messageDocId: `im-${ref}`,
        ref,
        memberUid: member,
        source: 'teams',
        sender: { name: 'Sam Example', handle: 'sam@example.com' },
        text: 'Every 1st at 9, prepare the invoices and ask me before sending.',
        threadRef: `thread-${ref}`,
        messageId: 'm-1',
        permalink: null,
        replyRef: null,
        receivedAt: new Date('2026-10-28T09:00:00Z'),
      }),
    ),
  );
  return `it${ref}`;
}
const thread = async (tid = 'itr1') => (await snap(T(tid))) as unknown as ThreadStateOf;
const schedule = async (sid: string) => (await snap(S(sid))) as unknown as ScheduleOf;

async function mine(sid = 's1', uid = 'alice', agentUid: string = AGENTS.a): Promise<As> {
  const m = as(uid);
  await ok(m.run(createSchedule(m.ctx, { ...INVOICES, agentUid, scheduleId: sid })));
  return m;
}
async function proposal(over: Partial<Parameters<typeof proposeSchedule>[1]> = {}) {
  const tid = (await snap(T('itr1'))).memberUid ? 'itr1' : await threadFor();
  const a = as(AGENTS.a);
  const p = proposeSchedule(a.ctx, {
    ...INVOICES,
    threadId: tid,
    thread: await thread(tid),
    scheduleId: 'sp1',
    outcomeId: 'osp1',
    ...over,
  });
  return { a, p, tid };
}

describe('the member makes his own schedules', () => {
  it('creates one, active from now, for an active agent of the org; he and the agents read it', async () => {
    await mine();
    const s = await snap(S('s1'));
    expect(s.state).toBe('active');
    expect(s.activeFrom).toBeInstanceOf(Timestamp);
    expect(s.version).toBe(1);
    const { getDoc, doc } = await import('firebase/firestore');
    await ok(getDoc(doc(as('alice').db, S('s1'))));
    await ok(getDoc(doc(as(AGENTS.star).db, S('s1'))));
    await denied(getDoc(doc(as('bob').db, S('s1'))));
  });

  it('refuses a revoked agent, a bad time, a proposed state, someone else as the member', async () => {
    const m = as('alice');
    await denied(
      m.run(createSchedule(m.ctx, { ...INVOICES, agentUid: AGENTS.revoked, scheduleId: 's1' })),
    );
    const p = createSchedule(m.ctx, { ...INVOICES, agentUid: AGENTS.a, scheduleId: 's1' });
    await denied(
      m.run(tamper(p, S('s1'), (d) => ({ ...d, rule: { freq: 'daily', at: '24:00' } }))),
    );
    await denied(m.run(tamper(p, S('s1'), (d) => ({ ...d, state: 'proposed' }))));
    await denied(m.run(tamper(p, S('s1'), (d) => ({ ...d, memberUid: 'bob' }))));
    await denied(m.run(tamper(p, S('s1'), (d) => ({ ...d, activeFrom: Timestamp.fromMillis(0) }))));
    await ok(m.run(p));
  });

  it('edits it: a new rule starts from now; the agent and the member cannot change', async () => {
    const m = await mine();
    const before = await snap(S('s1'));
    const edit = (s: ScheduleOf, changes: Partial<ScheduleInput>) =>
      editSchedule(m.ctx, { scheduleId: 's1', schedule: s, changes });
    // A new rule without moving activeFrom is refused.
    const moved = edit(await schedule('s1'), { rule: { ...INVOICES.rule, at: '10:00' } });
    await denied(
      m.run(
        tamper(moved, S('s1'), (d) => {
          delete d.activeFrom;
          return d;
        }),
      ),
    );
    await denied(m.run(tamper(moved, S('s1'), (d) => ({ ...d, agentUid: AGENTS.star }))));
    await denied(m.run(tamper(moved, S('s1'), (d) => ({ ...d, version: 5 }))));
    await ok(m.run(moved));
    const after = await snap(S('s1'));
    expect((after.activeFrom as Timestamp).toMillis()).toBeGreaterThanOrEqual(
      (before.activeFrom as Timestamp).toMillis(),
    );
    expect(after.version).toBe(2);
    // Only the text: activeFrom stays.
    await ok(m.run(edit(await schedule('s1'), { what: 'Prepare and send the invoices.' })));
    expect((await snap(S('s1'))).activeFrom).toEqual(after.activeFrom);
  });

  it('only the member edits, pauses or deletes it', async () => {
    await mine();
    const b = as('bob');
    const s = await schedule('s1');
    // Bob builds the same writes as if it were his (his own events).
    const asBob = { ...s, memberUid: 'bob' };
    await denied(
      b.run(
        editSchedule(b.ctx, { scheduleId: 's1', schedule: asBob, changes: { what: 'Mine now.' } }),
      ),
    );
    await denied(b.run(pauseSchedule(b.ctx, { scheduleId: 's1', schedule: asBob })));
    await denied(b.run(deleteSchedule(b.ctx, { scheduleId: 's1', schedule: asBob })));
    const a = as(AGENTS.a);
    await denied(
      a.run([
        {
          kind: 'update',
          path: S('s1'),
          data: {
            state: 'paused',
            version: s.version + 1,
            updatedAt: SERVER_TIME,
            lastEventId: 'x',
          },
        },
      ]),
    );
    await denied(a.run([{ kind: 'delete', path: S('s1') }]));
  });

  it('pauses and resumes it; a resume starts from now', async () => {
    const m = await mine();
    await ok(m.run(pauseSchedule(m.ctx, { scheduleId: 's1', schedule: await schedule('s1') })));
    expect((await snap(S('s1'))).state).toBe('paused');
    const r = resumeSchedule(m.ctx, { scheduleId: 's1', schedule: await schedule('s1') });
    await denied(
      m.run(
        tamper(r, S('s1'), (d) => {
          delete d.activeFrom;
          return d;
        }),
      ),
    );
    await ok(m.run(r));
    expect((await snap(S('s1'))).state).toBe('active');
  });

  it('deletes it only with its delete event', async () => {
    const m = await mine();
    const p = deleteSchedule(m.ctx, { scheduleId: 's1', schedule: await schedule('s1') });
    await denied(m.run(tamper(p, eventPath(p), null)));
    await ok(m.run(p));
    expect(await snap(S('s1'))).toEqual({});
  });
});

describe('an agent proposes, the member approves', () => {
  it('proposes on its own thread: the schedule stays proposed, the thread goes to Your call', async () => {
    const { a, p, tid } = await proposal();
    await ok(a.run(p));
    expect((await snap(S('sp1'))).state).toBe('proposed');
    expect((await snap(O('osp1'))).fields).toEqual({
      scheduleId: 'sp1',
      sentence: p.sentence,
    });
    expect((await snap(T(tid))).state).toBe('yourCall');
  });

  it('never proposes it active, nor without its outcome, nor the outcome alone', async () => {
    const { a, p } = await proposal();
    await denied(a.run(tamper(p, S('sp1'), (d) => ({ ...d, state: 'active' }))));
    await denied(
      a.run(tamper(p, S('sp1'), (d) => ({ ...d, state: 'active', activeFrom: SERVER_TIME }))),
    );
    await denied(a.run(tamper(p, O('osp1'), null)));
    await denied(a.run(tamper(p, S('sp1'), null)));
    // The schedule and its event without the outcome (nor the thread's move).
    await denied(a.run(tamper({ ops: tamper(p, O('osp1'), null) }, T('itr1'), null)));
    expect(() =>
      proposeOutcome(a.ctx, {
        threadId: 'itr1',
        thread: {
          memberUid: 'alice',
          subjectId: null,
          state: 'investigating',
          fetchedBy: AGENTS.a,
          refs: [],
        },
        type: 'schedule',
        fields: { scheduleId: 'x', sentence: 'Daily · 09:00' },
      }),
    ).toThrow(/schedule_propose/);
  });

  it('only the thread’s home agent proposes', async () => {
    const tid = await threadFor();
    const star = as(AGENTS.star);
    const lie = { ...(await thread(tid)), fetchedBy: AGENTS.star };
    await denied(
      star.run(
        proposeSchedule(star.ctx, {
          ...INVOICES,
          threadId: tid,
          thread: lie,
          scheduleId: 'sp1',
          outcomeId: 'osp1',
        }),
      ),
    );
  });

  it('a change replaces only a schedule it runs for that member', async () => {
    await mine('s1', 'alice', AGENTS.a);
    await mine('s2', 'alice', AGENTS.star);
    await mine('s3', 'bob', AGENTS.a);
    const { a, p } = await proposal({
      replaces: { id: 's2', schedule: { ...(await schedule('s2')), agentUid: AGENTS.a } },
    });
    await denied(a.run(p));
    const { p: p3 } = await proposal({
      replaces: { id: 's3', schedule: { ...(await schedule('s3')), memberUid: 'alice' } },
    });
    await denied(a.run(p3));
    const { p: p1 } = await proposal({ replaces: { id: 's1', schedule: await schedule('s1') } });
    await ok(a.run(p1));
  });

  it('approving the outcome activates it from now; the thread is done', async () => {
    const { a, p, tid } = await proposal();
    await ok(a.run(p));
    const m = as('alice');
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    const plan = approveOutcome(m.ctx, {
      outcomeId: 'osp1',
      outcome: o,
      thread: await thread(tid),
      schedule: { id: 'sp1', data: await schedule('sp1') },
    });
    await ok(m.run(plan));
    const s = await snap(S('sp1'));
    expect(s.state).toBe('active');
    expect(s.activeFrom).toBeInstanceOf(Timestamp);
    expect((await snap(O('osp1'))).state).toBe('done');
    expect((await snap(T(tid))).state).toBe('done');
  });

  it('the agent never activates it, nor the member without approving its outcome', async () => {
    const { a, p } = await proposal();
    await ok(a.run(p));
    const s = await schedule('sp1');
    const activate = (who: As, type: string): WriteOp[] => [
      {
        kind: 'update',
        path: S('sp1'),
        data: {
          state: 'active',
          activeFrom: SERVER_TIME,
          version: s.version + 1,
          updatedAt: SERVER_TIME,
          lastEventId: 'ev-act',
        },
      },
      {
        kind: 'set',
        path: inboxPaths.event(W, 'ev-act'),
        data: {
          actor: { type: who.ctx.actor.type, id: who.uid, name: who.uid },
          memberUid: 'alice',
          threadId: null,
          subjectId: null,
          type,
          data: { scheduleId: 'sp1', outcomeId: 'osp1' },
          at: SERVER_TIME,
        },
      },
    ];
    await denied(a.run(activate(a, 'outcome.proposed')));
    await denied(as('alice').run(activate(as('alice'), 'schedule.updated')));
    await ok(as('alice').run(activate(as('alice'), 'outcome.approved')));
  });

  it('rejecting it deletes the proposal', async () => {
    const { a, p, tid } = await proposal();
    await ok(a.run(p));
    const m = as('alice');
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    await ok(
      m.run(
        rejectOutcome(m.ctx, {
          outcomeId: 'osp1',
          outcome: o,
          thread: await thread(tid),
          othersPending: false,
        }),
      ),
    );
    expect(await snap(S('sp1'))).toEqual({});
  });

  it('approving a change rewrites the active schedule and deletes the proposal', async () => {
    await mine('s1');
    const { a, p, tid } = await proposal({
      replaces: { id: 's1', schedule: await schedule('s1') },
      rule: { freq: 'monthly', at: '10:00', tz: 'Europe/Lisbon', monthDay: 2 },
    });
    await ok(a.run(p));
    const m = as('alice');
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    await ok(
      m.run(
        approveOutcome(m.ctx, {
          outcomeId: 'osp1',
          outcome: o,
          thread: await thread(tid),
          schedule: { id: 'sp1', data: await schedule('sp1'), replaced: { version: 1 } },
        }),
      ),
    );
    expect(await snap(S('sp1'))).toEqual({});
    const s = await snap(S('s1'));
    expect(s.rule).toEqual({ freq: 'monthly', at: '10:00', tz: 'Europe/Lisbon', monthDay: 2 });
    expect(s.version).toBe(2);
    expect(s.state).toBe('active');
  });
});

describe('Ask for changes: the agent revises its proposal (slice 5)', () => {
  /** A proposal the member asked changes for, and the agent's revision of it. */
  async function asked() {
    const { a, p, tid } = await proposal();
    await ok(a.run(p));
    const m = as('alice');
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    await ok(
      m.run(
        requestRevision(m.ctx, {
          outcomeId: 'osp1',
          outcome: o,
          thread: await thread(tid),
          instruction: 'At 08:30, please',
        }),
      ),
    );
    const revise = async (who: As = a) =>
      reviseSchedule(who.ctx, {
        ...INVOICES,
        rule: { ...INVOICES.rule, at: '08:30' },
        outcomeId: 'osp1',
        outcome: (await snap(O('osp1'))) as unknown as OutcomeStateOf,
        thread: await thread(tid),
        schedule: { id: 'sp1', data: await schedule('sp1') },
        note: 'Moved to 08:30.',
      });
    return { a, m, tid, revise };
  }

  it('rewrites the proposed schedule with the outcome’s next version; approving it activates v2', async () => {
    const { a, m, tid, revise } = await asked();
    await ok(a.run(await revise()));
    const s = await snap(S('sp1'));
    expect(s.rule).toEqual({ ...INVOICES.rule, at: '08:30' });
    expect(s).toMatchObject({ state: 'proposed', version: 2 });
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    expect(o.state).toBe('proposed');
    expect(o.fields.sentence).toBe('Monthly · day 1 · 08:30');
    expect(o.versions).toHaveLength(2);
    await ok(
      m.run(
        approveOutcome(m.ctx, {
          outcomeId: 'osp1',
          outcome: o,
          thread: await thread(tid),
          schedule: { id: 'sp1', data: await schedule('sp1') },
        }),
      ),
    );
    expect(await snap(S('sp1'))).toMatchObject({ state: 'active', version: 3 });
  });

  it('refuses the schedule without the outcome’s revision, activating, retargeting or another agent', async () => {
    const { a, revise } = await asked();
    const p = await revise();
    await denied(a.run(tamper(p, O('osp1'), null)));
    await denied(a.run(tamper(p, S('sp1'), (d) => ({ ...d, state: 'active' }))));
    await denied(a.run(tamper(p, S('sp1'), (d) => ({ ...d, agentUid: AGENTS.star }))));
    await denied(a.run(tamper(p, S('sp1'), (d) => ({ ...d, version: 5 }))));
    await denied(
      a.run(tamper(p, S('sp1'), (d) => ({ ...d, rule: { freq: 'hourly', at: '08:30' } }))),
    );
    // Another agent of the org cannot rewrite it (nor the outcome: it did not propose it).
    const b = as(AGENTS.star);
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    const sc = await schedule('sp1');
    const byB = reviseSchedule(b.ctx, {
      ...INVOICES,
      outcomeId: 'osp1',
      outcome: { ...o, proposedBy: AGENTS.star },
      thread: (await snap(T('itr1'))) as unknown as ThreadStateOf,
      schedule: { id: 'sp1', data: { ...sc, agentUid: AGENTS.star } },
    });
    await denied(b.run(byB));
    await denied(b.run(tamper(byB, O('osp1'), null)));
    await ok(a.run(p));
  });

  it('refuses a revision nobody asked for, and outcome_propose on a schedule', async () => {
    const { a, p, tid } = await proposal();
    await ok(a.run(p));
    const o = (await snap(O('osp1'))) as unknown as OutcomeStateOf;
    // Hand-built: the outcome as if revising, written over a proposed one.
    const fake = reviseSchedule(a.ctx, {
      ...INVOICES,
      outcomeId: 'osp1',
      outcome: {
        ...o,
        state: 'revising',
        revise: { instruction: 'x', chips: [] },
      } as OutcomeStateOf,
      thread: await thread(tid),
      schedule: { id: 'sp1', data: await schedule('sp1') },
    });
    await denied(a.run(fake));
    const t = await thread(tid);
    expect(() =>
      reviseOutcome(a.ctx, { outcomeId: 'osp1', outcome: o, thread: t, fields: {} }),
    ).toThrow(/schedule_propose/);
  });
});

describe('runs', () => {
  const run = (state: string, member = 'alice') => ({
    memberUid: member,
    scheduleId: 's1',
    agentUid: AGENTS.a,
    key: '2026-11',
    period: 'Nov 2026',
    dueAt: Timestamp.fromMillis(Date.parse('2026-11-01T09:00:00Z')),
    title: 'Send invoices · Nov 2026',
    state,
    why:
      state === 'cantRun' ? { code: 'offline', text: 'Hive was offline (last seen 08:12).' } : null,
    threadId: null,
    attempts: 0,
    laterAt: null,
    firedAt: null,
    startedAt: null,
    endedAt: null,
    ask: null,
    decision: null,
    scheduleVersion: 1,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    lastEventId: 'seed',
  });
  const RID = 's1_2026-11';
  const decide = (who: As, state: string, choice: 'runNow' | 'later' | 'skip', laterAt?: Date) =>
    decideRun(who.ctx, {
      runId: RID,
      run: { memberUid: who.uid, scheduleId: 's1', state } as ScheduleRunOf,
      choice,
      laterAt: laterAt ?? null,
      nowMs: Date.now(),
    });

  it('the member decides a run that could not happen: run now, later, skip', async () => {
    const m = as('alice');
    for (const [choice, state] of [
      ['runNow', 'runNow'],
      ['later', 'later'],
      ['skip', 'skipped'],
    ] as const) {
      await put({ [R(RID)]: run('cantRun') });
      await ok(m.run(decide(m, 'cantRun', choice, new Date(Date.now() + 3_600_000))));
      const r = await snap(R(RID));
      expect(r.state).toBe(state);
      expect((r.decision as { choice: string }).choice).toBe(choice);
    }
  });

  it('refuses other members, other states, a past or far later, a choice and state that differ', async () => {
    await put({ [R(RID)]: run('cantRun') });
    const m = as('alice');
    const b = as('bob');
    await denied(b.run(decide(b, 'cantRun', 'skip')));
    const later = decide(m, 'cantRun', 'later', new Date(Date.now() + 3_600_000));
    await denied(
      m.run(tamper(later, R(RID), (d) => ({ ...d, laterAt: new Date(Date.now() - 60_000) }))),
    );
    await denied(
      m.run(
        tamper(later, R(RID), (d) => ({ ...d, laterAt: new Date(Date.now() + 40 * 86_400_000) })),
      ),
    );
    const skip = decide(m, 'cantRun', 'skip');
    await denied(m.run(tamper(skip, R(RID), (d) => ({ ...d, state: 'runNow' }))));
    await denied(
      m.run(
        tamper(skip, R(RID), (d) => ({
          ...d,
          decision: { ...(d.decision as object), by: 'bob' },
        })),
      ),
    );
    await put({ [R(RID)]: run('fired') });
    await denied(m.run(decide(m, 'cantRun', 'skip')));
  });

  it('nobody but the scheduler creates or moves runs', async () => {
    const m = as('alice');
    const a = as(AGENTS.a);
    const { getDoc, doc } = await import('firebase/firestore');
    await denied(m.run([{ kind: 'set', path: R('s1_2026-12'), data: run('fired') }]));
    await put({ [R(RID)]: run('fired') });
    await denied(
      a.run([
        {
          kind: 'update',
          path: R(RID),
          data: { state: 'done', updatedAt: SERVER_TIME, lastEventId: 'x' },
        },
      ]),
    );
    await ok(getDoc(doc(m.db, R(RID))));
    await ok(getDoc(doc(a.db, R(RID))));
    await denied(getDoc(doc(as('bob').db, R(RID))));
  });
});

describe('the Off switch', () => {
  it('the member turns his agents off (since now) and on again; his agents read it', async () => {
    const m = as('alice');
    await ok(m.run(setAgentsOff(m.ctx, { all: true })));
    const off = await snap(OFF('alice'));
    expect(off.all).toBe(true);
    expect(off.since).toBeInstanceOf(Timestamp);
    await ok(m.run(setAgentsOff(m.ctx, { all: false, agents: [AGENTS.a] })));
    await ok(m.run(setAgentsOff(m.ctx, { all: false })));
    expect((await snap(OFF('alice'))).since).toBeNull();
    const { getDoc, doc } = await import('firebase/firestore');
    await ok(getDoc(doc(as(AGENTS.a).db, OFF('alice'))));
    await denied(getDoc(doc(as('bob').db, OFF('alice'))));
  });

  it('refuses an agent, another member, an old since', async () => {
    const m = as('alice');
    const p = setAgentsOff(m.ctx, { all: true });
    await denied(
      m.run(
        tamper(p, OFF('alice'), (d) => ({
          ...d,
          since: Timestamp.fromMillis(Date.now() - 86_400_000),
        })),
      ),
    );
    const b = as('bob');
    const pb = setAgentsOff(b.ctx, { all: true });
    await denied(
      b.run(pb.ops.map((op) => (op.path === OFF('bob') ? { ...op, path: OFF('alice') } : op))),
    );
    const a = as(AGENTS.a);
    await denied(
      a.run([
        {
          kind: 'set',
          path: OFF('alice'),
          data: {
            all: false,
            agents: [],
            since: null,
            updatedAt: SERVER_TIME,
            lastEventId: 'ev-on',
          },
        },
        {
          kind: 'set',
          path: inboxPaths.event(W, 'ev-on'),
          data: {
            actor: { type: 'agent', id: AGENTS.a, name: 'Agent' },
            memberUid: 'alice',
            threadId: null,
            subjectId: null,
            type: 'agents.on',
            data: {},
            at: SERVER_TIME,
          },
        },
      ]),
    );
  });
});
