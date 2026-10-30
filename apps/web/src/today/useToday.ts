/**
 * Everything the Today page shows around the stack (item kt3E7u9EliL3q2veDDI0): senders, areas,
 * organization colours, the brief's counts, the threads waiting on others and those agents are
 * working on.
 */
import type { InboxMessage } from '@hive/shared';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import type { NeedsAll } from '../needs/data';
import { briefOf, type Brief, type Segment } from '../needs/brief';
import { entryBand, type NeedsEntry } from '../needs/logic';
import { orgColor } from '../orgs/color';
import { useLatestNotes, useMessagesSince, useSubjectsById, useThreadMessages } from './data';
import { dueShort } from './logic';
import { agentsTurn } from '../threads/logic';

const DAY = 86_400_000;

const WAITING_ON: Record<string, string> = {
  them: 'on them',
  thirdParty: 'on someone else',
  item: 'on an item',
  date: 'snoozed',
  agent: 'on the agent',
};

export function useToday(
  all: NeedsAll,
  stack: readonly NeedsEntry[],
  tidy: readonly NeedsEntry[],
  now: number,
  /** Decisions made this visit: their segments turn green. */
  doneCount = 0,
) {
  const { session } = useReady();
  const uid = session.me.uid;
  const wids = useMemo(() => all.orgs.map((o) => o.wid), [all.orgs]);
  // Fixed for the visit: the brief counts the 24 hours before the page opened.
  const [since] = useState(() => Date.now() - DAY);
  const recent = useMessagesSince(uid, wids, since);
  const subjects = useSubjectsById(uid, wids);

  const threadRefs = useMemo(
    () =>
      [...stack, ...tidy].filter((e) => e.thread).map((e) => ({ wid: e.wid, id: e.thread!.id })),
    [stack, tidy],
  );
  const messages = useThreadMessages(uid, threadRefs);

  const threadsAll = useMemo(
    () => all.inputs.flatMap((i) => i.threads.map((t) => ({ wid: i.wid, ...t }))),
    [all.inputs],
  );
  const investigating = useMemo(
    () =>
      threadsAll
        .filter((t) => t.data.memberUid === uid && agentsTurn(t.data))
        .sort((a, b) => b.data.updatedAt.toMillis() - a.data.updatedAt.toMillis())
        .slice(0, 5),
    [threadsAll, uid],
  );
  const notes = useLatestNotes(
    uid,
    useMemo(() => investigating.map((t) => ({ wid: t.wid, id: t.id })), [investigating]),
  );

  const colorOf = (wid: string) => orgColor(wid, all.orgs);
  const orgOf = (wid: string) => {
    const o = all.orgs.find((x) => x.wid === wid);
    return o ? { name: o.name, color: colorOf(wid) } : null;
  };
  const senderOf = (e: NeedsEntry): { name: string; source: string; at: number } | null => {
    if (!e.thread) return null;
    const list: InboxMessage[] = messages.get(`${e.wid}/${e.thread.id}`) ?? [];
    const last = [...list].reverse().find((m) => m.direction === 'in') ?? list[list.length - 1];
    return last
      ? { name: last.sender.name, source: last.source, at: last.receivedAt.toMillis() }
      : null;
  };
  const areaOf = (e: NeedsEntry) => {
    const sid = e.thread?.data.subjectId;
    return sid ? (subjects.get(`${e.wid}/${sid}`)?.area ?? null) : null;
  };

  const waiting = useMemo(
    () =>
      threadsAll
        .filter(
          (t) => t.data.memberUid === uid && t.data.state === 'waiting' && !agentsTurn(t.data),
        )
        .sort((a, b) => a.data.updatedAt.toMillis() - b.data.updatedAt.toMillis())
        .slice(0, 6)
        .map((t) => ({
          key: `${t.wid}/${t.id}`,
          wid: t.wid,
          tid: t.id,
          title: t.data.title || 'Untitled thread',
          on: WAITING_ON[t.data.waiting?.on ?? 'them'] ?? 'waiting',
          at: t.data.updatedAt.toMillis(),
        })),
    [threadsAll, uid],
  );
  const working = investigating.map((t) => ({
    key: `${t.wid}/${t.id}`,
    wid: t.wid,
    tid: t.id,
    title: t.data.title || 'Untitled thread',
    note: notes.get(`${t.wid}/${t.id}`)?.text ?? '',
  }));

  const brief = useMemo<Brief | null>(() => {
    if (recent.state === 'loading') return null;
    const inMsgs = recent.rows.filter((m) => m.data.direction === 'in');
    const threads = stack.filter((e) => e.thread);
    const proposals = threads.filter((e) => e.thread!.data.state === 'yourCall').length;
    const questions =
      threads.filter((e) => e.thread!.data.state === 'needsYou').length +
      stack.filter((e) => !e.thread && e.kind === 'question').length;
    const projectEntries = stack.filter((e) => !e.thread && e.kind !== 'question').length;
    const top = stack[0];
    const segments: Segment[] = [
      ...Array.from({ length: doneCount }, () => 'green' as const),
      ...stack.map((e): Segment => {
        const b = entryBand(e, now);
        return b === 1 || (b === null && e.urgent) ? 'red' : b === 2 ? 'amber' : 'grey';
      }),
    ];
    return briefOf({
      messages: inMsgs.length,
      sources: new Set(inMsgs.map((m) => m.data.source)).size,
      proposals,
      questions,
      projectEntries,
      tidyUps: tidy.length,
      working: investigating.length,
      top: top
        ? {
            title: top.thread
              ? top.thread.data.title || 'Untitled thread'
              : (top.entry?.item.title ?? 'Untitled'),
            due: top.thread?.data.due ? dueShort(top.thread.data.due.toMillis(), now) : null,
            urgent: top.thread ? top.thread.data.urgent === true : top.urgent,
          }
        : null,
      segments,
    });
  }, [recent, stack, tidy.length, investigating.length, now, doneCount]);

  return { brief, waiting, working, orgOf, senderOf, areaOf };
}
