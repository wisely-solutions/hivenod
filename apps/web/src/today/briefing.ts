/**
 * Briefing mode (item kt3E7u9EliL3q2veDDI0, design 2.2): the thread page opened from Today
 * (?from=today) steps through the same decisions in the same order: "‹ Today · ▬▬▭▭ 2 of 6 · Next: <title> ›".
 */
import { useMemo } from 'react';
import { useNeedsAll } from '../needs/data';
import { orderToday, type NeedsEntry } from '../needs/logic';

export type BriefingFrom = 'today';

/** The decisions a briefing steps through, in order. */
export function briefingList(
  todo: readonly NeedsEntry[],
  from: BriefingFrom,
  now: number,
): NeedsEntry[] {
  void from;
  return orderToday(todo, now);
}

export function useBriefing(from: BriefingFrom | undefined, key: string, now: number) {
  const all = useNeedsAll();
  return useMemo(() => {
    if (!from) return null;
    const list = briefingList(all.needs.todo, from, now);
    const index = list.findIndex((e) => e.key === key);
    return { list, index, ready: all.ready };
  }, [all.needs.todo, all.ready, from, key, now]);
}
