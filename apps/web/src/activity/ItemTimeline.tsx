import { eventSchema, type Agent } from '@hive/shared';
import { collection, limit, orderBy, query, where } from 'firebase/firestore';
import { useMemo } from 'react';
import { db } from '../lib/db';
import { useLiveQuery, type Row } from '../lib/live';
import { Skeleton } from '../ui/feedback';
import { useNow } from './data';
import { EventRow } from './EventRow';
import { eventDetail, foldProgress, groupByDay, type DetailContext } from './logic';
import { Eyebrow } from '../ui/badge';

/** Every event of one item, newest first. One listener (the project id lets the rules allow it). */
export function ItemTimeline({
  wid,
  pid,
  itemId,
  title,
  agents,
  detail,
}: {
  wid: string;
  pid: string;
  itemId: string;
  title: string;
  agents: Row<Agent>[];
  /** What the item's decisions, runs and attachments add to each event (one story). */
  detail?: DetailContext;
}) {
  const now = useNow(30_000);
  const live = useLiveQuery(
    `timeline:${wid}:${pid}:${itemId}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/events`),
        where('projectId', '==', pid),
        where('itemId', '==', itemId),
        orderBy('at', 'desc'),
        limit(200),
      ),
    eventSchema,
  );
  const all = useMemo(() => (live.state === 'ready' ? live.data : []), [live]);
  const folded = useMemo(() => foldProgress(all), [all]);
  const rows = folded.rows;
  const days = useMemo(() => groupByDay(rows, now), [rows, now]);
  if (live.state === 'loading') return <Skeleton className="h-20" />;
  if (live.state === 'error')
    return <p className="text-14 text-sendback">The timeline could not be loaded.</p>;
  if (rows.length === 0)
    return <p className="text-14 text-text-2">Nothing has happened to this item yet.</p>;
  return (
    <div className="flex flex-col gap-4" aria-label="History">
      {days.map((d) => (
        <section key={d.key} aria-label={d.label}>
          <h3 className="mb-2">
            <Eyebrow>{d.label}</Eyebrow>
          </h3>
          <ul className="overflow-hidden rounded-card border border-line bg-surface">
            {d.rows.map((r) => (
              <EventRow
                key={r.id}
                wid={wid}
                event={r}
                now={now}
                title={title}
                showProject={false}
                progress={folded.byAnchor.get(r.id)}
                detail={detail ? eventDetail(r, detail) : undefined}
                agent={agents.find((a) => a.id === r.data.actor.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
