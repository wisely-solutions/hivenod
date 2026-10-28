import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useReducedMotion } from '../ui/motion';
import type { Countdown } from '../ui/overlay';
import { useSecondsLeft } from '../ui/UndoButton';

/** The look of a button on the selection bar (also used by the screens that fill it). */
const BAR_BASE =
  'inline-flex min-h-11 items-center gap-1.5 rounded-btn border px-3 text-14 font-medium disabled:opacity-40';
export const BAR_BUTTON = `${BAR_BASE} border-surface/30 text-surface hover:bg-surface/10`;
export const BAR_PRIMARY = `${BAR_BASE} border-transparent bg-approve-solid text-on-solid`;

/**
 * The floating bar over a list with several rows selected: "N selected", the screen's actions and
 * Clear. Shared by the project List and Needs you. It reports its height so the screen can pad
 * its bottom and keep the last row reachable.
 */
export function SelectionBar({
  count,
  onHeight,
  onClear,
  children,
}: {
  count: number;
  onHeight: (h: number) => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => onHeight(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label="Actions for the selected items"
      className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+72px)] z-30 mx-auto flex max-w-3xl flex-wrap items-center gap-2 rounded-panel bg-ink p-2 shadow-e3 lg:bottom-6"
    >
      <span className="px-2 text-14 font-semibold text-surface">{count} selected</span>
      {children}
      <button type="button" aria-label="Clear selection" className={BAR_BUTTON} onClick={onClear}>
        <X size={16} aria-hidden />
        <span className="max-sm:sr-only">Clear</span>
      </button>
    </div>
  );
}

/**
 * The pressed bulk button while its decision counts down (card eLSSIGOs): "Undo \u00b7 5" with a
 * shrinking bar (no bar under reduced motion). The other buttons on the bar are dimmed.
 */
export function BarUndo({
  countdown,
  primary = false,
}: {
  countdown: Countdown;
  primary?: boolean;
}) {
  const reduced = useReducedMotion();
  const secs = useSecondsLeft(countdown);
  return (
    <button
      type="button"
      data-undo=""
      className={`${primary ? BAR_PRIMARY : BAR_BUTTON} relative overflow-hidden`}
      onClick={countdown.undo}
    >
      <span>
        Undo
        <span aria-hidden>
          {' '}
          {'\u00b7'} {secs}
        </span>
      </span>
      {reduced ? null : (
        <span
          aria-hidden
          data-keep-motion
          data-testid="undo-bar"
          className="absolute inset-x-0 bottom-0 h-1 origin-left animate-countdown bg-current opacity-60"
          style={{ animationDuration: `${countdown.ms}ms` }}
        />
      )}
    </button>
  );
}
