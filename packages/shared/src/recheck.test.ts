/**
 * Re-check (item bmNoIvvqKCdAorLSShE9): the member asks the home agent to check a thread again;
 * the agent confirms the open proposals (checkedAt), revises them unasked, or asks. Plus the
 * browser's "May be out of date" flag.
 */
import { describe, expect, it } from 'vitest';
import { SERVER_TIME, type ActionContext } from './actions';
import {
  recheckable,
  recheckDone,
  recheckPending,
  requestRecheck,
  reviseOutcome,
  RECHECK_RETRY_MS,
  type OutcomeStateOf,
  type PlanInput,
  type ThreadStateOf,
} from './inbox';
import { freshAt, staleReason, staleText, STALE_AFTER_MS } from './stale';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => 'e1',
};
const other: ActionContext = { ...agent, actor: { type: 'agent', id: 'agentB', name: 'B' } };
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => 'e2',
};
const NOW = Date.parse('2026-10-29T12:00:00Z');
const at = (ms: number) => ({ toMillis: () => ms });
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const PENDING: ThreadStateOf = { ...TH, recheck: { state: 'pending', requestedAt: at(NOW) } };
const O: OutcomeStateOf = {
  memberUid: 'joao',
  threadId: 't1',
  type: 'reply',
  fields: { text: 'Thursday works.' },
  state: 'proposed',
  executor: 'agentA',
  proposedBy: 'agentA',
  note: 'They asked.',
  confidence: 'high',
};

describe('requestRecheck', () => {
  it('sets a pending request on the thread, one event', () => {
    const p = requestRecheck(joao, { threadId: 't1', thread: TH, nowMs: NOW });
    expect(p.ops).toHaveLength(2);
    expect(p.ops[0]).toMatchObject({
      kind: 'update',
      path: 'workspaces/w1/inboxThreads/t1',
      data: {
        recheck: {
          state: 'pending',
          by: 'joao',
          requestedAt: SERVER_TIME,
          result: null,
          note: null,
          at: null,
        },
      },
    });
    expect(p.ops[1]!.data).toMatchObject({ type: 'thread.recheck_requested', threadId: 't1' });
  });
  it('only the member, only Your call or waiting, not while pending (30 minutes)', () => {
    expect(() => requestRecheck(agent, { threadId: 't1', thread: TH })).toThrow();
    expect(() =>
      requestRecheck(
        { ...joao, actor: { ...joao.actor, id: 'bob' } },
        { threadId: 't1', thread: TH },
      ),
    ).toThrow(/Only the person/);
    for (const state of ['investigating', 'needsYou', 'done', 'ignored'] as const)
      expect(() => requestRecheck(joao, { threadId: 't1', thread: { ...TH, state } })).toThrow(
        /proposal or a plan/,
      );
    expect(() =>
      requestRecheck(joao, { threadId: 't1', thread: { ...TH, state: 'waiting' }, nowMs: NOW }),
    ).not.toThrow();
    expect(() => requestRecheck(joao, { threadId: 't1', thread: PENDING, nowMs: NOW })).toThrow(
      /already checking/,
    );
    expect(() =>
      requestRecheck(joao, {
        threadId: 't1',
        thread: PENDING,
        nowMs: NOW + RECHECK_RETRY_MS + 1,
      }),
    ).not.toThrow();
    expect(
      recheckPending({ recheck: { state: 'done', requestedAt: at(NOW) } }, NOW),
    ).toBe(false);
  });
});

function planOf(states: OutcomeStateOf['state'][], cursor: number): PlanInput {
  const ids = states.map((_, i) => `s${i + 1}`);
  return {
    planId: 'p1',
    plan: { memberUid: 'joao', threadId: 't1', steps: ids, cursor, state: 'active' },
    outcomes: Object.fromEntries(
      ids.map((id, i) => [id, { ...O, planId: 'p1', state: states[i]! }]),
    ),
  };
}

describe('recheckable', () => {
  it('open proposals and the unrun steps of a live plan', () => {
    const pl = planOf(['done', 'approved', 'approved', 'proposed'], 1);
    expect(recheckable('o1', O)).toBe(true);
    expect(recheckable('o1', { ...O, state: 'approved' })).toBe(false);
    expect(recheckable('o1', { ...O, state: 'revising' })).toBe(false);
    expect(recheckable('s1', pl.outcomes.s1!, pl)).toBe(false); // done
    expect(recheckable('s2', pl.outcomes.s2!, pl)).toBe(false); // its turn: running
    expect(recheckable('s3', pl.outcomes.s3!, pl)).toBe(true);
    expect(recheckable('s4', pl.outcomes.s4!, pl)).toBe(true);
    const stopped = { ...pl, plan: { ...pl.plan, state: 'stopped' as const } };
    expect(recheckable('s3', pl.outcomes.s3!, stopped)).toBe(false);
  });
});

describe('recheckDone', () => {
  it('still good: closes the request and stamps checkedAt on what it looked at', () => {
    const pl = planOf(['done', 'approved', 'approved'], 1);
    const p = recheckDone(agent, {
      threadId: 't1',
      thread: PENDING,
      result: 'still_good',
      note: '  Nothing changed. ',
      outcomes: {
        o1: O,
        o2: { ...O, state: 'rejected' },
        o3: { ...O, threadId: 't2' },
        ...pl.outcomes,
      },
      plans: { p1: pl.plan },
    });
    expect(p.checked).toEqual(['o1', 's3']);
    expect(p.ops[0]).toMatchObject({
      path: 'workspaces/w1/inboxThreads/t1',
      data: {
        'recheck.state': 'done',
        'recheck.result': 'still_good',
        'recheck.note': 'Nothing changed.',
        'recheck.at': SERVER_TIME,
      },
    });
    expect(p.ops.slice(1, 3).map((o) => [o.path, o.data.checkedAt])).toEqual([
      ['workspaces/w1/inboxOutcomes/o1', SERVER_TIME],
      ['workspaces/w1/inboxOutcomes/s3', SERVER_TIME],
    ]);
    expect(p.ops.at(-1)!.data).toMatchObject({
      type: 'thread.rechecked',
      data: { result: 'still_good', note: 'Nothing changed.', checked: ['o1', 's3'] },
    });
  });
  it('revised and asked stamp nothing', () => {
    for (const result of ['revised', 'asked']) {
      const p = recheckDone(agent, { threadId: 't1', thread: PENDING, result, outcomes: { o1: O } });
      expect(p.checked).toEqual([]);
      expect(p.ops).toHaveLength(2);
    }
  });
  it('refused: not the home agent, nothing pending, a member, a bad result or note', () => {
    const base = { threadId: 't1', thread: PENDING, result: 'still_good', outcomes: {} };
    expect(() => recheckDone(other, base)).toThrow(/home agent/);
    expect(() => recheckDone(joao, base)).toThrow();
    expect(() => recheckDone(agent, { ...base, thread: TH })).toThrow(/Nobody asked/);
    expect(() =>
      recheckDone(agent, { ...base, thread: { ...TH, recheck: { state: 'done' } } }),
    ).toThrow(/Nobody asked/);
    expect(() => recheckDone(agent, { ...base, result: 'fine' })).toThrow(/still_good/);
    expect(() => recheckDone(agent, { ...base, note: 'x'.repeat(501) })).toThrow(/500/);
  });
});

describe('reviseOutcome on a re-check', () => {
  const f = { text: 'Friday works better.' };
  it('the home agent revises an open proposal unasked: asked is null', () => {
    const p = reviseOutcome(agent, { outcomeId: 'o1', outcome: O, thread: PENDING, fields: f });
    expect(p.version).toBe(2);
    expect(p.ops[0]!.data).toMatchObject({ state: 'proposed', fields: f, revise: null });
    expect((p.ops[0]!.data as { versions: { asked: unknown }[] }).versions[1]!.asked).toBeNull();
    expect(p.ops[0]!.data).not.toHaveProperty('decision');
  });
  it('an approved unrun plan step goes back to proposed, its approval cleared', () => {
    const pl = planOf(['done', 'approved', 'approved'], 1);
    const p = reviseOutcome(agent, {
      outcomeId: 's3',
      outcome: pl.outcomes.s3!,
      thread: { ...PENDING, state: 'waiting' },
      fields: f,
      plan: pl,
    });
    expect(p.ops[0]!.data).toMatchObject({ state: 'proposed', decision: null });
    // Its turn (being carried out), or without its plan: refused.
    expect(() =>
      reviseOutcome(agent, {
        outcomeId: 's2',
        outcome: pl.outcomes.s2!,
        thread: PENDING,
        fields: f,
        plan: pl,
      }),
    ).toThrow(/started/);
    expect(() =>
      reviseOutcome(agent, { outcomeId: 's3', outcome: pl.outcomes.s3!, thread: PENDING, fields: f }),
    ).toThrow(/give its plan/);
  });
  it('refused without a pending re-check, or for another agent', () => {
    expect(() =>
      reviseOutcome(agent, { outcomeId: 'o1', outcome: O, thread: TH, fields: f }),
    ).toThrow(/Nobody asked/);
    expect(() =>
      reviseOutcome(other, {
        outcomeId: 'o1',
        outcome: { ...O, proposedBy: 'agentB' },
        thread: PENDING,
        fields: f,
      }),
    ).toThrow(/Nobody asked/);
  });
});

describe('staleReason', () => {
  const thread = { lastMessageAt: at(NOW - 3_600_000) };
  const fresh = { state: 'proposed' as const, fields: { text: 'x' }, createdAt: at(NOW - 60_000) };
  it('current: written after the last message, less than 24 h ago, slot ahead', () => {
    expect(staleReason(fresh, thread, NOW)).toBeNull();
    expect(
      staleReason({ ...fresh, fields: { start: '2026-10-30T10:00:00Z' } }, thread, NOW),
    ).toBeNull();
  });
  it('slot passed, newer message, older than 24 h (in that order)', () => {
    expect(
      staleReason({ ...fresh, fields: { start: '2026-10-29T11:00:00Z' } }, thread, NOW),
    ).toBe('slot');
    expect(staleReason(fresh, { lastMessageAt: at(NOW - 1000) }, NOW)).toBe('message');
    const old = { ...fresh, createdAt: at(NOW - STALE_AFTER_MS - 1) };
    expect(staleReason(old, { lastMessageAt: at(NOW - STALE_AFTER_MS - 5000) }, NOW)).toBe('old');
    expect(staleText('old', old, NOW)).toBe('1 day old');
    expect(staleText('old', { ...old, createdAt: at(NOW - 2.5 * 86_400_000) }, NOW)).toBe(
      '2 days old',
    );
    expect(staleText('slot', old, NOW)).toMatch(/slot has passed/);
    expect(staleText('message', old, NOW)).toMatch(/newer message/);
  });
  it('a "still good" or a new version makes it fresh again; decided outcomes never flag', () => {
    const old = { ...fresh, createdAt: at(NOW - 3 * 86_400_000) };
    expect(staleReason({ ...old, checkedAt: at(NOW - 1000) }, thread, NOW)).toBeNull();
    expect(
      staleReason({ ...old, versions: [1, 2], updatedAt: at(NOW - 1000) }, thread, NOW),
    ).toBeNull();
    // A Cancel of an ask (updatedAt bumped, one version) does not count.
    expect(staleReason({ ...old, updatedAt: at(NOW - 1000) }, thread, NOW)).toBe('message');
    expect(staleReason({ ...old, state: 'done' }, thread, NOW)).toBeNull();
    expect(
      freshAt({ ...old, state: 'approved', decision: { at: at(NOW - 10) } }),
    ).toBe(NOW - 10);
  });
});
