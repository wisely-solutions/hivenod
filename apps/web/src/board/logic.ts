import {
  activelyWorked,
  STATUS_ASK_EVERY_MS,
  statusAskOf,
  statusAskOpen,
  isOnHold,
  parkOf,
  silenceOf,
  silenceText,
  statusLine,
  statusOf,
  STALE_CLAIM_MINUTES,
  type Agent,
  type Item,
  type Notified,
  type Project,
  type Step,
} from '@hive/shared';
import { colorIndex, heldCounts, presenceText } from '../agents/logic';
import type { Row } from '../lib/live';
import type { ItemCardData } from '../ui/card';
import { needsMyDecision } from '../shell/logic';
import { gateWaitNote, NO_REMINDERS } from '../notify/note';
import { approvedAt, pathView } from './path';

export type ItemRow = Row<Item>;

/** An item is being worked when its claim has a recent heartbeat and it is not parked (QjTTL). */
export function isItemLive(item: Item, now: number): boolean {
  return (
    item.status === 'working' &&
    !!item.claim &&
    now - item.claim.heartbeatAt.toMillis() < STALE_CLAIM_MINUTES * 60_000 &&
    !parkOf(item)
  );
}

/** "14:05" today, else "27 Oct, 14:05", in the viewer's time zone (item QjTTL). */
export function sinceText(ms: number, now: number): string {
  const d = new Date(ms);
  if (d.toDateString() !== new Date(now).toDateString()) return approvedAt(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Items per step, in board order (Intake order is the priority the people set). */
export function groupByStep(steps: readonly Step[], items: readonly ItemRow[]) {
  const out: Record<string, ItemRow[]> = Object.fromEntries(steps.map((s) => [s.id, []]));
  for (const row of items) out[row.data.stepId]?.push(row);
  for (const list of Object.values(out)) list.sort((a, b) => a.data.order - b.data.order);
  return out;
}

export interface StepStats {
  count: number;
  live: number;
  sendBacks: number;
  progress: { done: number; total: number } | null;
  /** Items in this gate where the person still has to decide. */
  mine: number;
  /** Items holding an open agent question or held at the step (stuck): worth a badge when folded. */
  attention: number;
}

export function stepStats(
  project: Project,
  list: readonly ItemRow[],
  uid: string,
  now: number,
): StepStats {
  let done = 0;
  let total = 0;
  let has = false;
  for (const { data } of list) {
    if (data.progress && data.progress.total > 0) {
      has = true;
      done += data.progress.done;
      total += data.progress.total;
    }
  }
  return {
    count: list.length,
    live: list.filter((r) => isItemLive(r.data, now)).length,
    sendBacks: list.reduce((n, r) => n + r.data.sendBackCount, 0),
    progress: has ? { done, total } : null,
    mine: list.filter((r) => needsMyDecision(project, r.data, uid)).length,
    attention: list.filter(
      (r) => r.data.awaitingAnswer != null || r.data.workStopped?.mode === 'back',
    ).length,
  };
}

export interface CardContext {
  project: Project;
  agents: readonly Row<Agent>[];
  items: readonly ItemRow[];
  uid: string;
  now: number;
  /** What the notifier sent per item ("reminder sent"); absent in tests. */
  reminders?: ReadonlyMap<string, Notified>;
}

/** What the shared ItemCard shows for one item. */
export function cardData(row: ItemRow, ctx: CardContext): ItemCardData {
  const { data } = row;
  const step = ctx.project.steps.find((s) => s.id === data.stepId);
  const agentRow = data.claim ? ctx.agents.find((a) => a.id === data.claim?.agentUid) : undefined;
  const need = step?.kind === 'human' && step.gate ? requiredApprovals(step) : 0;
  const parent = data.parentItemId
    ? ctx.items.find((i) => i.id === data.parentItemId)?.data.title
    : undefined;
  const raisedBy = data.type === 'finding' && data.createdBy.type === 'agent';
  const foundAgent = raisedBy
    ? ctx.agents.find((a) => a.id === data.createdBy.id)?.data.name
    : undefined;
  // Parked by its agent (item QjTTL): held, waiting, not being worked.
  const parked = parkOf(data);
  const live = isItemLive(data, ctx.now);
  const held = agentRow ? heldCounts(agentRow.id, ctx.items, ctx.now) : null;
  return {
    id: row.id,
    title: data.title,
    type: data.type,
    progress: data.progress && data.progress.total > 0 ? data.progress : undefined,
    sendBacks: data.sendBackCount || undefined,
    attachments: attachmentCountLabel(data.attachmentCount) || undefined,
    agent: agentRow
      ? {
          name: agentRow.data.name,
          color: colorIndex(agentRow.data.color, agentRow.id),
          live,
          ...(held && held.waiting > 0 ? { presence: presenceText(held) } : {}),
        }
      : undefined,
    parked: parked
      ? { reason: parked.reason, since: sinceText(parked.at.toMillis(), ctx.now) }
      : undefined,
    ...statusView(data, ctx.now),
    approvals:
      need > 0 && data.gate && data.status === 'waiting'
        ? { have: Object.keys(data.gate.approvals).length, need }
        : undefined,
    waitingForYou: needsMyDecision(ctx.project, data, ctx.uid),
    waitNote:
      gateWaitNote({
        project: ctx.project,
        item: data,
        itemId: row.id,
        sinceMs: data.updatedAt.toMillis(),
        nowMs: ctx.now,
        reminders: ctx.reminders ?? NO_REMINDERS,
      }) ?? undefined,
    onHold: isOnHold(data) || undefined,
    pendingSync: row.pending,
    foundBy:
      data.type === 'finding'
        ? `${foundAgent ?? 'an agent'}${parent ? ` on ${parent}` : ''}`
        : undefined,
    path:
      data.type === 'finding'
        ? undefined
        : pathView({
            project: ctx.project,
            item: data,
            uid: ctx.uid,
            agent: agentRow ? { name: agentRow.data.name, live } : null,
          }),
  };
}

/**
 * The caption of a suggestion in the Ideas lane: who found it, on which item, and the first words
 * of the details. Falls back to the label stored when it was raised (the item may be closed).
 */
export function suggestionLine(
  row: ItemRow,
  items: readonly ItemRow[],
  agents: readonly Row<Agent>[],
): string {
  const d = row.data;
  const agent = agents.find((a) => a.id === d.createdBy.id)?.data.name;
  const parent = d.parentItemId
    ? items.find((i) => i.id === d.parentItemId)?.data.title
    : undefined;
  const who =
    agent || parent
      ? `Found by ${agent ?? 'an agent'}${parent ? ` while on “${parent}”` : ''}`
      : `Found by ${d.source.label}`;
  const details = d.summary.trim().replace(/\s+/g, ' ');
  return details ? `${who}: ${details}` : `${who}.`;
}

/** How many approvals a gate needs before the item moves on. */
export function requiredApprovals(step: Step): number {
  const g = step.gate;
  if (!g) return 0;
  const n = g.deciderUids.length;
  if (g.rule === 'any') return Math.min(1, n);
  if (g.rule === 'atLeast') return Math.min(g.n ?? 1, n);
  return n;
}

export interface ScrubberEntry {
  id: string;
  name: string;
  kind: Step['kind'];
  count: number;
  /** Items waiting for this person (gates only). */
  mine: number;
}

/**
 * The step the phone board is showing: the column whose left edge is closest to the left edge of the
 * scroller (what a snapped column sits on). Ids and lefts are in the same coordinate space.
 */
export function activeStepId(
  columns: ReadonlyArray<{ id: string; left: number }>,
  scrollerLeft: number,
): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of columns) {
    const d = Math.abs(c.left - scrollerLeft);
    if (d < bestD) {
      bestD = d;
      best = c.id;
    }
  }
  return best;
}

export function scrubber(
  project: Project,
  grouped: Record<string, ItemRow[]>,
  uid: string,
): ScrubberEntry[] {
  return project.steps.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    count: grouped[s.id]?.length ?? 0,
    mine: (grouped[s.id] ?? []).filter((r) => needsMyDecision(project, r.data, uid)).length,
  }));
}

// ---------- list view ----------

export type SortKey = 'title' | 'project' | 'step' | 'status' | 'agent' | 'waiting' | 'cost';
export interface ListFilter {
  stepId: string;
  status: string;
  text: string;
  /** An item type, or '' for any. */
  type: string;
  /** An agent's uid, or '' for any. */
  agent: string;
  /** Only items this person has to decide. */
  mine: boolean;
}
export const NO_FILTER: ListFilter = {
  stepId: '',
  status: '',
  text: '',
  type: '',
  agent: '',
  mine: false,
};

/** True when any chip or the search box narrows the list. */
export function isFiltered(f: ListFilter): boolean {
  return !!(f.stepId || f.status || f.text.trim() || f.type || f.agent || f.mine);
}

export interface ListRow {
  row: ItemRow;
  /** The project the item belongs to (the all-projects list mixes several). */
  pid: string;
  project: Project;
  stepIndex: number;
  stepName: string;
  agentName: string;
  /** This person has to decide on it. */
  mine: boolean;
}

/** Selection key: item ids are only unique inside a project. */
export const rowKey = (r: Pick<ListRow, 'pid' | 'row'>) => `${r.pid}:${r.row.id}`;

export function listRows(
  project: Project,
  items: readonly ItemRow[],
  agents: readonly Row<Agent>[],
  pid = '',
  uid = '',
): ListRow[] {
  return items.map((row) => {
    const stepIndex = project.steps.findIndex((s) => s.id === row.data.stepId);
    return {
      row,
      pid,
      project,
      stepIndex,
      stepName: project.steps[stepIndex]?.name ?? row.data.stepId,
      agentName: agents.find((a) => a.id === row.data.claim?.agentUid)?.data.name ?? '',
      mine: !!uid && needsMyDecision(project, row.data, uid),
    };
  });
}

export function filterAndSort(
  rows: readonly ListRow[],
  filter: ListFilter,
  sort: { key: SortKey; dir: 1 | -1 },
): ListRow[] {
  const text = filter.text.trim().toLowerCase();
  const kept = rows.filter(
    (r) =>
      (!filter.stepId || r.row.data.stepId === filter.stepId) &&
      (!filter.status || r.row.data.status === filter.status) &&
      (!filter.type || r.row.data.type === filter.type) &&
      (!filter.agent || r.row.data.claim?.agentUid === filter.agent) &&
      (!filter.mine || r.mine) &&
      (!text ||
        r.row.data.title.toLowerCase().includes(text) ||
        r.row.data.summary.toLowerCase().includes(text)),
  );
  const val = (r: ListRow): number | string => {
    const d = r.row.data;
    switch (sort.key) {
      case 'title':
        return d.title.toLowerCase();
      case 'project':
        return r.project.name.toLowerCase();
      case 'step':
        return r.stepIndex;
      case 'status':
        return d.status;
      case 'agent':
        return r.agentName.toLowerCase();
      case 'waiting':
        return d.updatedAt.toMillis();
      case 'cost':
        return d.costEur;
    }
  };
  return [...kept].sort((a, b) => {
    const x = val(a);
    const y = val(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c * sort.dir || a.row.id.localeCompare(b.row.id);
  });
}

/** Persisted fold state: ids of agent steps the person has opened. */
export function parseExpanded(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export type BoardLayout = 'columns' | 'rows';

/** Up to 5 steps sit side by side; 6 or more stack as full-width rows. */
export const ROWS_FROM_STEPS = 6;
export function defaultLayout(stepCount: number): BoardLayout {
  return stepCount >= ROWS_FROM_STEPS ? 'rows' : 'columns';
}

/** A saved layout choice, or null when none (or garbage) is stored. */
export function parseLayout(raw: string | null): BoardLayout | null {
  return raw === 'rows' || raw === 'columns' ? raw : null;
}

/** "1 attachment", "3 attachments"; empty when none (items older than the counter read as none). */
export function attachmentCountLabel(count: number | undefined): string {
  if (!count || count < 1) return '';
  return count === 1 ? '1 attachment' : `${count} attachments`;
}

export function attachmentSummary(list: ReadonlyArray<{ name: string }>): string {
  if (list.length === 0) return '';
  const first = list[0]!.name;
  return list.length === 1 ? first : `${first} · ${list.length - 1} more`;
}

/** The order value for an item dropped at `index` among `others` (already sorted, without it). */
export function orderAt(others: readonly number[], index: number): number {
  const prev = others[index - 1];
  const next = others[index];
  if (prev === undefined && next === undefined) return Date.now();
  if (prev === undefined) return (next as number) - 1000;
  if (next === undefined) return prev + 1000;
  return (prev + next) / 2;
}

type DragId = { id: string | number };

/**
 * Screen-reader text for dragging cards: item titles, never internal ids.
 * Hovering the dragged item itself says nothing (that would replace "Picked up" in the same
 * update), and dropping where it started says it did not move.
 */
export function dragAnnouncements(
  titleOf: (id: string | number) => string,
  outside: () => boolean = () => false,
  /** 1-based place of an item in its step, for "2 of 4". */
  placeOf: (id: string | number) => { index: number; total: number } | null = () => null,
) {
  const name = (id: string | number) => `item ${titleOf(id)}`;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const at = (id: string | number) => {
    const p = placeOf(id);
    return p ? ` Position ${p.index} of ${p.total}.` : '';
  };
  const same = (active: DragId, over: DragId | null) => !over || over.id === active.id;
  return {
    onDragStart: ({ active }: { active: DragId }) =>
      `Picked up ${name(active.id)}.${at(active.id)}`,
    onDragOver: ({ active, over }: { active: DragId; over: DragId | null }) =>
      same(active, over) || outside()
        ? undefined
        : cap(`${name(active.id)} is over ${name(over!.id)}.`) + at(over!.id),
    onDragEnd: ({ active, over }: { active: DragId; over: DragId | null }) =>
      same(active, over) || outside()
        ? `Dropped ${name(active.id)}. It did not move.` +
          (outside() ? ' Items change step only through agent work or a decision.' : '')
        : `Dropped ${name(active.id)} on ${name(over!.id)}.` + at(over!.id),
    onDragCancel: ({ active }: { active: DragId }) =>
      `Cancelled. ${cap(name(active.id))} stays where it was.`,
  };
}

// ---------- watching a run (card EmDyZyfC) ----------

/** An attachment counts as new for this long after the run produced it. */
export const NEW_ATTACHMENT_MS = 10 * 60_000;

export function isNewAttachment(at: number, now: number): boolean {
  return now - at >= 0 && now - at < NEW_ATTACHMENT_MS;
}

/** "3/6" and its tooltip, for the progress ring on cards. */
export function progressLabel(p: { done: number; total: number }): { short: string; long: string } {
  return { short: `${p.done}/${p.total}`, long: `${p.done} of ${p.total} steps done` };
}

/**
 * Who may change an item's title, type and description (card mpWuccjl): the person who added it
 * and admins. Mirrors the rule in firestore.rules (humanEdit); findings keep their type.
 */
export function canEditItem(
  item: { createdBy: { type: string; id: string } },
  uid: string,
  isAdmin: boolean,
): boolean {
  return isAdmin || (item.createdBy.type === 'human' && item.createdBy.id === uid);
}

/** Why a stopped item is in the Archived list (card rLntxm7C): what the person sees, in a word. */
export type StoppedKind = 'Cancelled' | 'Archived' | 'Rejected' | 'Deleting';
export function stoppedKind(
  item: Pick<Item, 'workStopped' | 'archivedAt'> & { erasing?: boolean },
): StoppedKind {
  if (item.erasing) return 'Deleting';
  if (item.workStopped) return 'Cancelled';
  if (item.archivedAt) return 'Archived';
  return 'Rejected';
}

/**
 * The reason shown under an Archived row: the cancel reason, or the rationale of the latest
 * "stopped" decision for a rejected item. Empty when none was given (an archive has no reason).
 */
export function stoppedReason(
  item: Pick<Item, 'workStopped' | 'archivedAt'>,
  rejections: readonly { itemId: string; rationale: string; at: number }[],
  itemId: string,
): string {
  if (item.workStopped) return item.workStopped.reason.trim();
  if (item.archivedAt) return '';
  const mine = rejections.filter((d) => d.itemId === itemId).sort((a, b) => b.at - a.at)[0];
  return mine?.rationale.trim() ?? '';
}

/**
 * The status line and the silence flag of an item an agent holds (item AzveC). Only while it is
 * worked: a parked item shows its wait instead, and the status of an earlier run is gone.
 */
export function statusView(item: Item, now: number): { status?: string; silence?: string } {
  if (item.status !== 'working' || !item.claim) return {};
  const st = statusOf(item);
  const quiet = parkOf(item) ? null : silenceOf(item);
  return {
    ...(st ? { status: statusLine(st) } : {}),
    ...(quiet ? { silence: silenceText(quiet.since, now) } : {}),
  };
}

export interface AskState {
  /** The item is being actively worked: the button shows. */
  show: boolean;
  disabled: boolean;
  label: string;
}

/** What "Ask for status" shows now. Mirrors askStatusIt in firestore.rules. */
export function askStatusState(item: Item, now: number): AskState {
  if (!isItemLive(item, now) || !activelyWorked(item))
    return { show: false, disabled: true, label: 'Ask for status' };
  const ask = statusAskOf(item);
  const recent = !!ask && now - ask.at.toMillis() < STATUS_ASK_EVERY_MS;
  if (statusAskOpen(item))
    return recent
      ? { show: true, disabled: true, label: 'Asked · waiting…' }
      : { show: true, disabled: false, label: 'Ask again' };
  return { show: true, disabled: recent, label: 'Ask for status' };
}
