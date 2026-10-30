import { Activity } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { useShellData } from '../shell/data';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState, Skeleton } from '../ui/feedback';
import { useNow, useThreadFeed, useThreadTitles } from './data';
import { groupByDay, INDEX_BUILDING_TEXT } from './logic';
import { ThreadEventRow } from './ThreadEventRow';
import { foldProgress, matches, type ThreadFeedFilters } from './threadLogic';

/**
 * The thread activity feed (slice 9, design 6.7): the signed-in member's thread events, live,
 * newest first, grouped by day. Used by Activity and, filtered to one agent, by the agent page.
 */
export function ThreadFeed({
  filters,
  emptyText = 'When you and your agents work on threads, every step shows up here, newest first.',
}: {
  filters: ThreadFeedFilters;
  emptyText?: string;
}) {
  const { session } = useReady();
  const wid = session.workspaceId;
  const uid = session.me.uid;
  const { agents } = useShellData();
  const now = useNow(30_000);
  const feed = useThreadFeed(wid, uid, filters.group, true);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a] as const)), [agents]);

  const shown = useMemo(
    () => foldProgress(feed.rows.filter((r) => matches(r.data, filters))),
    [feed.rows, filters],
  );
  const titleOf = useThreadTitles(
    wid,
    shown.map((r) => r.data),
  );
  const days = useMemo(() => groupByDay(shown, now), [shown, now]);

  // Rows grow when a title arrives, so the first paint waits for its titles.
  const [revealed, setRevealed] = useState(false);
  if (feed.state === 'loading' && revealed) setRevealed(false);
  else if (feed.state === 'ready' && titleOf.settled && !revealed) setRevealed(true);

  // Infinite scroll: reaching the end of the list reads the next page of 50.
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore } = feed;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => entries.some((e) => e.isIntersecting) && loadMore(),
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, shown.length]);

  if (feed.state === 'loading' || (feed.state === 'ready' && shown.length > 0 && !revealed))
    return (
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
    );
  if (feed.state === 'error')
    return (
      <EmptyState
        icon={Activity}
        title={feed.indexBuilding ? 'Still preparing this view' : 'Activity could not be loaded'}
        description={
          feed.indexBuilding
            ? INDEX_BUILDING_TEXT
            : 'Check your connection and reload. If it keeps happening, you may not have access to this view.'
        }
      />
    );
  return (
    <div className="flex flex-col gap-5" data-testid="thread-feed">
      {shown.length === 0 ? (
        <EmptyState icon={Activity} title="Nothing here yet" description={emptyText} />
      ) : (
        days.map((day) => (
          <section key={day.key} aria-label={day.label}>
            <h2 className="sticky top-0 z-10 -mx-1 mb-2 bg-canvas/95 px-1 py-1 backdrop-blur">
              <Eyebrow>{day.label}</Eyebrow>
            </h2>
            <ul className="overflow-hidden rounded-card border border-line bg-surface shadow-e1">
              {day.rows.map((r) => (
                <ThreadEventRow
                  key={r.id}
                  wid={wid}
                  event={r}
                  folded={r.folded}
                  fresh={feed.fresh.has(r.id)}
                  title={titleOf(r.data.threadId)}
                  agent={agentById.get(r.data.actor.id)}
                />
              ))}
            </ul>
          </section>
        ))
      )}
      <div ref={sentinel} className="flex justify-center py-2">
        {feed.hasMore ? (
          <Button variant="secondary" loading={feed.loadingMore} onClick={feed.loadMore}>
            Load older activity
          </Button>
        ) : feed.complete && shown.length > 0 ? (
          <p className="text-13 text-text-2">That is everything.</p>
        ) : null}
      </div>
    </div>
  );
}
