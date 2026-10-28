import { Check, ChevronsLeftRight, CornerUpLeft, X, type LucideIcon } from 'lucide-react';
import { animate, AnimatePresence, motion, useInView } from 'motion/react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge, Eyebrow } from './badge';
import { cn } from './cn';
import { Icon } from './icon';
import { duration, ease, spring, tween, useReducedMotion } from './motion';

/* ------------------------------ Skeleton ------------------------------ */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-shimmer rounded-btn bg-line', className)} />;
}

/**
 * Skeleton to content cross-fade. Both layers share one grid cell, so the box never changes
 * size and layout never jumps (CLS). Give the skeleton the same shape as the content.
 */
export function SkeletonSwap({
  loading,
  skeleton,
  children,
}: {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid" aria-busy={loading}>
      <motion.div
        className="col-start-1 row-start-1"
        initial={false}
        animate={{ opacity: loading ? 0 : 1 }}
        transition={tween.slow}
        inert={loading}
      >
        {children}
      </motion.div>
      <motion.div
        className="pointer-events-none col-start-1 row-start-1"
        initial={false}
        animate={{ opacity: loading ? 1 : 0 }}
        transition={tween.slow}
        aria-hidden
      >
        {skeleton}
      </motion.div>
      {loading ? (
        <span className="sr-only" role="status">
          Loading
        </span>
      ) : null}
    </div>
  );
}

/* ------------------------------ EmptyState ------------------------------ */

export function EmptyState({
  icon,
  title,
  description,
  action,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-10 text-center">
      <span className="mb-3 grid size-11 place-items-center rounded-full bg-canvas text-text-2">
        <Icon icon={icon} size={20} />
      </span>
      <h2 className="text-16 font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-xs text-14 text-text-2">{description}</p>
      {children ? <div className="mt-4 flex w-full min-w-0 justify-center">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* ------------------------------ ProgressRing ------------------------------ */

export function ProgressRing({
  value,
  max,
  size = 28,
  label,
  caption = false,
}: {
  /** Show "3/6" beside the ring, with the plain-words tooltip. */
  caption?: boolean;
  value: number;
  max: number;
  size?: number;
  label: string;
}) {
  const r = (size - 4) / 2;
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} of ${max}`}
      title={`${value} of ${max} steps done`}
      className={cn(
        'shrink-0',
        caption ? 'inline-flex items-center gap-1' : 'relative inline-grid place-items-center',
      )}
      style={caption ? undefined : { width: size, height: size }}
    >
      <span
        className="relative inline-grid place-items-center"
        style={{ width: size, height: size }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          aria-hidden
          className="-rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={3}
            className="stroke-line"
          />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={3}
            strokeLinecap="round"
            className="stroke-agent"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: ratio }}
            transition={tween.slow}
          />
        </svg>
        {caption ? null : (
          <span aria-hidden className="absolute text-12 font-semibold tabular-nums text-text-2">
            {value}
          </span>
        )}
      </span>
      {caption ? (
        <span aria-hidden className="text-12 font-semibold tabular-nums text-text-2">
          {value}/{max}
        </span>
      ) : null}
    </span>
  );
}

/* ------------------------------ WorkingDots ------------------------------ */

export function WorkingDots({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('inline-flex items-center gap-0.5', className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-dots rounded-full bg-agent"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/* ------------------------------ FoldedColumn ------------------------------ */

export interface FoldedColumnProps {
  title: string;
  /** Items in this step. */
  count: number;
  /** Live runs in this step. Animated working dots show while above zero. */
  live?: number;
  sendBacks?: number;
  progress?: { done: number; total: number };
  expanded: boolean;
  /** Fill the grid cell instead of a fixed width (desktop board). */
  fluid?: boolean;
  onToggle: () => void;
  children?: ReactNode;
}

/**
 * Agent steps are folded into a slim strip. Expanding animates the width with a spring
 * (as a layout animation, so it stays on the compositor). Several strips can be open at once.
 */
export function FoldedColumn({
  title,
  count,
  live = 0,
  sendBacks = 0,
  progress,
  expanded,
  fluid = false,
  onToggle,
  children,
}: FoldedColumnProps) {
  const panel = useId();
  return (
    <motion.section
      layout
      transition={spring.ui}
      style={{ borderRadius: 12 }}
      className={cn(
        'shrink-0 overflow-hidden border border-line bg-agent-soft',
        fluid ? 'w-full' : expanded ? 'w-72' : 'w-14',
      )}
      aria-label={`${title}, agent step`}
    >
      <h2 className="sr-only">{title}</h2>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panel}
        className={cn(
          'flex w-full items-center foc:outline-2 foc:-outline-offset-2 foc:outline-focus',
          expanded ? 'min-h-12 gap-2 px-3 text-left' : 'min-h-56 flex-col gap-3 px-0 py-3',
        )}
      >
        <motion.span layout="position" className="inline-flex items-center gap-2">
          <Badge tone="agent" count={count} />
          {live > 0 ? (
            <>
              <WorkingDots />
              <span className="sr-only">{live} running now</span>
            </>
          ) : null}
        </motion.span>
        <motion.span
          layout="position"
          className={cn(
            'font-mono text-12 font-medium uppercase tracking-[0.08em] text-agent',
            !expanded && '[writing-mode:vertical-rl] rotate-180',
            expanded && 'flex-1',
          )}
        >
          {title}
        </motion.span>
        {sendBacks > 0 ? (
          <span className="inline-flex items-center gap-0.5 text-13 text-sendback">
            <Icon icon={CornerUpLeft} size={14} />
            <span aria-hidden>{sendBacks}</span>
            <span className="sr-only">{sendBacks} sent back</span>
          </span>
        ) : null}
        {progress ? (
          <ProgressRing value={progress.done} max={progress.total} label={`${title} progress`} />
        ) : null}
        {!expanded ? <Icon icon={ChevronsLeftRight} className="text-text-3" /> : null}
      </button>
      <div id={panel} hidden={!expanded}>
        <AnimatePresence initial={false}>
          {expanded ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: duration.base, ease, delay: 0.08 }}
              className="flex flex-col gap-2 p-2 pt-0"
            >
              {children}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}

/* ------------------------------ Stepper ------------------------------ */

export interface StepperStep {
  id: string;
  name: string;
  description: string;
  kind: 'agent' | 'human';
  tag?: string;
}

/**
 * Vertical process stepper for the send-back sheet. The item sits at `currentIndex`.
 * Choosing an earlier step glows it and draws a path from the current step back to it.
 */
export function Stepper({
  steps,
  currentIndex,
  value,
  onChange,
  label,
  stop,
}: {
  steps: StepperStep[];
  currentIndex: number;
  value: string | null;
  onChange: (id: string) => void;
  label: string;
  /** An extra last option that takes the item out of the flow (value `stop`). */
  stop?: { name: string; description: string };
}) {
  const targetIndex = steps.findIndex((s) => s.id === value);
  const reduced = useReducedMotion();
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col">
      {steps.map((s, i) => {
        const isCurrent = i === currentIndex;
        const selectable = i < currentIndex;
        const selected = s.id === value;
        const pathBelow = targetIndex >= 0 && i >= targetIndex && i < currentIndex;
        const dist = targetIndex >= 0 ? currentIndex - 1 - i : 0;
        return (
          <div key={s.id} className="flex gap-3">
            <div className="flex w-6 shrink-0 flex-col items-center">
              <span className="relative mt-3 grid size-6 place-items-center">
                {selected ? (
                  <motion.span
                    aria-hidden
                    layoutId="stepper-glow"
                    className="absolute -inset-1.5 rounded-full bg-gate/35"
                    transition={spring.ui}
                  />
                ) : null}
                <span
                  className={cn(
                    'relative grid size-6 place-items-center rounded-full border text-12 font-semibold',
                    selected && 'border-gate bg-gate text-on-gate',
                    isCurrent && 'border-ink bg-ink text-surface',
                    !selected &&
                      !isCurrent &&
                      i < currentIndex &&
                      'border-line-strong bg-surface text-text-2',
                    i > currentIndex && 'border-line bg-canvas text-text-3',
                  )}
                >
                  {i < currentIndex && !selected ? <Icon icon={Check} size={12} /> : i + 1}
                </span>
              </span>
              {i < steps.length - 1 ? (
                <span className="relative my-1 w-0.5 flex-1 bg-line">
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 origin-bottom bg-gate"
                    initial={false}
                    animate={{ scaleY: pathBelow ? 1 : 0 }}
                    transition={{
                      ...tween.base,
                      delay: reduced || !pathBelow ? 0 : Math.max(0, dist) * 0.07,
                    }}
                  />
                </span>
              ) : null}
            </div>
            <button
              type="button"
              role="radio"
              aria-checked={selected}
              aria-disabled={!selectable}
              disabled={!selectable}
              onClick={() => onChange(s.id)}
              className={cn(
                'mb-1 mt-1 min-h-11 flex-1 rounded-card border p-3 text-left',
                'transition-[border-color,background-color] duration-120 ease-standard',
                'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
                selected ? 'border-gate bg-gate-bg' : 'border-transparent hov:bg-canvas',
                !selectable && 'cursor-default opacity-70 hov:bg-transparent',
              )}
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-14 font-medium text-ink">{s.name}</span>
                {isCurrent ? <Badge>Now here</Badge> : null}
                {s.tag ? <Badge tone="gate">{s.tag}</Badge> : null}
                <Eyebrow>{s.kind === 'human' ? 'Decision' : 'Agent'}</Eyebrow>
              </span>
              <span className="mt-0.5 block text-13 text-text-2">{s.description}</span>
            </button>
          </div>
        );
      })}
      {stop ? (
        <div className="flex gap-3">
          <div className="flex w-6 shrink-0 justify-center">
            <span
              aria-hidden
              className={cn(
                'mt-3 grid size-6 place-items-center rounded-full border',
                value === 'stop'
                  ? 'border-sendback bg-sendback-bg text-sendback'
                  : 'border-line-strong',
              )}
            >
              <Icon icon={X} size={12} />
            </span>
          </div>
          <button
            type="button"
            role="radio"
            aria-checked={value === 'stop'}
            onClick={() => onChange('stop')}
            className={cn(
              'mb-1 mt-1 min-h-11 flex-1 rounded-card border p-3 text-left',
              'transition-[border-color,background-color] duration-120 ease-standard',
              'foc:outline-2 foc:outline-offset-2 foc:outline-focus',
              value === 'stop'
                ? 'border-sendback bg-sendback-bg'
                : 'border-transparent hov:bg-canvas',
            )}
          >
            <span className="text-14 font-medium text-ink">{stop.name}</span>
            <span className="mt-0.5 block text-13 text-text-2">{stop.description}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ KPI count-up ------------------------------ */

export function CountUp({
  to,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
}: {
  to: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const reduced = useReducedMotion();
  const [count, setN] = useState(0);
  const n = reduced ? to : count;

  useEffect(() => {
    if (!inView) return;
    if (reduced) return;
    const controls = animate(0, to, {
      duration: 0.9,
      ease,
      onUpdate: setN,
    });
    return () => controls.stop();
  }, [inView, reduced, to]);

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      <span aria-hidden>
        {prefix}
        {n.toFixed(decimals)}
        {suffix}
      </span>
      <span className="sr-only">
        {prefix}
        {to.toFixed(decimals)}
        {suffix}
      </span>
    </span>
  );
}

export function Kpi({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <Eyebrow>{label}</Eyebrow>
      <div className="mt-1 text-28 font-semibold tracking-tight text-ink">{children}</div>
      {hint ? <p className="mt-0.5 text-13 text-text-2">{hint}</p> : null}
    </div>
  );
}

/* ------------------------------ BarChart ------------------------------ */

export interface Bar {
  label: string;
  value: number;
}

/** Simple horizontal bar chart in SVG. Bars grow from zero when first in view. */
export function BarChart({ data, title }: { data: Bar[]; title: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const rowH = 44;
  const w = 320;
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' });
  const summary = data.map((d) => `${d.label} ${d.value}`).join(', ');
  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${w} ${data.length * rowH}`}
      role="img"
      aria-label={`${title}: ${summary}`}
      className="block h-auto w-full"
    >
      {data.map((d, i) => {
        const y = i * rowH;
        const bw = Math.max(2, ((w - 36) * d.value) / max);
        return (
          <g key={d.label}>
            <text x={0} y={y + 14} className="fill-text-2" fontSize={13}>
              {d.label}
            </text>
            <text
              x={w}
              y={y + 14}
              textAnchor="end"
              className="fill-ink"
              fontSize={13}
              fontWeight={600}
            >
              {d.value}
            </text>
            <rect x={0} y={y + 22} width={w} height={10} rx={5} className="fill-line" />
            <motion.rect
              x={0}
              y={y + 22}
              width={bw}
              height={10}
              rx={5}
              className="fill-agent"
              style={{ transformBox: 'fill-box', transformOrigin: 'left center' }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: inView ? 1 : 0 }}
              transition={{ duration: duration.slow * 2, ease, delay: i * 0.06 }}
            />
          </g>
        );
      })}
    </svg>
  );
}
