/**
 * Inbox data for the Today/decision redesign (item kt3E7u9EliL3q2veDDI0): an outcome's
 * confidence and checks, a thread's due date (thread_due), answer chips on a question, and the
 * registry's batchable (tidy-up) flag.
 */
import { describe, expect, it } from 'vitest';
import type { ActionContext } from './actions';
import { askMember, dueThread, proposeOutcome, type ThreadStateOf } from './inbox';
import { OUTCOMES, type OutcomeType } from './outcomes';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Agent' },
  newId: () => 'e1',
};
const joao: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'human', id: 'joao', name: 'João' },
  newId: () => 'e2',
};
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'investigating',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const reply = { threadId: 't1', thread: TH, type: 'reply', fields: { text: 'Thursday works.' } };

describe('outcome confidence and checks', () => {
  it('stores them when given, trimmed', () => {
    const p = proposeOutcome(agent, {
      ...reply,
      confidence: 'high',
      checks: ['  Your calendar: Thu 10:00-11:00 free ', 'Asked Rita by mail: either works'],
    });
    expect(p.ops[0]!.data).toMatchObject({
      confidence: 'high',
      checks: ['Your calendar: Thu 10:00-11:00 free', 'Asked Rita by mail: either works'],
    });
  });
  it('leaves them out when absent or empty (old shape)', () => {
    for (const extra of [{}, { confidence: null, checks: [] }, { checks: null }]) {
      const data = proposeOutcome(agent, { ...reply, ...extra }).ops[0]!.data;
      expect(data).not.toHaveProperty('confidence');
      expect(data).not.toHaveProperty('checks');
    }
  });
  it('refuses a bad confidence, 7 checks, an empty or long check', () => {
    expect(() => proposeOutcome(agent, { ...reply, confidence: 'sure' })).toThrow(
      /high, medium or low/,
    );
    expect(() => proposeOutcome(agent, { ...reply, checks: Array(7).fill('x') })).toThrow(
      /At most 6 checks/,
    );
    expect(() => proposeOutcome(agent, { ...reply, checks: ['  '] })).toThrow(/1-200/);
    expect(() => proposeOutcome(agent, { ...reply, checks: ['c'.repeat(201)] })).toThrow(/1-200/);
  });
});

describe('answer chips (question.options)', () => {
  const ask = { threadId: 't1', thread: TH, question: 'Thursday or Friday?' };
  it('stores up to 4 options, trimmed', () => {
    const p = askMember(agent, { ...ask, options: [' Thursday ', 'Friday'] });
    expect(p.ops[0]!.data).toMatchObject({
      question: { text: 'Thursday or Friday?', options: ['Thursday', 'Friday'], answer: null },
    });
    expect(p.ops[1]!.data).toMatchObject({ data: { options: ['Thursday', 'Friday'] } });
  });
  it('leaves options out when none are given', () => {
    const q = (askMember(agent, ask).ops[0]!.data as { question: object }).question;
    expect(q).not.toHaveProperty('options');
  });
  it('refuses 5 options and an empty or long one', () => {
    expect(() => askMember(agent, { ...ask, options: ['a', 'b', 'c', 'd', 'e'] })).toThrow(
      /At most 4 options/,
    );
    expect(() => askMember(agent, { ...ask, options: [' '] })).toThrow(/1-80/);
    expect(() => askMember(agent, { ...ask, options: ['o'.repeat(81)] })).toThrow(/1-80/);
  });
});

describe('due dates (thread_due)', () => {
  it('an agent sets a due date: a Date on the thread, ISO in the event', () => {
    const p = dueThread(agent, {
      threadId: 't1',
      thread: TH,
      due: '2026-10-30T12:00:00+01:00',
      reason: ' Sam asked for Friday noon ',
    });
    expect(p.ops[0]).toMatchObject({ path: 'workspaces/w1/inboxThreads/t1' });
    expect((p.ops[0]!.data as { due: Date }).due).toEqual(new Date('2026-10-30T11:00:00.000Z'));
    expect(p.ops[1]!.data).toMatchObject({
      type: 'thread.due',
      data: { due: '2026-10-30T11:00:00.000Z', reason: 'Sam asked for Friday noon' },
    });
  });
  it('the member clears it; nobody else may', () => {
    const p = dueThread(joao, { threadId: 't1', thread: TH, due: null });
    expect(p.ops[0]!.data).toMatchObject({ due: null });
    expect(p.ops[1]!.data).toMatchObject({ data: { due: null, reason: null } });
    const maria = { ...joao, actor: { type: 'human' as const, id: 'maria', name: 'Maria' } };
    expect(() => dueThread(maria, { threadId: 't1', thread: TH, due: null })).toThrow(
      /Only the person/,
    );
  });
  it('wants an ISO time with its offset', () => {
    for (const due of ['Friday', '2026-10-30T12:00:00'])
      expect(() => dueThread(agent, { threadId: 't1', thread: TH, due })).toThrow(/ISO 8601/);
  });
});

describe('batchable (tidy-up) outcome types', () => {
  it('are exactly no_reply, ignore and snooze, and none of them sends', () => {
    const all = Object.entries(OUTCOMES as Record<string, OutcomeType>);
    const batch = all.filter(([, t]) => t.batchable).map(([k]) => k);
    expect(batch.sort()).toEqual(['ignore', 'no_reply', 'snooze']);
    for (const [, t] of all) if (t.batchable) expect(t.executor).toBe('none');
  });
});
