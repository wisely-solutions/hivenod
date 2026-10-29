import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  canTriage,
  itemSchema,
  templateLabel,
  updateItem,
  type Project,
  type Step,
} from '@hive/shared';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeft,
  ChevronDown,
  FolderKanban,
  GripVertical,
  MoreHorizontal,
  Plus,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { useIsPhone } from '../components/ResponsiveModal';
import { useLiveDoc, type Row } from '../lib/live';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { monthSpend, needsMyDecision, spendText } from '../shell/logic';
import { useShortcut } from '../shell/shortcuts';
import { Badge, Eyebrow } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { useReminderMap } from '../notify/reminders';
import { ItemCard } from '../ui/card';
import { cn } from '../ui/cn';
import { EmptyState, FoldedColumn, Skeleton, WorkingDots } from '../ui/feedback';
import { Segmented } from '../ui/form';
import { useToast } from '../ui/overlay';
import { CardMenu } from './CardMenu';
import { useHiddenItems } from './itemActions';
import { FocusView } from '../components/FocusView';
import { ItemDetail } from './ItemDetail';
import { ListView } from './ListView';
import { useCapture } from '../capture/CaptureProvider';
import {
  cardData,
  defaultLayout,
  dragAnnouncements,
  groupByStep,
  parseExpanded,
  parseLayout,
  orderAt,
  scrubber,
  activeStepId,
  stepStats,
  type BoardLayout,
  type CardContext,
  listRows,
  type ItemRow,
} from './logic';
import { Scrubber } from './Scrubber';
import { SuggestionLane } from './SuggestionLane';

const route = getRouteApi('/p/$pid');

function useExpanded(uid: string, pid: string, first: string | undefined) {
  const key = `hive.board.open.${uid}.${pid}`;
  const [saved, setSaved] = useState<boolean>(() => {
    try {
      return localStorage.getItem(key) !== null;
    } catch {
      return false;
    }
  });
  const [open, setOpen] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? (first ? [first] : []) : parseExpanded(raw);
    } catch {
      return first ? [first] : [];
    }
  });
  /** `shown` is what the person currently sees open when nothing is saved yet (rows open non-empty steps). */
  const toggle = (id: string, shown?: string[]) =>
    setOpen((cur) => {
      const base = !saved && shown ? shown : cur;
      setSaved(true);
      const next = base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* storage is a convenience */
      }
      return next;
    });
  return [open, toggle, saved] as const;
}

/** The layout choice is remembered per project on this device; without one, the step count decides. */
function useLayout(uid: string, pid: string, steps: number) {
  const key = `hive.board.layout.${uid}.${pid}`;
  const [saved, setSaved] = useState<BoardLayout | null>(() => {
    try {
      return parseLayout(localStorage.getItem(key));
    } catch {
      return null;
    }
  });
  const choose = (v: BoardLayout) => {
    setSaved(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* storage is a convenience */
    }
  };
  return [saved ?? defaultLayout(steps), choose] as const;
}

/** Items sit side by side inside a row. */
const ROW_GRID = 'grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] items-start gap-2';

function SortableCard({
  row,
  ctx,
  pid,
  onOpen,
  sortable,
}: {
  pid: string;
  row: ItemRow;
  ctx: CardContext;
  onOpen: () => void;
  sortable: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.id, disabled: !sortable });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('flex items-stretch gap-1', isDragging && 'z-10 opacity-70')}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder ${row.data.title}. Press space, then the arrow keys.`}
        className="grid w-8 shrink-0 cursor-grab touch-none place-items-center rounded-btn text-text-3 hov:text-ink foc:outline-2 foc:outline-focus"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} />
      </button>
      <div className="min-w-0 flex-1">
        <CardMenu row={row} ctx={ctx} pid={pid}>
          {(pad) => (
            <ItemCard
              item={cardData(row, ctx)}
              layoutId={`item-${row.id}`}
              onOpen={onOpen}
              className={pad}
            />
          )}
        </CardMenu>
      </div>
    </div>
  );
}

function HumanColumn({
  step,
  rows,
  ctx,
  onOpen,
  phone,
  lane,
  asRows,
}: {
  step: Step;
  rows: ItemRow[];
  ctx: CardContext;
  onOpen: (id: string) => void;
  phone: boolean;
  /** The suggestions lane, when this is the first step. */
  lane?: ReactNode;
  /** Full-width row (items side by side) instead of a column. */
  asRows: boolean;
}) {
  // In rows an empty decision step is as thin as an empty agent row and not amber:
  // only a gate with something waiting is highlighted.
  const thin = asRows && rows.length === 0 && !lane;
  return (
    <section
      aria-label={`${step.name}, decision step`}
      data-step={step.id}
      data-waiting={rows.length > 0 ? 'true' : 'false'}
      className={cn(
        'flex shrink-0 rounded-card border',
        thin
          ? 'min-h-[46px] flex-row items-center border-line bg-surface px-3'
          : 'flex-col gap-2 border-gate/60 bg-gate-bg p-2',
        asRows ? 'w-full' : phone ? 'w-full snap-center' : 'w-full min-w-0',
      )}
    >
      <header className={cn('flex items-center gap-2', thin ? 'w-full' : 'px-1 pt-1')}>
        <h2 className={cn('text-14 font-semibold', thin ? 'text-text-2' : 'text-gate-text')}>
          {step.name}
        </h2>
        <Badge tone="gate" count={rows.length} />
        {thin ? <span className="text-13 text-text-2">Nothing waiting here.</span> : null}
        <Eyebrow className={cn('ml-auto', thin ? 'text-text-2' : 'text-gate-text')}>
          You decide
        </Eyebrow>
      </header>
      {lane}
      {rows.length === 0 ? (
        thin ? null : (
          <p className={cn('px-1 text-13 text-gate-text', asRows ? 'pb-1' : 'pb-2')}>
            Nothing waiting here.
          </p>
        )
      ) : (
        <div className={asRows ? ROW_GRID : 'flex flex-col gap-2'}>
          {rows.map((r) => (
            <ItemCard
              key={r.id}
              item={cardData(r, ctx)}
              layoutId={`item-${r.id}`}
              onOpen={() => onOpen(r.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** An agent step as a full-width row: a header you can fold, items side by side below. */
function AgentRow({
  step,
  count,
  live,
  sendBacks,
  attention,
  locked,
  expanded,
  onToggle,
  children,
}: {
  step: Step;
  count: number;
  live: number;
  sendBacks: number;
  /** Items inside holding a question or held (stuck): shown as a badge while folded. */
  attention: number;
  /** An open question keeps the step open: it cannot be folded. */
  locked: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const panel = useId();
  // Empty steps stay thin: nothing to unfold.
  const open = expanded;
  return (
    <section
      data-step={step.id}
      aria-label={`${step.name}, agent step`}
      className="w-full overflow-hidden rounded-card border border-line bg-agent-soft"
    >
      <h2 className="sr-only">{step.name}</h2>
      <button
        type="button"
        onClick={locked ? undefined : onToggle}
        aria-expanded={open}
        aria-controls={panel}
        aria-disabled={locked || undefined}
        className="flex min-h-11 w-full items-center gap-2 px-3 text-left foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
      >
        <Badge tone="agent" count={count} />
        {live > 0 ? (
          <>
            <WorkingDots />
            <span className="sr-only">{live} running now</span>
          </>
        ) : null}
        <span className="flex-1 font-mono text-12 font-medium uppercase tracking-[0.08em] text-agent">
          {step.name}
        </span>
        {attention > 0 && !open ? (
          <span
            data-testid="step-attention"
            className="rounded-full bg-gate-bg px-2 py-0.5 text-13 font-medium text-gate-text"
          >
            {attention} need{attention === 1 ? 's' : ''} attention
          </span>
        ) : null}
        {sendBacks > 0 ? (
          <span className="text-13 text-sendback">
            <span aria-hidden>{sendBacks} sent back</span>
            <span className="sr-only">{sendBacks} sent back</span>
          </span>
        ) : null}
        {locked ? null : (
          <ChevronDown
            size={16}
            aria-hidden
            className={cn('text-text-3 transition-transform', open && 'rotate-180')}
          />
        )}
      </button>
      <div id={panel} hidden={!open} className="flex flex-col gap-2 p-2 pt-0">
        {open ? children : null}
      </div>
    </section>
  );
}

function ItemPanel({
  pid,
  itemId,
  project,
  onClose,
  waiting,
  onOpen,
  backText,
}: {
  pid: string;
  itemId: string;
  project: Project;
  onClose: () => void;
  /** The items waiting for this person in this project, in board order (J / K). */
  waiting: string[];
  onOpen: (id: string) => void;
  backText: string;
}) {
  const { session } = useReady();
  const { agents } = useShellData();
  const live = useLiveDoc(
    `workspaces/${session.workspaceId}/projects/${pid}/items/${itemId}`,
    itemSchema,
    { synced: true },
  );
  // A cached "missing" is not gone: wait for the server before saying so.
  // The loading and gone states are the focus view too, so nothing shifts in the page behind.
  const shell = (children: React.ReactNode) => (
    <FocusView
      label="Item detail"
      role="region"
      backLabel="Close item"
      backText={backText}
      onBack={onClose}
      crumb={`${project.emoji} ${project.name}`}
    >
      {children}
    </FocusView>
  );
  if (live.state === 'loading' || (live.state === 'ready' && !live.data && live.fromCache))
    return shell(<Skeleton className="h-64" />);
  if (live.state === 'error' || !live.data) {
    return shell(<p className="text-14 text-text-2">This item is gone or not yours to see.</p>);
  }
  return (
    <ItemDetail
      pid={pid}
      itemId={itemId}
      project={project}
      item={live.data}
      agents={agents}
      onClose={onClose}
      backText={backText}
      position={
        waiting.length > 0 ? { index: waiting.indexOf(itemId), total: waiting.length } : undefined
      }
      onStep={(dir) => {
        const i = waiting.indexOf(itemId);
        const to = waiting[i < 0 ? (dir === 1 ? 0 : waiting.length - 1) : i + dir];
        if (to) onOpen(to);
      }}
      onDecided={() => {
        // Like Needs you: after an approval go to the next waiting item, else the one before, else close.
        const i = waiting.indexOf(itemId);
        const to = waiting[i + 1] ?? (i > 0 ? waiting[i - 1] : undefined);
        if (to && to !== itemId) onOpen(to);
        else onClose();
      }}
    />
  );
}

export function ProjectPage() {
  const { pid } = route.useParams();
  const { projects, projectsConfirmed } = useShellData();
  // A project missing from a cached list may still exist: say "not found" only on the server's word.
  const loading = !projectsConfirmed;
  const p = projects.find((x) => x.id === pid);
  if (!p) {
    return (
      <>
        <PageHeader title={loading ? 'Project' : 'Project not found'} />
        {loading ? (
          <Skeleton className="h-64" />
        ) : (
          <EmptyState
            icon={FolderKanban}
            title="This project is gone or not yours to see"
            description="Pick another one from the list."
            action={
              <Link to="/projects" className="text-14 font-medium underline underline-offset-4">
                Projects
              </Link>
            }
          />
        )}
      </>
    );
  }
  return <Board key={p.id} pid={pid} row={p as Row<Project>} />;
}

function Board({ pid, row }: { pid: string; row: Row<Project> }) {
  const project = row.data;
  const { session, actionContext, run } = useReady();
  const { agents, items, suggestions, runs, runsSynced, settled } = useShellData();
  const search = route.useSearch();
  const navigate = useNavigate({ from: '/p/$pid' });
  const phone = useIsPhone();
  const toast = useToast();
  const uid = session.me.uid;
  const view = search.view === 'list' ? 'list' : 'board';
  const [layout, chooseLayout] = useLayout(session.me.uid, pid, project.steps.length);
  // Columns/Rows means nothing on a phone: it always swipes between columns.
  const asRows = layout === 'rows' && !phone;
  const itemId = search.item;
  const capture = useCapture();
  const dragCol = useRef<HTMLDivElement>(null);
  // True while a mouse drag has left the first column: only reordering inside it is supported.
  const [dragOutside, setDragOutside] = useState(false);
  // Mirrors dragOutside for the announcements and the drop handler, which read it synchronously.
  const outsideRef = useRef(false);
  useEffect(() => {
    if (!dragOutside) return;
    const prev = document.body.style.cursor;
    document.body.style.cursor = 'not-allowed';
    return () => {
      document.body.style.cursor = prev;
    };
  }, [dragOutside]);
  function onDragMove(e: DragMoveEvent) {
    const r = e.active.rect.current.translated;
    const c = dragCol.current?.getBoundingClientRect();
    if (!r || !c) return;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Columns: leaving sideways. Rows: leaving up or down, out of the first step's row.
    const row = asRows ? dragCol.current?.closest('[data-step]')?.getBoundingClientRect() : null;
    const out = row ? cy < row.top || cy > row.bottom : cx < c.left || cx > c.right;
    outsideRef.current = out;
    setDragOutside(out);
  }
  const [savedOpen, toggle, openSaved] = useExpanded(uid, pid, project.steps[0]?.id);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const hiddenItems = useHiddenItems();
  const list = useMemo(
    () => (items[pid] ?? []).filter((r) => !hiddenItems.has(pid, r.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, pid, hiddenItems.size],
  );
  const listItems = useMemo(
    () => listRows(project, list, agents, pid, uid),
    [project, list, agents, pid, uid],
  );
  const grouped = useMemo(() => groupByStep(project.steps, list), [project.steps, list]);
  // Rows with something in them open by default; once the person folds one, their choice rules.
  // A step holding an open question never folds (the question would be hidden).
  const asking = useMemo(
    () =>
      new Set(
        project.steps
          .filter((s) => (grouped[s.id] ?? []).some((r) => r.data.awaitingAnswer != null))
          .map((s) => s.id),
      ),
    [project.steps, grouped],
  );
  const expanded = useMemo(() => {
    const base =
      asRows && !openSaved
        ? project.steps
            .filter((s, i) => i === 0 || (grouped[s.id]?.length ?? 0) > 0)
            .map((s) => s.id)
        : savedOpen;
    return asRows ? [...new Set([...base, ...asking])] : base;
  }, [asRows, openSaved, project.steps, grouped, savedOpen, asking]);
  // Only agent steps fold; the saved list never holds gate rows (tester R84).
  const agentOnly = (ids: string[]) =>
    ids.filter((id) => project.steps.find((s) => s.id === id)?.kind === 'agent');
  const reminders = useReminderMap();
  const ctx: CardContext = { project, agents, items: list, uid, now, reminders };
  const stats = (s: Step) => stepStats(project, grouped[s.id] ?? [], uid, now);
  const spend = monthSpend(
    runs.filter((r) => r.data.projectId === pid),
    new Date(now),
  );
  const spendKnown = runsSynced.has(pid);
  const agentCount = agents.filter(
    (a) =>
      !a.data.revokedAt &&
      (a.data.projectIds === '*' || (a.data.projectIds as string[]).includes(pid)),
  ).length;

  const open = (id: string | undefined) =>
    void navigate({ search: (s) => ({ ...s, item: id }), resetScroll: false });
  const suggested = suggestions[pid] ?? [];
  const lane = (
    <SuggestionLane
      pid={pid}
      project={project}
      rows={suggested}
      items={list}
      agents={agents}
      canTriage={canTriage(project, uid, session.isAdmin)}
      onOpen={open}
    />
  );
  const setView = (v: 'board' | 'list') =>
    void navigate({ search: (s) => ({ ...s, view: v === 'list' ? 'list' : undefined }) });

  // Escape closes the item.
  useEffect(() => {
    if (!itemId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) open(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const firstId = project.steps[0]?.id ?? '';
  async function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    // A drop while "only inside this step" is showing is a cancel.
    if (outsideRef.current || !over || active.id === over.id) return;
    const col = grouped[firstId] ?? [];
    const without = col.filter((r) => r.id !== active.id);
    const to = without.findIndex((r) => r.id === over.id);
    const from = col.findIndex((r) => r.id === active.id);
    const overIndex = col.findIndex((r) => r.id === over.id);
    const at = overIndex > from ? to + 1 : to;
    const order = orderAt(
      without.map((r) => r.data.order),
      at,
    );
    const ctx2 = actionContext(session.workspaceId);
    if (!ctx2) return;
    try {
      await run(
        updateItem(ctx2, { projectId: pid, itemId: String(active.id), changes: { order } }),
      );
    } catch {
      toast.push({ message: 'Could not reorder. Try again.' });
    }
  }

  const template = templateLabel(project.templateId);

  const spendLine = `Spend this month ${spendText(spend, spendKnown, `p.${pid}`)}`;
  // Phone: one row (back, name, menu). Everything else lives in the menu; adding is the tab bar's +.
  const phoneHeader = (
    <div className="-ml-2 mb-1 flex h-12 items-center gap-1">
      <Link
        to="/projects"
        aria-label="Projects"
        className="grid size-11 shrink-0 place-items-center rounded-btn text-ink hover:bg-canvas"
      >
        <Icon icon={ArrowLeft} size={20} />
      </Link>
      <h1 className="min-w-0 flex-1 truncate text-20 font-semibold leading-tight">
        {`${project.emoji} ${project.name}`.trim()}
      </h1>
      <ActionMenu
        label="Project menu"
        actions={[
          view === 'board'
            ? { id: 'list', label: 'List view', onSelect: () => setView('list') }
            : { id: 'board', label: 'Board view', onSelect: () => setView('board') },
          {
            id: 'process',
            label: 'Edit process',
            onSelect: () => void navigate({ to: '/p/$pid/process', params: { pid } }),
          },
          {
            id: 'insights',
            label: 'Insights',
            onSelect: () => void navigate({ to: '/p/$pid/insights', params: { pid } }),
          },
          { id: 'spend', label: spendLine, onSelect: () => undefined },
        ]}
        trigger={
          <IconButton label="Project menu">
            <Icon icon={MoreHorizontal} size={20} />
          </IconButton>
        }
      />
    </div>
  );

  const header = phone ? (
    phoneHeader
  ) : (
    <div className="mb-4 flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-28 font-semibold leading-tight">
            {`${project.emoji} ${project.name}`.trim()}
          </h1>
          <p className="mt-1 text-14 text-text-2">
            {template} · {agentCount} {agentCount === 1 ? 'agent' : 'agents'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button leading={<Plus size={16} />} onClick={() => capture.open({ projectId: pid })}>
            New item
          </Button>
          <Link
            to="/p/$pid/process"
            params={{ pid }}
            className="inline-flex min-h-11 items-center rounded-btn border border-line-strong bg-surface px-4 text-14 font-medium text-ink hover:bg-canvas"
          >
            Edit process
          </Link>
          <Link
            to="/p/$pid/insights"
            params={{ pid }}
            className="inline-flex min-h-11 items-center rounded-btn border border-line-strong bg-surface px-4 text-14 font-medium text-ink hover:bg-canvas"
          >
            Insights
          </Link>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="View"
          value={view}
          onValueChange={(v) => setView(v as 'board' | 'list')}
          options={[
            { value: 'board', label: 'Board' },
            { value: 'list', label: 'List' },
          ]}
        />
        {view === 'board' ? (
          <Segmented
            label="Layout"
            value={layout}
            onValueChange={(v) => chooseLayout(v as 'columns' | 'rows')}
            options={[
              { value: 'columns', label: 'Columns' },
              { value: 'rows', label: 'Rows' },
            ]}
          />
        ) : null}
        <p className="text-12 text-text-2 tabular-nums">
          Spend this month{' '}
          <span className="font-medium text-ink">{spendText(spend, spendKnown, `p.${pid}`)}</span>
        </p>
      </div>
    </div>
  );

  // Items still on their way: on a phone the swipe carousel is reserved at about its final height, so
  // it does not grow under the reader when they arrive (card 3j7gK: 0.077 at 6x CPU). A board that
  // fills the screen is what a loaded one looks like; a shorter one shrinks below the fold, shifting nothing.
  const loadingItems = list.length === 0 && !settled;
  const columns = (
    <div
      className={cn(
        'relative gap-3 pb-4',
        phone && !asRows && loadingItems && 'min-h-[calc(100dvh-14rem)]',
        asRows
          ? 'flex flex-col'
          : phone
            ? 'flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]'
            : 'grid items-start overflow-x-auto [scrollbar-color:var(--line)_transparent] [scrollbar-width:thin]',
      )}
      style={
        phone || asRows
          ? undefined
          : {
              gridTemplateColumns: project.steps
                .map((s) =>
                  s.kind === 'agent' && !expanded.includes(s.id) ? '3.5rem' : 'minmax(12rem, 1fr)',
                )
                .join(' '),
            }
      }
      data-testid="board"
      // A scroller must be reachable by keyboard when nothing inside it is (an empty board).
      {...(phone && !asRows ? { tabIndex: 0, role: 'region', 'aria-label': 'Board columns' } : {})}
    >
      {project.steps.map((s, i) => {
        const rows = grouped[s.id] ?? [];
        const st = stats(s);
        if (s.kind === 'human') {
          return (
            <HumanColumn
              key={s.id}
              step={s}
              rows={rows}
              ctx={ctx}
              onOpen={open}
              phone={phone}
              asRows={asRows}
              lane={i === 0 ? lane : undefined}
            />
          );
        }
        const body = (
          <>
            {i === 0 ? lane : null}
            {i === 0 && rows.length > 0 ? (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                accessibility={{
                  announcements: dragAnnouncements(
                    (id) => rows.find((r) => r.id === id)?.data.title || 'untitled',
                    () => dragOutside,
                    (id) => {
                      const index = rows.findIndex((r) => r.id === id);
                      return index < 0 ? null : { index: index + 1, total: rows.length };
                    },
                  ),
                }}
                onDragStart={() => {
                  outsideRef.current = false;
                }}
                onDragMove={onDragMove}
                onDragEnd={(e) => {
                  setDragOutside(false);
                  void onDragEnd(e);
                }}
                onDragCancel={() => setDragOutside(false)}
              >
                <div ref={dragCol} className={asRows ? ROW_GRID : 'flex flex-col gap-2'}>
                  {dragOutside ? (
                    <p
                      role="status"
                      className="pointer-events-none col-span-full fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-btn bg-ink px-3 py-2 text-13 text-surface shadow-e2"
                    >
                      Items can only be reordered inside this step.
                    </p>
                  ) : null}
                  <SortableContext
                    items={rows.map((r) => r.id)}
                    strategy={asRows ? rectSortingStrategy : verticalListSortingStrategy}
                  >
                    {rows.map((r) => (
                      <SortableCard
                        key={r.id}
                        row={r}
                        ctx={ctx}
                        pid={pid}
                        sortable
                        onOpen={() => open(r.id)}
                      />
                    ))}
                  </SortableContext>
                </div>
              </DndContext>
            ) : rows.length > 0 ? (
              <div className={asRows ? ROW_GRID : 'flex flex-col gap-2'}>
                {rows.map((r) => (
                  <CardMenu key={r.id} row={r} ctx={ctx} pid={pid}>
                    {(pad) => (
                      <ItemCard
                        item={cardData(r, ctx)}
                        layoutId={`item-${r.id}`}
                        onOpen={() => open(r.id)}
                        className={pad}
                      />
                    )}
                  </CardMenu>
                ))}
              </div>
            ) : null}
            {rows.length === 0 && i !== 0 && !loadingItems ? (
              <p className="px-1 py-2 text-13 text-text-2">Nothing here.</p>
            ) : null}
          </>
        );
        if (asRows) {
          return (
            <AgentRow
              key={s.id}
              step={s}
              count={st.count}
              live={st.live}
              sendBacks={st.sendBacks}
              attention={st.attention}
              locked={asking.has(s.id)}
              expanded={expanded.includes(s.id)}
              onToggle={() => toggle(s.id, agentOnly(expanded.filter((x) => !asking.has(x))))}
            >
              {body}
            </AgentRow>
          );
        }
        if (phone) {
          return (
            <section
              key={s.id}
              data-step={s.id}
              aria-label={`${s.name}, agent step`}
              className="flex w-full shrink-0 snap-center flex-col gap-2 rounded-card border border-line bg-agent-soft p-2"
            >
              <header className="flex items-center gap-2 px-1 pt-1">
                <h2 className="text-14 font-semibold text-agent">{s.name}</h2>
                <Badge tone="agent" count={st.count} />
                {st.live > 0 ? (
                  <>
                    <WorkingDots />
                    <span className="sr-only">{st.live} running now</span>
                  </>
                ) : null}
              </header>
              {body}
            </section>
          );
        }
        return (
          <div key={s.id} data-step={s.id} className="min-w-0">
            <FoldedColumn
              fluid
              title={s.name}
              count={st.count}
              live={st.live}
              sendBacks={st.sendBacks}
              progress={st.progress ?? undefined}
              expanded={expanded.includes(s.id)}
              onToggle={() => toggle(s.id, agentOnly(expanded))}
            >
              {body}
            </FoldedColumn>
          </div>
        );
      })}
    </div>
  );

  // Phone: which column the snap scroller is showing, for the step pager.
  const [activeStep, setActiveStep] = useState<string | null>(null);
  const phoneBoard = view === 'board' && phone;
  // A phone opened straight on an item (a link) shows the full-screen detail over the board. Do not
  // build the board under it: it would shift while it loads, behind a sheet nobody can see through.
  // It appears when the item is closed. (Tapping an item from the board keeps the board.)
  const [deepLinked, setDeepLinked] = useState(!!search.item);
  if (deepLinked && !itemId) setDeepLinked(false);
  const showBoard = !(phone && itemId && deepLinked);
  useEffect(() => {
    if (!phoneBoard) return;
    const scroller = document.querySelector<HTMLElement>('[data-testid="board"]');
    if (!scroller) return;
    const measure = () => {
      const left = scroller.getBoundingClientRect().left;
      const cols = [...scroller.querySelectorAll<HTMLElement>('[data-step]')].map((el) => ({
        id: el.dataset.step ?? '',
        left: el.getBoundingClientRect().left,
      }));
      setActiveStep(activeStepId(cols, left));
    };
    measure();
    scroller.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      scroller.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [phoneBoard, showBoard, project.steps.length]);

  // Who is waiting for this person here, in the order they sit on the board: J / K walk them.
  const waiting = useMemo(
    () =>
      project.steps.flatMap((st) =>
        (grouped[st.id] ?? [])
          .filter((r) => needsMyDecision(project, r.data, uid))
          .map((r) => r.id),
      ),
    [project, grouped, uid],
  );
  const focus = itemId ? (
    <ItemPanel
      pid={pid}
      itemId={itemId}
      project={project}
      onClose={() => open(undefined)}
      waiting={waiting}
      onOpen={open}
      backText={view === 'list' ? 'List' : 'Board'}
    />
  ) : null;
  useShortcut({
    id: 'focus:next',
    keys: ['j'],
    label: 'Next waiting item',
    group: 'Item',
    run: () => {
      if (!itemId || !waiting.length) return;
      const i = waiting.indexOf(itemId);
      const to = waiting[i < 0 ? 0 : i + 1];
      if (to) open(to);
    },
  });
  useShortcut({
    id: 'focus:prev',
    keys: ['k'],
    label: 'Previous waiting item',
    group: 'Item',
    run: () => {
      if (!itemId || !waiting.length) return;
      const i = waiting.indexOf(itemId);
      const to = waiting[i < 0 ? waiting.length - 1 : i - 1];
      if (to) open(to);
    },
  });

  if (!showBoard) return focus;

  return (
    <div>
      {header}
      {view === 'board' && phone && loadingItems ? (
        // The step strip appears with the first items: hold its place (44 px pills, 12 px padding and
        // margin) so the board does not drop 68 px when they arrive.
        <div aria-hidden className="mb-3 h-14" />
      ) : null}
      {view === 'board' && phone && !loadingItems ? (
        <Scrubber
          entries={scrubber(project, grouped, uid)}
          activeId={activeStep}
          onJump={(id) => {
            // Scroll only the horizontal snap scroller: scrollIntoView would also move the page
            // under the sticky bar and chip strip (card weB6bMnf, tester round 1).
            const scroller = document.querySelector<HTMLElement>('[data-testid="board"]');
            const col = scroller?.querySelector<HTMLElement>(`[data-step="${id}"]`);
            if (!scroller || !col) return;
            const s = scroller.getBoundingClientRect();
            const c = col.getBoundingClientRect();
            const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            scroller.scrollTo({
              left: scroller.scrollLeft + (c.left + c.width / 2) - (s.left + s.width / 2),
              behavior: reduced ? 'auto' : 'smooth',
            });
          }}
        />
      ) : null}
      {list.length === 0 && settled ? (
        <div
          data-testid="empty-board"
          className="mb-4 rounded-card border border-dashed border-line-strong bg-surface p-4 text-14"
        >
          <p className="font-medium text-ink">
            Ideas you add land in {project.steps[0]?.name ?? 'the first step'}.
          </p>
          <p className="mt-1 text-text-2">
            {phone ? 'Tap + below to add one.' : 'Press New item or C from anywhere.'}
          </p>
          {agentCount === 0 ? (
            <p className="mt-2 text-text-2">
              This project has no agent, so nothing moves on its own.{' '}
              {session.isAdmin ? (
                <Link
                  to="/agents"
                  search={{ new: 1 }}
                  className="font-medium text-ink underline underline-offset-4"
                >
                  Connect a terminal
                </Link>
              ) : (
                'Ask an admin to connect one.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {view === 'board' ? (
            columns
          ) : (
            <ListView
              rows={listItems}
              agents={agents}
              onOpen={(r) => open(r.row.id)}
              now={now}
              selected={itemId}
              closedOf={{ pid, project }}
            />
          )}
        </div>
      </div>
      {focus}
    </div>
  );
}
