/**
 * The visual kit (item OE8FmrTaIxFVGcaeGG3N, slices 2 and 4; design 5): charts (bar, line, stacked_bar,
 * number) and diagrams (flow, before_after, timeline) drawn from the summary's data by our own
 * SVG and HTML, never from agent markup. Every label is a React text node (plain text, never
 * HTML). Each visual is a figure with its title and caption (the takeaway, also the SVG's
 * aria-label) and a "Show data" toggle with the same data as a table or list. Colours come from
 * the theme tokens, so light and dark follow; meaning is never carried by colour alone.
 */
import type { Visual } from '@hive/shared';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  Circle,
  CircleDot,
  Cog,
  Pencil,
  TriangleAlert,
  User,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../cn';
import { Icon } from '../icon';
import { Frame } from './frame';
import { ImagePairView, ImageView, type ThreadImages } from './ImageVisuals';
import {
  bandX,
  chartDomain,
  flowLayout,
  formatValue,
  labelEvery,
  lineDiff,
  lineSegments,
  niceTicks,
  scaleY,
  seriesValues,
  stackSegments,
  timelineEvents,
} from './scale';

/** Series colours (design 5): 1 agent, 2 agent-2, 3 agent-7, 4 agent-5. */
export const SERIES_COLORS = ['var(--agent)', 'var(--agent-2)', 'var(--agent-7)', 'var(--agent-5)'];
const DIM = 0.55;

/** The element's width, followed (600 where it cannot be measured, as in tests). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(el.clientWidth);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w || 600] as const;
}

const cell = 'border-b border-line px-2 py-1.5 text-left text-13 [overflow-wrap:anywhere]';

function DataTable({
  title,
  head,
  rows,
}: {
  title: string;
  head: string[];
  rows: Array<{ label: string; values: string[] }>;
}) {
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-ink">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cn(cell, 'font-semibold text-text-2')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <th scope="row" className={cn(cell, 'font-medium')}>
                {r.label}
              </th>
              {r.values.map((v, j) => (
                <td key={j} className={cn(cell, 'tabular-nums')}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- charts ----------

type Chart = Extract<Visual, { kind: 'bar' | 'line' | 'stacked_bar' }>;
const TOP = 20;
const PLOT_H = 160;
const BOTTOM = 22;
const LEFT = 44;
const RIGHT = 8;

function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <ul aria-hidden className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-12 text-text-2">
      {names.map((n, i) => (
        <li key={i} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block size-2.5 rounded-[3px]"
            style={{ background: SERIES_COLORS[i] }}
          />
          {n}
        </li>
      ))}
    </ul>
  );
}

function ChartView({ v }: { v: Chart }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const n = v.x.length;
  const series = v.series.map((s) => seriesValues(s.values, n));
  const dom = chartDomain(v.kind, series);
  const t = niceTicks(dom.min, dom.max, 4);
  const d = { min: t.min, max: t.max };
  const pw = Math.max(40, width - LEFT - RIGHT);
  const y = (val: number) => TOP + scaleY(val, d, PLOT_H);
  const hi = v.highlight !== null && v.highlight < n ? v.highlight : null;
  const op = (i: number) => (hi === null || hi === i ? 1 : DIM);
  const labelled = new Set([n - 1, ...(hi !== null ? [hi] : [])]);
  const every = labelEvery(n, pw);
  const fmt = (val: number) => formatValue(val, v.unit);
  const text = 'fill-[var(--text-2)]';

  const marks: ReactNode[] = [];
  const values: ReactNode[] = [];
  if (v.kind === 'bar') {
    for (let i = 0; i < n; i++) {
      const b = bandX(i, n, pw);
      const sw = b.w / series.length;
      series.forEach((s, k) => {
        const val = s[i];
        if (val === null || val === undefined) return;
        const top = y(Math.max(val, 0));
        const h = Math.max(1, Math.abs(y(val) - y(0)));
        const x = LEFT + b.x + k * sw;
        marks.push(
          <rect
            key={`${i}-${k}`}
            x={x + 0.5}
            y={top}
            width={Math.max(1, sw - 1)}
            height={h}
            rx={2}
            fill={SERIES_COLORS[k]}
            opacity={op(i)}
          />,
        );
        if (labelled.has(i))
          values.push(
            <text
              key={`v${i}-${k}`}
              x={x + sw / 2}
              y={val >= 0 ? top - 5 : top + h + 12}
              textAnchor="middle"
              className="fill-[var(--ink)] text-[11px] font-semibold"
            >
              {fmt(val)}
            </text>,
          );
      });
    }
  } else if (v.kind === 'stacked_bar') {
    for (let i = 0; i < n; i++) {
      const b = bandX(i, n, pw);
      const segs = stackSegments(series, i);
      segs.forEach((sg) => {
        const top = y(Math.max(sg.from, sg.to));
        const h = Math.max(1, Math.abs(y(sg.to) - y(sg.from)));
        marks.push(
          <rect
            key={`${i}-${sg.series}`}
            x={LEFT + b.x}
            y={top}
            width={b.w}
            height={h}
            fill={SERIES_COLORS[sg.series]}
            opacity={op(i)}
            stroke="var(--surface)"
            strokeWidth={1}
          />,
        );
      });
      if (labelled.has(i) && segs.length) {
        const total = segs.reduce((a, sg) => a + (sg.to - sg.from), 0);
        const up = Math.max(0, ...segs.map((sg) => Math.max(sg.from, sg.to)));
        values.push(
          <text
            key={`v${i}`}
            x={LEFT + b.cx}
            y={y(up) - 5}
            textAnchor="middle"
            className="fill-[var(--ink)] text-[11px] font-semibold"
          >
            {fmt(total)}
          </text>,
        );
      }
    }
  } else {
    series.forEach((s, k) => {
      for (const seg of lineSegments(s, d, pw, PLOT_H)) {
        marks.push(
          <polyline
            key={`l${k}-${seg[0]![0]}`}
            points={seg.map(([px, py]) => `${LEFT + px},${TOP + py}`).join(' ')}
            fill="none"
            stroke={SERIES_COLORS[k]}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />,
        );
      }
      s.forEach((val, i) => {
        if (val === null) return;
        const cx = LEFT + bandX(i, n, pw).cx;
        const cy = y(val);
        marks.push(
          <circle
            key={`p${k}-${i}`}
            cx={cx}
            cy={cy}
            r={hi === i ? 4.5 : 3}
            fill={hi === null || hi === i ? SERIES_COLORS[k] : 'var(--surface)'}
            stroke={SERIES_COLORS[k]}
            strokeWidth={1.5}
            opacity={hi === null || hi === i ? 1 : 0.85}
          />,
        );
        if (labelled.has(i))
          values.push(
            <text
              key={`v${k}-${i}`}
              x={cx}
              y={cy - 8}
              textAnchor={i === n - 1 && n > 1 ? 'end' : 'middle'}
              className="fill-[var(--ink)] text-[11px] font-semibold"
            >
              {fmt(val)}
            </text>,
          );
      });
    });
  }

  return (
    <div ref={ref} className="min-w-0">
      <svg
        role="img"
        aria-label={v.caption}
        width={width}
        height={TOP + PLOT_H + BOTTOM}
        className="block max-w-full overflow-visible"
      >
        {t.ticks.map((tk) => (
          <g key={tk}>
            <line
              x1={LEFT}
              x2={LEFT + pw}
              y1={y(tk)}
              y2={y(tk)}
              stroke={tk === 0 ? 'var(--line-strong)' : 'var(--line)'}
              strokeWidth={1}
            />
            <text x={LEFT - 6} y={y(tk) + 4} textAnchor="end" className={cn(text, 'text-[11px]')}>
              {formatValue(tk, v.unit === '%' || v.unit === '€' ? v.unit : null)}
            </text>
          </g>
        ))}
        {marks}
        {values}
        {v.x.map((lab, i) =>
          i % every === 0 || i === n - 1 ? (
            <text
              key={`x${i}`}
              x={LEFT + bandX(i, n, pw).cx}
              y={TOP + PLOT_H + 15}
              textAnchor="middle"
              className={cn(text, 'text-[11px]', hi === i && 'font-semibold fill-[var(--ink)]')}
            >
              {lab}
            </text>
          ) : null,
        )}
      </svg>
      <Legend names={v.series.map((s) => s.name)} />
    </div>
  );
}

function chartData(v: Chart) {
  const n = v.x.length;
  return (
    <DataTable
      title={v.title}
      head={['Point', ...v.series.map((s) => s.name)]}
      rows={v.x.map((x, i) => ({
        label: x,
        values: v.series.map((s) => {
          const val = seriesValues(s.values, n)[i];
          return val === null || val === undefined ? 'no value' : formatValue(val, v.unit);
        }),
      }))}
    />
  );
}

// ---------- number ----------

type NumberVisual = Extract<Visual, { kind: 'number' }>;

function NumberView({ v }: { v: NumberVisual }) {
  const delta = v.delta;
  const good =
    delta === null || delta === 0 || v.better === null ? null : delta > 0 === (v.better === 'up');
  const trend = v.trend;
  let spark: ReactNode = null;
  if (trend && trend.length >= 2) {
    const w = 120;
    const h = 32;
    const d = chartDomain('line', [trend]);
    const segs = lineSegments(
      trend,
      d.min === d.max ? { min: d.min - 1, max: d.max + 1 } : d,
      w,
      h,
    );
    spark = (
      <svg aria-hidden width={w} height={h} className="block overflow-visible">
        {segs.map((seg, i) => (
          <polyline
            key={i}
            points={seg.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="none"
            stroke="var(--agent)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        ))}
      </svg>
    );
  }
  return (
    <div role="img" aria-label={v.caption} className="flex flex-wrap items-end gap-x-4 gap-y-2">
      <div>
        <p className="text-28 font-semibold tabular-nums text-ink">
          {formatValue(v.value, v.unit)}
        </p>
        {delta !== null ? (
          <p
            className={cn(
              'mt-1 inline-flex items-center gap-1 text-13 font-medium',
              good === true && 'text-approve-text',
              good === false && 'text-sendback',
              good === null && 'text-text-2',
            )}
          >
            <Icon icon={delta > 0 ? ArrowUp : delta < 0 ? ArrowDown : ArrowRight} size={14} />
            {delta > 0 ? '+' : ''}
            {formatValue(delta, v.unit)}
            {good === null ? '' : good ? ' · better' : ' · worse'}
          </p>
        ) : null}
      </div>
      {spark}
    </div>
  );
}

function numberData(v: NumberVisual) {
  const rows = [{ label: 'Value', values: [formatValue(v.value, v.unit)] }];
  if (v.delta !== null) rows.push({ label: 'Change', values: [formatValue(v.delta, v.unit)] });
  (v.trend ?? []).forEach((t, i) =>
    rows.push({ label: `Trend ${i + 1}`, values: [formatValue(t, v.unit)] }),
  );
  return <DataTable title={v.title} head={['Item', 'Value']} rows={rows} />;
}

// ---------- flow ----------

type FlowVisual = Extract<Visual, { kind: 'flow' }>;
const WHO: Record<string, { icon: LucideIcon; word: string; cls: string }> = {
  agent: { icon: Bot, word: 'agent', cls: 'border-agent/40 bg-agent-soft' },
  person: { icon: User, word: 'person', cls: 'border-gate/70 bg-gate-bg' },
  system: { icon: Cog, word: 'system', cls: 'border-line-strong/60 bg-canvas' },
};
const NODE_STATE: Record<string, { icon: LucideIcon; word: string }> = {
  done: { icon: Check, word: 'done' },
  now: { icon: CircleDot, word: 'now' },
  next: { icon: Circle, word: 'next' },
  changed: { icon: Pencil, word: 'changed' },
  removed: { icon: X, word: 'removed' },
};

function FlowView({ v }: { v: FlowVisual }) {
  const { layers, edges } = flowLayout(v.nodes, v.edges);
  const byId = new Map(v.nodes.map((n) => [n.id, n]));
  const into = (id: string) =>
    edges.filter((e) => e.to === id && e.label).map((e) => e.label as string);
  return (
    <div
      role="img"
      aria-label={v.caption}
      className="flex flex-col items-start gap-1.5 sm:flex-row sm:flex-wrap sm:items-center"
    >
      {layers.map((layer, li) => (
        <div key={li} className="contents">
          {li > 0 ? (
            <span className="text-text-3">
              <Icon icon={ArrowDown} size={16} className="sm:hidden" />
              <Icon icon={ArrowRight} size={16} className="max-sm:hidden" />
            </span>
          ) : null}
          <div className="flex flex-wrap gap-1.5 sm:flex-col">
            {layer.map((id) => {
              const node = byId.get(id)!;
              const who = WHO[node.who ?? 'system']!;
              const st = node.state ? NODE_STATE[node.state] : null;
              const labels = into(id);
              return (
                <span
                  key={id}
                  data-node={id}
                  className={cn(
                    'inline-flex max-w-full flex-col rounded-[10px] border px-2.5 py-1.5',
                    who.cls,
                    node.state === 'now' && 'ring-2 ring-agent/40',
                  )}
                >
                  {labels.length ? (
                    <span className="text-12 text-text-2">↳ {labels.join(' / ')}</span>
                  ) : null}
                  <span className="inline-flex items-center gap-1.5 text-13 font-medium text-ink">
                    <Icon icon={who.icon} size={13} className="shrink-0 text-text-2" />
                    <span
                      className={cn(
                        '[overflow-wrap:anywhere]',
                        node.state === 'removed' && 'line-through',
                      )}
                    >
                      {node.label}
                    </span>
                  </span>
                  {st ? (
                    <span className="inline-flex items-center gap-1 text-12 text-text-2">
                      <Icon icon={st.icon} size={12} />
                      {st.word}
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function flowData(v: FlowVisual) {
  const { layers, edges } = flowLayout(v.nodes, v.edges);
  const byId = new Map(v.nodes.map((n) => [n.id, n]));
  return (
    <div className="flex flex-col gap-2 text-13 text-ink">
      <ol className="list-decimal pl-5">
        {layers.flat().map((id) => {
          const n = byId.get(id)!;
          const extra = [n.who, n.state].filter(Boolean).join(', ');
          return (
            <li key={id} className="[overflow-wrap:anywhere]">
              {n.label}
              {extra ? ` (${extra})` : ''}
            </li>
          );
        })}
      </ol>
      {edges.length ? (
        <ul className="list-disc pl-5 text-text-2">
          {edges.map((e, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {byId.get(e.from)?.label} to {byId.get(e.to)?.label}
              {e.label ? `: ${e.label}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------- before / after ----------

type BeforeAfterVisual = Extract<Visual, { kind: 'before_after' }>;

function BeforeAfterView({ v }: { v: BeforeAfterVisual }) {
  const d = lineDiff(v.before.lines, v.after.lines);
  const col = (
    label: string,
    lines: Array<{ text: string; changed: boolean }>,
    side: 'before' | 'after',
  ) => (
    <div className="min-w-0 rounded-btn border border-line bg-surface-2 p-2.5">
      <p className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        {label}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1 text-13 text-ink">
        {lines.map((l, i) => (
          <li
            key={i}
            data-changed={l.changed ? side : undefined}
            className={cn(
              'flex gap-1.5 [overflow-wrap:anywhere]',
              l.changed && side === 'before' && 'text-text-2 line-through',
              l.changed && side === 'after' && 'font-medium',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-3 shrink-0 font-mono',
                l.changed && side === 'after' ? 'text-approve-text' : 'text-sendback',
              )}
            >
              {l.changed ? (side === 'before' ? '−' : '+') : ''}
            </span>
            {l.changed ? (
              <span className="sr-only">{side === 'before' ? 'Removed: ' : 'Added: '}</span>
            ) : null}
            <span className="min-w-0">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {col(v.before.label ?? 'Before', d.before, 'before')}
      {col(v.after.label ?? 'After', d.after, 'after')}
    </div>
  );
}

function beforeAfterData(v: BeforeAfterVisual) {
  const list = (label: string, lines: string[]) => (
    <div>
      <p className="text-13 font-semibold text-ink">{label}</p>
      <ul className="list-disc pl-5 text-13 text-ink">
        {lines.map((l, i) => (
          <li key={i} className="[overflow-wrap:anywhere]">
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div className="flex flex-col gap-2">
      {list(v.before.label ?? 'Before', v.before.lines)}
      {list(v.after.label ?? 'After', v.after.lines)}
    </div>
  );
}

// ---------- timeline ----------

type TimelineVisual = Extract<Visual, { kind: 'timeline' }>;
const EVENT_STATE: Record<string, { icon: LucideIcon; word: string; cls: string }> = {
  done: { icon: Check, word: 'done', cls: 'border-approve-solid bg-approve-solid text-on-solid' },
  now: { icon: CircleDot, word: 'now', cls: 'border-agent bg-agent-soft text-agent' },
  next: { icon: Circle, word: 'next', cls: 'border-line-strong bg-surface text-text-2' },
  risk: { icon: TriangleAlert, word: 'risk', cls: 'border-sendback bg-sendback-bg text-sendback' },
};

function TimelineView({ v }: { v: TimelineVisual }) {
  const events = timelineEvents(v.events);
  return (
    <ol className="flex flex-col gap-2.5 border-l-2 border-line pl-4 sm:flex-row sm:gap-0 sm:border-l-0 sm:border-t-2 sm:pl-0 sm:pt-0">
      {events.map((e, i) => {
        const st = EVENT_STATE[e.state ?? 'next']!;
        return (
          <li key={i} className="relative min-w-0 sm:flex-1 sm:pr-2 sm:pt-4">
            <span
              aria-hidden
              className={cn(
                'absolute -left-[1.4rem] top-0.5 grid size-4 place-items-center rounded-full border sm:-top-[0.55rem] sm:left-0',
                st.cls,
              )}
            >
              <Icon icon={st.icon} size={10} />
            </span>
            <p className="font-mono text-12 text-text-2">{e.when}</p>
            <p className="text-13 font-medium text-ink [overflow-wrap:anywhere]">{e.label}</p>
            {e.state ? <p className="text-12 text-text-2">{st.word}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

function timelineData(v: TimelineVisual) {
  return (
    <ol className="list-decimal pl-5 text-13 text-ink">
      {timelineEvents(v.events).map((e, i) => (
        <li key={i} className="[overflow-wrap:anywhere]">
          {e.when}: {e.label}
          {e.state ? ` (${e.state})` : ''}
        </li>
      ))}
    </ol>
  );
}

// ---------- the one entry point ----------

const NO_IMAGES: ThreadImages = new Map();

/** One visual from the summary, drawn by the kit (images: the thread's, checked by the caller). */
export function VisualView({ v, images = NO_IMAGES }: { v: Visual; images?: ThreadImages }) {
  switch (v.kind) {
    case 'image':
      return <ImageView v={v} images={images} />;
    case 'image_pair':
      return <ImagePairView v={v} images={images} />;
    case 'bar':
    case 'line':
    case 'stacked_bar':
      return (
        <Frame title={v.title} caption={v.caption} kind={v.kind} data={chartData(v)}>
          <ChartView v={v} />
        </Frame>
      );
    case 'number':
      return (
        <Frame title={v.title} caption={v.caption} kind={v.kind} data={numberData(v)}>
          <NumberView v={v} />
        </Frame>
      );
    case 'flow':
      return (
        <Frame title={v.title} caption={v.caption} kind={v.kind} data={flowData(v)}>
          <FlowView v={v} />
        </Frame>
      );
    case 'before_after':
      return (
        <Frame title={v.title} caption={v.caption} kind={v.kind} data={beforeAfterData(v)}>
          <BeforeAfterView v={v} />
        </Frame>
      );
    case 'timeline':
      return (
        <Frame title={v.title} caption={v.caption} kind={v.kind} data={timelineData(v)}>
          <TimelineView v={v} />
        </Frame>
      );
  }
}

/** A visual of a kind this page cannot draw (from a newer agent). */
export function VisualNotShown({ kind }: { kind: string }) {
  return (
    <p
      data-visual-unknown={kind}
      className="rounded-card border border-dashed border-line px-3.5 py-3 text-13 text-text-2"
    >
      A visual this page can’t show yet ({kind}).
    </p>
  );
}

/** Small visuals (a number) may share a row with the one next to them on desktop. */
export const isSmallVisual = (v: Visual) => v.kind === 'number';
