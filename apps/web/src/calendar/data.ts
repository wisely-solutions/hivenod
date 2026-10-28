import { busyBlockSchema, calendarEventSchema, type CalendarEvent } from '@hive/shared';
import {
  collection,
  getDocs,
  onSnapshot,
  query,
  Timestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { db } from '../lib/db';
import type { CalBlock } from './logic';

/** "all": every calendar of mine, with details; otherwise one organization's id. */
export type Scope = 'all' | string;

/** My events in one organization (the "all my calendars" view). */
export const myEventsQuery = (wid: string, uid: string, from: Date) =>
  query(
    collection(db, `workspaces/${wid}/calendar`),
    where('memberUid', '==', uid),
    where('end', '>', Timestamp.fromDate(from)),
  );

/** Every member's events in one organization (members of it may read them). */
export const orgEventsQuery = (wid: string, from: Date) =>
  query(collection(db, `workspaces/${wid}/calendar`), where('end', '>', Timestamp.fromDate(from)));

/** My busy time, from every organization (no details). */
export const myBusyQuery = (uid: string, from: Date) =>
  query(collection(db, `users/${uid}/busy`), where('end', '>', Timestamp.fromDate(from)));

/**
 * Removes my busy blocks of an organization I just left (the rules allow it once I am no longer a
 * member). Best effort: whatever is left is hidden by the calendar view.
 */
export async function clearBusyOf(uid: string, wid: string): Promise<void> {
  const snap = await getDocs(
    query(collection(db, `users/${uid}/busy`), where('workspaceId', '==', wid)),
  );
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of snap.docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
}

type Snap = { state: 'loading' } | { state: 'ready'; blocks: CalBlock[] } | { state: 'error' };

const toBlock = (id: string, e: CalendarEvent, label: string): CalBlock => ({
  id,
  start: new Date(e.start.toMillis()),
  end: new Date(e.end.toMillis()),
  title: e.busyOnly ? '' : e.title,
  kind: e.busyOnly ? 'busy' : 'event',
  label,
  allDay: e.allDay,
});

/**
 * The blocks of the range: in "all", my events of every organization (labelled with its name);
 * in one organization, its events (others' labelled with their name) plus my busy time from my
 * other organizations, greyed and without details.
 */
export function useCalendarBlocks(opts: {
  scope: Scope;
  uid: string;
  orgs: ReadonlyArray<{ id: string; name: string }>;
  memberName: (wid: string, uid: string) => string;
  from: Date;
  to: Date;
}): { state: 'loading' | 'ready' | 'error'; blocks: CalBlock[] } {
  const { scope, uid, orgs, from, to, memberName } = opts;
  const fromMs = from.getTime();
  const orgKey = orgs.map((o) => `${o.id}:${o.name}`).join('|');
  const [snaps, setSnaps] = useState<{ key: string; parts: Record<string, Snap> }>({
    key: '',
    parts: {},
  });
  const key = `${scope}|${uid}|${fromMs}|${orgKey}`;
  useEffect(() => {
    const since = new Date(fromMs);
    const set = (part: string, s: Snap) =>
      setSnaps((cur) => ({
        key,
        parts: { ...(cur.key === key ? cur.parts : {}), [part]: s },
      }));
    const listen = (
      part: string,
      q: ReturnType<typeof query>,
      map: (id: string, d: unknown) => CalBlock | null,
    ) => {
      set(part, { state: 'loading' });
      return onSnapshot(
        q,
        (snap) => {
          const blocks: CalBlock[] = [];
          for (const d of snap.docs) {
            const b = map(d.id, d.data({ serverTimestamps: 'estimate' }));
            if (b) blocks.push(b);
          }
          set(part, { state: 'ready', blocks });
        },
        () => set(part, { state: 'error' }),
      );
    };
    const event =
      (wid: string, label: (e: CalendarEvent) => string) => (id: string, d: unknown) => {
        const r = calendarEventSchema.safeParse(d);
        if (!r.success || r.data.deleted) return null;
        return toBlock(`${wid}/${id}`, r.data, label(r.data));
      };
    const stops: Array<() => void> = [];
    if (scope === 'all') {
      for (const o of orgs)
        stops.push(
          listen(
            o.id,
            myEventsQuery(o.id, uid, since),
            event(o.id, () => o.name),
          ),
        );
    } else {
      const here = orgs.find((o) => o.id === scope)?.name ?? '';
      stops.push(
        listen(
          scope,
          orgEventsQuery(scope, since),
          event(scope, (e) => (e.memberUid === uid ? here : memberName(scope, e.memberUid))),
        ),
      );
      stops.push(
        listen('busy', myBusyQuery(uid, since), (id, d) => {
          const r = busyBlockSchema.safeParse(d);
          if (!r.success || r.data.deleted || r.data.workspaceId === scope) return null;
          // Time of an organization I am no longer in (or that is gone) is not mine to show.
          if (!orgs.some((o) => o.id === r.data.workspaceId)) return null;
          return {
            id: `busy/${id}`,
            start: new Date(r.data.start.toMillis()),
            end: new Date(r.data.end.toMillis()),
            title: '',
            kind: 'busy',
            label: 'Another organization',
            allDay: false,
          };
        }),
      );
    }
    return () => stops.forEach((s) => s());
    // memberName is read when a snapshot arrives; a new name shows with the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useMemo(() => {
    const parts = snaps.key === key ? Object.values(snaps.parts) : [];
    if (parts.length === 0) return { state: 'loading' as const, blocks: [] };
    if (parts.some((p) => p.state === 'error')) {
      const ok = parts.flatMap((p) => (p.state === 'ready' ? p.blocks : []));
      return {
        state: ok.length ? ('ready' as const) : ('error' as const),
        blocks: ok.filter((b) => b.start < to),
      };
    }
    if (parts.some((p) => p.state === 'loading')) return { state: 'loading' as const, blocks: [] };
    const blocks = parts
      .flatMap((p) => (p.state === 'ready' ? p.blocks : []))
      .filter((b) => b.start < to);
    return { state: 'ready' as const, blocks };
  }, [snaps, key, to]);
}
