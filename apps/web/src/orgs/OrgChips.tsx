import type { CSSProperties } from 'react';
import { cn } from '../ui/cn';
import { orgColor } from './color';

/**
 * Organization colour chips (item icVly, model A): narrow Today or Inbox to one
 * organization, or show them all. A filter only: the switcher never changes it, and the page keeps
 * the choice in its URL (`?org=`). The colours are the ones the organization has everywhere.
 */
export function OrgChips({
  orgs,
  value,
  onChange,
  hint,
  className,
}: {
  orgs: ReadonlyArray<{ wid: string; name: string }>;
  /** The organization shown, or null for all of them. */
  value: string | null;
  onChange: (wid: string | null) => void;
  /** A short line after the chips (desktop only). */
  hint?: string;
  className?: string;
}) {
  if (orgs.length < 2) return null;
  const base =
    'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-13 font-medium transition-colors foc:outline-2 foc:outline-focus';
  return (
    <div
      role="group"
      aria-label="Organization"
      data-org-chips=""
      className={cn(
        // Scrolls sideways on its own on a phone; the page never does.
        '-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0',
        className,
      )}
    >
      <button
        type="button"
        aria-pressed={value === null}
        onClick={() => onChange(null)}
        className={cn(
          base,
          value === null
            ? 'border-ink bg-ink text-surface'
            : 'border-line bg-surface text-text-2 hov:border-line-strong hov:text-ink',
        )}
      >
        All <span className="tabular-nums">{orgs.length}</span>
      </button>
      {orgs.map((o) => {
        const color = orgColor(o.wid, orgs);
        const on = value === o.wid;
        return (
          <button
            key={o.wid}
            type="button"
            aria-pressed={on}
            data-org-chip={o.wid}
            onClick={() => onChange(on ? null : o.wid)}
            style={{ '--chip': color } as CSSProperties}
            className={cn(
              base,
              'text-ink',
              on
                ? 'border-[var(--chip)] bg-[color-mix(in_srgb,var(--chip)_22%,var(--color-surface))]'
                : 'border-transparent bg-[color-mix(in_srgb,var(--chip)_11%,var(--color-surface))] hov:border-[color-mix(in_srgb,var(--chip)_50%,transparent)]',
            )}
          >
            <span aria-hidden className="size-2 rounded-full" style={{ background: color }} />
            <span className="whitespace-nowrap">{o.name}</span>
          </button>
        );
      })}
      {hint ? (
        <span className="ml-1 hidden shrink-0 text-13 text-text-3 lg:inline">{hint}</span>
      ) : null}
    </div>
  );
}
