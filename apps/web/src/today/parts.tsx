/**
 * Small pieces of the Today page (item kt3E7u9EliL3q2veDDI0): the confidence meter, the sender's
 * avatar, the organization chip, the rank chip and the state chip.
 */
import type { InboxThread, OutcomeConfidence } from '@hive/shared';
import { agentColorIndex } from '../ui/avatar';
import { cn } from '../ui/cn';
import type { Band } from '../threads/logic';
import { CONFIDENCE, dueShort } from './logic';

/** "Sure ▮▮▮": the word, with three bars; nothing for older outcomes without a confidence. */
export function ConfidenceMeter({
  value,
  compact,
  className,
}: {
  value: OutcomeConfidence | undefined;
  /** Bars only (one-line rows); the word is still read by screen readers. */
  compact?: boolean;
  className?: string;
}) {
  if (!value) return null;
  const c = CONFIDENCE[value];
  return (
    <span
      data-confidence={value}
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-13 text-text-2', className)}
    >
      <span aria-hidden className="flex items-end gap-0.5">
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn(
              'inline-block w-1.5 rounded-[2px]',
              i <= c.bars
                ? value === 'high'
                  ? 'bg-approve'
                  : value === 'medium'
                    ? 'bg-gate'
                    : 'bg-sendback'
                : 'bg-line',
            )}
            style={{ height: 6 + i * 3 }}
          />
        ))}
      </span>
      <span className={compact ? 'sr-only' : 'font-medium'}>{c.word}</span>
    </span>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

/** The sender's initials on a colour picked from their name (decorative: the name is shown). */
export function SenderAvatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-on-solid',
        size === 'md' ? 'size-10 text-14' : 'size-8 text-12',
      )}
      style={{ background: `var(--agent-${agentColorIndex(name)})` }}
    >
      {initials(name)}
    </span>
  );
}

/** A chip with a coloured dot: the organization. */
export function OrgChip({ name, color }: { name: string; color: string }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-12 font-medium text-ink">
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A neutral chip (the area). */
export function Chip({ children }: { children: string }) {
  return (
    <span className="inline-flex h-6 max-w-full items-center rounded-full bg-canvas px-2.5 text-12 font-medium text-text-2">
      <span className="truncate">{children}</span>
    </span>
  );
}

/** "Urgent · due Fri", "Due Mon", "Overdue", or nothing (design 2.2). */
export function rankText(t: Pick<InboxThread, 'urgent' | 'due'>, band: Band, now: number): string {
  const due = t.due ? t.due.toMillis() : null;
  const when = due === null ? '' : due < now ? 'overdue' : `due ${dueShort(due, now)}`;
  if (t.urgent) return when ? `Urgent · ${when}` : 'Urgent';
  if (band <= 2 && when) return when[0]!.toUpperCase() + when.slice(1);
  return '';
}

export function RankChip({ text, band }: { text: string; band: Band }) {
  if (!text) return null;
  return (
    <span
      data-rank={band}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-12 font-semibold',
        band === 1
          ? 'border-sendback-border bg-sendback-bg text-sendback'
          : 'border-gate/50 bg-gate-bg text-gate-text',
      )}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', band === 1 ? 'bg-sendback' : 'bg-gate')}
      />
      {text}
    </span>
  );
}

/** The left edge of a card or row by rank band: red, amber, or none. */
export const bandEdge = (band: Band | null) =>
  band === 1 ? 'border-l-sendback' : band === 2 ? 'border-l-gate' : 'border-l-transparent';
