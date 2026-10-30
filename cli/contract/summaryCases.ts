/**
 * Contract cases for thread summaries (item OE8FmrTaIxFVGcaeGG3N): checkSummary and writeSummary
 * in packages/shared/src/summary.ts and their Go port cli/internal/actions/summary.go. Kept
 * apart from cases.ts so parallel work on other actions merges cleanly.
 */
import { checkSummary, threadAttach, writeSummary } from '../../packages/shared/src/index';
import type { ActionContext, Actor, ThreadStateOf } from '../../packages/shared/src/index';

type Act = <I>(
  name: string,
  action: string,
  actor: Actor,
  input: I,
  fn: (ctx: ActionContext, input: I) => unknown,
) => void;
type Pure = <I>(name: string, action: string, input: I, fn: (input: I) => unknown) => void;

export function summaryCases(
  act: Act,
  pure: Pure,
  who: { agent: Actor; other: Actor; human: Actor },
) {
  const BASE = { headline: '  Release 175: ship it?  ', bullets: ['All checks green'] };
  const bar = (over: Record<string, unknown> = {}) => ({
    kind: 'bar',
    title: ' Check time ',
    caption: 'Down from 14 to 10 minutes',
    x: ['r173', 'r174', 'r175'],
    series: [{ name: 'minutes', values: [14, 12.5, null] }],
    ...over,
  });
  const flow = (over: Record<string, unknown> = {}) => ({
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
      { from: 'b', to: 'c', label: ' yes ' },
    ],
    ...over,
  });
  const check = (name: string, input: unknown) =>
    pure(`checkSummary/${name}`, 'checkSummary', { summary: input }, (i) =>
      checkSummary(i.summary),
    );

  check('everything', {
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
    visuals: [
      bar({ unit: 'min', highlight: 2, better: 'down' }),
      flow(),
      {
        kind: 'number',
        title: 'Tests',
        caption: '412 pass',
        value: 412,
        delta: -0.5,
        trend: [400, 406, 412],
        better: 'up',
      },
      {
        kind: 'before_after',
        title: 'Nav',
        caption: 'Projects goes',
        before: { lines: [' Today ', 'Projects'] },
        after: { label: 'Now', lines: ['Today'] },
      },
    ],
    noVisualWhy: '  ',
    refs: [{ kind: 'link', id: 'pr86', label: 'PR #86', url: 'https://github.com/x/y/pull/86' }],
  });
  check('minimal', BASE);
  check('timeline and stacked', {
    ...BASE,
    visuals: [
      {
        kind: 'timeline',
        title: 'Dates',
        caption: 'Due Friday',
        events: [
          { at: '2026-10-29', label: 'Asked', state: 'done' },
          { at: '2026-10-31T17:00:30.5+01:00', label: 'Due', state: 'risk' },
        ],
      },
      bar({
        kind: 'stacked_bar',
        series: [
          { name: 'a', values: [1, 2, 3] },
          { name: 'b', values: [3, 2, 1] },
        ],
      }),
      flow({ edges: undefined }),
    ],
  });
  check('a reason instead of a visual', { ...BASE, ask: 'Ship it?', noVisualWhy: 'Text only' });
  const bad: [string, unknown][] = [
    ['not an object', 'Release 175'],
    ['no headline', { bullets: ['x'] }],
    ['long headline', { ...BASE, headline: 'x'.repeat(121) }],
    ['unknown field', { ...BASE, zeta: 1, colour: 'red' }],
    ['no bullets', { headline: 'H' }],
    ['zero bullets', { ...BASE, bullets: [] }],
    ['six bullets', { ...BASE, bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['long bullet', { ...BASE, bullets: ['x'.repeat(161)] }],
    ['bullet not text', { ...BASE, bullets: [42] }],
    ['four bullet refs', { ...BASE, bullets: [{ text: 'a', refs: [1, 2, 3, 4] }] }],
    ['bad confidence', { ...BASE, confidence: 'sure' }],
    ['recommendation without why', { ...BASE, recommendation: { action: 'Approve' } }],
    ['long details', { ...BASE, details: 'x'.repeat(6001) }],
    ['ask not text', { ...BASE, ask: 3 }],
    ['five visuals', { ...BASE, visuals: [bar(), bar(), bar(), bar(), bar()] }],
    ['visuals not a list', { ...BASE, visuals: { kind: 'bar' } }],
    ['pie', { ...BASE, visuals: [bar({ kind: 'pie' })] }],
    ['image comes later', { ...BASE, visuals: [{ kind: 'image', title: 'T', caption: 'C' }] }],
    ['no kind', { ...BASE, visuals: [{ title: 'T' }] }],
    ['svg', { ...BASE, visuals: [bar({ svg: '<svg/>' })] }],
    ['html title', { ...BASE, visuals: [bar({ title: '<b>Check</b>' })] }],
    ['empty caption', { ...BASE, visuals: [bar({ caption: '' })] }],
    [
      '25 points',
      { ...BASE, visuals: [bar(), bar({ x: Array.from({ length: 25 }, (_, i) => `d${i}`) })] },
    ],
    ['1 point', { ...BASE, visuals: [bar({ x: ['a'] })] }],
    ['long x label', { ...BASE, visuals: [bar({ x: ['a', 'x'.repeat(17), 'c'] })] }],
    ['no series', { ...BASE, visuals: [bar({ series: [] })] }],
    ['stacked with one series', { ...BASE, visuals: [bar({ kind: 'stacked_bar' })] }],
    [
      'five series',
      {
        ...BASE,
        visuals: [
          bar({
            series: Array.from({ length: 5 }, (_, i) => ({ name: `s${i}`, values: [1, 2, 3] })),
          }),
        ],
      },
    ],
    ['values short', { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, 2] }] })] }],
    ['value text', { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, '2', 3] }] })] }],
    ['value huge', { ...BASE, visuals: [bar({ series: [{ name: 'm', values: [1, 2e12, 3] }] })] }],
    [
      'series html name',
      { ...BASE, visuals: [bar({ series: [{ name: '<i>m', values: [1, 2, 3] }] })] },
    ],
    ['highlight out', { ...BASE, visuals: [bar({ highlight: 3 })] }],
    ['highlight half', { ...BASE, visuals: [bar({ highlight: 1.5 })] }],
    ['bad better', { ...BASE, visuals: [bar({ better: 'more' })] }],
    ['number without value', { ...BASE, visuals: [{ kind: 'number', title: 'T', caption: 'C' }] }],
    [
      'short trend',
      { ...BASE, visuals: [{ kind: 'number', title: 'T', caption: 'C', value: 1, trend: [1] }] },
    ],
    [
      'trend gap',
      {
        ...BASE,
        visuals: [{ kind: 'number', title: 'T', caption: 'C', value: 1, trend: [1, null] }],
      },
    ],
    ['one node', { ...BASE, visuals: [flow({ nodes: [{ id: 'a', label: 'A' }], edges: [] })] }],
    [
      'nine nodes',
      {
        ...BASE,
        visuals: [
          flow({
            nodes: Array.from({ length: 9 }, (_, i) => ({ id: `n${i}`, label: 'N' })),
            edges: [],
          }),
        ],
      },
    ],
    [
      'node twice',
      {
        ...BASE,
        visuals: [
          flow({
            nodes: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
            edges: [],
          }),
        ],
      },
    ],
    [
      'node script',
      {
        ...BASE,
        visuals: [
          flow({
            nodes: [
              { id: 'a', label: '<script>x</script>' },
              { id: 'b', label: 'B' },
            ],
            edges: [],
          }),
        ],
      },
    ],
    [
      'node robot',
      {
        ...BASE,
        visuals: [
          flow({
            nodes: [
              { id: 'a', label: 'A', who: 'robot' },
              { id: 'b', label: 'B' },
            ],
            edges: [],
          }),
        ],
      },
    ],
    ['edge to nowhere', { ...BASE, visuals: [flow({ edges: [{ from: 'a', to: 'z' }] })] }],
    ['edge from nowhere', { ...BASE, visuals: [flow({ edges: [{ from: 'q', to: 'z' }] })] }],
    [
      'eleven edges',
      {
        ...BASE,
        visuals: [flow({ edges: Array.from({ length: 11 }, () => ({ from: 'a', to: 'b' })) })],
      },
    ],
    [
      'side without lines',
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
    ],
    [
      'no after',
      {
        ...BASE,
        visuals: [{ kind: 'before_after', title: 'B', caption: 'C', before: { lines: ['x'] } }],
      },
    ],
    [
      'long side label',
      {
        ...BASE,
        visuals: [
          {
            kind: 'before_after',
            title: 'B',
            caption: 'C',
            before: { label: 'x'.repeat(25), lines: ['y'.repeat(61)] },
            after: { lines: ['x'] },
          },
        ],
      },
    ],
    [
      'friday',
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
    ],
    [
      'month 13',
      {
        ...BASE,
        visuals: [
          {
            kind: 'timeline',
            title: 'T',
            caption: 'C',
            events: [
              { at: '2026-13-01', label: 'a' },
              { at: '2026-10-30', label: 'b' },
            ],
          },
        ],
      },
    ],
    ['link without url', { ...BASE, refs: [{ kind: 'link', id: 'x', label: 'X' }] }],
    [
      'javascript url',
      { ...BASE, refs: [{ kind: 'link', id: 'x', label: 'X', url: 'javascript:alert(1)' }] },
    ],
    ['http url', { ...BASE, refs: [{ kind: 'message', id: 'x', label: 'X', url: 'http://x.y' }] }],
    ['bad ref kind', { ...BASE, refs: [{ kind: 'file', id: 'x', label: 'X' }] }],
    ['ref without id', { ...BASE, refs: [{ kind: 'event', label: 'X' }] }],
    [
      '31 refs',
      {
        ...BASE,
        refs: Array.from({ length: 31 }, (_, i) => ({ kind: 'event', id: `e${i}`, label: 'E' })),
      },
    ],
    ['long reason', { ...BASE, noVisualWhy: 'x'.repeat(141) }],
    ['ask without visual or reason', { ...BASE, ask: 'Ship it?' }],
  ];
  for (const [name, input] of bad) check(`refused/${name}`, input);

  const TH: ThreadStateOf = {
    memberUid: 'joao',
    subjectId: 's1',
    state: 'yourCall',
    fetchedBy: who.agent.id,
    refs: ['r1'],
  };
  const write = (name: string, actor: Actor, input: Partial<Parameters<typeof writeSummary>[1]>) =>
    act(
      `writeSummary/${name}`,
      'writeSummary',
      actor,
      {
        threadId: 'it1',
        thread: TH,
        current: null,
        baseVersion: 0,
        summary: {
          ...BASE,
          ask: 'Ship it?',
          recommendation: { action: 'Approve', why: 'Green' },
          confidence: 'high',
          visuals: [bar()],
        },
        basis: { lastEventId: 'ev9', planCursor: 3 },
        ...input,
      },
      writeSummary,
    );
  write('first', who.agent, {});
  write('next', who.agent, {
    current: { version: 4 },
    baseVersion: 4,
    basis: { lastEventId: null, planCursor: null },
  });
  write('twenty first drops the first', who.agent, { current: { version: 20 }, baseVersion: 20 });
  write('without a recommendation', who.agent, {
    summary: BASE,
    thread: { ...TH, subjectId: null },
  });
  write('stale base', who.agent, { current: { version: 3 }, baseVersion: 2 });
  write('base for none', who.agent, { baseVersion: 1 });
  write('negative base', who.agent, { baseVersion: -1 });
  write('half base', who.agent, { baseVersion: 0.5 });
  write('no base', who.agent, { baseVersion: undefined });
  write('bad summary', who.agent, { summary: { headline: '' } });
  write('long basis', who.agent, { basis: { lastEventId: 'x'.repeat(129), planCursor: null } });
  write('not the home agent', who.other, {});
  write('person refused', who.human, {});

  // Slice 4: image visuals name image attachments of the same thread.
  const pair = {
    kind: 'image_pair',
    title: ' Board card ',
    caption: 'The card shows the summary',
    before: 'it1_b4',
    after: 'it1_af',
  };
  const shots = (visuals: unknown[]) => ({ summary: { ...BASE, ask: 'Ship it?', visuals } });
  const both = { it1_b4: 'image', it1_af: 'image' };
  write('image pair', who.agent, { ...shots([pair]), attachments: both });
  write('image and labels', who.agent, {
    ...shots([
      { kind: 'image', title: 'Shot', caption: 'New page', attachment: 'it1_b4' },
      { ...pair, labels: [' Old ', 'New'] },
    ]),
    attachments: both,
  });
  write('image missing', who.agent, { ...shots([pair]), attachments: { it1_b4: 'image' } });
  write('image not an image', who.agent, {
    ...shots([pair]),
    attachments: { ...both, it1_af: 'html' },
  });
  write('image of another thread', who.agent, {
    ...shots([{ ...pair, after: 'it2_af' }]),
    attachments: { ...both, it2_af: 'image' },
  });
  write('image as a url', who.agent, {
    ...shots([{ ...pair, before: 'https://example.com/a.png' }]),
    attachments: both,
  });
  write('image without attachments', who.agent, shots([pair]));
  for (const [name, v] of [
    ['image no attachment', { kind: 'image', title: 'T', caption: 'C' }],
    ['image extra field', { kind: 'image', title: 'T', caption: 'C', attachment: 'a', url: 'x' }],
    ['pair one label', { ...pair, labels: ['Old'] }],
    ['pair html label', { ...pair, labels: ['<b>x</b>', 'New'] }],
    ['pair no after', { ...pair, after: undefined }],
    ['pair long id', { ...pair, before: 'x'.repeat(201) }],
  ] as const)
    check(`refused/${name}`, { ...BASE, visuals: [v] });

  // thread_attach (./threadattach.ts).
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const att = (name: string, actor: Actor, input: Record<string, unknown>) =>
    act(
      `threadAttach/${name}`,
      'threadAttach',
      actor,
      { threadId: 'it1', thread: TH, kind: 'image', name: ' before.png ', content: PNG, ...input },
      threadAttach as never,
    );
  att('image', who.agent, { id: 'shot1' });
  att('new id', who.agent, { kind: 'text', content: 'héllo' });
  att('webp', who.agent, { content: 'data:image/webp;base64,UklGRg==' });
  att('link', who.agent, { kind: 'link', content: undefined, url: ' https://example.com/pr/1 ' });
  att('http link', who.agent, { kind: 'link', content: undefined, url: 'http://example.com' });
  att('svg', who.agent, { content: 'data:image/svg+xml;base64,PHN2Zz4=' });
  att('html as image', who.agent, { content: '<b>x</b>' });
  att('bad id', who.agent, { id: 'a_b' });
  att('no name', who.agent, { name: '  ' });
  att('long name', who.agent, { name: 'n'.repeat(201) });
  att('bad kind', who.agent, { kind: 'video' });
  att('no content', who.agent, { content: undefined });
  att('not the home agent', who.other, {});
  att('person refused', who.human, {});
}
