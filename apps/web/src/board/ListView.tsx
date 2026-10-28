import { decisionSchema, itemSchema, type Agent, type ItemType, type Project } from '@hive/shared';
import { collection, query, where } from 'firebase/firestore';
import { Archive, ArchiveRestore, Check, Shapes, SlidersHorizontal, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { useIsPhone } from '../components/ResponsiveModal';
import { db } from '../lib/db';
import { stash } from '../lib/pendingDecisions';
import { useLiveQuery, type Row } from '../lib/live';
import { timeAgo } from '../projects/logic';
import { BAR_BUTTON, BAR_PRIMARY, SelectionBar } from './SelectionBar';
import { isTypingTarget } from '../shell/shortcuts';
import { formatEur } from '../shell/logic';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Select } from '../ui/form';
import { ActionMenu } from '../ui/menu';
import { useToast } from '../ui/overlay';
import { ItemActions, useHiddenItems } from './itemActions';
import {
  bulkBlocker,
  bulkMessage,
  eligible,
  movableSteps,
  planBulk,
  rangeKeys,
  type BulkAction,
  type Who,
} from './bulk';
import {
  filterAndSort,
  isFiltered,
  listRows,
  NO_FILTER,
  rowKey,
  stoppedKind,
  stoppedReason,
  type ListFilter,
  type ListRow,
  type SortKey,
} from './logic';

const COLUMNS: Array<{ key: SortKey; label: string; hide?: boolean; all?: boolean }> = [
  { key: 'title', label: 'Title' },
  { key: 'project', label: 'Project', all: true },
  { key: 'step', label: 'Step', hide: true },
  { key: 'status', label: 'Status', hide: true },
  { key: 'agent', label: 'Agent', hide: true },
  { key: 'waiting', label: 'Waiting', hide: true },
  { key: 'cost', label: 'Cost', hide: true },
];

type Scope = 'open' | 'done' | 'archived';

/** Focus on a checkbox or radio is not typing: list keys (Esc, x, j, k) still work there. */
function typingInField(t: EventTarget | null): boolean {
  if (t instanceof HTMLInputElement && (t.type === 'checkbox' || t.type === 'radio')) return false;
  return isTypingTarget(t);
}

const TYPES: ItemType[] = ['idea', 'request', 'bug', 'task'];

/**
 * A sortable, filterable table of open items, of one project or of all of them. Rows can be
 * selected (checkbox, Shift-click, `x`, Shift+`x`, Esc clears) and acted on together.
 */
export function ListView({
  rows: open,
  agents,
  onOpen,
  now,
  selected,
  everyProject,
  closedOf,
}: {
  rows: ListRow[];
  agents: Row<Agent>[];
  onOpen: (r: ListRow) => void;
  now: number;
  selected?: string;
  /** The all-projects list: shows the project and hides the step filter. */
  everyProject?: boolean;
  /** One project's list: lets the person look at its done and archived items too. */
  closedOf?: { pid: string; project: Project };
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const phone = useIsPhone();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const who = useMemo<Who>(
    () => ({ uid: session.me.uid, isAdmin: session.isAdmin }),
    [session.me.uid, session.isAdmin],
  );
  const uid = session.me.uid;
  const [scope, setScope] = useState<Scope>('open');
  const closed = useLiveQuery(
    closedOf && scope !== 'open' ? `closed:${session.workspaceId}:${closedOf.pid}:${scope}` : null,
    () =>
      query(
        collection(db, `workspaces/${session.workspaceId}/projects/${closedOf?.pid}/items`),
        where('status', '==', scope === 'done' ? 'done' : 'stopped'),
      ),
    itemSchema,
  );
  // Why rejected items are here: the reason is on the "stopped" decision (card rLntxm7C).
  const rejections = useLiveQuery(
    closedOf && scope === 'archived' ? `rejections:${session.workspaceId}:${closedOf.pid}` : null,
    () =>
      query(
        collection(db, `workspaces/${session.workspaceId}/projects/${closedOf?.pid}/decisions`),
        where('outcome', '==', 'stopped'),
      ),
    decisionSchema,
  );
  const rejected = useMemo(
    () =>
      rejections.state === 'ready'
        ? rejections.data.map((d) => ({
            itemId: d.data.itemId,
            rationale: d.data.rationale,
            at: d.data.at.toMillis(),
          }))
        : [],
    [rejections],
  );
  // Archived or deleted a moment ago from a menu: gone from the list at once.
  const hiddenItems = useHiddenItems();
  const all = useMemo(() => {
    const rows =
      !closedOf || scope === 'open'
        ? open
        : closed.state !== 'ready'
          ? []
          : // Archived = every stopped item: bulk-archived and rejected ("Stop: archive") alike.
            listRows(closedOf.project, closed.data, agents, closedOf.pid, uid);
    return hiddenItems.size === 0 ? rows : rows.filter((r) => !hiddenItems.has(r.pid, r.row.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, closedOf, scope, closed, agents, uid, hiddenItems.size]);
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'step', dir: 1 });
  const shown = useMemo(() => filterAndSort(all, filter, sort), [all, filter, sort]);
  const order = useMemo(() => shown.map(rowKey), [shown]);

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [cursor, setCursor] = useState<string | null>(null);
  const [barHeight, setBarHeight] = useState(56);
  const anchor = useRef<string | null>(null);
  // Selected rows that have since left the list (done, archived, filtered out) drop out.
  const chosen = useMemo(() => shown.filter((r) => picked.has(rowKey(r))), [shown, picked]);

  const toggle = useCallback((key: string, on?: boolean) => {
    setPicked((cur) => {
      const next = new Set(cur);
      if (on ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
    anchor.current = key;
  }, []);
  const select = useCallback(
    (key: string, shift: boolean) => {
      if (shift && anchor.current) {
        const keys = rangeKeys(order, anchor.current, key);
        setPicked((cur) => new Set([...cur, ...keys]));
      } else toggle(key);
    },
    [order, toggle],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      if (typingInField(e.target)) return;
      if (document.querySelector('[role="dialog"]:not([data-state="closed"])')) return;
      if (e.key === 'Escape') {
        if (picked.size > 0) {
          e.preventDefault();
          setPicked(new Set());
          anchor.current = null;
        }
        return;
      }
      if (e.key.toLowerCase() === 'x') {
        const key = cursor && order.includes(cursor) ? cursor : order[0];
        if (!key) return;
        e.preventDefault();
        select(key, e.shiftKey);
        return;
      }
      if (e.key === 'j' || e.key === 'k') {
        const i = cursor ? order.indexOf(cursor) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, i + (e.key === 'j' ? 1 : -1)))];
        if (next) {
          setCursor(next);
          document.getElementById(`row-${next}`)?.scrollIntoView({ block: 'nearest' });
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked, cursor, order, select]);

  function act(a: BulkAction, rows: ListRow[] = chosen) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    const planned = planBulk(ctx, a, rows, who);
    const skipped = rows.length - planned.length;
    if (planned.length === 0) {
      toast.push({ message: 'You cannot do that to the items you picked.' });
      return;
    }
    setPicked(new Set());
    const forget = stash(
      session.me.uid,
      session.workspaceId,
      planned.map((p) => p.plan.ops),
      `Saved your changes to ${planned.length} ${planned.length === 1 ? 'item' : 'items'}`,
    );
    // Like a single decision: the writes wait 5 s so Undo can take the action back.
    toast.push({
      message: bulkMessage(a, planned.length, skipped),
      undoLabel: 'Undo',
      duration: 5000,
      onUndo: forget,
      onCommit: () => {
        void Promise.allSettled(planned.map((p) => run(p.plan))).then((res) => {
          forget();
          const failed = res.filter((r) => r.status === 'rejected').length;
          if (failed > 0)
            toast.push({ message: `Could not change ${failed} of ${planned.length} items.` });
        });
      },
    });
  }

  const why = (r: ListRow) => stoppedReason(r.row.data, rejected, r.row.id);

  const th = (c: (typeof COLUMNS)[number]) =>
    c.all && !everyProject ? null : (
      <th
        key={c.key}
        scope="col"
        aria-sort={sort.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
        className={cn(
          'px-3 py-2 text-left text-12 font-medium text-text-2',
          c.hide && 'hidden md:table-cell',
        )}
      >
        <button
          type="button"
          className="min-h-11 font-medium hover:text-ink"
          onClick={() =>
            setSort((s) => ({ key: c.key, dir: s.key === c.key && s.dir === 1 ? -1 : 1 }))
          }
        >
          {c.label}
          {sort.key === c.key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
        </button>
      </th>
    );

  const first = all[0];
  const steps = closedOf
    ? closedOf.project.steps
    : !everyProject && first
      ? first.project.steps
      : [];
  const live = agents.filter((a) => !a.data.revokedAt);
  const allShown = shown.length > 0 && chosen.length === shown.length;
  const activeFilters =
    [filter.stepId, filter.status, filter.type, filter.agent].filter(Boolean).length +
    (filter.mine ? 1 : 0) +
    (scope !== 'open' ? 1 : 0);
  const cols = COLUMNS.filter((c) => !c.all || everyProject).length + 2;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className={phone ? 'flex items-end gap-2' : 'contents'}>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:col-span-2 lg:col-span-1">
            <label htmlFor="list-find" className="text-13 font-medium text-ink">
              Find
            </label>
            <input
              id="list-find"
              value={filter.text}
              onChange={(e) => setFilter({ ...filter, text: e.target.value })}
              placeholder="Title or description contains"
              className="min-h-11 w-full rounded-btn border border-line-strong bg-surface px-3 text-16 text-ink placeholder:text-text-3"
            />
          </div>
          {phone ? (
            <button
              type="button"
              aria-expanded={filtersOpen}
              aria-controls="list-filters"
              onClick={() => setFiltersOpen((o) => !o)}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-btn border border-line-strong bg-surface px-4 text-14 font-medium text-ink"
            >
              <SlidersHorizontal size={16} aria-hidden />
              Filter
              {activeFilters > 0 ? (
                <span className="rounded-full bg-ink px-1.5 text-12 tabular-nums text-surface">
                  {activeFilters}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
        <div id="list-filters" className={phone && !filtersOpen ? 'hidden' : 'contents'}>
          {closedOf ? (
            <Select
              label="Show"
              value={scope}
              onValueChange={(v) => {
                setScope(v as Scope);
                setPicked(new Set());
                setFilter({ ...filter, status: '' });
              }}
              options={[
                { value: 'open', label: 'Open items' },
                { value: 'done', label: 'Done' },
                { value: 'archived', label: 'Archived' },
              ]}
            />
          ) : null}
          {everyProject ? null : (
            <Select
              label="Step"
              value={filter.stepId}
              onValueChange={(v) => setFilter({ ...filter, stepId: v })}
              options={[
                { value: '', label: 'All steps' },
                ...steps.map((s) => ({ value: s.id, label: s.name })),
              ]}
            />
          )}
          {scope !== 'open' ? null : (
            <Select
              label="Status"
              value={filter.status}
              onValueChange={(v) => setFilter({ ...filter, status: v })}
              options={[
                { value: '', label: 'Any status' },
                { value: 'queued', label: 'Queued' },
                { value: 'working', label: 'Working' },
                { value: 'waiting', label: 'Waiting' },
              ]}
            />
          )}
          <Select
            label="Type"
            value={filter.type}
            onValueChange={(v) => setFilter({ ...filter, type: v })}
            options={[
              { value: '', label: 'Any type' },
              ...[...TYPES, 'finding' as const].map((t) => ({ value: t, label: t })),
            ]}
          />
          <Select
            label="Agent"
            value={filter.agent}
            onValueChange={(v) => setFilter({ ...filter, agent: v })}
            options={[
              { value: '', label: 'Any agent' },
              ...live.map((a) => ({ value: a.id, label: a.data.name })),
            ]}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-pressed={filter.mine}
          onClick={() => setFilter({ ...filter, mine: !filter.mine })}
          className={cn(
            'min-h-11 items-center gap-1.5 rounded-full border px-4 text-14 font-medium',
            phone && !filtersOpen ? 'hidden' : 'inline-flex',
            filter.mine
              ? 'border-gate/60 bg-gate-bg text-gate-text'
              : 'border-line-strong bg-surface text-text-2 hover:text-ink',
          )}
        >
          Waiting on me
          {filter.mine ? <X size={14} aria-hidden /> : null}
        </button>
        {isFiltered(filter) && !(phone && !filtersOpen) ? (
          <Button variant="ghost" onClick={() => setFilter(NO_FILTER)}>
            Clear filters
          </Button>
        ) : null}
        <span className="ml-auto text-13 text-text-2" aria-live="polite">
          {shown.length} of {all.length}
        </span>
      </div>
      <div className="overflow-x-auto rounded-card border border-line bg-surface">
        <table className="w-full border-collapse text-14">
          <thead className="border-b border-line">
            <tr>
              <th scope="col" className="w-11 px-3">
                <input
                  type="checkbox"
                  aria-label="Select all shown"
                  checked={allShown}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allShown;
                  }}
                  onChange={() => setPicked(allShown ? new Set() : new Set(order))}
                  className="size-5 accent-[var(--color-ink)]"
                />
              </th>
              {COLUMNS.map(th)}
              <th scope="col" className="w-12 px-1">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={cols} className="px-3 py-6 text-center text-text-2">
                  {scope !== 'open' && closed.state === 'loading'
                    ? 'Loading…'
                    : scope === 'open'
                      ? 'No items match.'
                      : `No ${scope} items match.`}
                </td>
              </tr>
            ) : (
              shown.map((r) => {
                const key = rowKey(r);
                const on = picked.has(key);
                return (
                  <tr
                    key={key}
                    id={`row-${key}`}
                    aria-selected={on}
                    onMouseEnter={() => setCursor(key)}
                    onFocusCapture={() => setCursor(key)}
                    className={cn(
                      'border-b border-line last:border-0',
                      (selected === r.row.id || on) && 'bg-canvas',
                      cursor === key && 'shadow-[inset_2px_0_0_var(--color-ink)]',
                    )}
                  >
                    <td className="px-3 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Select ${r.row.data.title}`}
                        checked={on}
                        onChange={() => undefined}
                        onClick={(e) => {
                          setCursor(key);
                          select(key, e.shiftKey);
                        }}
                        className="size-5 accent-[var(--color-ink)]"
                      />
                    </td>
                    <td className="px-3 py-1">
                      <button
                        type="button"
                        onClick={() => onOpen(r)}
                        className="min-h-11 text-left font-medium text-ink underline-offset-4 hover:underline"
                      >
                        {r.row.data.title}
                      </button>
                      {r.mine ? (
                        <span className="ml-2 text-12 font-medium text-gate-text">Needs you</span>
                      ) : null}
                      <div className="flex items-center gap-2 pb-1 text-12 text-text-2 md:hidden">
                        <Badge
                          tone={r.project.steps[r.stepIndex]?.kind === 'human' ? 'gate' : 'agent'}
                        >
                          {r.stepName}
                        </Badge>
                        {scope === 'archived' ? stoppedKind(r.row.data) : r.row.data.status}
                      </div>
                      {scope === 'archived' && why(r) ? (
                        <p className="max-w-prose pb-1 text-13 text-text-2">{why(r)}</p>
                      ) : null}
                    </td>
                    {everyProject ? (
                      <td className="px-3 py-1 text-text-2">
                        {r.project.emoji} {r.project.name}
                      </td>
                    ) : null}
                    <td className="hidden px-3 py-1 md:table-cell">
                      <Badge
                        tone={r.project.steps[r.stepIndex]?.kind === 'human' ? 'gate' : 'agent'}
                      >
                        {r.stepName}
                      </Badge>
                    </td>
                    <td className="hidden px-3 py-1 text-text-2 md:table-cell">
                      {scope === 'archived' ? stoppedKind(r.row.data) : r.row.data.status}
                    </td>
                    <td className="hidden px-3 py-1 text-text-2 md:table-cell">
                      {r.agentName || '–'}
                    </td>
                    <td className="hidden px-3 py-1 text-text-2 md:table-cell">
                      {timeAgo(r.row.data.updatedAt.toMillis(), now)}
                    </td>
                    <td className="hidden px-3 py-1 text-text-2 md:table-cell">
                      {formatEur(r.row.data.costEur)}
                    </td>
                    <td className="px-1 py-1">
                      <ItemActions
                        pid={r.pid}
                        itemId={r.row.id}
                        item={r.row.data}
                        extra={
                          scope === 'archived' && bulkBlocker(r, { kind: 'restore' }, who) === null
                            ? [
                                {
                                  id: 'restore',
                                  label: 'Restore',
                                  icon: ArchiveRestore,
                                  onSelect: () => act({ kind: 'restore' }, [r]),
                                },
                              ]
                            : []
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {chosen.length > 0 ? (
        // Keeps the last row scrollable above the fixed bar (bar height + its offset).
        <div
          aria-hidden
          style={{ height: `calc(${barHeight}px + 80px + env(safe-area-inset-bottom))` }}
        />
      ) : null}
      {chosen.length > 0 ? (
        <BulkBar
          onHeight={setBarHeight}
          rows={chosen}
          scope={scope}
          who={who}
          onAct={act}
          onClear={() => {
            setPicked(new Set());
            anchor.current = null;
          }}
        />
      ) : null}
    </div>
  );
}

function BulkBar({
  onHeight,
  rows,
  scope,
  who,
  onAct,
  onClear,
}: {
  onHeight: (h: number) => void;
  rows: ListRow[];
  scope: Scope;
  who: Who;
  onAct: (a: BulkAction) => void;
  onClear: () => void;
}) {
  const approvable = eligible(rows, { kind: 'approve' }, who).length;
  const steps = movableSteps(rows, who);
  const restorable = eligible(rows, { kind: 'restore' }, who).length;
  const bar = BAR_BUTTON;
  return (
    <SelectionBar count={rows.length} onHeight={onHeight} onClear={onClear}>
      {scope === 'archived' ? (
        <button
          type="button"
          className={bar}
          disabled={restorable === 0}
          onClick={() => onAct({ kind: 'restore' })}
        >
          <ArchiveRestore size={16} aria-hidden />
          Restore {restorable}
        </button>
      ) : null}
      {scope !== 'open' ? null : (
        <>
          <ActionMenu
            label="Move to step"
            actions={steps.map((s) => ({
              id: s.id,
              label: s.name,
              onSelect: () => onAct({ kind: 'move', toStepId: s.id }),
            }))}
            trigger={
              <button type="button" className={bar} disabled={steps.length === 0}>
                Move to step
              </button>
            }
          />
          <button
            type="button"
            className={BAR_PRIMARY}
            disabled={approvable === 0}
            onClick={() => onAct({ kind: 'approve' })}
          >
            <Check size={16} aria-hidden />
            Approve {approvable}
          </button>
          <ActionMenu
            label="Change type"
            actions={TYPES.map((t) => ({
              id: t,
              label: t,
              onSelect: () => onAct({ kind: 'type', type: t }),
            }))}
            trigger={
              <button type="button" className={bar}>
                <Shapes size={16} aria-hidden />
                Change type
              </button>
            }
          />
          <button type="button" className={bar} onClick={() => onAct({ kind: 'archive' })}>
            <Archive size={16} aria-hidden />
            Archive
          </button>
        </>
      )}
    </SelectionBar>
  );
}
