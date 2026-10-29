/**
 * What the calendar shows from the Inbox (item kt3E7u9EliL3q2veDDI0, design 2.6): the bookings
 * agents proposed (open reply_book outcomes, dashed in the grid) and the threads' deadlines (the
 * due strip). Both come from the Needs-you feeds the shell already listens to: no extra reads.
 */
import { THREAD_OPEN, type InboxOutcome, type InboxThread } from '@hive/shared';
import { useMemo } from 'react';
import type { Row } from '../lib/live';
import { useNeedsAll } from '../needs/data';
import { bandOf } from '../threads/logic';
import type { CalBlock } from './logic';

export interface Proposed {
  wid: string;
  oid: string;
  tid: string;
  outcome: Row<InboxOutcome>;
  thread: Row<InboxThread> | null;
  start: Date;
  end: Date;
  title: string;
  with: string;
}

export interface Deadline {
  wid: string;
  tid: string;
  title: string;
  due: Date;
  /** 1 red (urgent or within a day), 2 amber. */
  band: 1 | 2 | 3 | 4;
}

/** Open reply_book proposals as calendar data. Pure, for tests. */
export function proposedBookings(
  inputs: ReadonlyArray<{
    wid: string;
    openOutcomes: readonly Row<InboxOutcome>[];
    threads: readonly Row<InboxThread>[];
  }>,
): Proposed[] {
  const out: Proposed[] = [];
  for (const i of inputs)
    for (const o of i.openOutcomes) {
      if (
        o.data.type !== 'reply_book' ||
        (o.data.state !== 'proposed' && o.data.state !== 'revising')
      )
        continue;
      const s = Date.parse(String(o.data.fields.start ?? ''));
      const e = Date.parse(String(o.data.fields.end ?? ''));
      if (Number.isNaN(s) || Number.isNaN(e) || e <= s) continue;
      const withWho = String(o.data.fields.with ?? '');
      out.push({
        wid: i.wid,
        oid: o.id,
        tid: o.data.threadId,
        outcome: o,
        thread: i.threads.find((t) => t.id === o.data.threadId) ?? null,
        start: new Date(s),
        end: new Date(e),
        title: String(o.data.fields.title ?? '') || `Meeting with ${withWho}`,
        with: withWho,
      });
    }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Deadlines of the member's open threads. Pure, for tests. */
export function deadlines(
  inputs: ReadonlyArray<{ wid: string; threads: readonly Row<InboxThread>[] }>,
  uid: string,
  now: number,
): Deadline[] {
  const out: Deadline[] = [];
  for (const i of inputs)
    for (const t of i.threads) {
      if (t.data.memberUid !== uid || !t.data.due) continue;
      if (!(THREAD_OPEN as readonly string[]).includes(t.data.state)) continue;
      out.push({
        wid: i.wid,
        tid: t.id,
        title: t.data.title || 'Untitled thread',
        due: new Date(t.data.due.toMillis()),
        band: bandOf(t.data, now),
      });
    }
  return out.sort((a, b) => a.due.getTime() - b.due.getTime());
}

/** The proposals and deadlines, live, plus how many things wait for the member. */
export function useCalendarInbox(uid: string, now: number) {
  const all = useNeedsAll();
  const proposed = useMemo(() => proposedBookings(all.inputs), [all.inputs]);
  const due = useMemo(() => deadlines(all.inputs, uid, now), [all.inputs, uid, now]);
  return { proposed, due, forYou: all.ready ? all.counts.total : 0, orgs: all.orgs };
}

/** Proposed bookings as dashed blocks of the grid. */
export function proposedBlocks(
  list: readonly Proposed[],
  label: (wid: string) => string,
): CalBlock[] {
  return list.map((p) => ({
    id: `proposed/${p.oid}`,
    start: p.start,
    end: p.end,
    title: p.title,
    kind: 'proposed' as const,
    label: label(p.wid),
    allDay: false,
    proposal: { wid: p.wid, tid: p.tid, oid: p.oid },
  }));
}
