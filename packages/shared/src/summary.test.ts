/**
 * Thread summaries (item OE8FmrTaIxFVGcaeGG3N): checkSummary's shapes and plain errors, the
 * visual rule at person steps, writeSummary's batch (version, mirror, kept versions) and the
 * freshness helpers.
 */
import { describe, expect, it } from 'vitest';
import { ActionError, SERVER_TIME, type ActionContext } from './actions';
import type { ThreadStateOf } from './inbox';
import {
  checkSummary,
  summarizeDue,
  summaryFreshness,
  summaryRulesBlock,
  visualSchema,
  writeSummary,
  SUMMARIZE_AFTER_MS,
} from './summary';

const agent: ActionContext = {
  workspaceId: 'w1',
  actor: { type: 'agent', id: 'agentA', name: 'Hive' },
  newId: () => 'e1',
};
const other: ActionContext = { ...agent, actor: { type: 'agent', id: 'agentB', name: 'Bee' } };
const joao: ActionContext = { ...agent, actor: { type: 'human', id: 'joao', name: 'João' } };
const TH: ThreadStateOf = {
  memberUid: 'joao',
  subjectId: 's1',
  state: 'yourCall',
  fetchedBy: 'agentA',
  refs: ['r1'],
};
const BASE = { headline: 'Release 175: ship it?', bullets: ['All checks green'] };
const err = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof ActionError) return e.message;
    throw e;
  }
  return null;
};
const bar = (over: Record<string, unknown> = {}) => ({
  kind: 'bar',
  title: 'Check time',
  caption: 'Down from 14 to 10 minutes',
  x: ['r173', 'r174', 'r175'],
  series: [{ name: 'minutes', values: [14, 12, 10] }],
  ...over,
});

describe('checkSummary', () => {
  it('trims, fills every key, and takes bullets as texts or objects', () => {
    const s = checkSummary({
      headline: '  Release 175  ',
      ask: ' Ship it? ',
      answer: 'Everything passed',
      recommendation: { action: 'Approve', why: 'Green and small' },
      confidence: 'high',
      bullets: [
        '  2 changes ',
        { text: 'No migration', refs: [{ kind: 'step', id: 'o3', label: 'Build' }] },
      ],
      details: '  ## What changed\n- x  ',
      visuals: [bar({ unit: 'min', highlight: 2, better: 'down' })],
      refs: [{ kind: 'link', id: 'pr86', label: 'PR #86', url: 'https://github.com/x/y/pull/86' }],
    });
    expect(s).toEqual({
      headline: 'Release 175',
      ask: 'Ship it?',
      answer: 'Everything passed',
      recommendation: { action: 'Approve', why: 'Green and small' },
      confidence: 'high',
      bullets: [
        { text: '2 changes', refs: [] },
        { text: 'No migration', refs: [{ kind: 'step', id: 'o3', label: 'Build', url: null }] },
      ],
      details: '## What changed\n- x',
      visuals: [
        {
          kind: 'bar',
          title: 'Check time',
          caption: 'Down from 14 to 10 minutes',
          unit: 'min',
          x: ['r173', 'r174', 'r175'],
          series: [{ name: 'minutes', values: [14, 12, 10] }],
          highlight: 2,
          better: 'down',
        },
      ],
      noVisualWhy: null,
      refs: [{ kind: 'link', id: 'pr86', label: 'PR #86', url: 'https://github.com/x/y/pull/86' }],
    });
    for (const v of s.visuals) expect(visualSchema.parse(v)).toEqual(v);
  });

  it('every kind of slice 1 round-trips through the stored schema', () => {
    const s = checkSummary({
      ...BASE,
      visuals: [
        {
          kind: 'number',
          title: 'Tests',
          caption: '412 pass',
          value: 412,
          delta: 6,
          trend: [400, 406, 412],
          better: 'up',
        },
        {
          kind: 'flow',
          title: 'Plan',
          caption: 'Build is next',
          nodes: [
            { id: 'a', label: 'Shape', who: 'agent', state: 'done' },
            { id: 'b', label: 'Approve', who: 'person', state: 'now' },
            { id: 'c', label: 'Build' },
          ],
          edges: [
            { from: 'a', to: 'b' },
            { from: 'b', to: 'c', label: 'yes' },
          ],
        },
        {
          kind: 'before_after',
          title: 'Nav',
          caption: 'Projects goes',
          before: { lines: ['Today', 'Projects'] },
          after: { label: 'Now', lines: ['Today'] },
        },
        {
          kind: 'timeline',
          title: 'Dates',
          caption: 'Due Friday',
          events: [
            { at: '2026-10-29', label: 'Asked', state: 'done' },
            { at: '2026-10-31T17:00Z', label: 'Due', state: 'risk' },
          ],
        },
      ],
    });
    expect(s.visuals.map((v) => v.kind)).toEqual(['number', 'flow', 'before_after', 'timeline']);
    expect(s.visuals[0]).toMatchObject({ unit: null });
    expect(s.visuals[1]).toMatchObject({
      nodes: [
        { id: 'a', who: 'agent' },
        { id: 'b' },
        { id: 'c', label: 'Build', who: null, state: null },
      ],
      edges: [{ from: 'a', to: 'b', label: null }, { label: 'yes' }],
    });
    expect(s.visuals[2]).toMatchObject({ before: { label: null }, after: { label: 'Now' } });
    for (const v of s.visuals) expect(visualSchema.parse(v)).toEqual(v);
    // A flow without edges: a straight sequence.
    const f = checkSummary({
      ...BASE,
      visuals: [
        {
          kind: 'flow',
          title: 'F',
          caption: 'C',
          nodes: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B' },
          ],
        },
      ],
    });
    expect(f.visuals[0]).toMatchObject({ edges: [] });
  });

  it.each([
    [{ bullets: ['x'] }, 'headline: required'],
    [{ ...BASE, headline: 'x'.repeat(121) }, 'headline: at most 120 characters'],
    [{ ...BASE, colour: 'red' }, 'summary: unknown field "colour"'],
    [{ headline: 'H' }, 'bullets: required (1 to 5)'],
    [{ ...BASE, bullets: [] }, 'bullets: 0 bullets, at least 1'],
    [{ ...BASE, bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'bullets: 6 bullets, at most 5'],
    [{ ...BASE, bullets: ['x'.repeat(161)] }, 'bullet 1 text: at most 160 characters'],
    [{ ...BASE, bullets: [{ text: 'a', refs: [1, 2, 3, 4] }] }, 'bullet 1: 4 refs, at most 3'],
    [{ ...BASE, confidence: 'sure' }, 'confidence: one of high, medium, low'],
    [{ ...BASE, recommendation: { action: 'Approve' } }, 'recommendation why: required'],
    [{ ...BASE, details: 'x'.repeat(6001) }, 'details: at most 6000 characters'],
    [{ ...BASE, visuals: [bar(), bar(), bar(), bar(), bar()] }, 'visuals: 5 visuals, at most 4'],
    [
      { ...BASE, visuals: [{ ...bar(), kind: 'pie' }] },
      'visual 1 kind: one of bar, line, stacked_bar, number, flow, before_after, timeline',
    ],
    [
      { ...BASE, visuals: [{ ...bar(), kind: 'image' }] },
      'visual 1 kind: one of bar, line, stacked_bar, number, flow, before_after, timeline',
    ],
    [{ ...BASE, visuals: [bar({ svg: '<svg/>' })] }, 'visual 1: unknown field "svg"'],
    [
      { ...BASE, visuals: [bar({ title: '<b>Check</b>' })] },
      'visual 1 title: plain text only (no HTML)',
    ],
    [{ ...BASE, visuals: [bar({ caption: '' })] }, 'visual 1 caption: required'],
    [
      { ...BASE, visuals: [bar(), bar({ x: Array.from({ length: 25 }, (_, i) => `d${i}`) })] },
      'visual 2: 25 points, at most 24',
    ],
    [{ ...BASE, visuals: [bar({ x: ['a'] })] }, 'visual 1: 1 points, at least 2'],
    [
      { ...BASE, visuals: [bar({ x: ['a', 'x'.repeat(17), 'c'] })] },
      'visual 1 x 2: at most 16 characters',
    ],
    [{ ...BASE, visuals: [bar({ series: [] })] }, 'visual 1: 0 series, at least 1'],
    [{ ...BASE, visuals: [bar({ kind: 'stacked_bar' })] }, 'visual 1: 1 series, at least 2'],
    [
      {
        ...BASE,
        visuals: [
          bar({
            series: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })),
          }),
        ],
      },
      'visual 1: 5 series, at most 4',
    ],
    [
      { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, 2] }] })] },
      'visual 1 series 1: 2 values for 3 points',
    ],
    [
      { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, '2', 3] }] })] },
      'visual 1 series 1 value 2: a number, at most 1000000000000 either way',
    ],
    [
      { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, 2e12, 3] }] })] },
      'visual 1 series 1 value 2: a number, at most 1000000000000 either way',
    ],
    [{ ...BASE, visuals: [bar({ highlight: 3 })] }, 'visual 1 highlight: an index of x, 0 to 2'],
    [{ ...BASE, visuals: [bar({ highlight: 1.5 })] }, 'visual 1 highlight: an index of x, 0 to 2'],
    [{ ...BASE, visuals: [bar({ better: 'more' })] }, 'visual 1 better: one of up, down'],
    [
      { ...BASE, visuals: [{ kind: 'number', title: 'T', caption: 'C' }] },
      'visual 1 value: required',
    ],
    [
      { ...BASE, visuals: [{ kind: 'number', title: 'T', caption: 'C', value: 1, trend: [1] }] },
      'visual 1 trend: 1 points, at least 2',
    ],
    [
      {
        ...BASE,
        visuals: [{ kind: 'number', title: 'T', caption: 'C', value: 1, trend: [1, null] }],
      },
      'visual 1 trend 2: required',
    ],
    [
      {
        ...BASE,
        visuals: [{ kind: 'flow', title: 'F', caption: 'C', nodes: [{ id: 'a', label: 'A' }] }],
      },
      'visual 1: 1 nodes, at least 2',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'flow',
            title: 'F',
            caption: 'C',
            nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: 'N' })),
          },
        ],
      },
      'visual 1: 9 nodes, at most 8',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'flow',
            title: 'F',
            caption: 'C',
            nodes: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      },
      'visual 1 node 2 id: "a" is used twice',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'flow',
            title: 'F',
            caption: 'C',
            nodes: [
              { id: 'a', label: '<script>x</script>' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
      },
      'visual 1 node 1 label: plain text only (no HTML)',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'flow',
            title: 'F',
            caption: 'C',
            nodes: [
              { id: 'a', label: 'A', who: 'robot' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
      },
      'visual 1 node 1 who: one of agent, person, system',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'flow',
            title: 'F',
            caption: 'C',
            nodes: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
            edges: [{ from: 'a', to: 'z' }],
          },
        ],
      },
      'visual 1 edge 1 to: no node "z"',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'before_after',
            title: 'B',
            caption: 'C',
            before: { lines: [] },
            after: { lines: ['x'] },
          },
        ],
      },
      'visual 1 before: 0 lines, at least 1',
    ],
    [
      {
        ...BASE,
        visuals: [{ kind: 'before_after', title: 'B', caption: 'C', before: { lines: ['x'] } }],
      },
      'visual 1 after: an object',
    ],
    [
      {
        ...BASE,
        visuals: [
          {
            kind: 'timeline',
            title: 'T',
            caption: 'C',
            events: [
              { at: '2026-10-29', label: 'a' },
              { at: 'Friday', label: 'b' },
            ],
          },
        ],
      },
      'visual 1 event 2 at: an ISO date (2026-10-29) or date and time (2026-10-29T14:00Z)',
    ],
    [{ ...BASE, refs: [{ kind: 'link', id: 'x', label: 'X' }] }, 'ref 1 url: required for a link'],
    [
      { ...BASE, refs: [{ kind: 'link', id: 'x', label: 'X', url: 'javascript:alert(1)' }] },
      'ref 1 url: an https link',
    ],
    [
      { ...BASE, refs: [{ kind: 'file', id: 'x', label: 'X' }] },
      'ref 1 kind: one of message, attachment, step, event, link',
    ],
    [
      {
        ...BASE,
        refs: Array.from({ length: 31 }, (_, i) => ({ kind: 'event', id: `e${i}`, label: 'E' })),
      },
      'refs: 31 refs, at most 30',
    ],
    [{ ...BASE, noVisualWhy: 'x'.repeat(141) }, 'noVisualWhy: at most 140 characters'],
  ])('refuses %j: %s', (input, msg) => {
    expect(err(() => checkSummary(input))).toBe(msg);
  });

  it('at a person step: a visual or a reason', () => {
    expect(err(() => checkSummary({ ...BASE, ask: 'Ship it?' }))).toMatch(
      /^At a person step add a visual or say why there is none/,
    );
    expect(checkSummary({ ...BASE, ask: 'Ship it?', visuals: [bar()] }).ask).toBe('Ship it?');
    expect(
      checkSummary({ ...BASE, ask: 'Ship it?', noVisualWhy: 'Text-only change' }).noVisualWhy,
    ).toBe('Text-only change');
    // No ask: no visual needed.
    expect(checkSummary(BASE).visuals).toEqual([]);
  });
});

describe('writeSummary', () => {
  const input = (over: Partial<Parameters<typeof writeSummary>[1]> = {}) => ({
    threadId: 't1',
    thread: TH,
    current: null,
    baseVersion: 0,
    summary: { ...BASE, recommendation: { action: 'Approve', why: 'Green' }, confidence: 'high' },
    basis: { lastEventId: 'ev9', planCursor: 3 },
    ...over,
  });
  it('writes v1: summary, version, thread mirror, event', () => {
    const p = writeSummary(agent, input());
    expect(p.version).toBe(1);
    expect(p.ops.map((o) => [o.kind, o.path])).toEqual([
      ['set', 'workspaces/w1/inboxSummaries/t1'],
      ['set', 'workspaces/w1/inboxSummaryVersions/t1_1'],
      ['update', 'workspaces/w1/inboxThreads/t1'],
      ['set', 'workspaces/w1/inboxEvents/e1'],
    ]);
    expect(p.ops[0]!.data).toMatchObject({
      memberUid: 'joao',
      threadId: 't1',
      version: 1,
      by: 'agentA',
      at: SERVER_TIME,
      headline: 'Release 175: ship it?',
      bullets: [{ text: 'All checks green', refs: [] }],
      basis: { lastEventId: 'ev9', planCursor: 3 },
      lastEventId: 'e1',
    });
    expect(p.ops[1]!.data).toEqual(p.ops[0]!.data);
    expect(p.ops[2]!.data).toEqual({
      summary: {
        version: 1,
        at: SERVER_TIME,
        headline: 'Release 175: ship it?',
        ask: null,
        answer: null,
        recAction: 'Approve',
        confidence: 'high',
      },
      updatedAt: SERVER_TIME,
      lastEventId: 'e1',
    });
    expect(p.ops[3]!.data).toMatchObject({
      type: 'summary.written',
      data: { version: 1 },
      threadId: 't1',
      subjectId: 's1',
    });
  });
  it('keeps 20 versions: v21 deletes v1', () => {
    const p = writeSummary(agent, input({ current: { version: 20 }, baseVersion: 20 }));
    expect(p.version).toBe(21);
    expect(p.ops[2]).toEqual({ kind: 'delete', path: 'workspaces/w1/inboxSummaryVersions/t1_1' });
    expect(
      writeSummary(agent, input({ current: { version: 19 }, baseVersion: 19 })).ops.some(
        (o) => o.kind === 'delete',
      ),
    ).toBe(false);
  });
  it('refuses a stale base, another agent, a person, a bad summary', () => {
    expect(err(() => writeSummary(agent, input({ current: { version: 3 }, baseVersion: 2 })))).toBe(
      'The summary moved on to v3: re-read the thread (thread_read), then write it with baseVersion 3.',
    );
    expect(err(() => writeSummary(agent, input({ baseVersion: 1 })))).toBe(
      'This thread has no summary yet: write it with baseVersion 0.',
    );
    expect(err(() => writeSummary(agent, input({ baseVersion: -1 })))).toMatch(/^baseVersion:/);
    expect(err(() => writeSummary(other, input()))).toBe(
      "Only the thread's home agent (the one that brought it in) writes its summary.",
    );
    expect(err(() => writeSummary(joao, input()))).toBe('Only agents can do this');
    expect(err(() => writeSummary(agent, input({ summary: { headline: '' } })))).toBe(
      'headline: required',
    );
  });
});

describe('freshness', () => {
  const at = (ms: number) => ({ toMillis: () => ms });
  it('none, fresh, stale; summarize 3 minutes after a change', () => {
    expect(summaryFreshness({ updatedAt: at(10) })).toBe('none');
    expect(summaryFreshness({ updatedAt: at(10), summary: { at: at(10) } })).toBe('fresh');
    expect(summaryFreshness({ updatedAt: at(11), summary: { at: at(10) } })).toBe('stale');
    const t = { updatedAt: at(1000), summary: { at: at(10) } };
    expect(summarizeDue(t, 1000 + SUMMARIZE_AFTER_MS - 1)).toBe(false);
    expect(summarizeDue(t, 1000 + SUMMARIZE_AFTER_MS)).toBe(true);
    expect(summarizeDue({ updatedAt: at(1000) }, 1000 + SUMMARIZE_AFTER_MS)).toBe(true);
    expect(summarizeDue({ updatedAt: at(1000), summary: { at: at(1000) } }, 1e12)).toBe(false);
  });
});

describe('rules block', () => {
  it('is generated from the limits', () => {
    const b = summaryRulesBlock();
    expect(b).toMatch(/BEGIN summary checks/);
    expect(b).toContain("'stacked_bar' ? 2 : 1) && l.size() <= 4");
    expect(b).toContain('(l.size() <= 7 || summaryNodeOk(l[7]))');
    expect(b).not.toContain('(l.size() <= 8 ||');
  });
});
