import { AnimatePresence, motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn';
import { Icon } from './icon';
import { tween } from './motion';

export type Tone = 'neutral' | 'gate' | 'agent' | 'approve' | 'sendback' | 'external';

const tones: Record<Tone, string> = {
  neutral: 'bg-canvas text-text-2 border-line',
  gate: 'bg-gate-bg text-gate-text border-gate/50',
  agent: 'bg-agent-soft text-agent border-agent/30',
  approve: 'bg-approve-bg text-approve-text border-approve/40',
  sendback: 'bg-sendback-bg text-sendback border-sendback-border',
  external: 'bg-external-bg text-external border-external/40',
};

/** Rolls to a new number: the old value slides up and out, the new one in from below. */
export function NumberRoll({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden tabular-nums', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={value}
          initial={{ y: '70%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-70%', opacity: 0 }}
          transition={tween.base}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function Badge({
  tone = 'neutral',
  count,
  children,
  className,
}: {
  tone?: Tone;
  /** When set, the number rolls on change. Pass the label as children. */
  count?: number;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-full border px-1.5 text-12 font-semibold leading-none',
        tones[tone],
        className,
      )}
    >
      {children}
      {count !== undefined ? <NumberRoll value={count} /> : null}
    </span>
  );
}

/** Small mono label ("eyebrow") used for column and section names. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Pill({
  tone = 'neutral',
  children,
  className,
  'data-testid': testId,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-13 font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export type StepState = 'done' | 'current' | 'upcoming';

/** A process step: gates are amber pills, agent steps are blue. Never colour only: the label is text. */
export function StepPill({
  label,
  kind,
  state = 'upcoming',
  count,
  onClick,
  selected,
}: {
  label: string;
  kind: 'agent' | 'human';
  state?: StepState;
  count?: number;
  onClick?: () => void;
  selected?: boolean;
}) {
  const gate = kind === 'human';
  const cls = cn(
    'inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-13 font-medium transition-colors duration-120',
    'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
    gate ? 'bg-gate-bg text-gate-text border-gate/60' : 'bg-surface text-text-2 border-line',
    selected && !gate && 'border-agent text-agent bg-agent-soft',
    selected && gate && 'border-gate',
  );
  const inner = (
    <>
      {state === 'done' ? (
        <Icon icon={Check} size={14} />
      ) : gate ? null : (
        <span aria-hidden className="size-1.5 rounded-full bg-current" />
      )}
      <span>{label}</span>
      <span className="sr-only">{gate ? ', decision step' : ', agent step'}</span>
      {count ? (
        <span className="rounded-full bg-gate px-1.5 text-12 font-semibold text-on-gate">
          <NumberRoll value={count} />
        </span>
      ) : null}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-pressed={selected}>
      {inner}
    </button>
  ) : (
    <span className={cls}>{inner}</span>
  );
}
