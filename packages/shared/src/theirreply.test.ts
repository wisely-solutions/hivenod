import { describe, expect, it } from 'vitest';
import { cleanOutcomeFields } from './outcomes';
import { planThreadState, planView } from './plans';
import { addWorkingDays, remindAfterDays, theirReplyView, type ExtStateOf } from './theirreply';
import { threadAsk } from './threadask';

const ts = (ms: number) => ({ toMillis: () => ms });
const MON = Date.parse('2026-11-02T10:00:00Z');
const DAY = 86_400_000;
const F = { who: 'Ana', org: 'Acme', channel: 'mail', address: 'ana@example.com', need: 'Her OK' };
const ext = (
  state: 'proposed' | 'approved' | 'sent',
  over: Partial<ExtStateOf> = {},
): ExtStateOf => ({
  ask: { n: 1, kind: 'ask', text: 'Hi Ana', state, by: 'a' },
  outAt: state === 'sent' ? ts(MON) : null,
  sent: state === 'sent' ? 1 : 0,
  reply: null,
  ...over,
});

describe('their reply', () => {
  it('fields: who, channel, address and need are required; remind days are 1-30', () => {
    expect(() => cleanOutcomeFields('their_reply', { who: 'Ana' })).toThrow(/needs channel/);
    expect(cleanOutcomeFields('their_reply', { ...F, remindAfterDays: '5' })).toMatchObject({
      remindAfterDays: '5',
    });
    for (const bad of ['0', '31', 'x', '2.5'])
      expect(() => cleanOutcomeFields('their_reply', { ...F, remindAfterDays: bad })).toThrow(
        /remindAfterDays/,
      );
    expect(remindAfterDays({})).toBe(3);
    expect(remindAfterDays({ remindAfterDays: '10' })).toBe(10);
  });
  it('working days skip the weekend', () => {
    const fri = Date.parse('2026-11-06T10:00:00Z');
    expect(new Date(addWorkingDays(fri, 1)).getUTCDay()).toBe(1);
    expect(addWorkingDays(MON, 3)).toBe(MON + 3 * DAY);
    expect(addWorkingDays(fri, 3)).toBe(fri + 5 * DAY);
  });
  it('the view: approve, sending, waiting on them with days and the reminder, the quote', () => {
    const o = (state: string, e: ExtStateOf | null) => ({
      type: 'their_reply',
      state,
      fields: F,
      ext: e,
    });
    expect(theirReplyView(o('approved', null), MON)).toMatchObject({ phase: 'ready', pill: null });
    expect(theirReplyView(o('running', ext('proposed')), MON)).toMatchObject({ phase: 'approve' });
    expect(theirReplyView(o('running', ext('approved')), MON)).toMatchObject({ phase: 'sending' });
    const w = theirReplyView(
      o('running', ext('sent', { reply: { messageDocId: 'im1', quote: 'Maybe' } })),
      MON + 2 * DAY + 5,
    )!;
    expect(w).toMatchObject({
      phase: 'waiting',
      days: 2,
      pill: 'waiting on Ana · 2 d',
      quote: 'Maybe',
    });
    expect(w.remindAtMs).toBe(MON + 3 * DAY);
    expect(theirReplyView({ type: 'reply', state: 'done', fields: {} }, MON)).toBeNull();
  });
  it('the plan: a draft waits for you, an approved one on the agent, a sent one on them', () => {
    const plan = { steps: ['o1', 'o2'], cursor: 0, state: 'active' as const };
    const at = (e: ExtStateOf) => ({
      o1: { type: 'their_reply', state: 'running' as const, fields: F, ext: e },
      o2: { type: 'reply', state: 'approved' as const, fields: { text: 'x' } },
    });
    expect(planThreadState(plan, at(ext('proposed')))).toEqual({
      state: 'yourCall',
      waiting: null,
    });
    expect(planThreadState(plan, at(ext('approved')))).toEqual({
      state: 'waiting',
      waiting: { on: 'agent', until: null },
    });
    expect(planThreadState(plan, at(ext('sent')))).toEqual({
      state: 'waiting',
      waiting: { on: 'them', until: null },
    });
    expect(planView(plan, at(ext('proposed'))).waitingForYou?.outcomeId).toBe('o1');
    expect(planView(plan, at(ext('sent'))).steps[0]!.ui).toBe('running');
  });
  it('the ask: each drafted message is a new step ask', () => {
    const base = {
      thread: { state: 'yourCall', question: null },
      plan: { id: 'p1', plan: { steps: ['o1', 'o2'], cursor: 0, state: 'active' as const } },
    };
    const a = threadAsk({
      ...base,
      open: [
        {
          id: 'o1',
          type: 'their_reply',
          state: 'running',
          planId: 'p1',
          createdAtMs: 1,
          ext: { n: 2, kind: 'follow_up' },
        },
      ],
    });
    expect(a).toMatchObject({
      kind: 'step',
      key: 's:p1:o1:2',
      gate: false,
      ext: { n: 2, kind: 'follow_up' },
    });
  });
});
