import { planView, type PlanView } from '@hive/shared';
import { describe, expect, it } from 'vitest';
import {
  bulletDiff,
  quietFor,
  everythingHint,
  threadImages,
  excerpt,
  freshness,
  looseSummarySchema,
  parseVisual,
  planFoldParts,
  safeHttps,
  summaryLine,
  topState,
  type TopInput,
} from './decision';

const ts = (ms: number) => ({
  seconds: ms / 1000,
  nanoseconds: 0,
  toMillis: () => ms,
  toDate: () => new Date(ms),
});
const NOW = Date.UTC(2026, 9, 29, 14, 30);
const MIN = 60_000;

function plan(states: string[], cursor: number, state = 'active', types?: string[]): PlanView {
  const steps = states.map((_, i) => `o${i}`);
  const outcomes = Object.fromEntries(
    states.map((s, i) => [
      `o${i}`,
      {
        type: types?.[i] ?? (s === 'gate' ? 'approval' : 'reply'),
        state: s === 'gate' ? 'proposed' : s,
      },
    ]),
  );
  return planView(
    { memberUid: 'm', threadId: 't', steps, cursor, state } as never,
    outcomes as never,
  );
}

const base = (over: Partial<TopInput> = {}): TopInput => ({
  thread: { state: 'needsYou', question: null, waiting: null, updatedAt: NOW - 5 * MIN },
  plan: null,
  proposals: 0,
  agent: 'Hive',
  ...over,
});

describe('topState', () => {
  it('a gate at the cursor waits for the member: step k of N and its label', () => {
    const view = plan(['done', 'done', 'done', 'gate', 'approved', 'gate'], 3);
    const s = topState(
      base({
        plan: {
          view,
          main: { kind: 'step', index: 3, outcomeId: 'o3', gate: true },
          label: 'Ship it?',
          error: null,
        },
      }),
    );
    expect(s.kind).toBe('person');
    expect(s.tone).toBe('gate');
    expect(s.kicker).toBe('Your approval · step 4 of 6 · Ship it?');
  });
  it('a proposed plan asks for the whole plan', () => {
    const view = plan(['proposed', 'proposed'], 0, 'proposed');
    const s = topState(
      base({ plan: { view, main: { kind: 'approvePlan' }, label: null, error: null } }),
    );
    expect(s.kicker).toBe('Your approval · plan of 2 steps');
  });
  it('a single proposal', () => {
    expect(topState(base({ proposals: 1 })).kicker).toBe('Your approval');
    expect(topState(base({ proposals: 3 })).kicker).toBe('Your approval · 3 proposals');
  });
  it('a question', () => {
    const s = topState(
      base({
        thread: {
          state: 'needsYou',
          question: { text: 'Which room?', answer: null },
          waiting: null,
          updatedAt: NOW,
        },
      }),
    );
    expect(s).toMatchObject({ kind: 'question', kicker: 'Hive asks', tone: 'gate' });
  });
  it('a blocked plan says where and why, before anything else', () => {
    const view = plan(['done', 'failed', 'proposed'], 1, 'blocked');
    const s = topState(
      base({
        proposals: 1,
        plan: {
          view,
          main: { kind: 'retry', index: 1 },
          label: null,
          error: 'The live check failed: Today shows no top line',
        },
      }),
    );
    expect(s.kind).toBe('blocked');
    expect(s.tone).toBe('sendback');
    expect(s.kicker).toBe('Blocked at step 2: The live check failed: Today shows no top line');
  });
  it('the agent at work: a running step, or investigating', () => {
    const view = plan(['done', 'running', 'gate'], 1);
    expect(topState(base({ plan: { view, main: null, label: null, error: null } }))).toMatchObject({
      kind: 'working',
      tone: 'agent',
      kicker: 'Hive is working · step 2 of 3',
    });
    expect(
      topState(
        base({ thread: { state: 'investigating', question: null, waiting: null, updatedAt: NOW } }),
      ).kicker,
    ).toBe('Hive is working on it');
  });
  it('waiting, done and ignored', () => {
    expect(
      topState(
        base({
          thread: {
            state: 'waiting',
            question: null,
            waiting: { on: 'them', until: null },
            updatedAt: NOW,
          },
        }),
      ),
    ).toMatchObject({ kind: 'waiting', kicker: 'Waiting on them', tone: 'neutral' });
    const done = topState(
      base({
        thread: {
          state: 'done',
          question: null,
          waiting: null,
          updatedAt: Date.UTC(2026, 9, 29, 9),
        },
      }),
    );
    expect(done).toMatchObject({ kind: 'done', tone: 'approve' });
    expect(done.kicker).toMatch(/^Done · 29 Oct$/);
    const pv = plan(['done', 'done'], 2, 'done');
    expect(topState(base({ plan: { view: pv, main: null, label: null, error: null } })).kind).toBe(
      'done',
    );
    expect(
      topState(
        base({ thread: { state: 'ignored', question: null, waiting: null, updatedAt: NOW } }),
      ).kicker,
    ).toBe('Ignored');
  });
  it('nothing to decide: the thread state', () => {
    expect(
      topState(
        base({ thread: { state: 'yourCall', question: null, waiting: null, updatedAt: NOW } }),
      ),
    ).toMatchObject({
      kind: 'idle',
      kicker: 'Your call',
    });
  });
});

describe('freshness', () => {
  const agent = { name: 'Hive', online: true, lastSeen: NOW, cliVersion: '0.2.200' };
  it('fresh: when it was written and the version', () => {
    const f = freshness({
      summary: { version: 7, at: NOW - 3 * MIN },
      updatedAt: NOW - 3 * MIN,
      now: NOW,
      agent,
    });
    expect(f).toMatchObject({
      kind: 'fresh',
      updated: 'updated 3 min ago',
      version: 'v7',
      stale: null,
      why: null,
    });
  });
  it('stale: changed since, and why when the agent cannot write it', () => {
    const at = new Date(2026, 9, 29, 14, 2).getTime();
    const f = freshness({
      summary: { version: 2, at: at - 10 * MIN },
      updatedAt: at,
      now: at + 20 * MIN,
      agent: { ...agent, online: false, lastSeen: new Date(2026, 9, 29, 13, 40).getTime() },
    });
    expect(f.kind).toBe('stale');
    expect(f.stale).toBe('May be out of date: changed since 14:02');
    expect(f.why).toBe('Hive is offline since 13:40');
  });
  it('an old CLI comes first; never seen says so', () => {
    const f = freshness({
      summary: null,
      updatedAt: NOW,
      now: NOW,
      agent: { ...agent, cliVersion: '0.2.188' },
    });
    expect(f.kind).toBe('none');
    expect(f.why).toBe("Hive's CLI 0.2.188 can't write summaries: update to 0.2.191 or later");
    expect(
      freshness({
        summary: null,
        updatedAt: NOW,
        now: NOW,
        agent: { ...agent, online: false, lastSeen: null },
      }).why,
    ).toBe('Hive has not been online yet');
  });
  it('a day before: the day too', () => {
    const at = new Date(2026, 9, 27, 9, 5).getTime();
    const f = freshness({ summary: { version: 1, at: at - MIN }, updatedAt: at, now: NOW, agent });
    expect(f.stale).toBe('May be out of date: changed since Tue 27 Oct, 09:05');
  });
});

describe('parseVisual and the loose schema', () => {
  const bar = {
    kind: 'bar',
    title: 'Check time',
    caption: 'Fastest of six',
    unit: 'min',
    x: ['170', '171'],
    series: [{ name: 'Minutes', values: [12, 10.8] }],
    highlight: 1,
    better: 'down',
  };
  it('a known kind parses; an unknown or broken one is "not shown" with its kind', () => {
    expect(parseVisual(bar)).toMatchObject({ ok: true, visual: { kind: 'bar' } });
    expect(parseVisual({ kind: 'image', title: 'x', caption: 'y', attachment: 'a1' })).toEqual({
      ok: true,
      visual: { kind: 'image', title: 'x', caption: 'y', attachment: 'a1' },
    });
    expect(parseVisual({ kind: 'video', title: 'x', caption: 'y' })).toEqual({
      ok: false,
      kind: 'video',
    });
    expect(parseVisual({ ...bar, x: ['only one'] })).toEqual({ ok: false, kind: 'bar' });
    expect(parseVisual('nope')).toEqual({ ok: false, kind: 'unknown' });
  });
  it('one bad visual does not hide the summary', () => {
    const doc = {
      memberUid: 'm',
      threadId: 't',
      version: 1,
      by: 'a',
      at: ts(NOW),
      headline: 'H',
      ask: null,
      answer: null,
      recommendation: null,
      confidence: null,
      bullets: [{ text: 'b', refs: [] }],
      details: null,
      visuals: [bar, { kind: 'mermaid', src: 'graph' }],
      noVisualWhy: null,
      refs: [],
      basis: { lastEventId: null, planCursor: null },
      lastEventId: 'e',
    };
    const r = looseSummarySchema.safeParse(doc);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.visuals.map((v) => v.ok)).toEqual([true, false]);
  });
});

describe('safeHttps', () => {
  it('only https links are followed', () => {
    expect(safeHttps('https://github.com/x/y/pull/86')).toBe('https://github.com/x/y/pull/86');
    expect(safeHttps('http://example.com')).toBeNull();
    expect(safeHttps('javascript:alert(1)')).toBeNull();
    expect(safeHttps(' https://a.b')).toBeNull();
    expect(safeHttps(null)).toBeNull();
  });
});

describe('bulletDiff', () => {
  it('an older version against the current one', () => {
    expect(bulletDiff(['a', 'b'], ['a', 'c'])).toEqual([
      { text: 'a', change: 'same' },
      { text: 'b', change: 'removed' },
      { text: 'c', change: 'added' },
    ]);
  });
});

describe('fold hints', () => {
  it('plan: done · you · next', () => {
    const view = plan(['done', 'done', 'done', 'gate', 'approved', 'gate'], 3);
    expect(planFoldParts(view).map((p) => p.text)).toEqual(['3 done', 'you', '2 next']);
    const blocked = plan(['done', 'failed', 'proposed'], 1, 'blocked');
    expect(planFoldParts(blocked).map((p) => p.text)).toEqual(['1 done', 'blocked', '1 next']);
  });
  it('everything: counts, singular and plural', () => {
    expect(everythingHint({ messages: 1, notes: 2, outcomes: 0, links: 3 })).toBe(
      '1 message · 2 notes · 3 links · log',
    );
  });
  it('excerpt cuts at a word', () => {
    expect(excerpt('Hello there big world', 12)).toBe('Hello there…');
    expect(excerpt('  short  ', 12)).toBe('short');
  });
});

describe('summaryLine (slice 3)', () => {
  const sum = {
    version: 2,
    at: { toMillis: () => 1 },
    headline: 'Sam asks to move the review',
    ask: 'Reply that Thursday works?',
    answer: null,
    recAction: 'Approve',
    confidence: 'high' as const,
  };
  it('the ask while something waits, else the headline; none without a summary', () => {
    expect(summaryLine({ state: 'yourCall', summary: sum as never })).toBe(
      'Reply that Thursday works?',
    );
    expect(summaryLine({ state: 'investigating', summary: sum as never })).toBe(
      'Sam asks to move the review',
    );
    expect(summaryLine({ state: 'needsYou', summary: { ...sum, ask: null } as never })).toBe(
      'Sam asks to move the review',
    );
    expect(summaryLine({ state: 'yourCall' })).toBeNull();
  });
});

describe('threadImages (slice 4)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const row = (id: string, over: Record<string, unknown> = {}) =>
    ({
      id,
      data: { kind: 'image', threadId: 't1', name: `${id}.png`, content: PNG, ...over },
    }) as never;
  it('keeps only PNG/JPEG/WebP images of this thread', () => {
    const m = threadImages(
      [
        row('t1_a'),
        row('t1_svg', { content: 'data:image/svg+xml;base64,PHN2Zz4=' }),
        row('t1_html', { kind: 'html', content: '<b>x</b>' }),
        row('t2_b', { threadId: 't2' }),
        row('t1_c', { threadId: 't2' }),
        row('t1_url', { content: 'https://example.com/a.png' }),
      ],
      't1',
    );
    expect([...m.keys()]).toEqual(['t1_a']);
    expect(m.get('t1_a')).toEqual({ name: 't1_a.png', src: PNG });
  });
  it('Everything counts files', () => {
    expect(everythingHint({ messages: 1, notes: 0, outcomes: 0, links: 0, files: 2 })).toBe(
      '1 message · 2 files · log',
    );
  });
});

describe('quietFor (slice 6b)', () => {
  it('is null under an hour, then hours, then days', () => {
    const now = 10 * 86_400_000;
    expect(quietFor(now - 59 * 60_000, now)).toBeNull();
    expect(quietFor(now - 60 * 60_000, now)).toBe('1 h');
    expect(quietFor(now - 5 * 3_600_000, now)).toBe('5 h');
    expect(quietFor(now - 50 * 3_600_000, now)).toBe('2 d');
  });
});
