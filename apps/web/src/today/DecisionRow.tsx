/**
 * A thread of the Today stack that is not the focused one (item kt3E7u9EliL3q2veDDI0, design
 * 2.1): one line with the sender, the title, the proposal in short, the confidence and the state.
 * A click focuses it (it becomes the decision card).
 */
import { CheckCircle2, ChevronRight } from 'lucide-react';
import { outcomeType } from '@hive/shared';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { motion, useReducedMotion } from '../ui/motion';
import type { NeedsEntry } from '../needs/logic';
import { bandOf } from '../threads/logic';
import { proposalSentence } from './logic';
import { bandEdge, ConfidenceMeter, RankChip, rankText, SenderAvatar } from './parts';

export function DecisionRow({
  entry,
  sender,
  org,
  now,
  onFocus,
}: {
  entry: NeedsEntry;
  sender: string | null;
  /** Shown when the member is in several organizations. */
  org: { name: string; color: string } | null;
  now: number;
  onFocus: () => void;
}) {
  const reduced = useReducedMotion();
  const t = entry.thread!.data;
  const asked = t.state === 'needsYou';
  const first = entry.proposals?.[0];
  const band = bandOf(t, now);
  const rank = rankText(t, band, now);
  const summary = asked
    ? `${sender ? `${sender.split(' ')[0]} asks: ` : 'Asks: '}${t.question?.text ?? ''}`
    : first
      ? `${proposalSentence(first.data.type, first.data.fields)}${
          (entry.proposals?.length ?? 0) > 1 ? ` · +${entry.proposals!.length - 1} more` : ''
        }`
      : '';
  return (
    <motion.li
      layout={reduced ? false : 'position'}
      initial={false}
      exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
      className="relative pb-2"
    >
      <button
        type="button"
        onClick={onFocus}
        data-thread-row={entry.key}
        className={cn(
          'flex w-full items-center gap-3 rounded-card border border-l-4 border-line bg-surface px-3.5 py-3 text-left',
          'transition-colors duration-120 hov:bg-canvas foc:outline-2 foc:outline-offset-2 foc:outline-focus',
          bandEdge(band),
        )}
      >
        <SenderAvatar name={sender ?? t.title} size="sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            {org ? (
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: org.color }}
              />
            ) : null}
            <span className="truncate text-14 font-semibold text-ink">
              {t.title || 'Untitled thread'}
            </span>
          </span>
          <span className="truncate text-13 text-text-2">
            {org ? <span className="sr-only">{org.name} · </span> : null}
            {summary}
          </span>
        </span>
        {rank ? (
          <span className="max-sm:hidden">
            <RankChip text={rank} band={band} />
          </span>
        ) : null}
        {first && !asked ? (
          <ConfidenceMeter value={first.data.confidence} compact className="max-sm:hidden" />
        ) : null}
        <Badge tone={asked ? 'gate' : 'agent'} className="shrink-0">
          {asked
            ? 'Question'
            : first
              ? outcomeType(first.data.type)?.executor === 'none'
                ? 'Proposed'
                : 'Draft ready'
              : 'Your call'}
        </Badge>
        <Icon icon={ChevronRight} size={16} className="shrink-0 text-text-3 max-sm:hidden" />
      </button>
    </motion.li>
  );
}

/** A decision made this visit: the card collapsed to one line ("Sent · Reply and book · Sam"). */
export function DoneRow({ label }: { label: string }) {
  return (
    <li className="pb-2" data-done-row="">
      <div className="flex items-center gap-2 rounded-card border border-approve/40 bg-approve-bg px-3.5 py-2.5 text-14 font-medium text-approve-text">
        <Icon icon={CheckCircle2} size={16} />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    </li>
  );
}
