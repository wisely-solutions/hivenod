import { ownGet } from '@hive/shared';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  canEditAgentSettings,
  moveTargets,
  normalizeStepAgents,
  plainSummary,
  sameStepAgents,
  saveProcess,
  type GroupRef,
  type Step,
  type StepKind,
  setShapeNewItems,
  shapesNewItems,
} from '@hive/shared';
import { Link, getRouteApi } from '@tanstack/react-router';
import { ChevronLeft, FolderKanban, GitBranch, GripVertical, Plus, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useReady } from '../auth/context';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { displayName, useGroups, useProfiles } from '../members/data';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { Badge, Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Segmented, Select, Toggle } from '../ui/form';
import { Icon } from '../ui/icon';
import { AnimatePresence, motion, spring, useReducedMotion } from '../ui/motion';
import { useToast } from '../ui/overlay';
import { GateEditor, type Person } from './GateEditor';
import { StepEditor, type AgentChoice } from './StepEditor';
import {
  canChangeGate,
  checkDraft,
  insertAfter,
  newStep,
  stepsDiffer,
  withKind,
  type Removed,
} from './logic';

const route = getRouteApi('/p/$pid/process');

const WIDE = '(min-width: 1024px)';
function useWide(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(WIDE);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export function ProcessPage() {
  const { pid } = route.useParams();
  const { projects, items, projectsConfirmed, agents } = useShellData();
  const loading = !projectsConfirmed;
  const project = projects.find((p) => p.id === pid);
  if (!project) {
    return (
      <>
        <PageHeader title="Process" />
        {loading ? (
          <Skeleton className="h-64" />
        ) : (
          <EmptyState
            icon={FolderKanban}
            title="This project is gone or not yours to see"
            description="Pick another one from the list."
            action={
              <Link to="/projects" className="text-14 font-medium underline underline-offset-4">
                All projects
              </Link>
            }
          />
        )}
      </>
    );
  }
  return (
    <ProcessEditor
      key={project.id}
      pid={pid}
      projectName={`${project.data.emoji} ${project.data.name}`.trim()}
      base={project.data.steps}
      createdBy={project.data.createdBy}
      memberUids={project.data.memberUids}
      baseAgents={project.data.stepAgents}
      shapeNewItems={shapesNewItems(project.data)}
      agents={agents
        .filter((a) => !a.data.revokedAt)
        .map((a) => ({
          uid: a.id,
          name: a.data.name,
          onProject: a.data.projectIds === '*' || a.data.projectIds.includes(pid),
        }))}
      items={items[pid] ?? []}
    />
  );
}

type OpenItem = { id: string; data: { stepId: string } };

function ProcessEditor({
  pid,
  projectName,
  base,
  createdBy,
  memberUids,
  baseAgents,
  shapeNewItems,
  agents,
  items,
}: {
  shapeNewItems: boolean;
  pid: string;
  projectName: string;
  base: Step[];
  createdBy: string;
  memberUids: string[];
  baseAgents: Record<string, string[]>;
  agents: AgentChoice[];
  items: OpenItem[];
}) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const wide = useWide();
  const reduced = useReducedMotion();
  const wid = session.workspaceId;
  const me = session.me.uid;
  const who = { uid: me, isAdmin: session.isAdmin, createdBy };
  // Where a new gate starts: the viewer only when they may name deciders.
  const starter = canChangeGate([], '', who) ? me : null;

  const groupsLive = useGroups(wid);
  const groups: GroupRef[] = useMemo(
    () =>
      groupsLive.state === 'ready'
        ? groupsLive.data.map((g) => ({
            id: g.id,
            name: g.data.name,
            memberUids: g.data.memberUids,
          }))
        : [],
    [groupsLive],
  );
  const uids = useMemo(() => Object.keys(session.workspace.memberRoles), [session.workspace]);
  const profiles = useProfiles(wid, uids);
  const people: Person[] = useMemo(
    () =>
      uids
        .map((uid) => ({
          uid,
          name: displayName(profiles[uid], uid),
          profile: profiles[uid] ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [uids, profiles],
  );
  const names = useMemo(() => Object.fromEntries(people.map((p) => [p.uid, p.name])), [people]);

  // The draft is null until the first edit, so remote changes show through while nothing is edited.
  const [draft, setDraft] = useState<Step[] | null>(null);
  const [removed, setRemoved] = useState<Removed[]>([]);
  const steps = draft ?? base;
  // Per-step allowed agents (card zSzW3LXy): null until edited, like the steps.
  const [agentsDraft, setAgentsDraft] = useState<Record<string, string[]> | null>(null);
  const stepAgents = agentsDraft ?? baseAgents;
  const mayLimitAgents = canEditAgentSettings({ uid: me, isAdmin: session.isAdmin }, { createdBy });
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'steps' | 'gates'>('steps');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The floating save bar grows with its messages, so the spacer under the page follows its real height.
  const [barEl, barRef] = useState<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(96);
  useEffect(() => {
    if (!barEl || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBarHeight(barEl.offsetHeight));
    ro.observe(barEl);
    return () => ro.disconnect();
  }, [barEl]);
  const [error, setError] = useState<string | null>(null);

  const agentsDirty =
    agentsDraft !== null &&
    !sameStepAgents(
      normalizeStepAgents(steps, agentsDraft),
      normalizeStepAgents(steps, baseAgents),
    );
  const dirty = (draft !== null && stepsDiffer(draft, base)) || agentsDirty;
  const { moves, issues } = useMemo(() => checkDraft(base, steps, removed), [base, steps, removed]);

  const edit = (fn: (s: Step[]) => Step[]) => setDraft((d) => fn(d ?? base));
  const patch = (id: string, next: Step) => edit((s) => s.map((x) => (x.id === id ? next : x)));
  const itemsOn = (stepId: string) => items.filter((i) => i.data.stepId === stepId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const stepName = (id: string | number) => {
    const i = steps.findIndex((s) => s.id === id);
    return i < 0 ? 'step' : `step ${i + 1}, ${steps[i]!.name || 'untitled'}`;
  };
  const announcements = {
    onDragStart: ({ active }: { active: { id: string | number } }) =>
      `Picked up ${stepName(active.id)}.`,
    onDragOver: ({
      active,
      over,
    }: {
      active: { id: string | number };
      over: { id: string | number } | null;
    }) =>
      over
        ? `${stepName(active.id)} is over ${stepName(over.id)}.`
        : `${stepName(active.id)} is not over a step.`,
    onDragEnd: ({
      active,
      over,
    }: {
      active: { id: string | number };
      over: { id: string | number } | null;
    }) =>
      over
        ? `Dropped ${stepName(active.id)} on ${stepName(over.id)}.`
        : `Dropped ${stepName(active.id)}.`,
    onDragCancel: ({ active }: { active: { id: string | number } }) =>
      `Cancelled. ${stepName(active.id)} was not moved.`,
  };

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    edit((s) => {
      const from = s.findIndex((x) => x.id === active.id);
      const to = s.findIndex((x) => x.id === over.id);
      return from < 0 || to < 0 ? s : arrayMove(s, from, to);
    });
  }
  function move(id: string, delta: -1 | 1) {
    edit((s) => {
      const i = s.findIndex((x) => x.id === id);
      const j = i + delta;
      return i < 0 || j < 0 || j >= s.length ? s : arrayMove(s, i, j);
    });
  }
  function add(kind: StepKind) {
    const step = newStep(kind, starter);
    const at = selected ? steps.findIndex((s) => s.id === selected) : -1;
    edit((s) => insertAfter(s, at < 0 ? null : at, step));
    setSelected(step.id);
    if (kind === 'human') setView('steps');
  }
  function requestDelete(id: string) {
    if (itemsOn(id).length > 0) setDeleting(id);
    else removeStep(id, null);
  }
  function removeStep(id: string, target: string | null) {
    const index = steps.findIndex((s) => s.id === id);
    const step = steps[index];
    if (!step) return;
    const held = itemsOn(id).map((i) => i.id);
    // A step that was added in this draft has no items; one that existed keeps them until saved.
    if (held.length) setRemoved((r) => [...r, { step, index, itemIds: held, target }]);
    edit((s) => s.filter((x) => x.id !== id));
    setSelected((cur) => (cur === id ? null : cur));
    setDeleting(null);
  }
  function restore(r: Removed) {
    setRemoved((all) => all.filter((x) => x.step.id !== r.step.id));
    edit((s) => insertAfter(s, Math.min(r.index, s.length) - 1, r.step));
  }
  function discard() {
    setDraft(null);
    setAgentsDraft(null);
    setRemoved([]);
    setSelected(null);
    setError(null);
  }

  async function save() {
    const ctx = actionContext(wid);
    if (!ctx || issues.length) return;
    setSaving(true);
    setError(null);
    try {
      await run(
        saveProcess(ctx, { projectId: pid, steps, before: base, moves, memberUids, stepAgents }),
      );
      toast.push({ message: 'Process saved.' });
      setDraft(null);
      setAgentsDraft(null);
      setRemoved([]);
    } catch {
      setError('Could not save. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  const selectedStep = steps.find((s) => s.id === selected) ?? null;
  const selectedIndex = selectedStep ? steps.indexOf(selectedStep) : -1;
  const gates = steps.filter((s) => s.kind === 'human');
  const editor = selectedStep ? (
    view === 'gates' && selectedStep.gate ? (
      <GateEditor
        gate={selectedStep.gate}
        onChange={(g) => patch(selectedStep.id, { ...selectedStep, gate: g })}
        people={people}
        groups={groups}
        stepName={selectedStep.name || 'This gate'}
        locked={!canChangeGate(base, selectedStep.id, who)}
      />
    ) : (
      <StepEditor
        step={selectedStep}
        index={selectedIndex}
        count={steps.length}
        people={people}
        groups={groups}
        gateLocked={!canChangeGate(base, selectedStep.id, who)}
        agents={agentChoices(agents, ownGet(stepAgents, selectedStep.id) ?? [])}
        allowedAgents={ownGet(stepAgents, selectedStep.id) ?? []}
        onAllowedAgents={(uids) => setAgentsDraft({ ...stepAgents, [selectedStep.id]: uids })}
        agentsLocked={!mayLimitAgents}
        onChange={(s) => patch(selectedStep.id, s)}
        onKind={(k) => patch(selectedStep.id, withKind(selectedStep, k, starter))}
        onMove={(d) => move(selectedStep.id, d)}
        onDelete={() => requestDelete(selectedStep.id)}
      />
    )
  ) : null;
  const deletingStep = steps.find((s) => s.id === deleting) ?? null;

  return (
    <>
      <Link
        to="/p/$pid"
        params={{ pid }}
        className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-14 text-text-2 hover:text-ink"
      >
        <Icon icon={ChevronLeft} />
        {projectName}
      </Link>
      <PageHeader
        title="Process"
        subtitle="Agents take the steps in between. You decide at the gates."
      />
      <ShapeSwitch pid={pid} on={shapeNewItems} may={mayLimitAgents} />

      <Segmented
        tabs
        label="View"
        value={view}
        onValueChange={(v) => {
          setView(v as typeof view);
          setSelected(null);
        }}
        options={[
          { value: 'steps', label: 'Steps' },
          { value: 'gates', label: 'Who decides' },
        ]}
        className="mb-5"
      />

      <div className={cn('grid gap-8', wide && 'lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]')}>
        <div className="min-w-0">
          {view === 'steps' ? (
            <>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
                accessibility={{ announcements }}
              >
                <SortableContext
                  items={steps.map((s) => s.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol aria-label="Steps" className="flex flex-col gap-2">
                    {steps.map((s, i) => (
                      <SortableStep
                        key={s.id}
                        step={s}
                        index={i}
                        onlyAgents={
                          s.kind === 'agent'
                            ? (ownGet(stepAgents, s.id) ?? []).map(
                                (u) => agents.find((a) => a.uid === u)?.name ?? 'removed agent',
                              )
                            : []
                        }
                        selected={s.id === selected}
                        onSelect={() => setSelected(s.id)}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  leading={<Icon icon={Plus} />}
                  onClick={() => add('agent')}
                >
                  Add agent step
                </Button>
                <Button
                  variant="secondary"
                  leading={<Icon icon={Plus} />}
                  onClick={() => add('human')}
                >
                  Add decision step
                </Button>
              </div>
            </>
          ) : gates.length === 0 ? (
            <EmptyState
              icon={GitBranch}
              title="No decision points yet"
              description="Add a decision step and choose who decides there."
              action={
                <Button onClick={() => add('human')} leading={<Icon icon={Plus} />}>
                  Add decision step
                </Button>
              }
            />
          ) : (
            <ul aria-label="Decision points" className="flex flex-col gap-2">
              {gates.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={s.id === selected}
                    onClick={() => setSelected(s.id)}
                    className={cn(
                      'w-full rounded-card border bg-surface p-3.5 text-left transition-colors duration-120',
                      'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                      s.id === selected ? 'border-gate' : 'border-line hov:border-line-strong',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Badge tone="gate">{steps.indexOf(s) + 1}</Badge>
                      <span className="text-14 font-medium text-ink">{s.name || 'Untitled'}</span>
                    </span>
                    <span className="mt-1 block text-13 text-text-2">
                      {s.gate ? plainSummary(s.gate, names, groups) : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {removed.length ? (
            <section aria-label="Removed steps" className="mt-6 flex flex-col gap-2">
              <Eyebrow>Removed when you save</Eyebrow>
              {removed.map((r) => (
                <div
                  key={r.step.id}
                  className="rounded-card border border-dashed border-line-strong p-3"
                >
                  <p className="text-14 font-medium text-ink">
                    {r.step.name}{' '}
                    <span className="font-normal text-text-2">
                      · {r.itemIds.length} {r.itemIds.length === 1 ? 'item moves' : 'items move'} to{' '}
                      {steps.find((s) => s.id === r.target)?.name ?? 'a step you choose'}
                    </span>
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button variant="ghost" onClick={() => setDeleting(`removed:${r.step.id}`)}>
                      Change
                    </Button>
                    <Button
                      variant="ghost"
                      leading={<Icon icon={RotateCcw} />}
                      onClick={() => restore(r)}
                    >
                      Restore
                    </Button>
                  </div>
                </div>
              ))}
            </section>
          ) : null}
        </div>

        {wide ? (
          <div className="min-w-0">
            <AnimatePresence mode="wait" initial={false}>
              {selectedStep ? (
                <motion.section
                  key={selectedStep.id}
                  aria-label={`Edit ${selectedStep.name}`}
                  initial={{ opacity: 0, x: reduced ? 0 : 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  transition={spring.ui}
                  className="rounded-panel border border-line bg-surface p-5 shadow-e1"
                >
                  {editor}
                </motion.section>
              ) : (
                <p className="rounded-panel border border-dashed border-line-strong p-8 text-center text-14 text-text-2">
                  {view === 'steps'
                    ? 'Pick a step to edit it.'
                    : 'Pick a decision point to choose who decides.'}
                </p>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <ResponsiveModal
            open={selectedStep !== null}
            onOpenChange={(o) => !o && setSelected(null)}
            title={selectedStep?.name || 'Step'}
            description={view === 'gates' ? 'Who decides' : undefined}
            footer={<Button onClick={() => setSelected(null)}>Done</Button>}
          >
            {editor}
          </ResponsiveModal>
        )}
      </div>

      <DeleteDialog
        before={base}
        steps={steps}
        removed={removed}
        deleting={deleting}
        count={deleting && !deleting.startsWith('removed:') ? itemsOn(deleting).length : 0}
        onClose={() => setDeleting(null)}
        onConfirm={(id, target) => {
          if (id.startsWith('removed:'))
            setRemoved((all) => all.map((r) => (r.step.id === id.slice(8) ? { ...r, target } : r)));
          else removeStep(id, target);
          setDeleting(null);
        }}
        name={deletingStep?.name}
      />

      {/* Room to scroll the last controls clear of the floating save bar (phones are short). */}
      {dirty || removed.length ? (
        <div aria-hidden data-testid="save-bar-spacer" style={{ height: barHeight + 104 }} />
      ) : null}
      <AnimatePresence>
        {dirty || removed.length ? (
          <motion.div
            ref={barRef}
            role="region"
            aria-label="Unsaved changes"
            initial={{ y: reduced ? 0 : 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: reduced ? 0 : 24, opacity: 0 }}
            transition={spring.ui}
            className="fixed inset-x-3 bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 mx-auto flex max-w-3xl flex-col gap-2 rounded-panel border border-line bg-surface p-3 shadow-e3 sm:left-[4.75rem] sm:bottom-6 xl:left-[16.75rem]"
          >
            {issues.length || error ? (
              <ul role="alert" className="flex flex-col gap-0.5 text-13 text-sendback">
                {issues.map((i, k) => (
                  <li key={k}>{i.message}</li>
                ))}
                {error ? <li>{error}</li> : null}
              </ul>
            ) : (
              <p className="text-13 text-text-2">You have unsaved changes to this process.</p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={discard} disabled={saving}>
                Discard
              </Button>
              <Button onClick={save} loading={saving} disabled={issues.length > 0}>
                Save process
              </Button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** Agents allowed on the project, plus any still listed on the step that no longer are. */
function agentChoices(agents: AgentChoice[], listed: string[]): AgentChoice[] {
  return agents
    .filter((a) => a.onProject || listed.includes(a.uid))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function SortableStep({
  step,
  index,
  selected,
  onSelect,
  onlyAgents = [],
}: {
  step: Step;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onlyAgents?: string[];
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: step.id });
  const gate = step.kind === 'human';
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'z-10')}
    >
      <div
        className={cn(
          'flex items-stretch rounded-card border bg-surface transition-[border-color,box-shadow] duration-120',
          gate ? 'border-gate/60 bg-gate-bg' : 'border-line',
          selected && (gate ? 'border-gate' : 'border-agent'),
          isDragging && 'shadow-e3',
        )}
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          aria-label={`Reorder ${step.name}. Press space, then the arrow keys.`}
          className="grid w-11 shrink-0 cursor-grab touch-none place-items-center rounded-l-card text-text-3 hov:text-ink foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
          {...attributes}
          {...listeners}
        >
          <Icon icon={GripVertical} size={18} />
        </button>
        <button
          type="button"
          aria-label={`Edit ${step.name}`}
          aria-current={selected || undefined}
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-r-card py-3 pr-3 text-left foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
        >
          <span className="flex items-center gap-2">
            <span className="font-mono text-13 tabular-nums text-text-3">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-14 font-medium text-ink">
              {step.name || 'Untitled'}
            </span>
            <Badge tone={gate ? 'gate' : 'agent'}>{gate ? 'You decide' : 'Agent'}</Badge>
          </span>
          {step.description ? (
            <span className="mt-1 line-clamp-2 block pl-6 text-13 text-text-2">
              {step.description}
            </span>
          ) : null}
          {onlyAgents.length ? (
            <span className="mt-1 block truncate pl-6 text-13 text-agent">
              Only {onlyAgents.join(', ')}
            </span>
          ) : null}
        </button>
      </div>
    </li>
  );
}

function DeleteDialog({
  before,
  steps,
  removed,
  deleting,
  count,
  name,
  onClose,
  onConfirm,
}: {
  before: Step[];
  steps: Step[];
  removed: Removed[];
  deleting: string | null;
  count: number;
  name: string | undefined;
  onClose: () => void;
  onConfirm: (id: string, target: string | null) => void;
}) {
  const [choice, setChoice] = useState<string>('');
  const again = deleting?.startsWith('removed:')
    ? removed.find((r) => r.step.id === deleting.slice(8))
    : undefined;
  const id = again ? again.step.id : deleting;
  const n = again ? again.itemIds.length : count;
  const stepName = again ? again.step.name : name;
  const after = again ? steps : steps.filter((s) => s.id !== deleting);
  const targets = id ? moveTargets(before, id, after) : [];
  const value = targets.some((t) => t.id === choice) ? choice : (targets[0]?.id ?? '');
  return (
    <ResponsiveModal
      key={deleting ?? 'none'}
      open={deleting !== null}
      onOpenChange={(o) => !o && onClose()}
      title={`Move ${n} ${n === 1 ? 'item' : 'items'} to…`}
      description={`${stepName ?? 'This step'} still holds ${n} ${n === 1 ? 'item' : 'items'}. Choose where they go when you save.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={again ? 'primary' : 'sendback'}
            disabled={!value}
            onClick={() => id && onConfirm(deleting!, value)}
          >
            {again ? 'Move there' : `Move ${n} and delete step`}
          </Button>
        </>
      }
    >
      {targets.length ? (
        <Select
          label="Move to"
          value={value}
          onValueChange={setChoice}
          options={targets.map((t) => ({ value: t.id, label: t.name }))}
        />
      ) : (
        <p className="text-14 text-text-2">
          There is no step the items can move to. Items only go back to an earlier step, or on to
          the next one after an agent step. Keep this step, or change the order first.
        </p>
      )}
    </ResponsiveModal>
  );
}

/**
 * "Shape new items" (card st5INNZj): new items first wait for an agent to pick the steps they
 * need from this process. Admins and the project's creator switch it; it applies at once.
 */
function ShapeSwitch({ pid, on, may }: { pid: string; on: boolean; may: boolean }) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function set(v: boolean) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    setBusy(true);
    try {
      await run(setShapeNewItems(ctx, { projectId: pid, on: v }));
      toast.push({
        message: v
          ? 'New items now wait for an agent to pick their steps.'
          : 'New items go through every step again.',
      });
    } catch (e) {
      toast.push({ message: `Could not save: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="mb-5 rounded-card border border-line bg-surface px-4 py-2"
      data-testid="shape-switch"
    >
      <Toggle
        label="Shape new items"
        description={
          may
            ? 'An agent picks the steps each new item needs; people steps are skipped only with a decider.'
            : 'An agent picks the steps each new item needs. Admins and the project creator switch this.'
        }
        checked={on}
        disabled={!may || busy}
        onCheckedChange={(v) => void set(v)}
      />
    </div>
  );
}
