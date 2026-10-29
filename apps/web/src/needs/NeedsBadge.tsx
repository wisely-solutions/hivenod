import { NumberRoll } from '../ui/badge';
import { cn } from '../ui/cn';

/**
 * The Needs you counter (item 2YZRd): everything waiting across every organization, with the part
 * only this person can act on highlighted in front (solid). "2 | 5": 2 only you, 5 in all; one
 * solid "3" when all of it is only you. Hidden from screen readers: the link's name says it.
 */
export function NeedsBadge({
  total,
  onlyYou,
  className,
}: {
  total: number;
  onlyYou: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-needs-badge
      className={cn(
        'inline-flex h-5 items-stretch overflow-hidden rounded-full border border-gate/50 text-12 font-semibold leading-none',
        className,
      )}
    >
      {onlyYou > 0 ? (
        <span
          data-only-you
          className="inline-flex min-w-5 items-center justify-center bg-ink px-1.5 text-surface"
        >
          <NumberRoll value={onlyYou} />
        </span>
      ) : null}
      {onlyYou < total ? (
        <span className="inline-flex min-w-5 items-center justify-center bg-gate-bg px-1.5 text-gate-text">
          <NumberRoll value={total} />
        </span>
      ) : null}
    </span>
  );
}

/** "Needs you 5 waiting, 2 only you": the accessible name of the nav entry. */
export function needsLabel(label: string, total: number, onlyYou: number): string {
  if (total <= 0) return label;
  return `${label} ${total} waiting${onlyYou > 0 ? `, ${onlyYou} only you` : ''}`;
}
