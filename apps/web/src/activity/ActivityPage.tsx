import { memberProfileSchema } from '@hive/shared';
import { Activity } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { useLiveCollection } from '../lib/live';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { Button } from '../ui/button';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Select } from '../ui/form';
import { Eyebrow } from '../ui/badge';
import { useActivityFeed, useItemTitles, useNow } from './data';
import { EventRow } from './EventRow';
import {
  groupByDay,
  INDEX_BUILDING_TEXT,
  NO_FILTERS,
  TYPE_GROUPS,
  type FeedFilters,
  type TypeGroupId,
} from './logic';

/** Everything every agent and person did, newest first, live. */
export function ActivityPage() {
  const { session } = useReady();
  const wid = session.workspaceId;
  const { projects, agents, items, loading } = useShellData();
  const members = useLiveCollection(`workspaces/${wid}/members`, memberProfileSchema);
  const now = useNow(30_000);

  // A plain member may only read events one project at a time, so a project is always chosen.
  const isAdmin = session.isAdmin;
  const [filters, setFilters] = useState<FeedFilters>(NO_FILTERS);
  const firstProject = projects[0]?.id ?? '';
  const effective: FeedFilters = isAdmin
    ? filters
    : { ...filters, projectId: filters.projectId || firstProject };
  const ready = isAdmin || (!loading && Boolean(effective.projectId));
  const feed = useActivityFeed(wid, effective, ready);

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p.data] as const)),
    [projects],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);
  const known = useMemo(() => {
    const m = new Map<string, string>();
    for (const [pid, rows] of Object.entries(items))
      for (const r of rows) m.set(`${pid}/${r.id}`, r.data.title);
    return (pid: string, iid: string) => m.get(`${pid}/${iid}`);
  }, [items]);
  const titleOf = useItemTitles(
    wid,
    feed.rows.map((r) => r.data),
    known,
  );

  // Rows grow when a title arrives, so the first paint of a feed waits for its titles. Later
  // pages (older activity) load below the fold and may fill in afterwards.
  const [revealed, setRevealed] = useState(false);
  const titlesReady = titleOf.settled;
  if (feed.state === 'loading' && revealed) setRevealed(false);
  else if (feed.state === 'ready' && titlesReady && !revealed) setRevealed(true);

  const days = useMemo(() => groupByDay(feed.rows, now), [feed.rows, now]);

  // Infinite scroll: reaching the end of the list reads the next page of 50.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && loadMore(),
      {
        rootMargin: '400px',
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, feed.rows.length]);

  const people = members.state === 'ready' ? members.data : [];
  const actorOptions = [
    { value: 'all', label: 'Everyone' },
    { value: 'people', label: 'All people' },
    { value: 'agents', label: 'All agents' },
    ...agents.map((a) => ({ value: a.id, label: `Agent · ${a.data.name}` })),
    ...people.map((p) => ({ value: p.id, label: p.data.name || p.data.email || 'Member' })),
  ];
  const projectOptions = [
    ...(isAdmin ? [{ value: '', label: 'All projects' }] : []),
    ...projects.map((p) => ({ value: p.id, label: `${p.data.emoji} ${p.data.name}` })),
  ];
  const typeOptions = [
    { value: '', label: 'All types' },
    ...TYPE_GROUPS.map((g) => ({ value: g.id, label: g.label })),
  ];

  return (
    <>
      <PageHeader title="Activity" subtitle="Everything people and agents did, as it happens." />

      <div role="group" aria-label="Filters" className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Select
          label="Project"
          value={effective.projectId}
          onValueChange={(v) => setFilters((f) => ({ ...f, projectId: v }))}
          options={projectOptions}
        />
        <Select
          label="Who"
          value={filters.actor}
          onValueChange={(v) => setFilters((f) => ({ ...f, actor: v }))}
          options={actorOptions}
        />
        <Select
          label="Type"
          value={filters.group}
          onValueChange={(v) => setFilters((f) => ({ ...f, group: v as '' | TypeGroupId }))}
          options={typeOptions}
        />
      </div>

      {!ready && !loading && !isAdmin ? (
        <EmptyState
          icon={Activity}
          title="No projects yet"
          description="Activity from the projects you are on shows up here."
        />
      ) : feed.state === 'loading' ||
        (!isAdmin && loading) ||
        (feed.state === 'ready' && feed.rows.length > 0 && !revealed && !titlesReady) ? (
        <div aria-busy="true" aria-label="Loading activity">
          <div className="mb-2 py-1">
            <Skeleton className="h-4 w-24" />
          </div>
          <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-e1">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li
                key={i}
                className="flex h-[4.5rem] items-start gap-3 border-t border-line px-3 py-2.5 first:border-t-0 sm:px-4"
              >
                <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2 pt-1">
                  <Skeleton className="h-3.5 w-4/5" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : feed.state === 'error' ? (
        <EmptyState
          icon={Activity}
          title={feed.indexBuilding ? 'Still preparing this view' : 'Activity could not be loaded'}
          description={
            feed.indexBuilding
              ? INDEX_BUILDING_TEXT
              : 'Check your connection and reload. If it keeps happening, you may not have access to this view.'
          }
        />
      ) : feed.rows.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="Nothing here yet"
          description="When people and agents work on items, every step shows up here, newest first."
        />
      ) : (
        <div className="flex flex-col gap-5">
          {days.map((day) => (
            <section key={day.key} aria-label={day.label}>
              <h2 className="sticky top-0 z-10 -mx-1 mb-2 bg-canvas/95 px-1 py-1 backdrop-blur">
                <Eyebrow>{day.label}</Eyebrow>
              </h2>
              <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-e1">
                {day.rows.map((r) => (
                  <EventRow
                    key={r.id}
                    wid={wid}
                    event={r}
                    fresh={feed.fresh.has(r.id)}
                    now={now}
                    title={titleOf(r.data.projectId, r.data.itemId)}
                    project={r.data.projectId ? projectById.get(r.data.projectId) : undefined}
                    agent={agentById.get(r.data.actor.id)}
                  />
                ))}
              </ul>
            </section>
          ))}
          <div ref={sentinel} className="flex justify-center py-2">
            {feed.hasMore ? (
              <Button variant="secondary" loading={feed.loadingMore} onClick={feed.loadMore}>
                Load older activity
              </Button>
            ) : feed.complete ? (
              <p className="text-13 text-text-2">That is everything.</p>
            ) : null}
          </div>
        </div>
      )}
    </>
  );
}
