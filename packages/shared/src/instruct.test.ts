/**
 * Ask the agent (item w6O2KOw4ys70TQv9I1xD): the member asks the home agent on any thread (text
 * or a chip); the agent answers once; it suggests chips; the browser picks the chips that fit.
 */
import { describe, expect, it } from 'vitest';
import { DELETE_FIELD, SERVER_TIME, type ActionContext } from './actions';
import { contextChips, FOLLOW_UP_AFTER_MS } from './chips';
import {
  answerInstruction,
  instructPending,
  instructThread,
  suggestChips,
  INSTRUCT_RETRY_MS,
  type ThreadStateOf,
} from './inbox';

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
  state: 'waiting',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const PENDING: ThreadStateOf = {
  ...TH,
  instructions: { i1: { state: 'pending', at: at(NOW) } },
  instruct: { state: 'pending', id: 'i1', at: at(NOW) },
};

describe('instructThread', () => {
  it('keeps the request on the thread, pending, and one event with it', () => {
    const p = instructThread(joao, {
      threadId: 't1',
      thread: TH,
      text: '  Prepare me  ',
      nowMs: NOW,
    });
    expect(p.instructionId).toBe('e2');
    expect(p.ops).toHaveLength(2);
    expect(p.ops[0]).toMatchObject({
      kind: 'update',
      path: 'workspaces/w1/inboxThreads/t1',
      data: {
        'instructions.e2': {
          text: 'Prepare me',
          chip: null,
          by: 'joao',
          at: SERVER_TIME,
          state: 'pending',
          answer: null,
        },
        instruct: { state: 'pending', id: 'e2', at: SERVER_TIME },
      },
    });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'thread.instructed',
      threadId: 't1',
      data: { text: 'Prepare me', chip: null },
    });
  });
  it('a chip instead of text; any thread state', () => {
    const p = instructThread(joao, {
      threadId: 't1',
      thread: { ...TH, state: 'closed' },
      chip: 'prepare_meeting',
    });
    expect(p.ops[0]!.data['instructions.e2']).toMatchObject({
      text: null,
      chip: 'prepare_meeting',
    });
  });
  it('refuses: not the member, an agent, both or neither, a bad chip, recheck, too long', () => {
    const go = (ctx: ActionContext, extra: Record<string, unknown>) =>
      instructThread(ctx, { threadId: 't1', thread: TH, nowMs: NOW, ...extra });
    expect(() => go(agent, { text: 'x' })).toThrow();
    expect(() => go({ ...joao, actor: { ...joao.actor, id: 'bob' } }, { text: 'x' })).toThrow();
    expect(() => go(joao, {})).toThrow(/text or a chip/);
    expect(() => go(joao, { text: 'x', chip: 'summarize' })).toThrow(/text or a chip/);
    expect(() => go(joao, { chip: 'dance' })).toThrow(/chip is/);
    expect(() => go(joao, { chip: 'recheck' })).toThrow(/chip is/);
    expect(() => go(joao, { text: 'x'.repeat(501) })).toThrow(/500/);
    expect(() => go(joao, { text: 'x'.repeat(500) })).not.toThrow();
  });
  it('one at a time: again once answered, or after 30 minutes', () => {
    expect(instructPending(PENDING, NOW + 1000)).toBe(true);
    expect(() =>
      instructThread(joao, { threadId: 't1', thread: PENDING, text: 'x', nowMs: NOW + 1000 }),
    ).toThrow(/still on/);
    expect(instructPending(PENDING, NOW + INSTRUCT_RETRY_MS)).toBe(false);
    expect(() =>
      instructThread(joao, {
        threadId: 't1',
        thread: PENDING,
        text: 'x',
        nowMs: NOW + INSTRUCT_RETRY_MS,
      }),
    ).not.toThrow();
    const done = { ...PENDING, instruct: { state: 'done' as const, id: 'i1', at: at(NOW) } };
    expect(instructPending(done, NOW)).toBe(false);
  });
  it('at most 20 kept: the oldest answered one goes', () => {
    const instructions: NonNullable<ThreadStateOf['instructions']> = {};
    for (let i = 0; i < 20; i++)
      instructions[`i${String(i).padStart(2, '0')}`] = {
        state: i === 0 ? 'pending' : 'answered',
        at: at(NOW - (20 - i) * 60_000 - INSTRUCT_RETRY_MS),
      };
    const p = instructThread(joao, { threadId: 't1', thread: { ...TH, instructions }, text: 'x' });
    expect(p.ops[0]!.data['instructions.i01']).toBe(DELETE_FIELD);
    expect(p.ops[0]!.data['instructions.i00']).toBeUndefined();
  });
});

describe('answerInstruction', () => {
  it('the home agent answers once: the instruction and the latest request are done', () => {
    const p = answerInstruction(agent, {
      threadId: 't1',
      thread: PENDING,
      instructionId: 'i1',
      kind: 'outcome',
      refId: 'o9',
      note: 'A follow-up to approve.',
    });
    expect(p.ops[0]!.data).toMatchObject({
      'instructions.i1.state': 'answered',
      'instructions.i1.answer': {
        kind: 'outcome',
        refId: 'o9',
        note: 'A follow-up to approve.',
        at: SERVER_TIME,
      },
      'instruct.state': 'done',
    });
    expect(p.ops[1]!.data).toMatchObject({
      type: 'thread.instruction_answered',
      data: { instructionId: 'i1', kind: 'outcome', refId: 'o9' },
    });
  });
  it('an older instruction leaves the latest request as it is', () => {
    const th: ThreadStateOf = {
      ...PENDING,
      instructions: { ...PENDING.instructions, i0: { state: 'pending', at: at(NOW - 1) } },
    };
    const p = answerInstruction(agent, {
      threadId: 't1',
      thread: th,
      instructionId: 'i0',
      kind: 'ask',
    });
    expect(p.ops[0]!.data['instruct.state']).toBeUndefined();
  });
  it('refuses: another agent, the member, unknown, answered, bad kind, refs', () => {
    const go = (ctx: ActionContext, extra: Record<string, unknown>, thread = PENDING) =>
      answerInstruction(ctx, {
        threadId: 't1',
        thread,
        instructionId: 'i1',
        kind: 'note',
        note: 'Done.',
        ...extra,
      });
    expect(() => go(other, {})).toThrow(/home agent/);
    expect(() => go(joao, {})).toThrow();
    expect(() => go(agent, { instructionId: 'zz' })).toThrow(/no request/);
    expect(() =>
      go(agent, {}, { ...PENDING, instructions: { i1: { state: 'answered', at: at(NOW) } } }),
    ).toThrow(/answered already/);
    expect(() => go(agent, { kind: 'shrug' })).toThrow(/kind is/);
    expect(() => go(agent, { note: null })).toThrow(/note/);
    expect(() => go(agent, { kind: 'outcome' })).toThrow(/refId/);
    expect(() => go(agent, { kind: 'ask', refId: 'x' })).toThrow(/refId/);
    expect(() => go(agent, { note: 'x'.repeat(501) })).toThrow(/500/);
  });
});

describe('suggestChips', () => {
  it('the home agent sets 0-5 known chips, once each', () => {
    const p = suggestChips(agent, { threadId: 't1', thread: TH, chips: ['summarize', 'recheck'] });
    expect(p.ops[0]!.data).toMatchObject({ suggestedChips: ['summarize', 'recheck'] });
    expect(p.ops[1]!.data).toMatchObject({ type: 'thread.chips_suggested' });
    expect(() => suggestChips(other, { threadId: 't1', thread: TH, chips: [] })).toThrow();
    expect(() => suggestChips(agent, { threadId: 't1', thread: TH, chips: ['x'] })).toThrow();
    expect(() =>
      suggestChips(agent, { threadId: 't1', thread: TH, chips: ['summarize', 'summarize'] }),
    ).toThrow(/once/);
    expect(
      suggestChips(agent, { threadId: 't1', thread: TH, chips: [] }).ops[0]!.data,
    ).toMatchObject({ suggestedChips: [] });
  });
});

describe('contextChips', () => {
  const base = {
    thread: { state: 'yourCall' as const, lastMessageAt: at(NOW - 3_600_000) },
    outcomes: [],
    canRecheck: true,
    nowMs: NOW,
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  it('nothing fits: none', () => {
    expect(contextChips(base)).toEqual([]);
  });
  it('a meeting booked in the next 7 days → Prepare; not past, not later', () => {
    const book = (start: number, state = 'approved') => ({
      type: 'reply_book',
      state: state as 'approved',
      fields: { start: iso(start), end: iso(start + 1) },
    });
    expect(contextChips({ ...base, outcomes: [book(NOW + 86_400_000)] })).toEqual([
      'prepare_meeting',
    ]);
    expect(contextChips({ ...base, outcomes: [book(NOW + 86_400_000, 'done')] })).toEqual([
      'prepare_meeting',
    ]);
    expect(contextChips({ ...base, outcomes: [book(NOW - 1000)] })).toEqual([]);
    expect(contextChips({ ...base, outcomes: [book(NOW + 8 * 86_400_000)] })).toEqual([]);
    expect(contextChips({ ...base, outcomes: [book(NOW + 1000, 'proposed')] })).not.toContain(
      'prepare_meeting',
    );
  });
  it('a stale proposal → Re-check, only where it may be asked', () => {
    const o = {
      type: 'reply',
      state: 'proposed' as const,
      fields: { text: 'x' },
      createdAt: at(NOW - 2 * 86_400_000),
    };
    expect(contextChips({ ...base, outcomes: [o] })).toEqual(['recheck']);
    expect(contextChips({ ...base, outcomes: [o], canRecheck: false })).toEqual([]);
    expect(contextChips({ ...base, staleStep: true })).toEqual(['recheck']);
  });
  it('waiting on them 3 days → Follow up', () => {
    const thread = {
      state: 'waiting' as const,
      waiting: { on: 'them' },
      lastMessageAt: at(NOW - FOLLOW_UP_AFTER_MS),
    };
    expect(contextChips({ ...base, thread })).toEqual(['follow_up']);
    expect(
      contextChips({ ...base, thread: { ...thread, lastMessageAt: at(NOW - 86_400_000) } }),
    ).toEqual([]);
    expect(contextChips({ ...base, thread: { ...thread, waiting: { on: 'date' } } })).toEqual([]);
  });
  it('8 messages → Summarize; the last is theirs and nothing open → Draft a reply', () => {
    const msgs = (n: number, last: 'in' | 'out') =>
      Array.from({ length: n }, (_, i) => ({ direction: i === n - 1 ? last : ('out' as const) }));
    expect(contextChips({ ...base, messages: msgs(8, 'out') })).toEqual(['summarize']);
    expect(contextChips({ ...base, messages: msgs(2, 'in') })).toEqual(['draft_reply']);
    expect(
      contextChips({
        ...base,
        messages: msgs(2, 'in'),
        outcomes: [{ type: 'reply', state: 'proposed', fields: {}, createdAt: at(NOW) }],
      }),
    ).toEqual([]);
    expect(contextChips({ ...base, messages: msgs(2, 'in'), livePlan: true })).toEqual([]);
  });
  it("the agent's suggestions first, at most 3, unknown ones dropped", () => {
    const thread = {
      ...base.thread,
      suggestedChips: ['follow_up', 'nope', 'recheck'],
    };
    const msgs = Array.from({ length: 9 }, () => ({ direction: 'in' as const }));
    expect(contextChips({ ...base, thread, messages: msgs })).toEqual([
      'follow_up',
      'recheck',
      'summarize',
    ]);
    expect(contextChips({ ...base, thread, messages: msgs, canRecheck: false })).toEqual([
      'follow_up',
      'summarize',
      'draft_reply',
    ]);
  });
});
