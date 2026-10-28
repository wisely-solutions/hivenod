import { eventSchema, type HiveEvent, type Project } from '@hive/shared';
import { countReads } from '../lib/reads';
import { Link } from '@tanstack/react-router';
import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveQuery, type Live, type Row } from '../lib/live';
import { Avatar, AgentAvatar, agentColorIndex } from '../ui/avatar';
import { Eyebrow } from '../ui/badge';
import { cn } from '../ui/cn';
import { Skeleton } from '../ui/feedback';
import { describeEventWithItem, timeAgo } from './logic';

export const RECENT_EVENTS = 20;

/**
 * The newest events, live. Admins read the whole organization in one query; a member reads one
 * query per project they are on (the rules only allow that), merged newest first.
 */
export function useRecentEvents(projectIds: readonly string[]): Live<Row<HiveEvent>[]> {
  const { session } = useReady();
  const wid = session.workspaceId;
  const admin = session.isAdmin;
  const orgWide = useLiveQuery(
    admin ? `events:${wid}:recent` : null,
    () =>
      query(
        collection(db, `workspaces/${wid}/events`),
        orderBy('at', 'desc'),
        limit(RECENT_EVENTS),
      ),
    eventSchema,
  );

  const key = projectIds.join('|');
  const [byProject, setByProject] = useState<{
    key: string;
    rows: Record<string, Row<HiveEvent>[]>;
  }>({
    key: '',
    rows: {},
  });
  useEffect(() => {
    if (admin) return;
    const ids = key ? key.split('|') : [];
    const stops = ids.map((pid) =>
      onSnapshot(
        query(
          collection(db, `workspaces/${wid}/events`),
          where('projectId', '==', pid),
          orderBy('at', 'desc'),
          limit(RECENT_EVENTS),
        ),
        (snap) => {
          countReads(snap);
          const rows: Row<HiveEvent>[] = [];
          snap.docs.forEach((d) => {
            const r = eventSchema.safeParse(d.data({ serverTimestamps: 'estimate' }));
            if (r.success) rows.push({ id: d.id, data: r.data });
          });
          setByProject((cur) => ({
            key,
            rows: { ...(cur.key === key ? cur.rows : {}), [pid]: rows },
          }));
        },
        () => undefined,
      ),
    );
    return () => stops.forEach((stop) => stop());
  }, [admin, wid, key]);

  return useMemo<Live<Row<HiveEvent>[]>>(() => {
    if (admin) return orgWide;
    const ids = key ? key.split('|') : [];
    if (ids.length === 0) return { state: 'ready', data: [] };
    if (byProject.key !== key || ids.some((id) => !byProject.rows[id])) return { state: 'loading' };
    const all = ids.flatMap((id) => byProject.rows[id] ?? []);
    all.sort((a, b) => b.data.at.toMillis() - a.data.at.toMillis());
    return { state: 'ready', data: all.slice(0, RECENT_EVENTS) };
  }, [admin, orgWide, byProject, key]);
}

export function RecentActivity({
  events,
  titleOf,
  projects,
  now,
  className,
}: {
  events: Row<HiveEvent>[] | null;
  titleOf: (pid: string | null, iid: string | null) => string | null;
  projects: Row<Project>[];
  now: number;
  className?: string;
}) {
  const names = new Map(projects.map((p) => [p.id, p.data] as const));
  return (
    <section aria-labelledby="recent-activity" className={cn('min-w-0', className)}>
      <h2 id="recent-activity" className="mb-3">
        <Eyebrow>Recent activity</Eyebrow>
      </h2>
      {events === null ? (
        <div
          aria-hidden
          aria-busy="true"
          className="flex flex-col rounded-card border border-line bg-surface shadow-e1"
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className={cn(
                'flex min-h-12 items-center gap-2.5 px-3 py-2',
                i > 0 && 'border-t border-line',
              )}
            >
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3 w-4/5" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      ) : events.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong p-4 text-14 text-text-2">
          Nothing yet. Activity from people and agents shows up here.
        </p>
      ) : (
        <ul className="flex flex-col rounded-card border border-line bg-surface shadow-e1">
          {events.map((e, i) => {
            const project = e.data.projectId ? names.get(e.data.projectId) : undefined;
            const who = e.data.actor;
            const body = (
              <>
                {who.type === 'agent' ? (
                  <AgentAvatar
                    name={who.name || 'Agent'}
                    color={agentColorIndex(who.id)}
                    size="sm"
                  />
                ) : (
                  <Avatar name={who.name || '?'} size="sm" />
                )}
                <span className="min-w-0">
                  <span className="block truncate text-13 text-ink">
                    {describeEventWithItem(e.data, titleOf(e.data.projectId, e.data.itemId))}
                  </span>
                  <span className="block truncate text-13 text-text-2">
                    {project ? `${project.emoji} ${project.name} · ` : ''}
                    {timeAgo(e.data.at.toMillis(), now)}
                  </span>
                </span>
              </>
            );
            return (
              <li key={e.id} className={i > 0 ? 'border-t border-line' : undefined}>
                {e.data.projectId && project ? (
                  <Link
                    to="/p/$pid"
                    params={{ pid: e.data.projectId }}
                    className="flex min-h-12 items-center gap-2.5 px-3 py-2 hov:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
                  >
                    {body}
                  </Link>
                ) : (
                  <div className="flex min-h-12 items-center gap-2.5 px-3 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
