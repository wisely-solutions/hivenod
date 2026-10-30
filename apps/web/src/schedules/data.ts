/**
 * Scheduled tasks, slice 6: the listeners behind the Schedules page and Today. As cheap as
 * possible (João, 2026-10-30): one listener per organization for the member's schedules (the
 * timeline, Coming up and next runs are computed from it), one for the runs that could not happen
 * (Today), one for the runs of the shown range (the page only), the scheduler's beat (one doc),
 * and a schedule's history only while its detail is open. Every query is the member's own
 * (memberUid == me), which is all the rules let a member read.
 */
import {
  agentSchema,
  schedulePaths,
  scheduleRunSchema,
  scheduleSchema,
  SCHEDULER_BEAT_PATH,
  type Schedule,
  type ScheduleRun,
} from '@hive/shared';
import { collection, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { useMemo } from 'react';
import { z } from 'zod';
import { db } from '../lib/db';
import { useLiveDoc } from '../lib/live';
import { agentsQuery } from '../shell/queries';
import { useAcross } from '../threads/data';
import type { RunLite, SchedLite } from './logic';

export const schedulesQuery = (wid: string, uid: string) =>
  query(collection(db, `workspaces/${wid}/schedules`), where('memberUid', '==', uid));

/** The runs waiting for the member's decision (Today's cards). Equality only: no composite index. */
export const cantRunQuery = (wid: string, uid: string) =>
  query(
    collection(db, `workspaces/${wid}/scheduleRuns`),
    where('memberUid', '==', uid),
    where('state', '==', 'cantRun'),
  );

export const HISTORY_MAX = 12;

const runsSinceQuery = (wid: string, uid: string, sinceMs: number) =>
  query(
    collection(db, `workspaces/${wid}/scheduleRuns`),
    where('memberUid', '==', uid),
    where('dueAt', '>=', Timestamp.fromMillis(sinceMs)),
  );

const historyQuery = (wid: string, uid: string, sid: string) =>
  query(
    collection(db, `workspaces/${wid}/scheduleRuns`),
    where('memberUid', '==', uid),
    where('scheduleId', '==', sid),
    orderBy('dueAt', 'desc'),
    limit(HISTORY_MAX),
  );

export function toSched(wid: string, id: string, d: Schedule): SchedLite {
  return {
    wid,
    id,
    title: d.title,
    what: d.what,
    agentUid: d.agentUid,
    rule: d.rule,
    runTitle: d.runTitle,
    steps: d.steps,
    state: d.state,
    activeFromMs: d.activeFrom ? d.activeFrom.toMillis() : null,
    subjectId: d.subjectId,
    replaces: d.replaces,
  };
}

export function toRun(wid: string, id: string, d: ScheduleRun): RunLite {
  return {
    wid,
    id,
    scheduleId: d.scheduleId,
    key: d.key,
    period: d.period,
    dueMs: d.dueAt.toMillis(),
    title: d.title,
    state: d.state,
    why: d.why,
    threadId: d.threadId,
    laterAtMs: d.laterAt ? d.laterAt.toMillis() : null,
    decision: d.decision ? { choice: d.decision.choice, atMs: d.decision.at.toMillis() } : null,
  };
}

/** The member's schedules in every organization, with the raw docs (the actions need them). */
export function useMySchedules(uid: string, wids: readonly string[]) {
  const r = useAcross('my-schedules', wids, uid, schedulesQuery, scheduleSchema, (wid, id, d) => ({
    lite: toSched(wid, id, d),
    data: d,
  }));
  return useMemo(
    () => ({
      state: r.state,
      list: r.rows.map((x) => x.lite),
      docs: new Map(r.rows.map((x) => [`${x.lite.wid}/${x.lite.id}`, x.data] as const)),
    }),
    [r],
  );
}

/** Runs waiting for a decision (Run now · Try later · Skip). */
export function useCantRun(uid: string, wids: readonly string[]) {
  const r = useAcross('cant-run', wids, uid, cantRunQuery, scheduleRunSchema, (wid, id, d) => ({
    lite: toRun(wid, id, d),
    data: d,
  }));
  return useMemo(
    () => ({
      state: r.state,
      list: r.rows.map((x) => x.lite),
      docs: new Map(r.rows.map((x) => [`${x.lite.wid}/${x.lite.id}`, x.data] as const)),
    }),
    [r],
  );
}

/** Runs due since `sinceMs` (the timeline's range and the list's last runs). */
export function useRunsSince(uid: string, wids: readonly string[], sinceMs: number) {
  const r = useAcross(
    `runs-since:${sinceMs}`,
    wids,
    uid,
    (wid, u) => runsSinceQuery(wid, u, sinceMs),
    scheduleRunSchema,
    (wid, id, d) => ({ lite: toRun(wid, id, d), data: d }),
  );
  return useMemo(
    () => ({
      state: r.state,
      list: r.rows.map((x) => x.lite),
      docs: new Map(r.rows.map((x) => [`${x.lite.wid}/${x.lite.id}`, x.data] as const)),
    }),
    [r],
  );
}

/** One schedule's latest runs (its detail), only while open. */
export function useScheduleHistory(uid: string, wid: string | null, sid: string | null) {
  const wids = useMemo(() => (wid ? [wid] : []), [wid]);
  const r = useAcross(
    `schedule-history:${sid ?? ''}`,
    wids,
    uid,
    (w, u) => historyQuery(w, u, sid ?? ''),
    scheduleRunSchema,
    (w, id, d) => ({ lite: toRun(w, id, d), data: d }),
    !!wid && !!sid,
  );
  return useMemo(
    () => ({
      state: r.state,
      list: r.rows.map((x) => x.lite).sort((a, b) => b.dueMs - a.dueMs),
      docs: new Map(r.rows.map((x) => [`${x.lite.wid}/${x.lite.id}`, x.data] as const)),
    }),
    [r],
  );
}

const beatSchema = z.object({ beatAt: z.unknown().optional() }).passthrough();

/** The scheduler's last beat (ms), null when it never beat; undefined while loading. */
export function useSchedulerBeat(enabled = true): number | null | undefined {
  const live = useLiveDoc(enabled ? SCHEDULER_BEAT_PATH : null, beatSchema);
  if (live.state === 'loading') return undefined;
  if (live.state !== 'ready' || !live.data) return null;
  const b = live.data.beatAt as { toMillis?: () => number } | undefined;
  return b && typeof b.toMillis === 'function' ? b.toMillis() : null;
}

/** The agents of every organization the member is in, by `wid/uid` (names and colours). */
export function useAgentsAcross(uid: string, wids: readonly string[]) {
  const r = useAcross(
    'agents-across',
    wids,
    uid,
    (wid) => agentsQuery(wid),
    agentSchema,
    (wid, id, d) => ({
      key: `${wid}/${id}`,
      data: d,
    }),
  );
  return useMemo(() => new Map(r.rows.map((a) => [a.key, a.data] as const)), [r.rows]);
}

/** The member's Off switch in one organization (read-only here; slice 7 flips it). */
export function offPath(wid: string, uid: string) {
  return schedulePaths.off(wid, uid);
}

/**
 * Today's scheduled-task parts (design 9.3): the member's schedules (Coming up and the banner),
 * the runs that could not happen (cards), and the beat (only read when there is a schedule).
 */
export function useTodaySchedules(uid: string, wids: readonly string[]) {
  const schedules = useMySchedules(uid, wids);
  const cant = useCantRun(uid, wids);
  const any = schedules.list.some((s) => s.state === 'active');
  const beat = useSchedulerBeat(any);
  return { schedules, cant, beat: any ? beat : null };
}
