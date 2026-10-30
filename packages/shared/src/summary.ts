/**
 * Thread summaries (item OE8FmrTaIxFVGcaeGG3N, slice 1; design: docs/INBOX.md "Summaries"): every
 * thread carries an up-to-date summary written by its home agent, so the member reads one line,
 * sees the recommendation and decides; detail is there when wanted.
 *
 *   workspaces/{wid}/inboxSummaries/{tid}                   the current summary (doc id = thread id)
 *   workspaces/{wid}/inboxSummaryVersions/{tid}_{version}   every version, create-only; the last 20 kept
 *   inboxThreads/{tid}.summary                              its top line (mirror for Today and the list)
 *
 * Visuals are data, never pictures or markup: charts (bar, line, stacked_bar, number) and
 * diagrams (flow, before_after, timeline), rendered only by the app's own kit. Images (image,
 * image_pair, slice 4) name PNG/JPEG/WebP files the home agent attached to the same thread with
 * thread_attach (./threadattach.ts). Stored visuals are normalized: every key of their kind is
 * present, null when not given (edges [] = a straight sequence).
 *
 * `checkSummary` is the one validation (plain errors, the same in the Go CLI through the contract
 * cases); `writeSummary` is the action (one batch: summary, version, thread mirror, one
 * `summary.written` event). The rules check the same shapes (`summaryRulesBlock`, generated into
 * firestore.rules by scripts/summary-rules.test.mjs).
 */
import { z } from 'zod';
import {
  ActionError,
  requireAgent,
  SERVER_TIME,
  type ActionContext,
  type ActionPlan,
  type WriteOp,
} from './actions';
import { inboxPlan, inboxPaths, type ThreadStateOf } from './inbox';
import { OUTCOME_CONFIDENCE } from './outcomes';
import { timestamp } from './schema';
import { isThreadAttachmentOf } from './threadattach';

// ---------- limits and kinds ----------

export const SUMMARY_LIMITS = {
  headline: 120,
  ask: 200,
  answer: 160,
  recAction: 40,
  recWhy: 200,
  bullets: 5,
  bullet: 160,
  bulletRefs: 3,
  details: 6000,
  visuals: 4,
  noVisualWhy: 140,
  refs: 30,
  refId: 64,
  refLabel: 60,
  url: 2048,
  basisEventId: 128,
  /** Every visual: title and caption (the takeaway, also the alt text). */
  title: 80,
  caption: 200,
  unit: 12,
  /** Charts: x labels (points) and series. */
  minPoints: 2,
  points: 24,
  xLabel: 16,
  series: 4,
  seriesName: 30,
  /** Every number is finite, at most this either way. */
  maxAbs: 1e12,
  /** Flow diagrams. */
  minNodes: 2,
  nodes: 8,
  nodeId: 16,
  nodeLabel: 40,
  edges: 10,
  edgeLabel: 24,
  /** Before/after diagrams: each side's label and lines. */
  sideLabel: 24,
  lines: 6,
  line: 60,
  /** Timelines. */
  minEvents: 2,
  events: 12,
  eventLabel: 60,
  /** Images: an attachment id ({threadId}_{id}) and an image pair's two labels. */
  attachmentId: 200,
  pairLabel: 24,
  /** Versions kept (older ones are deleted by the writer in the same batch). */
  versionsKept: 20,
} as const;

/** Wait this long after a change before the home agent's session asks for a summary. */
export const SUMMARIZE_AFTER_MS = 3 * 60_000;

export const CHART_KINDS = ['bar', 'line', 'stacked_bar'] as const;
export const IMAGE_KINDS = ['image', 'image_pair'] as const;
export const VISUAL_KINDS = [
  ...CHART_KINDS,
  'number',
  'flow',
  'before_after',
  'timeline',
  ...IMAGE_KINDS,
] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];
export const REF_KINDS = ['message', 'attachment', 'step', 'event', 'link'] as const;
export const BETTER = ['up', 'down'] as const;
export const NODE_WHO = ['agent', 'person', 'system'] as const;
export const NODE_STATES = ['done', 'now', 'next', 'changed', 'removed'] as const;
export const EVENT_STATES = ['done', 'now', 'next', 'risk'] as const;

/** The keys each visual kind has (stored: all of them; given: any of them but kind/title/caption optional ones). */
const VISUAL_KEYS: Record<VisualKind, readonly string[]> = {
  bar: ['kind', 'title', 'caption', 'unit', 'x', 'series', 'highlight', 'better'],
  line: ['kind', 'title', 'caption', 'unit', 'x', 'series', 'highlight', 'better'],
  stacked_bar: ['kind', 'title', 'caption', 'unit', 'x', 'series', 'highlight', 'better'],
  number: ['kind', 'title', 'caption', 'value', 'unit', 'delta', 'trend', 'better'],
  flow: ['kind', 'title', 'caption', 'nodes', 'edges'],
  before_after: ['kind', 'title', 'caption', 'before', 'after'],
  timeline: ['kind', 'title', 'caption', 'events'],
  image: ['kind', 'title', 'caption', 'attachment'],
  image_pair: ['kind', 'title', 'caption', 'before', 'after', 'labels'],
};
export const SUMMARY_INPUT_KEYS = [
  'headline',
  'ask',
  'answer',
  'recommendation',
  'confidence',
  'bullets',
  'details',
  'visuals',
  'noVisualWhy',
  'refs',
] as const;

/** Something in an HTML tag's shape: refused in visual texts (they are plain text). */
export const TAG_RE = /<[a-zA-Z/!]/;
/** An ISO date (2026-10-29), or date and time (2026-10-29T14:02, seconds and zone optional). */
export const ISO_DATE_RE =
  /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?)?$/;

// ---------- stored shapes (zod, for the app) ----------

const L = SUMMARY_LIMITS;
const num = z.number().finite().min(-L.maxAbs).max(L.maxAbs);
export const summaryRefSchema = z.object({
  kind: z.enum(REF_KINDS),
  id: z.string().min(1).max(L.refId),
  label: z.string().min(1).max(L.refLabel),
  /** https only; null when the ref points inside the thread. */
  url: z.string().max(L.url).nullable(),
});
export type SummaryRef = z.infer<typeof summaryRefSchema>;
export const summaryBulletSchema = z.object({
  text: z.string().min(1).max(L.bullet),
  refs: z.array(summaryRefSchema).max(L.bulletRefs),
});
export type SummaryBullet = z.infer<typeof summaryBulletSchema>;

const head = {
  title: z.string().min(1).max(L.title),
  caption: z.string().min(1).max(L.caption),
};
const better = z.enum(BETTER).nullable();
const chartSchema = (kind: (typeof CHART_KINDS)[number]) =>
  z.object({
    kind: z.literal(kind),
    ...head,
    unit: z.string().max(L.unit).nullable(),
    x: z.array(z.string().min(1).max(L.xLabel)).min(L.minPoints).max(L.points),
    series: z
      .array(
        z.object({ name: z.string().min(1).max(L.seriesName), values: z.array(num.nullable()) }),
      )
      .min(kind === 'stacked_bar' ? 2 : 1)
      .max(L.series),
    /** The index of x to emphasise (this release, today). */
    highlight: z.number().int().min(0).nullable(),
    /** Which way is good (colours the change). */
    better,
  });
const attachmentRef = z.string().min(1).max(L.attachmentId);
const pairLabel = z.string().min(1).max(L.pairLabel);
const side = z.object({
  label: z.string().min(1).max(L.sideLabel).nullable(),
  lines: z.array(z.string().min(1).max(L.line)).min(1).max(L.lines),
});
export const visualSchema = z.discriminatedUnion('kind', [
  chartSchema('bar'),
  chartSchema('line'),
  chartSchema('stacked_bar'),
  z.object({
    kind: z.literal('number'),
    ...head,
    value: num,
    unit: z.string().max(L.unit).nullable(),
    delta: num.nullable(),
    trend: z.array(num).min(L.minPoints).max(L.points).nullable(),
    better,
  }),
  z.object({
    kind: z.literal('flow'),
    ...head,
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(L.nodeId),
          label: z.string().min(1).max(L.nodeLabel),
          who: z.enum(NODE_WHO).nullable(),
          state: z.enum(NODE_STATES).nullable(),
        }),
      )
      .min(L.minNodes)
      .max(L.nodes),
    /** Empty: a straight sequence in node order. */
    edges: z
      .array(
        z.object({
          from: z.string(),
          to: z.string(),
          label: z.string().min(1).max(L.edgeLabel).nullable(),
        }),
      )
      .max(L.edges),
  }),
  z.object({ kind: z.literal('before_after'), ...head, before: side, after: side }),
  z.object({
    kind: z.literal('timeline'),
    ...head,
    events: z
      .array(
        z.object({
          at: z.string().regex(ISO_DATE_RE),
          label: z.string().min(1).max(L.eventLabel),
          state: z.enum(EVENT_STATES).nullable(),
        }),
      )
      .min(L.minEvents)
      .max(L.events),
  }),
  /** A screenshot or picture: an image attachment of this thread. */
  z.object({ kind: z.literal('image'), ...head, attachment: attachmentRef }),
  /** Before and after screenshots, side by side (stacked on phones). */
  z.object({
    kind: z.literal('image_pair'),
    ...head,
    before: attachmentRef,
    after: attachmentRef,
    /** Null: "Before", "After". */
    labels: z.tuple([pairLabel, pairLabel]).nullable(),
  }),
]);
export type Visual = z.infer<typeof visualSchema>;
export type ChartVisual = Extract<Visual, { kind: 'bar' | 'line' | 'stacked_bar' }>;

const summaryFields = {
  memberUid: z.string(),
  threadId: z.string(),
  /** 1, 2, … */
  version: z.number().int().min(1),
  /** The agent that wrote it (the thread's home agent). */
  by: z.string(),
  at: timestamp,
  /** What this thread is, in one line. */
  headline: z.string().min(1).max(L.headline),
  /** The question to the member, set only while a person step or a proposal waits. */
  ask: z.string().max(L.ask).nullable(),
  /** The one-line answer or state. */
  answer: z.string().max(L.answer).nullable(),
  recommendation: z
    .object({ action: z.string().min(1).max(L.recAction), why: z.string().min(1).max(L.recWhy) })
    .nullable(),
  confidence: z.enum(OUTCOME_CONFIDENCE).nullable(),
  bullets: z.array(summaryBulletSchema).min(1).max(L.bullets),
  /** Markdown, rendered by the safe renderer. */
  details: z.string().max(L.details).nullable(),
  visuals: z.array(visualSchema).max(L.visuals),
  /** Why there is no visual (required when `ask` is set and there are no visuals). */
  noVisualWhy: z.string().max(L.noVisualWhy).nullable(),
  refs: z.array(summaryRefSchema).max(L.refs),
  /** What the agent had read: the thread's last event and its live plan's cursor. */
  basis: z.object({ lastEventId: z.string().nullable(), planCursor: z.number().int().nullable() }),
  lastEventId: z.string(),
};
export const inboxSummarySchema = z.object(summaryFields);
export type InboxSummary = z.infer<typeof inboxSummarySchema>;
/** A version doc holds the same fields. */
export const inboxSummaryVersionSchema = inboxSummarySchema;

export const summaryPaths = {
  summary: (w: string, t: string) => `workspaces/${w}/inboxSummaries/${t}`,
  version: (w: string, t: string, v: number) => `workspaces/${w}/inboxSummaryVersions/${t}_${v}`,
} as const;

/** What the agent gives (thread_summary): the fields minus the server ones. */
export type SummaryContent = Pick<
  InboxSummary,
  | 'headline'
  | 'ask'
  | 'answer'
  | 'recommendation'
  | 'confidence'
  | 'bullets'
  | 'details'
  | 'visuals'
  | 'noVisualWhy'
  | 'refs'
>;

// ---------- checkSummary ----------

function fail(msg: string): never {
  throw new ActionError(msg);
}
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const absent = (v: unknown) => v === undefined || v === null;

function obj(where: string, v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isObj(v)) fail(`${where}: an object`);
  const extra = Object.keys(v)
    .filter((k) => !keys.includes(k))
    .sort();
  if (extra.length) fail(`${where}: unknown field "${extra[0]}"`);
  return v;
}
function list(where: string, v: unknown): unknown[] {
  if (!Array.isArray(v)) fail(`${where}: a list`);
  return v;
}
/** A text: trimmed, 1..max characters; null when optional and absent or empty. */
function text(where: string, v: unknown, max: number, required: boolean, plain = false) {
  if (absent(v)) {
    if (required) fail(`${where}: required`);
    return null;
  }
  if (typeof v !== 'string') fail(`${where}: a text`);
  const t = v.trim();
  if (t === '') {
    if (required) fail(`${where}: required`);
    return null;
  }
  if (t.length > max) fail(`${where}: at most ${max} characters`);
  if (plain && TAG_RE.test(t)) fail(`${where}: plain text only (no HTML)`);
  return t;
}
const need = (where: string, v: unknown, max: number, plain = false) =>
  text(where, v, max, true, plain) as string;
const opt = (where: string, v: unknown, max: number, plain = false) =>
  text(where, v, max, false, plain);
function oneOf<T extends string>(where: string, v: unknown, all: readonly T[]): T | null {
  if (absent(v)) return null;
  if (typeof v !== 'string' || !(all as readonly string[]).includes(v))
    fail(`${where}: one of ${all.join(', ')}`);
  return v as T;
}
function number(where: string, v: unknown, required: boolean): number | null {
  if (absent(v)) {
    if (required) fail(`${where}: required`);
    return null;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > L.maxAbs)
    fail(`${where}: a number, at most ${L.maxAbs} either way`);
  return v;
}
/** A list's length within min..max, said as "<where>: 25 points, at most 24". */
function count(where: string, n: number, min: number, max: number, unit: string) {
  if (n < min) fail(`${where}: ${n} ${unit}, at least ${min}`);
  if (n > max) fail(`${where}: ${n} ${unit}, at most ${max}`);
}

function ref(where: string, v: unknown): SummaryRef {
  const r = obj(where, v, ['kind', 'id', 'label', 'url']);
  const kind = oneOf(`${where} kind`, r.kind, REF_KINDS);
  if (!kind) fail(`${where} kind: required`);
  const id = need(`${where} id`, r.id, L.refId);
  const label = need(`${where} label`, r.label, L.refLabel);
  const url = opt(`${where} url`, r.url, L.url);
  if (url !== null && !/^https:\/\/\S+$/.test(url)) fail(`${where} url: an https link`);
  if (kind === 'link' && url === null) fail(`${where} url: required for a link`);
  return { kind, id, label, url };
}

function chart(where: string, v: Record<string, unknown>, kind: (typeof CHART_KINDS)[number]) {
  const x = list(`${where} x`, v.x);
  count(where, x.length, L.minPoints, L.points, 'points');
  const xs = x.map((e, i) => need(`${where} x ${i + 1}`, e, L.xLabel, true));
  const series = list(`${where} series`, v.series);
  count(where, series.length, kind === 'stacked_bar' ? 2 : 1, L.series, 'series');
  const ss = series.map((e, i) => {
    const w = `${where} series ${i + 1}`;
    const s = obj(w, e, ['name', 'values']);
    const name = need(`${w} name`, s.name, L.seriesName, true);
    const values = list(`${w} values`, s.values);
    if (values.length !== xs.length) fail(`${w}: ${values.length} values for ${xs.length} points`);
    return { name, values: values.map((n, j) => number(`${w} value ${j + 1}`, n, false)) };
  });
  let highlight: number | null = null;
  if (!absent(v.highlight)) {
    const h = v.highlight;
    if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h >= xs.length)
      fail(`${where} highlight: an index of x, 0 to ${xs.length - 1}`);
    highlight = h;
  }
  return {
    kind,
    unit: opt(`${where} unit`, v.unit, L.unit, true),
    x: xs,
    series: ss,
    highlight,
    better: oneOf(`${where} better`, v.better, BETTER),
  };
}

function visual(where: string, raw: unknown): Visual {
  if (!isObj(raw)) fail(`${where}: an object`);
  const kind = oneOf(`${where} kind`, raw.kind, VISUAL_KINDS);
  if (!kind) fail(`${where} kind: required`);
  const v = obj(where, raw, VISUAL_KEYS[kind]);
  const title = need(`${where} title`, v.title, L.title, true);
  const caption = need(`${where} caption`, v.caption, L.caption, true);
  const top = { title, caption };
  switch (kind) {
    case 'bar':
    case 'line':
    case 'stacked_bar': {
      const c = chart(where, v, kind);
      return {
        kind: c.kind,
        ...top,
        unit: c.unit,
        x: c.x,
        series: c.series,
        highlight: c.highlight,
        better: c.better,
      } as Visual;
    }
    case 'number': {
      const value = number(`${where} value`, v.value, true) as number;
      const unit = opt(`${where} unit`, v.unit, L.unit, true);
      const delta = number(`${where} delta`, v.delta, false);
      let trend: number[] | null = null;
      if (!absent(v.trend)) {
        const t = list(`${where} trend`, v.trend);
        count(`${where} trend`, t.length, L.minPoints, L.points, 'points');
        trend = t.map((n, i) => number(`${where} trend ${i + 1}`, n, true) as number);
      }
      return {
        kind,
        ...top,
        value,
        unit,
        delta,
        trend,
        better: oneOf(`${where} better`, v.better, BETTER),
      };
    }
    case 'flow': {
      const nodes = list(`${where} nodes`, v.nodes);
      count(where, nodes.length, L.minNodes, L.nodes, 'nodes');
      const seen = new Set<string>();
      const ns = nodes.map((e, i) => {
        const w = `${where} node ${i + 1}`;
        const n = obj(w, e, ['id', 'label', 'who', 'state']);
        const id = need(`${w} id`, n.id, L.nodeId, true);
        if (seen.has(id)) fail(`${w} id: "${id}" is used twice`);
        seen.add(id);
        return {
          id,
          label: need(`${w} label`, n.label, L.nodeLabel, true),
          who: oneOf(`${w} who`, n.who, NODE_WHO),
          state: oneOf(`${w} state`, n.state, NODE_STATES),
        };
      });
      const edges = absent(v.edges) ? [] : list(`${where} edges`, v.edges);
      if (edges.length > L.edges) fail(`${where}: ${edges.length} edges, at most ${L.edges}`);
      const es = edges.map((e, i) => {
        const w = `${where} edge ${i + 1}`;
        const d = obj(w, e, ['from', 'to', 'label']);
        const from = need(`${w} from`, d.from, L.nodeId, true);
        if (!seen.has(from)) fail(`${w} from: no node "${from}"`);
        const to = need(`${w} to`, d.to, L.nodeId, true);
        if (!seen.has(to)) fail(`${w} to: no node "${to}"`);
        return { from, to, label: opt(`${w} label`, d.label, L.edgeLabel, true) };
      });
      return { kind, ...top, nodes: ns, edges: es };
    }
    case 'before_after': {
      const sideOf = (name: 'before' | 'after') => {
        const w = `${where} ${name}`;
        const s = obj(w, v[name], ['label', 'lines']);
        const lines = list(`${w} lines`, s.lines);
        count(w, lines.length, 1, L.lines, 'lines');
        return {
          label: opt(`${w} label`, s.label, L.sideLabel, true),
          lines: lines.map((l, i) => need(`${w} line ${i + 1}`, l, L.line, true)),
        };
      };
      return { kind, ...top, before: sideOf('before'), after: sideOf('after') };
    }
    case 'timeline': {
      const events = list(`${where} events`, v.events);
      count(where, events.length, L.minEvents, L.events, 'events');
      const es = events.map((e, i) => {
        const w = `${where} event ${i + 1}`;
        const d = obj(w, e, ['at', 'label', 'state']);
        const at = need(`${w} at`, d.at, 40);
        if (!ISO_DATE_RE.test(at))
          fail(`${w} at: an ISO date (2026-10-29) or date and time (2026-10-29T14:00Z)`);
        return {
          at,
          label: need(`${w} label`, d.label, L.eventLabel, true),
          state: oneOf(`${w} state`, d.state, EVENT_STATES),
        };
      });
      return { kind, ...top, events: es };
    }
    case 'image':
      return {
        kind,
        ...top,
        attachment: need(`${where} attachment`, v.attachment, L.attachmentId),
      };
    case 'image_pair': {
      const before = need(`${where} before`, v.before, L.attachmentId);
      const after = need(`${where} after`, v.after, L.attachmentId);
      let labels: [string, string] | null = null;
      if (!absent(v.labels)) {
        const l = list(`${where} labels`, v.labels);
        if (l.length !== 2) fail(`${where} labels: two labels (before, after)`);
        labels = [
          need(`${where} label 1`, l[0], L.pairLabel, true),
          need(`${where} label 2`, l[1], L.pairLabel, true),
        ];
      }
      return { kind, ...top, before, after, labels };
    }
  }
}

/** The attachment ids a visual names (images only). */
export function visualAttachments(v: Visual): string[] {
  if (v.kind === 'image') return [v.attachment];
  if (v.kind === 'image_pair') return [v.before, v.after];
  return [];
}

/**
 * Checks what an agent gives as a summary and returns it cleaned (texts trimmed, every stored
 * key present, null when not given). Throws an ActionError with a plain message ("bullets: 6
 * bullets, at most 5", "visual 2: 25 points, at most 24").
 */
export function checkSummary(input: unknown): SummaryContent {
  const s = obj('summary', input, SUMMARY_INPUT_KEYS);
  const headline = need('headline', s.headline, L.headline);
  const ask = opt('ask', s.ask, L.ask);
  const answer = opt('answer', s.answer, L.answer);
  let recommendation: SummaryContent['recommendation'] = null;
  if (!absent(s.recommendation)) {
    const r = obj('recommendation', s.recommendation, ['action', 'why']);
    recommendation = {
      action: need('recommendation action', r.action, L.recAction),
      why: need('recommendation why', r.why, L.recWhy),
    };
  }
  const confidence = oneOf('confidence', s.confidence, OUTCOME_CONFIDENCE);
  if (absent(s.bullets)) fail('bullets: required (1 to 5)');
  const bl = list('bullets', s.bullets);
  count('bullets', bl.length, 1, L.bullets, 'bullets');
  const bullets = bl.map((e, i) => {
    const w = `bullet ${i + 1}`;
    const b = typeof e === 'string' ? { text: e } : obj(w, e, ['text', 'refs']);
    const refs = absent(b.refs) ? [] : list(`${w} refs`, b.refs);
    if (refs.length > L.bulletRefs) fail(`${w}: ${refs.length} refs, at most ${L.bulletRefs}`);
    return {
      text: need(`${w} text`, b.text, L.bullet),
      refs: refs.map((r, j) => ref(`${w} ref ${j + 1}`, r)),
    };
  });
  const details = opt('details', s.details, L.details);
  const vl = absent(s.visuals) ? [] : list('visuals', s.visuals);
  if (vl.length > L.visuals) fail(`visuals: ${vl.length} visuals, at most ${L.visuals}`);
  const visuals = vl.map((v, i) => visual(`visual ${i + 1}`, v));
  const noVisualWhy = opt('noVisualWhy', s.noVisualWhy, L.noVisualWhy);
  const rl = absent(s.refs) ? [] : list('refs', s.refs);
  if (rl.length > L.refs) fail(`refs: ${rl.length} refs, at most ${L.refs}`);
  const refs = rl.map((r, i) => ref(`ref ${i + 1}`, r));
  if (ask !== null && visuals.length === 0 && noVisualWhy === null)
    fail(
      'At a person step add a visual or say why there is none: a chart for data, before/after screenshots (thread_attach both, then an image_pair) or a flow for a change, or noVisualWhy in one line.',
    );
  return {
    headline,
    ask,
    answer,
    recommendation,
    confidence,
    bullets,
    details,
    visuals,
    noVisualWhy,
    refs,
  };
}

// ---------- writeSummary ----------

export interface SummaryBasis {
  /** The thread's last event when the agent read it. */
  lastEventId: string | null;
  /** Its live plan's cursor then (null: no live plan). */
  planCursor: number | null;
}

export interface WriteSummaryInput {
  threadId: string;
  thread: ThreadStateOf;
  /** The current summary (null: none yet). */
  current: { version: number } | null;
  /** The version the agent read (0 when there was none): no lost updates. */
  baseVersion: number;
  /** What the agent gives (checkSummary). */
  summary: unknown;
  basis: SummaryBasis;
  /** The thread's attachments as {id: kind}: image visuals must name its images. */
  attachments?: Readonly<Record<string, string>>;
}

/** The thread's mirror of its summary (one read for Today and the Inbox list). */
export function summaryMirror(v: number, c: SummaryContent, at: unknown = SERVER_TIME) {
  return {
    version: v,
    at,
    headline: c.headline,
    ask: c.ask,
    answer: c.answer,
    recAction: c.recommendation?.action ?? null,
    confidence: c.confidence,
  };
}

/**
 * The home agent writes the thread's summary (thread_summary), as the last call after every
 * change it made to the thread. One batch: the summary doc (version + 1), its version doc (the
 * one 20 versions back deleted), the thread's mirror (which stamps updatedAt, so the summary is
 * fresh) and one `summary.written` event.
 */
export function writeSummary(
  ctx: ActionContext,
  input: WriteSummaryInput,
): ActionPlan & { version: number } {
  requireAgent(ctx);
  const t = input.thread;
  if (t.fetchedBy !== ctx.actor.id)
    fail("Only the thread's home agent (the one that brought it in) writes its summary.");
  const cur = input.current?.version ?? 0;
  const base = input.baseVersion;
  if (typeof base !== 'number' || !Number.isInteger(base) || base < 0)
    fail('baseVersion: the summary version you read (thread_read), 0 when there is none.');
  if (base !== cur)
    fail(
      cur === 0
        ? 'This thread has no summary yet: write it with baseVersion 0.'
        : `The summary moved on to v${cur}: re-read the thread (thread_read), then write it with baseVersion ${cur}.`,
    );
  const content = checkSummary(input.summary);
  const atts = input.attachments ?? {};
  content.visuals.forEach((v, i) => {
    for (const aid of visualAttachments(v)) {
      if (!isThreadAttachmentOf(aid, input.threadId))
        fail(`visual ${i + 1}: "${aid}" is not an attachment of this thread`);
      if (atts[aid] !== 'image')
        fail(
          `visual ${i + 1}: no image "${aid}" on this thread (attach the screenshot with thread_attach first)`,
        );
    }
  });
  const b = input.basis;
  const basis: SummaryBasis = {
    lastEventId: b?.lastEventId ?? null,
    planCursor: b?.planCursor ?? null,
  };
  if (basis.lastEventId !== null && basis.lastEventId.length > L.basisEventId)
    fail(`basis lastEventId: at most ${L.basisEventId} characters`);
  if (basis.planCursor !== null && (!Number.isInteger(basis.planCursor) || basis.planCursor < 0))
    fail('basis planCursor: a step index');
  const version = cur + 1;
  const w = ctx.workspaceId;
  const p = inboxPlan(
    ctx,
    'summary.written',
    { memberUid: t.memberUid, threadId: input.threadId, subjectId: t.subjectId },
    { version },
    (eventId) => {
      const doc = {
        memberUid: t.memberUid,
        threadId: input.threadId,
        version,
        by: ctx.actor.id,
        at: SERVER_TIME,
        ...content,
        basis,
        lastEventId: eventId,
      };
      const ops: WriteOp[] = [
        { kind: 'set', path: summaryPaths.summary(w, input.threadId), data: doc },
        { kind: 'set', path: summaryPaths.version(w, input.threadId, version), data: doc },
      ];
      if (version > L.versionsKept)
        ops.push({
          kind: 'delete',
          path: summaryPaths.version(w, input.threadId, version - L.versionsKept),
        });
      ops.push({
        kind: 'update',
        path: inboxPaths.thread(w, input.threadId),
        data: {
          summary: summaryMirror(version, content),
          updatedAt: SERVER_TIME,
          lastEventId: eventId,
        },
      });
      return ops;
    },
  );
  return { ...p, version };
}

// ---------- freshness ----------

type Ms = { toMillis(): number } | null | undefined;
/**
 * none: never summarized; fresh: written at or after the thread's last change; stale: the
 * thread changed since (the page says "May be out of date").
 */
export function summaryFreshness(t: {
  updatedAt?: Ms;
  summary?: { at?: Ms } | null;
}): 'none' | 'fresh' | 'stale' {
  if (!t.summary) return 'none';
  const at = t.summary.at?.toMillis();
  const up = t.updatedAt?.toMillis();
  if (at === undefined || up === undefined) return 'fresh';
  return at >= up ? 'fresh' : 'stale';
}

/** Whether the home agent's session should ask for a summary now (`summarize`). */
export function summarizeDue(
  t: { updatedAt?: Ms; summary?: { at?: Ms } | null },
  nowMs: number,
): boolean {
  if (summaryFreshness(t) === 'fresh') return false;
  const up = t.updatedAt?.toMillis();
  return up !== undefined && nowMs - up >= SUMMARIZE_AFTER_MS;
}

// ---------- rules ----------

/**
 * The generated block of firestore.rules that checks a summary's bullets and visuals, from the
 * limits above: shapes (only the known keys), kinds, counts (points, series, nodes, edges, lines,
 * events) and plain-text titles and captions. Kept equal by scripts/summary-rules.test.mjs
 * (UPDATE_GO_CONTRACT=1 pnpm test:scripts rewrites it). Firestore evaluates at most 1000
 * expressions per document, so the checks stay at that level (per-label texts, values per point
 * and edge ends are checkSummary's), and are spread over the batch: the summary doc checks the
 * top fields, its version copy the visuals, the thread's mirror the bullets.
 */
export function summaryRulesBlock(): string {
  const q = (l: readonly string[]) => `[${l.map((k) => `'${k}'`).join(', ')}]`;
  const unroll = (fn: string, n: number, more = '') =>
    Array.from({ length: n }, (_, i) => `(l.size() <= ${i} || ${fn}(l[${i}]${more}))`).join(
      '\n    && ',
    );
  const size = (v: string, min: number, max: number) =>
    `${v} is list && ${v}.size() >= ${min} && ${v}.size() <= ${max}`;
  const lines = [
    '// BEGIN summary checks (generated from packages/shared/src/summary.ts by',
    '// UPDATE_GO_CONTRACT=1 pnpm test:scripts; do not edit by hand)',
    `function summaryPlain(v, max) { return str(v, 1, max) && !v.matches('(?s).*<[a-zA-Z/!].*'); }`,
    'function summaryBulletOk(b) {',
    `  return b.keys().hasOnly(['text', 'refs']) && str(b.text, 1, ${L.bullet}) && b.refs.size() <= ${L.bulletRefs};`,
    '}',
    'function summaryBulletsOk(l) {',
    `  return ${size('l', 1, L.bullets)}`,
    `    && ${unroll('summaryBulletOk', L.bullets)};`,
    '}',
    "function summaryAtt(a, t) { return a.matches(t + '_[A-Za-z0-9]{1,40}'); }",
    'function summaryVisualOk(v, t) {',
    `  return v.kind in ${q(VISUAL_KINDS)}`,
    `    && summaryPlain(v.title, ${L.title}) && summaryPlain(v.caption, ${L.caption})`,
    `    && (v.kind in ${q(CHART_KINDS)} ? ${size('v.x', L.minPoints, L.points)}`,
    `        && ${size('v.series', 1, L.series)} && (v.kind != 'stacked_bar' || v.series.size() >= 2)`,
    `      : v.kind == 'number' ? v.value is number && (v.trend == null || v.trend.size() <= ${L.points})`,
    `      : v.kind == 'flow' ? ${size('v.nodes', L.minNodes, L.nodes)} && v.edges.size() <= ${L.edges}`,
    `      : v.kind == 'before_after' ? v.before.lines.size() <= ${L.lines} && v.after.lines.size() <= ${L.lines}`,
    `      : v.kind == 'image' ? summaryAtt(v.attachment, t)`,
    `      : v.kind == 'image_pair' ? summaryAtt(v.before, t) && summaryAtt(v.after, t)`,
    `      : ${size('v.events', L.minEvents, L.events)});`,
    '}',
    'function summaryVisualsOk(l, t) {',
    `  return l.size() <= ${L.visuals}`,
    `    && ${unroll('summaryVisualOk', L.visuals, ', t')};`,
    '}',
    '// END summary checks',
  ];
  return lines
    .join('\n')
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}
