import type { Decision } from '@hive/shared';
import { isSentBack, outcomeName } from '../lib/outcomes';

/** A decision as stored, with its id and the project it belongs to. */
export interface DecisionRow {
  id: string;
  pid: string;
  d: Omit<Decision, 'at'> & { at: { toMillis: () => number } };
}

export const RANGES = [7, 30, 90] as const;
export type Range = (typeof RANGES)[number];
export const DAY = 86_400_000;

export function parseRange(v: unknown): Range {
  const n = Number(v);
  return (RANGES as readonly number[]).includes(n) ? (n as Range) : 30;
}

/** Start of the window: the local midnight `days` days back, so the query key is stable all day. */
export function rangeStart(days: number, now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime() - (days - 1) * DAY;
}

const at = (r: DecisionRow) => r.d.at.toMillis();

/** Gate decisions (approve, send back, stop); answering a question is not a gate decision. */
const isGate = (r: DecisionRow) => r.d.outcome !== 'answered';

export function inRange(rows: readonly DecisionRow[], since: number): DecisionRow[] {
  return rows.filter((r) => at(r) >= since);
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export interface Kpis {
  made: number;
  approved: number;
  /** Share (0-100) of gates where the first decision on the item at that step was an approval. */
  firstTimePct: number | null;
  sentBack: number;
  stopped: number;
  /** Where items were sent back to, most first. */
  sentBackTo: Array<{ step: string; count: number }>;
  /** Median time an item waited for a decision, in ms. */
  medianWaitMs: number | null;
}

/** Resolves a step id of a decision's project to a name (so projects with the same steps add up). */
export type StepName = (r: DecisionRow, stepId: string) => string;
const byId: StepName = (_r, id) => id;

export function computeKpis(rows: readonly DecisionRow[], nameOf: StepName = byId): Kpis {
  const gate = rows.filter(isGate).sort((a, b) => at(a) - at(b));
  const first = new Map<string, DecisionRow>();
  for (const r of gate) {
    const k = `${r.pid}/${r.d.itemId}/${r.d.stepId}`;
    if (!first.has(k)) first.set(k, r);
  }
  const firstApproved = [...first.values()].filter((r) => r.d.outcome === 'approved').length;
  const to = new Map<string, number>();
  for (const r of gate)
    if (isSentBack(r.d.outcome) && r.d.toStepId)
      to.set(nameOf(r, r.d.toStepId), (to.get(nameOf(r, r.d.toStepId)) ?? 0) + 1);
  const waits = gate.flatMap((r) => (r.d.waitMs === undefined ? [] : [r.d.waitMs]));
  return {
    made: gate.length,
    approved: gate.filter((r) => r.d.outcome === 'approved').length,
    firstTimePct: first.size ? Math.round((firstApproved / first.size) * 100) : null,
    sentBack: gate.filter((r) => isSentBack(r.d.outcome)).length,
    stopped: gate.filter((r) => r.d.outcome === 'stopped').length,
    sentBackTo: [...to].map(([step, count]) => ({ step, count })).sort((a, b) => b.count - a.count),
    medianWaitMs: median(waits),
  };
}

/** How often each tag was used on a send back (stops excluded), most first. */
export function tagCounts(rows: readonly DecisionRow[]): Array<{ tag: string; count: number }> {
  const m = new Map<string, number>();
  for (const r of rows)
    if (isSentBack(r.d.outcome)) for (const t of new Set(r.d.tags)) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export type OutcomeFilter = 'all' | Decision['outcome'];
export interface LogFilter {
  step: string;
  outcome: OutcomeFilter;
  person: string;
  tag: string;
  search: string;
}
export const NO_FILTER: LogFilter = { step: '', outcome: 'all', person: '', tag: '', search: '' };

/** Newest first. `step` is the name of the step the decision was made at. */
export function filterLog(
  rows: readonly DecisionRow[],
  f: LogFilter,
  nameOf: StepName = byId,
): DecisionRow[] {
  const q = f.search.trim().toLowerCase();
  return rows
    .filter(
      (r) =>
        (!f.step || nameOf(r, r.d.stepId) === f.step) &&
        (f.outcome === 'all' || r.d.outcome === f.outcome) &&
        (!f.person || r.d.byUid === f.person) &&
        (!f.tag || r.d.tags.includes(f.tag)) &&
        (!q || r.d.rationale.toLowerCase().includes(q)),
    )
    .sort((a, b) => at(b) - at(a));
}

/** The latest decisions that carry a reason worth reading. */
export function latestRationales(rows: readonly DecisionRow[], n: number): DecisionRow[] {
  return rows
    .filter((r) => r.d.rationale.trim().length > 0)
    .sort((a, b) => at(b) - at(a))
    .slice(0, n);
}

export function formatWait(ms: number | null): string {
  if (ms === null) return 'n/a';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1 min';
  if (min < 60) return `${min} min`;
  const h = ms / 3_600_000;
  if (h < 48) return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
  return `${Math.round(h / 24)} d`;
}

export function outcomeLabel(
  r: DecisionRow,
  stepName: (id: string) => string,
): { glyph: string; text: string } {
  switch (r.d.outcome) {
    case 'approved':
      return { glyph: '✓', text: 'Approved' };
    case 'sentBack':
      return {
        glyph: '↩',
        text: `Sent back to ${r.d.toStepId ? stepName(r.d.toStepId) : 'an earlier step'}`,
      };
    case 'stopped':
      return { glyph: '■', text: 'Stopped' };
    default:
      return { glyph: '?', text: 'Answered' };
  }
}

/** A CSV cell. Quotes when needed, and defuses spreadsheet formulas (=, +, -, @ at the start). */
function cell(v: string): string {
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_BOM = '﻿';

/** UTF-8 BOM first so Excel reads accents; ISO 8601 UTC dates; CRLF line ends. */
export function toCsv(
  rows: readonly DecisionRow[],
  names: {
    step: (id: string) => string;
    person: (uid: string) => string;
    project: (pid: string) => string;
  },
): string {
  const head = [
    'When (UTC)',
    'Project',
    'Item',
    'Step',
    'Decision',
    'Sent back to',
    'By',
    'Tags',
    'Rationale',
  ];
  const lines = [head.map(cell).join(',')];
  for (const r of rows) {
    lines.push(
      [
        new Date(at(r)).toISOString(),
        names.project(r.pid),
        r.d.itemTitle,
        names.step(r.d.stepId),
        outcomeName(r.d.outcome),
        isSentBack(r.d.outcome) && r.d.toStepId ? names.step(r.d.toStepId) : '',
        names.person(r.d.byUid),
        r.d.tags.join('; '),
        r.d.rationale,
      ]
        .map(cell)
        .join(','),
    );
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}

/** Milliseconds an item has been waiting, from its last update. Stored with the decision. */
export function waitedMs(
  item: { updatedAt: { toMillis: () => number } },
  now = Date.now(),
): number {
  return Math.max(0, now - item.updatedAt.toMillis());
}
