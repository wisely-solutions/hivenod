import {
  restoreProject,
  describeProcess,
  templateLabel,
  type HiveEvent,
  type Project,
} from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Archive, ArchiveRestore, FolderKanban, Plus, Users } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { spendText } from '../shell/logic';
import type { Row } from '../lib/live';
import { NumberRoll, Pill } from '../ui/badge';
import { IconButton, Button } from '../ui/button';
import { Card } from '../ui/card';
import { cn } from '../ui/cn';
import { Skeleton, WorkingDots } from '../ui/feedback';
import { Icon } from '../ui/icon';
import { AnimatePresence, motion, spring, useReducedMotion } from '../ui/motion';
import { useToast } from '../ui/overlay';
import { latestByProject, orderProjects, projectColorIndex, summarize, timeAgo } from './logic';
import { describeEventWithItem } from './logic';
import { useItemTitles } from '../activity/data';
import { useArchiveProject } from './useArchive';
import { NewProjectModal } from './NewProjectModal';
import { ProcessStrip } from './ProcessStrip';
import { ProjectPeopleModal } from './ProjectPeopleModal';
import { RecentActivity, useRecentEvents } from './RecentActivity';
import { TemplateGallery } from './TemplateGallery';

export function ProjectsPage() {
  const { session, actionContext, run } = useReady();
  const {
    projects,
    needs,
    items,
    runs,
    runsSynced,
    loading: projectsLoading,
    settled,
  } = useShellData();
  // Cards print needs-you counts and spend, so they wait for the per-project reads too. A
  // feed that never answers must not hide the list for good: after 3 s show what we have.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), 3000);
    return () => clearTimeout(t);
  }, []);
  const loading = projectsLoading || (!settled && patient);
  const toast = useToast();
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);
  const recent = useRecentEvents(projectIds);
  const events: Row<HiveEvent>[] | null = recent.state === 'ready' ? recent.data : null;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // New project modal. A new key each time it opens gives it fresh state.
  const [creating, setCreating] = useState<{ key: number; template?: string } | null>(null);
  const opened = useRef(0);
  const openCreate = (template?: string) => setCreating({ key: ++opened.current, template });
  // The palette's "New project" arrives as /projects?new=1 and shows the gallery until closed.
  const { new: wantNew } = useSearch({ strict: false }) as { new?: 1 };
  const navigateHere = useNavigate();
  const shown = creating ?? (wantNew ? { key: -1, template: undefined } : null);
  const closeCreate = () => {
    setCreating(null);
    if (wantNew) void navigateHere({ to: '/projects', search: {}, replace: true });
  };

  const { hidden, archive } = useArchiveProject();

  const live = useMemo(
    () => projects.filter((p) => !p.data.archivedAt && !hidden.has(p.id)),
    [projects, hidden],
  );
  const ordered = useMemo(() => orderProjects(live, needs.byProject), [live, needs.byProject]);
  const latest = useMemo(() => latestByProject(events ?? []), [events]);
  const known = useMemo(() => {
    const m = new Map<string, string>();
    for (const [pid, rows] of Object.entries(items))
      for (const r of rows) m.set(`${pid}/${r.id}`, r.data.title);
    return (pid: string, iid: string) => m.get(`${pid}/${iid}`);
  }, [items]);
  const titleOf = useItemTitles(
    session.workspaceId,
    useMemo(() => (events ?? []).map((r) => r.data), [events]),
    known,
  );

  const archived = useMemo(
    () => (session.isAdmin ? projects.filter((p) => p.data.archivedAt) : []),
    [projects, session.isAdmin],
  );
  function restore(p: Row<Project>) {
    const ctx = actionContext(session.workspaceId);
    if (!ctx) return;
    run(restoreProject(ctx, { projectId: p.id, name: p.data.name })).then(
      () => toast.push({ message: `${p.data.name} restored.` }),
      () => toast.push({ message: `Could not restore ${p.data.name}.` }),
    );
  }

  // The skeleton takes the shape of the list the last visit ended with (how many cards, how many
  // with a "need you" pill), so the real cards land on the same boxes and nothing below moves.
  const shapeKey = `hive:projects-shape:${session.workspaceId}`;
  const [remembered] = useState(() => readShape(shapeKey));
  const pills = ordered.filter((p) => (needs.byProject[p.id] ?? 0) > 0).length;
  useEffect(() => {
    if (settled && !projectsLoading) writeShape(shapeKey, { n: ordered.length, pills });
  }, [settled, projectsLoading, shapeKey, ordered.length, pills]);
  const skeleton = projectsLoading
    ? remembered
    : { n: live.length, pills: Math.min(remembered.pills, live.length) };

  const [peopleOf, setPeopleOf] = useState<Row<Project> | null>(null);
  const empty = !loading && live.length === 0;
  return (
    <>
      <PageHeader
        title="Projects"
        // Named after the organization: the list is this organization's only (item icVly).
        subtitle={
          live.length
            ? `${session.workspace.name} · ${live.length} ${live.length === 1 ? 'project' : 'projects'}`
            : undefined
        }
        reserveSubtitle={loading}
        action={
          <div className="flex items-center gap-2">
            <Link
              to="/items"
              className="inline-flex min-h-11 items-center rounded-btn border border-line-strong bg-surface px-4 text-14 font-medium text-ink hover:bg-canvas"
            >
              List all items
            </Link>
            <Button leading={<Icon icon={Plus} />} onClick={() => openCreate()}>
              New project
            </Button>
          </div>
        }
      />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {loading ? (
            <ul
              aria-hidden
              aria-busy="true"
              className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1"
            >
              {Array.from({ length: Math.max(1, skeleton.n) }, (_, i) => (
                <ProjectCardSkeleton key={i} pill={i < skeleton.pills} />
              ))}
            </ul>
          ) : empty ? (
            <section aria-labelledby="hero" className="flex flex-col gap-5">
              <div className="rounded-panel border border-line bg-surface p-6 shadow-e1">
                <span className="grid size-11 place-items-center rounded-full bg-canvas text-text-2">
                  <Icon icon={FolderKanban} size={20} />
                </span>
                <h2 id="hero" className="mt-3 text-20 font-semibold text-ink">
                  {session.isAdmin
                    ? 'Agents do the work. You make the decisions.'
                    : 'You are not on any project yet'}
                </h2>
                <p className="mt-1 max-w-prose text-14 text-text-2">
                  {session.isAdmin
                    ? 'A Hivenod project is a process of steps. Agents take the steps in between, and you decide at the gates. Start from a template.'
                    : `An admin of ${session.workspace.name} adds you to a project and it shows up here. You can also start one of your own from a template.`}
                </p>
              </div>
              <TemplateGallery
                bleed="page"
                columns={1}
                value={null}
                onValueChange={(t) => openCreate(t.id)}
              />
            </section>
          ) : (
            <ul
              aria-label="Projects"
              className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1"
            >
              <AnimatePresence mode="popLayout" initial={false}>
                {ordered.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    summary={summarize(p.id, items, runs, needs.byProject[p.id] ?? 0, now)}
                    spendKnown={runsSynced.has(p.id)}
                    activity={latest[p.id]}
                    titleOf={titleOf}
                    now={now}
                    canArchive={session.isAdmin}
                    onArchive={() => archive(p)}
                    onPeople={session.isAdmin ? () => setPeopleOf(p) : undefined}
                  />
                ))}
              </AnimatePresence>
            </ul>
          )}
          {!loading && archived.length ? (
            <details className="mt-8 rounded-card border border-line bg-surface">
              <summary className="cursor-pointer px-4 py-3 text-14 font-medium text-ink foc:outline-2 foc:outline-focus">
                Archived ({archived.length})
              </summary>
              <ul
                aria-label="Archived projects"
                className="divide-y divide-line border-t border-line"
              >
                {archived.map((p) => (
                  <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span aria-hidden className="text-20">
                      {p.data.emoji}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-14 text-text-2">
                      {p.data.name}
                    </span>
                    <Button
                      variant="ghost"
                      leading={<Icon icon={ArchiveRestore} size={16} />}
                      onClick={() => restore(p)}
                    >
                      Restore<span className="sr-only"> {p.data.name}</span>
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>

        {/* On a phone it sits under the list: show it once the list is final, so the cards
            arriving never push it down (on desktop it is a side column and cannot move). */}
        <RecentActivity
          events={events}
          titleOf={titleOf}
          projects={projects}
          now={now}
          className={loading ? 'max-lg:hidden' : undefined}
        />
      </div>

      {peopleOf ? (
        <ProjectPeopleModal
          key={peopleOf.id}
          project={projects.find((p) => p.id === peopleOf.id) ?? peopleOf}
          onClose={() => setPeopleOf(null)}
        />
      ) : null}

      {shown ? (
        <NewProjectModal
          key={shown.key}
          open
          initialTemplateId={shown.template}
          nextColor={(projects.length % 8) + 1}
          onClose={closeCreate}
        />
      ) : null}
    </>
  );
}

interface Shape {
  n: number;
  pills: number;
}

/** The list shape remembered from the last visit (browser storage may be missing or blocked). */
function readShape(key: string): Shape {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Shape> | null;
    if (v && Number.isInteger(v.n) && Number.isInteger(v.pills))
      return { n: Math.min(Math.max(v.n!, 0), 50), pills: Math.max(v.pills!, 0) };
  } catch {
    // Fall through to the default.
  }
  return { n: 2, pills: 1 };
}

function writeShape(key: string, shape: Shape) {
  try {
    localStorage.setItem(key, JSON.stringify(shape));
  } catch {
    // Only a nicer skeleton next time; nothing to do.
  }
}

/** Same boxes as ProjectCard (with room for the "need you" pill), so the list does not jump when the projects arrive. */
function ProjectCardSkeleton({ pill = false }: { pill?: boolean }) {
  return (
    <li>
      <Card className="flex h-full flex-col gap-3.5">
        <div className="flex items-start gap-3 pr-11">
          <Skeleton className="size-11 shrink-0 rounded-card" />
          <div className="min-w-0 flex-1">
            <div className="flex h-6 items-center">
              <Skeleton className="h-4 w-1/2" />
            </div>
            <div className="flex h-[1.3125rem] items-center">
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
        </div>
        {pill ? <Skeleton className="h-6 w-24 rounded-full" /> : null}
        <Skeleton className="h-4" />
        <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className={cn('flex h-[2.7rem] flex-col justify-between', i === 2 && 'w-28')}
            >
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
        <div className="border-t border-transparent pt-3">
          <div className="flex h-[1.3125rem] items-center">
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      </Card>
    </li>
  );
}

function ProjectCard({
  project,
  summary,
  activity,
  titleOf,
  spendKnown,
  now,
  canArchive,
  onArchive,
  onPeople,
}: {
  project: Row<Project>;
  summary: ReturnType<typeof summarize>;
  activity: Row<HiveEvent> | undefined;
  titleOf: (pid: string | null, iid: string | null) => string | null;
  spendKnown: boolean;
  now: number;
  canArchive: boolean;
  onArchive: () => void;
  onPeople?: () => void;
}) {
  const p = project.data;
  const reduced = useReducedMotion();
  const idx = projectColorIndex(p.color, project.id);
  const when = activity
    ? `${describeEventWithItem(activity.data, titleOf(activity.data.projectId, activity.data.itemId))} · ${timeAgo(activity.data.at.toMillis(), now)}`
    : `Created ${timeAgo(p.createdAt.toMillis(), now)}`;
  return (
    <motion.li
      layout={reduced ? false : 'position'}
      initial={{ opacity: 0, scale: reduced ? 1 : 0.96, y: reduced ? 0 : 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: reduced ? 1 : 0.96 }}
      transition={spring.ui}
      aria-label={p.name}
      className="relative"
    >
      <Link
        to="/p/$pid"
        params={{ pid: project.id }}
        className="block rounded-card transition-[transform,box-shadow] duration-200 ease-standard hov:-translate-y-0.5 hov:shadow-e2 act:scale-[0.99] foc:outline-2 foc:outline-offset-2 foc:outline-focus"
      >
        <Card className="flex h-full flex-col gap-3.5">
          <div className={cn('flex items-start gap-3', onPeople ? 'pr-24' : 'pr-11')}>
            <span
              aria-hidden
              className="grid size-11 shrink-0 place-items-center rounded-card text-20"
              style={{
                backgroundColor: `color-mix(in srgb, var(--agent-${idx}) 16%, transparent)`,
              }}
            >
              {p.emoji}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-16 font-semibold text-ink">{p.name}</h2>
              <p className="truncate text-13 text-text-2">{templateLabel(p.templateId)}</p>
            </div>
          </div>

          {summary.needsYou > 0 ? (
            <Pill tone="gate" className="self-start">
              <NumberRoll value={summary.needsYou} /> need you
            </Pill>
          ) : null}

          <ProcessStrip steps={p.steps} />
          <span className="sr-only">{describeProcess(p.steps)}</span>

          {/* The spend column keeps its label on one line (it wrapped at 375 px). */}
          <dl className="grid grid-cols-[1fr_1fr_auto] gap-2 text-13">
            <div>
              <dt className="text-text-2">Open items</dt>
              <dd className="font-medium tabular-nums text-ink">{summary.openItems}</dd>
            </div>
            <div>
              <dt className="text-text-2">Agents active</dt>
              <dd className="flex items-center gap-1.5 font-medium tabular-nums text-ink">
                {summary.agentsActive}
                {summary.agentsActive > 0 ? <WorkingDots /> : null}
              </dd>
            </div>
            <div>
              <dt className="whitespace-nowrap text-text-2">Spend this month</dt>
              <dd className="font-medium tabular-nums text-ink">
                {spendText(summary.spend, spendKnown, `p.${project.id}`)}
              </dd>
            </div>
          </dl>

          <p className="truncate border-t border-line pt-3 text-13 text-text-2">{when}</p>
        </Card>
      </Link>
      {canArchive || onPeople ? (
        <span className="absolute right-2 top-2 flex">
          {onPeople ? (
            <IconButton label={`People on ${p.name}`} variant="ghost" onClick={onPeople}>
              <Icon icon={Users} size={18} />
            </IconButton>
          ) : null}
          {canArchive ? (
            <IconButton label={`Archive ${p.name}`} variant="ghost" onClick={onArchive}>
              <Icon icon={Archive} size={18} />
            </IconButton>
          ) : null}
        </span>
      ) : null}
    </motion.li>
  );
}
