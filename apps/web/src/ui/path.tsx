/**
 * The path strip (card st5INNZj, look decided with João): A, compact segments (one per step on
 * the path; a skipped step is a faint dot, a proposed one dashed), expanding on tap to C, a
 * vertical trail with who decides each step. Presentational: the data comes from pathView().
 */
import { Check, ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { PathSegment, PathView, Tone } from '../board/path';
import { skippedLine, trailRows } from '../board/path';
import { cn } from './cn';
import { Icon } from './icon';

const statusTone: Record<Tone, string> = {
  gate: 'text-gate-text',
  agent: 'text-agent',
  approve: 'text-approve-text',
  neutral: 'text-text-2',
};

function segmentClass(s: PathSegment): string {
  if (s.state === 'skipped') return 'block size-1.5 flex-none rounded-full bg-line-strong/40';
  const base = 'block h-1.5 w-full min-w-3 rounded-full';
  if (s.state === 'proposed') return cn(base, 'border border-dashed border-gate bg-gate-bg');
  if (s.state === 'done') return cn(base, 'bg-approve');
  if (s.state === 'current')
    return cn(base, 'h-2', s.kind === 'human' ? 'bg-gate ring-1 ring-gate-text/40' : 'bg-agent');
  return cn(base, s.kind === 'human' ? 'border border-gate bg-transparent' : 'bg-line-strong/30');
}

/** A: the segments and one line on where the item is. */
export function PathCompact({
  view,
  labels = false,
  className,
}: {
  view: PathView;
  /** Step names under the segments (item detail and Needs you; not on board cards). */
  labels?: boolean;
  className?: string;
}) {
  const shown = view.segments;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)} data-testid="path-strip">
      {view.unshaped ? null : (
        <div className="flex items-start gap-1" aria-hidden>
          {shown.map((s) => (
            <span
              key={s.id}
              className={cn(
                'flex min-w-0 flex-col gap-1',
                s.state === 'skipped' ? 'flex-none' : 'flex-1',
              )}
            >
              <span className={segmentClass(s)} />
              {labels && s.state !== 'skipped' ? (
                <span
                  className={cn(
                    'truncate font-mono text-[10px] uppercase tracking-[0.06em]',
                    s.state === 'current' ? 'font-semibold text-ink' : 'text-text-3',
                    s.state === 'proposed' && 'text-gate-text',
                  )}
                >
                  {s.name}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      )}
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-13">
        {view.done ? (
          <>
            <span aria-hidden className="size-2 flex-none rounded-full bg-approve" />
            <span className="font-semibold text-ink" data-testid="path-done">
              All {view.current?.m ?? view.segments.filter((s) => s.state !== 'skipped').length}{' '}
              steps done
            </span>
          </>
        ) : view.current ? (
          <>
            <span
              aria-hidden
              className={cn(
                'size-2 flex-none rounded-full',
                view.current.kind === 'human' ? 'bg-gate' : 'bg-agent',
              )}
            />
            <span className="text-text-2">
              Step {view.current.n} of {view.current.m}
            </span>{' '}
            <span className="text-text-3">·</span>{' '}
            <span className="font-semibold text-ink">{view.current.name}</span>{' '}
            {view.current.next ? (
              <span className="text-text-2">{`\u2192 next: ${view.current.next}`}</span>
            ) : null}
          </>
        ) : view.unshaped ? (
          <span className="text-text-2">Not shaped yet</span>
        ) : null}
        <span className="ml-auto inline-flex flex-wrap items-center gap-x-1.5">
          {view.status ? (
            <span className={cn('font-medium', statusTone[view.status.tone])}>
              {view.status.text}
            </span>
          ) : null}
          {view.pending.map((p) => (
            <span
              key={p}
              className="border-b border-dashed border-gate-text text-12 text-gate-text"
            >
              {p}
            </span>
          ))}
        </span>
      </p>
      <span className="sr-only">
        {view.unshaped
          ? 'Path not set yet.'
          : `Path: ${shown
              .filter((s) => s.state !== 'skipped')
              .map((s) => s.name)
              .join(', ')}. ${skippedLine(view.skippedNames)}`}
      </span>
    </div>
  );
}

function TrailIcon({ s }: { s: PathSegment }) {
  if (s.state === 'done')
    return (
      <span className="grid size-5 place-items-center rounded-full bg-approve text-on-solid">
        <Icon icon={Check} size={12} />
      </span>
    );
  return (
    <span
      className={cn(
        'size-5 rounded-full border-2',
        s.state === 'proposed' && 'border-dashed border-gate',
        s.state === 'current' && (s.kind === 'human' ? 'border-gate bg-gate' : 'border-agent'),
        s.state === 'ahead' && (s.kind === 'human' ? 'border-gate' : 'border-line-strong'),
      )}
    />
  );
}

/** C: one row per step on the path (and proposed ones), skipped ones folded into one line. */
export function PathTrail({
  view,
  rowExtra,
}: {
  view: PathView;
  /** Extra content under a row: the decision on a pending change, for example. */
  rowExtra?: (s: PathSegment) => ReactNode;
}) {
  const rows = trailRows(view);
  return (
    <div className="flex flex-col gap-2">
      <ol aria-label="Path" className="flex flex-col gap-2">
        {rows.map((s) => (
          <li key={s.id} className="flex flex-col gap-1.5" data-step={s.id} data-state={s.state}>
            <div className="flex items-center gap-2.5 text-13">
              <TrailIcon s={s} />
              <span
                className={cn('font-semibold', s.state === 'ahead' ? 'text-text-2' : 'text-ink')}
              >
                {s.name}
              </span>
              <span className="text-text-2">{s.who}</span>
            </div>
            {rowExtra?.(s)}
          </li>
        ))}
      </ol>
      {view.skippedNames.length ? (
        <p className="border-t border-dashed border-line pt-2 text-12 text-text-2">
          {skippedLine(view.skippedNames)}
        </p>
      ) : null}
    </div>
  );
}

/** A, with "Path" to open C. `children` go below the trail (the path editor, for example). */
export function PathStrip({
  view,
  labels = true,
  rowExtra,
  children,
  defaultOpen = false,
}: {
  view: PathView;
  labels?: boolean;
  rowExtra?: (s: PathSegment) => ReactNode;
  children?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <section
      aria-label="Path"
      className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3"
    >
      <div className="flex items-start gap-2">
        {open ? (
          <p className="min-w-0 flex-1 text-13">
            {view.current ? (
              <>
                <span className="font-semibold text-ink">{view.current.name}</span>{' '}
                <span className="text-text-2">
                  step {view.current.n} of {view.current.m}
                  {view.status
                    ? ` · ${view.status.tone === 'agent' ? view.status.text : view.status.text.toLowerCase()}`
                    : ''}
                </span>
              </>
            ) : (
              <span className="text-text-2">{view.status?.text ?? 'Not shaped yet'}</span>
            )}
          </p>
        ) : (
          <PathCompact view={view} labels={labels} className="flex-1" />
        )}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(!open)}
          className="inline-flex min-h-11 flex-none items-center gap-1 self-start px-1 text-12 font-medium text-text-2 hov:text-ink"
        >
          {open ? 'Hide path' : 'Path'}
          <Icon icon={ChevronDown} size={14} className={cn(open && 'rotate-180')} />
        </button>
      </div>
      {open ? (
        <div id={id} className="flex flex-col gap-3">
          <PathTrail view={view} rowExtra={rowExtra} />
          {children}
        </div>
      ) : null}
    </section>
  );
}
