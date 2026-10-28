import {
  approve,
  archiveItem,
  moveItem,
  restoreItem,
  updateItem,
  type ActionContext,
  type ActionPlan,
  type ItemType,
} from '@hive/shared';
import { waitedMs } from '../insights/logic';
import { needsMyDecision } from '../shell/logic';
import { rowKey, type ListRow } from './logic';

/**
 * Bulk actions (card O2Ehb9CG). A bulk action is the single-item action repeated: each item is
 * checked against the same rule the server applies (firestore.rules), so an item the person may
 * not change is skipped and counted, never forced. The server still re-checks every write.
 */
export type BulkAction =
  | { kind: 'approve' }
  | { kind: 'move'; toStepId: string }
  | { kind: 'type'; type: ItemType }
  | { kind: 'archive' }
  | { kind: 'restore' };

export interface Who {
  uid: string;
  isAdmin: boolean;
}

const open = (r: ListRow) =>
  (r.row.data.status === 'queued' || r.row.data.status === 'waiting') && !r.row.data.claim;
const mayEdit = (r: ListRow, who: Who) =>
  who.isAdmin || (r.row.data.createdBy.type === 'human' && r.row.data.createdBy.id === who.uid);

/** Why this person cannot do the action to this item, or null when they can. */
export function bulkBlocker(r: ListRow, a: BulkAction, who: Who): string | null {
  const d = r.row.data;
  switch (a.kind) {
    case 'approve':
      return needsMyDecision(r.project, d, who.uid) ? null : 'not waiting on you';
    case 'move': {
      if (!open(r) || d.workStopped) return 'an agent has it';
      const to = r.project.steps.findIndex((s) => s.id === a.toStepId);
      if (to < 0) return 'no such step';
      if (to === r.stepIndex) return 'already there';
      return to < r.stepIndex || who.isAdmin ? null : 'only an admin moves it forward';
    }
    case 'type':
      if (d.type === 'finding' || a.type === 'finding') return 'a suggestion';
      if (d.type === a.type) return 'already that type';
      return mayEdit(r, who) ? null : 'only its creator or an admin';
    case 'restore':
      if (d.status !== 'stopped') return 'not archived';
      if (d.workStopped) return 'cancelled for good';
      return mayEdit(r, who) ? null : 'only its creator or an admin';
    case 'archive':
      if (!open(r)) return 'an agent has it';
      return mayEdit(r, who) ? null : 'only its creator or an admin';
  }
}

export function eligible(rows: readonly ListRow[], a: BulkAction, who: Who): ListRow[] {
  return rows.filter((r) => bulkBlocker(r, a, who) === null);
}

/** What the person has chosen to move to: step ids that at least one chosen item may go to. */
export function movableSteps(rows: readonly ListRow[], who: Who) {
  const first = rows[0];
  if (!first || rows.some((r) => r.pid !== first.pid)) return [];
  return first.project.steps.filter((s) =>
    rows.some((r) => bulkBlocker(r, { kind: 'move', toStepId: s.id }, who) === null),
  );
}

export interface Planned {
  key: string;
  plan: Pick<ActionPlan, 'ops'>;
}

/** One write plan per item the person may act on. */
export function planBulk(
  ctx: ActionContext,
  a: BulkAction,
  rows: readonly ListRow[],
  who: Who,
): Planned[] {
  return eligible(rows, a, who).map((r) => {
    const base = { projectId: r.pid, itemId: r.row.id, item: r.row.data };
    switch (a.kind) {
      case 'approve':
        return {
          key: rowKey(r),
          plan: approve(ctx, { ...base, project: r.project, waitedMs: waitedMs(r.row.data) }),
        };
      case 'move':
        return {
          key: rowKey(r),
          plan: moveItem(ctx, { ...base, project: r.project, toStepId: a.toStepId }),
        };
      case 'type':
        return {
          key: rowKey(r),
          plan: updateItem(ctx, {
            projectId: r.pid,
            itemId: r.row.id,
            changes: { type: a.type },
            before: { title: r.row.data.title, type: r.row.data.type },
          }),
        };
      case 'archive':
        return { key: rowKey(r), plan: archiveItem(ctx, base) };
      case 'restore':
        return {
          key: rowKey(r),
          plan: restoreItem(ctx, {
            project: r.project,
            projectId: r.pid,
            itemId: r.row.id,
            stepId: r.row.data.stepId,
          }),
        };
    }
  });
}

const things = (n: number) => (n === 1 ? '1 item' : `${n} items`);

/** The toast line: what will happen, and what was skipped and why. */
export function bulkMessage(a: BulkAction, done: number, skipped: number): string {
  const verb =
    a.kind === 'approve'
      ? 'Approving'
      : a.kind === 'move'
        ? 'Moving'
        : a.kind === 'type'
          ? 'Changing the type of'
          : a.kind === 'restore'
            ? 'Restoring'
            : 'Archiving';
  return `${verb} ${things(done)}${skipped ? `, skipping ${skipped} you cannot change` : ''}`;
}

/** Range of keys between two rows (inclusive), in the order shown. */
export function rangeKeys(order: readonly string[], from: string, to: string): string[] {
  const a = order.indexOf(from);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return b < 0 ? [] : [to];
  return order.slice(Math.min(a, b), Math.max(a, b) + 1);
}
