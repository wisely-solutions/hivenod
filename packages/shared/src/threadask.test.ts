import { describe, expect, it } from 'vitest';
import {
  askApproves,
  askFallback,
  decisionLines,
  notNowHides,
  notNowUntil,
  threadAsk,
  type AskInput,
} from './threadask';

const base = (over: Partial<AskInput> = {}): AskInput => ({
  thread: { state: 'yourCall', question: null },
  plan: null,
  open: [],
  ...over,
});
const out = (id: string, type: string, extra: Partial<AskInput['open'][number]> = {}) => ({
  id,
  type,
  state: 'proposed',
  planId: null,
  createdAtMs: 100,
  ...extra,
});

describe('threadAsk (slice 3)', () => {
  it('a question, with its options, keyed by its time', () => {
    const a = threadAsk(
      base({
        thread: {
          state: 'needsYou',
          question: { text: 'Thursday?', atMs: 42, answer: null, options: ['Yes', 'No'] },
        },
      }),
    );
    expect(a).toEqual({ kind: 'question', key: 'q42', text: 'Thursday?', options: ['Yes', 'No'] });
    expect(askApproves(a)).toBe(false);
  });

  it('the oldest single proposal, keyed as before slice 3', () => {
    const a = threadAsk(
      base({ open: [out('o2', 'reply', { createdAtMs: 200 }), out('o1', 'snooze')] }),
    );
    expect(a).toMatchObject({ kind: 'proposal', key: 'c100', outcomeId: 'o1', count: 2 });
    expect(askApproves(a)).toBe(true);
  });

  it('a proposed plan, then its gate at its turn, then a blocked step', () => {
    const plan = { steps: ['s1', 's2', 's3'], cursor: 0, state: 'proposed' as const };
    const open = [
      out('s1', 'reply', { planId: 'p1' }),
      out('s2', 'approval', { planId: 'p1', fields: { what: 'Ship it?' } }),
    ];
    expect(threadAsk(base({ plan: { id: 'p1', plan }, open }))).toMatchObject({
      kind: 'approvePlan',
      key: 'p:p1',
      total: 3,
    });
    const atGate = { ...plan, state: 'active' as const, cursor: 1 };
    const gate = threadAsk(base({ plan: { id: 'p1', plan: atGate }, open: [open[1]!] }));
    expect(gate).toMatchObject({
      kind: 'step',
      key: 's:p1:s2',
      gate: true,
      number: 2,
      total: 3,
      what: 'Ship it?',
    });
    expect(askFallback(gate!, 'Release')).toBe('Ship it? · step 2 of 3');
    const blocked = { ...plan, state: 'blocked' as const, cursor: 2 };
    expect(threadAsk(base({ plan: { id: 'p1', plan: blocked }, open: [] }))).toMatchObject({
      kind: 'retry',
      key: 'r:p1:2',
    });
  });

  it('nothing while an approved step runs', () => {
    const plan = { steps: ['s1'], cursor: 0, state: 'active' as const };
    expect(threadAsk(base({ plan: { id: 'p1', plan }, open: [] }))).toBeNull();
  });
});

describe('Not now (slice 3)', () => {
  it('09:00 the next day in the member time zone', () => {
    // 23:30 in Lisbon (UTC+0 in winter) → 09:00 the next day.
    expect(
      new Date(notNowUntil(Date.UTC(2026, 11, 1, 23, 30), 'Europe/Lisbon')).toISOString(),
    ).toBe('2026-12-02T09:00:00.000Z');
    // 01:00 on 2 Dec in Tokyo is still 1 Dec UTC: the next day there is 3 Dec, 09:00 JST.
    expect(new Date(notNowUntil(Date.UTC(2026, 11, 1, 16, 0), 'Asia/Tokyo')).toISOString()).toBe(
      '2026-12-03T00:00:00.000Z',
    );
    // Over a daylight saving change (Berlin, 24 → 25 Oct 2026): 09:00 CET is 08:00 UTC.
    expect(new Date(notNowUntil(Date.UTC(2026, 9, 24, 12), 'Europe/Berlin')).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
    // An unknown zone counts as UTC.
    expect(new Date(notNowUntil(Date.UTC(2026, 0, 1, 12), 'Nowhere/Here')).toISOString()).toBe(
      '2026-01-02T09:00:00.000Z',
    );
  });

  it('hides only the same decision, only until then', () => {
    const nn = { until: { toMillis: () => 1000 }, key: 'q1' };
    expect(notNowHides(nn, { key: 'q1' }, 999)).toBe(true);
    expect(notNowHides(nn, { key: 'q1' }, 1000)).toBe(false);
    expect(notNowHides(nn, { key: 'c5' }, 10)).toBe(false);
    expect(notNowHides(null, { key: 'q1' }, 10)).toBe(false);
  });
});

describe('decisionLines (slice 3)', () => {
  const ask = threadAsk(base({ open: [out('o1', 'reply')] }))!;
  const summary = {
    headline: 'Sam asks to move the review',
    ask: 'Reply to Sam that Thursday works?',
    answer: 'Thursday is free; Sam proposed it',
    recAction: 'Approve',
    confidence: 'high',
  };
  it('a fresh summary gives the one-liner and the recommendation', () => {
    expect(
      decisionLines({
        ask,
        title: 'Review',
        subjectName: 'Payments',
        agentName: 'Hive',
        summary,
        fresh: true,
      }),
    ).toEqual({
      line: 'Reply to Sam that Thursday works?',
      detail: 'Hive recommends Approve · confidence high',
    });
  });
  it('an old summary is not used; long lines are cut at 90', () => {
    expect(
      decisionLines({
        ask,
        title: 'Review',
        subjectName: 'Payments',
        agentName: 'Hive',
        summary,
        fresh: false,
      }),
    ).toEqual({ line: 'Reply', detail: 'Payments · Review' });
    const long = decisionLines({
      ask,
      title: '',
      subjectName: '',
      agentName: 'Hive',
      summary: { ...summary, ask: 'x'.repeat(200), recAction: null, confidence: null },
      fresh: true,
    });
    expect(long.line).toHaveLength(90);
    expect(long.detail).toBe('Thursday is free; Sam proposed it');
  });
});
