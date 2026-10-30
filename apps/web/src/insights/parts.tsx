import { useInView } from 'motion/react';
import { useRef } from 'react';
import { cn } from '../ui/cn';
import { motion, useReducedMotion } from '../ui/motion';

/** A bar that grows from zero when it first scrolls into view. */
export function TagBar({
  label,
  count,
  total,
  active,
  onClick,
}: {
  label: string;
  count: number;
  /** All send-backs: every bar is its share of this, so bars compare on one scale. */
  total: number;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const reduced = useReducedMotion();
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'block min-h-11 w-full rounded-btn px-2 py-1.5 text-left transition-colors duration-120 hov:bg-canvas',
        'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
        active && 'bg-canvas',
      )}
    >
      <span className="flex items-baseline justify-between gap-3 text-14">
        <span className={cn('truncate', active ? 'font-semibold text-ink' : 'text-text-2')}>
          {label}
        </span>
        <span className="font-semibold tabular-nums text-ink">
          {count}
          <span className="ml-1.5 font-normal text-text-2">
            {Math.round((count / total) * 100)}%
          </span>
        </span>
      </span>
      <span className="mt-1.5 block h-2.5 overflow-hidden rounded-full bg-line">
        <motion.span
          className="block h-full origin-left rounded-full bg-sendback"
          initial={{ scaleX: reduced ? 1 : 0 }}
          animate={{ scaleX: inView || reduced ? 1 : 0 }}
          style={{ width: `${Math.max(3, (count / total) * 100)}%` }}
          transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
        />
      </span>
    </button>
  );
}

export function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
