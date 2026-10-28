import { useEffect, useRef } from 'react';
import { cn } from '../ui/cn';
import type { ScrubberEntry } from './logic';

/** Phone: every step at a glance. Every step is a chip with its name and count (gates amber); the current one is ringed. One design with the item path strip. */
export function Scrubber({
  entries,
  activeId,
  onJump,
}: {
  entries: ScrubberEntry[];
  /** The step on screen now (null until the board has laid out). */
  activeId: string | null;
  onJump: (id: string) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  // Keep the current pill in view: the strip follows the board's scroll (card MZmBDw2C).
  useEffect(() => {
    const strip = nav.current;
    const pill = strip?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!strip || !pill) return;
    const s = strip.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    if (p.left >= s.left && p.right <= s.right) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    strip.scrollTo({
      left: strip.scrollLeft + (p.left + p.width / 2) - (s.left + s.width / 2),
      behavior: reduced ? 'auto' : 'smooth',
    });
  }, [activeId]);
  // An empty board has nothing to scan: a lone dot above the first column looked like a glitch.
  if (entries.every((e) => e.count === 0)) return null;
  return (
    <nav
      ref={nav}
      aria-label="Steps"
      className="sticky top-[calc(48px+env(safe-area-inset-top))] z-10 -mx-4 mb-3 flex items-center gap-2 overflow-x-auto bg-canvas px-4 py-1.5 [scrollbar-width:none]"
    >
      {entries.map((e) => {
        const human = e.kind === 'human';
        const n = human ? e.mine || e.count : e.count;
        return (
          <button
            key={e.id}
            type="button"
            onClick={() => onJump(e.id)}
            aria-current={e.id === activeId ? 'step' : undefined}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3 text-13',
              human
                ? 'border-gate bg-gate-bg font-semibold text-gate-text'
                : 'border-line-strong bg-surface text-text-2',
              n === 0 && !human && 'text-text-3',
              e.id === activeId && 'ring-2 ring-ink font-semibold text-ink',
              e.id === activeId && human && 'text-gate-text',
            )}
          >
            {e.name}
            <span className="tabular-nums">{n}</span>
          </button>
        );
      })}
    </nav>
  );
}
