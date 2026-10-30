/**
 * The visual kit's pure maths (item OE8FmrTaIxFVGcaeGG3N, slice 2; design 5): nice axis ticks,
 * value and band scales, line segments, stacks, number formatting, the flow diagram's layers
 * (longest path, no free positioning), the before/after line diff and timeline dates. No DOM.
 */

export interface Domain {
  min: number;
  max: number;
}
export type ChartKind = 'bar' | 'line' | 'stacked_bar';
export type Values = ReadonlyArray<number | null>;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A step of 1, 2, 2.5 or 5 × 10^n that splits `range` into about `count` parts. */
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * pow;
}

/** Axis ticks: the domain rounded out to a nice step, about `count` intervals. */
export function niceTicks(min: number, max: number, count = 4): Domain & { ticks: number[] } {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
    hi += pad;
    if (lo !== 0) lo -= pad;
  }
  const step = niceStep(hi - lo, count);
  const nMin = Math.floor(lo / step + 1e-9) * step;
  const nMax = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  const n = Math.round((nMax - nMin) / step);
  for (let i = 0; i <= n; i++) ticks.push(Number((nMin + i * step).toPrecision(12)));
  return { min: ticks[0]!, max: ticks[ticks.length - 1]!, ticks };
}

/** The values of a series as drawn: exactly `n` of them, anything not a finite number a gap. */
export function seriesValues(values: Values, n: number): (number | null)[] {
  return Array.from({ length: n }, (_, i) => {
    const v = values[i];
    return finite(v) ? v : null;
  });
}

/** The data's range: bars and stacks from zero, lines from their own minimum. */
export function chartDomain(kind: ChartKind, series: ReadonlyArray<Values>): Domain {
  const all: number[] = [];
  if (kind === 'stacked_bar') {
    const n = Math.max(0, ...series.map((s) => s.length));
    for (let i = 0; i < n; i++) {
      let up = 0;
      let down = 0;
      for (const s of series) {
        const v = s[i];
        if (!finite(v)) continue;
        if (v >= 0) up += v;
        else down += v;
      }
      all.push(up, down);
    }
  } else for (const s of series) for (const v of s) if (finite(v)) all.push(v);
  if (all.length === 0) return { min: 0, max: 1 };
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (kind !== 'line') {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) return kind === 'line' ? { min, max } : { min: 0, max: max || 1 };
  return { min, max };
}

/** A value's y in a plot `height` tall (0 at the top). */
export function scaleY(v: number, d: Domain, height: number): number {
  const span = d.max - d.min || 1;
  return height - ((v - d.min) / span) * height;
}

/** Band `i` of `n` across `width`: its left edge, width (with a gap) and centre. */
export function bandX(i: number, n: number, width: number, gap = 0.3) {
  const band = width / Math.max(1, n);
  const w = band * (1 - gap);
  const x = i * band + (band - w) / 2;
  return { x, w, cx: i * band + band / 2 };
}

/** A line's points, split where a value is missing. */
export function lineSegments(
  values: Values,
  d: Domain,
  width: number,
  height: number,
): Array<Array<[number, number]>> {
  const segs: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  values.forEach((v, i) => {
    if (!finite(v)) {
      if (cur.length) segs.push(cur);
      cur = [];
      return;
    }
    cur.push([bandX(i, values.length, width).cx, scaleY(v, d, height)]);
  });
  if (cur.length) segs.push(cur);
  return segs;
}

/** The stacked pieces at x index `i`: positives upwards from zero, negatives downwards. */
export function stackSegments(series: ReadonlyArray<Values>, i: number) {
  const out: Array<{ series: number; from: number; to: number }> = [];
  let up = 0;
  let down = 0;
  series.forEach((s, k) => {
    const v = s[i];
    if (!finite(v) || v === 0) return;
    if (v > 0) {
      out.push({ series: k, from: up, to: up + v });
      up += v;
    } else {
      out.push({ series: k, from: down, to: down + v });
      down += v;
    }
  });
  return out;
}

/** Show every n-th x label so they do not overlap (about 44 px each). */
export function labelEvery(points: number, width: number, px = 44): number {
  const fit = Math.max(1, Math.floor(width / px));
  return Math.max(1, Math.ceil(points / fit));
}

const CURRENCY = new Set(['€', '$', '£', '¥', 'CHF']);
const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const plain = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });

/** A value with its unit: "10.8 min", "12%", "€1.2K". */
export function formatValue(v: number, unit: string | null | undefined): string {
  const n = Math.abs(v) >= 1000 ? compact.format(v) : plain.format(v);
  const u = unit?.trim() ?? '';
  if (!u) return n;
  if (u === '%') return `${n}%`;
  if (CURRENCY.has(u)) return v < 0 ? `-${u}${n.slice(1)}` : `${u}${n}`;
  return `${n} ${u}`;
}

// ---------- flow ----------

export interface FlowNodeIn {
  id: string;
  label: string;
  who: 'agent' | 'person' | 'system' | null;
  state: 'done' | 'now' | 'next' | 'changed' | 'removed' | null;
}
export interface FlowEdgeIn {
  from: string;
  to: string;
  label: string | null;
}

/**
 * Columns of a flow diagram: each node in the layer of its longest path from a start, in node
 * order within a layer. No edges: a straight sequence in node order. Edges to unknown nodes are
 * dropped; an edge that closes a cycle does not move layers.
 */
export function flowLayout(nodes: readonly FlowNodeIn[], edgesIn: readonly FlowEdgeIn[]) {
  const ids = nodes.map((n) => n.id);
  const known = new Set(ids);
  const edges: FlowEdgeIn[] = edgesIn.length
    ? edgesIn.filter((e) => known.has(e.from) && known.has(e.to) && e.from !== e.to)
    : ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id, label: null }));
  // Depth-first order, ignoring the edges that go back to a node on the current path.
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from)!.push(e.to);
  const forward: FlowEdgeIn[] = [];
  const state = new Map<string, 'on' | 'done'>();
  const order: string[] = [];
  const visit = (id: string) => {
    state.set(id, 'on');
    for (const e of edges.filter((x) => x.from === id)) {
      const s = state.get(e.to);
      if (s === 'on') continue;
      forward.push(e);
      if (!s) visit(e.to);
    }
    state.set(id, 'done');
    order.push(id);
  };
  const hasIn = new Set(edges.map((e) => e.to));
  for (const id of ids) if (!hasIn.has(id) && !state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);
  order.reverse();
  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const id of order)
    for (const e of forward)
      if (e.from === id) layer.set(e.to, Math.max(layer.get(e.to)!, layer.get(id)! + 1));
  const depth = Math.max(0, ...layer.values());
  const layers: string[][] = Array.from({ length: depth + 1 }, () => []);
  for (const id of ids) layers[layer.get(id)!]!.push(id);
  return { layers: layers.filter((l) => l.length), edges, layerOf: layer };
}

// ---------- before / after ----------

/** Lines only on the left are removed, lines only on the right are added (longest common run). */
export function lineDiff(before: readonly string[], after: readonly string[]) {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        before[i] === after[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const keepB = new Set<number>();
  const keepA = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      keepB.add(i++);
      keepA.add(j++);
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
    else j++;
  }
  return {
    before: before.map((text, k) => ({ text, changed: !keepB.has(k) })),
    after: after.map((text, k) => ({ text, changed: !keepA.has(k) })),
  };
}

// ---------- timeline ----------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "29 Oct" or "29 Oct 14:02", read from the ISO text itself (no time zone shift). */
export function isoLabel(at: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(at);
  if (!m) return at;
  const day = `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]}`;
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day;
}

/** Timeline events in date order (as written: ISO texts sort by time). */
export function timelineEvents<E extends { at: string; label: string; state: string | null }>(
  events: readonly E[],
): Array<E & { when: string }> {
  return [...events]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.at < b.e.at ? -1 : a.e.at > b.e.at ? 1 : a.i - b.i))
    .map(({ e }) => ({ ...e, when: isoLabel(e.at) }));
}
