/**
 * The briefing bar on a thread opened from Today or the calendar (item kt3E7u9EliL3q2veDDI0,
 * design 2.2): "‹ Today · ▬▬▭▭▭ 2 of 6 · Next: <title> ›".
 */
import { Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { NeedsEntry } from '../needs/logic';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import type { BriefingFrom } from '../today/briefing';

const titleOf = (e: NeedsEntry) =>
  e.thread ? e.thread.data.title || 'Untitled thread' : (e.entry?.item.title ?? 'Untitled');

export function BriefingBar({
  from,
  list,
  index,
}: {
  from: BriefingFrom;
  list: readonly NeedsEntry[];
  index: number;
}) {
  const next = index >= 0 ? list[index + 1] : list[0];
  const back = from === 'calendar' ? 'Calendar' : 'Today';
  return (
    <nav
      aria-label="Briefing"
      data-briefing=""
      className="mb-4 flex min-h-12 flex-wrap items-center gap-x-4 gap-y-1 rounded-card border border-line bg-surface px-3 py-1.5 shadow-e1"
    >
      <Link
        to={from === 'calendar' ? '/calendar' : '/'}
        className="inline-flex min-h-11 items-center gap-1 rounded-btn pr-1 text-14 font-semibold text-ink foc:outline-2 foc:outline-focus"
      >
        <Icon icon={ChevronLeft} size={16} />
        {back}
      </Link>
      {list.length ? (
        <span className="flex items-center gap-2 text-13 text-text-2">
          <span aria-hidden className="flex gap-1">
            {list.slice(0, 12).map((e, i) => (
              <span
                key={e.key}
                className={cn(
                  'h-1.5 w-5 rounded-full',
                  i === index ? 'bg-ink' : i < index ? 'bg-approve' : 'bg-line-strong/40',
                )}
              />
            ))}
          </span>
          <span data-position="" className="tabular-nums">
            {index >= 0 ? `${index + 1} of ${list.length}` : `${list.length} left`}
          </span>
        </span>
      ) : (
        <span className="text-13 text-text-2">Nothing else waits</span>
      )}
      {next ? (
        <Link
          to={next.thread ? '/inbox/$wid/t/$tid' : '/'}
          params={next.thread ? { wid: next.wid, tid: next.thread.id } : undefined}
          search={next.thread ? { from } : { sel: next.key }}
          className="ml-auto inline-flex min-h-11 min-w-0 items-center gap-1 rounded-btn text-14 text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
        >
          <span className="truncate">Next: {titleOf(next)}</span>
          <Icon icon={ChevronRight} size={16} className="shrink-0" />
        </Link>
      ) : null}
    </nav>
  );
}
