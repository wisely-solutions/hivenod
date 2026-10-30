import { visualSchema, type Visual } from '@hive/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VisualNotShown, VisualView } from './Visual';

const v = (raw: Record<string, unknown>): Visual => visualSchema.parse(raw);

const bar = v({
  kind: 'bar',
  title: 'Check time, last 6 releases (min)',
  caption: 'Release 175 ran the checks in 10.8 min, the fastest of the last six.',
  unit: 'min',
  x: ['170', '171', '172', '173', '174', '175'],
  series: [{ name: 'Minutes', values: [14, 16, 13, 12.5, 12, 10.8] }],
  highlight: 5,
  better: 'down',
});

describe('charts', () => {
  it('a bar chart is an SVG image named by its caption, with value labels on the highlight', () => {
    const { container } = render(<VisualView v={bar} />);
    const img = screen.getByRole('img', { name: bar.caption });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(container.querySelectorAll('rect')).toHaveLength(6);
    // Highlight solid, the others dimmed.
    const ops = [...container.querySelectorAll('rect')].map((r) => r.getAttribute('opacity'));
    expect(ops.slice(0, 5)).toEqual(Array(5).fill('0.55'));
    expect(ops[5]).toBe('1');
    expect(img.textContent).toContain('10.8 min');
    expect(screen.getByText(bar.caption).tagName.toLowerCase()).toBe('figcaption');
  });
  it('Show data opens a table with the same numbers', () => {
    render(<VisualView v={bar} />);
    const toggle = screen.getByRole('button', { name: 'Show data' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    const table = screen.getByRole('table', { name: bar.title });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(7);
    expect(within(rows[6]!).getByRole('rowheader')).toHaveTextContent('175');
    expect(within(rows[6]!).getByRole('cell')).toHaveTextContent('10.8 min');
    expect(screen.getByRole('button', { name: 'Hide data' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });
  it('lines break at a gap; stacked bars stack; legends name series', () => {
    const line = v({
      kind: 'line',
      title: 'Flaky tests',
      caption: 'Down to 2',
      unit: null,
      x: ['a', 'b', 'c', 'd'],
      series: [
        { name: 'Flaky', values: [5, null, 3, 2] },
        { name: 'Retried', values: [1, 2, 3, 4] },
      ],
      highlight: null,
      better: 'down',
    });
    const { container, unmount } = render(<VisualView v={line} />);
    expect(container.querySelectorAll('polyline')).toHaveLength(3);
    expect(screen.getByText('Retried')).toBeInTheDocument();
    unmount();
    const stacked = v({
      kind: 'stacked_bar',
      title: 'Checks',
      caption: 'All passed',
      unit: null,
      x: ['171', '172'],
      series: [
        { name: 'Passed', values: [600, 612] },
        { name: 'Retried', values: [10, 4] },
      ],
      highlight: 1,
      better: null,
    });
    const r = render(<VisualView v={stacked} />);
    expect(r.container.querySelectorAll('rect')).toHaveLength(4);
    expect(screen.getByRole('img').textContent).toContain('616');
  });
  it('a number tile with a delta says better or worse in words', () => {
    render(
      <VisualView
        v={v({
          kind: 'number',
          title: 'Check time',
          caption: '1.2 min faster than last release',
          value: 10.8,
          unit: 'min',
          delta: -1.2,
          trend: [14, 12, 10.8],
          better: 'down',
        })}
      />,
    );
    const tile = screen.getByRole('img', { name: '1.2 min faster than last release' });
    expect(tile).toHaveTextContent('10.8 min');
    expect(tile).toHaveTextContent('better');
  });
});

describe('diagrams', () => {
  it('a flow lists its nodes with who and state in words', () => {
    render(
      <VisualView
        v={v({
          kind: 'flow',
          title: 'How a release goes',
          caption: 'Ship it? waits for you',
          nodes: [
            { id: 'b', label: 'Build', who: 'agent', state: 'done' },
            { id: 's', label: 'Ship it?', who: 'person', state: 'now' },
            { id: 'r', label: 'Release', who: 'agent', state: 'next' },
          ],
          edges: [],
        })}
      />,
    );
    const img = screen.getByRole('img', { name: 'Ship it? waits for you' });
    expect(img).toHaveTextContent('Build');
    expect(img).toHaveTextContent('now');
    fireEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toContain(
      'Ship it? (person, now)',
    );
  });
  it('before/after marks removed and added lines by sign and words, not colour alone', () => {
    const { container } = render(
      <VisualView
        v={v({
          kind: 'before_after',
          title: 'Thread page',
          caption: 'The ask comes first',
          before: { label: null, lines: ['Conversation', 'Agent panel'] },
          after: { label: null, lines: ['Conversation', 'Top card'] },
        })}
      />,
    );
    expect(container.querySelector('[data-changed="before"]')).toHaveTextContent(
      'Removed: Agent panel',
    );
    expect(container.querySelector('[data-changed="after"]')).toHaveTextContent('Added: Top card');
  });
  it('a timeline in date order', () => {
    render(
      <VisualView
        v={v({
          kind: 'timeline',
          title: 'Release',
          caption: 'Live tomorrow',
          events: [
            { at: '2026-10-30', label: 'Live', state: 'next' },
            { at: '2026-10-29T14:02', label: 'Built', state: 'done' },
          ],
        })}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('29 Oct 14:02');
    expect(items[0]).toHaveTextContent('Built');
  });
});

describe('safety', () => {
  it('labels with tags show as plain text, never as markup', () => {
    // The tool refuses tags in titles; the page must still never render one.
    const raw = {
      ...bar,
      title: '<b>bold</b>',
      x: ['<script>x</script>', 'ok'],
      series: [{ name: '<img src=x>', values: [1, 2] }],
    };
    const { container } = render(<VisualView v={raw as Visual} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('<b>bold</b>')).toBeInTheDocument();
    expect(container.textContent).toContain('<script>x</script>');
  });
  it('an unknown kind is a quiet note', () => {
    render(<VisualNotShown kind="image" />);
    expect(screen.getByText(/can’t show yet \(image\)/)).toBeInTheDocument();
  });
});

describe('images (slice 4)', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';
  const images = new Map([
    ['t1_b4', { name: 'before.png', src: PNG }],
    ['t1_af', { name: 'after.png', src: `${PNG}AA` }],
  ]);
  const pair = v({
    kind: 'image_pair',
    title: 'Board card',
    caption: 'The card now shows the summary line',
    before: 't1_b4',
    after: 't1_af',
    labels: null,
  });
  it('an image pair shows both, alt from the caption, Show data names the files', () => {
    render(<VisualView v={pair} images={images} />);
    expect(screen.getByAltText('Before: The card now shows the summary line')).toHaveAttribute(
      'src',
      PNG,
    );
    expect(screen.getByAltText('After: The card now shows the summary line')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show data' }));
    expect(screen.getByText('Before: before.png')).toBeInTheDocument();
    expect(screen.getByText('After: after.png')).toBeInTheDocument();
  });
  it('Compare appears only when both images have the same size', () => {
    render(<VisualView v={pair} images={images} />);
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull();
    for (const img of screen.getAllByRole('img')) {
      Object.defineProperty(img, 'naturalWidth', { value: 800 });
      Object.defineProperty(img, 'naturalHeight', { value: 600 });
      fireEvent.load(img);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('slider', { name: /Compare/ })).toBeInTheDocument();
  });
  it('an image not handed to the page is not shown (another thread, a URL)', () => {
    const { container } = render(
      <VisualView
        v={v({ kind: 'image', title: 'Shot', caption: 'New', attachment: 't2_x' })}
        images={images}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('This image isn’t available on this thread.')).toBeInTheDocument();
  });
  it('labels show as plain text', () => {
    render(<VisualView v={{ ...pair, labels: ['<b>Old</b>', 'New'] } as Visual} images={images} />);
    expect(screen.getByText('<b>Old</b>')).toBeInTheDocument();
  });
});
