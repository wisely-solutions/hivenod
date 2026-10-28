import { describeProcess, type TemplateStep } from '@hive/shared';
import { cn } from '../ui/cn';

/**
 * A mini picture of a process: blue dots for agent steps, amber diamonds for human gates.
 * The text alternative lists where the gates are, so colour is never the only signal.
 */
export function ProcessStrip({
  steps,
  className,
}: {
  steps: readonly Pick<TemplateStep, 'kind'>[];
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={describeProcess(steps)}
      className={cn('flex h-4 items-center', className)}
    >
      {steps.map((s, i) => (
        <span key={i} className={cn('flex items-center', i > 0 && 'min-w-1 flex-1')} aria-hidden>
          {i > 0 ? <span className="h-px flex-1 bg-line-strong" /> : null}
          {s.kind === 'human' ? (
            // The wrapper reserves the rotated diagonal, so the last diamond never pokes past the strip.
            <span className="grid size-4 shrink-0 place-items-center">
              <span className="size-[11px] rotate-45 rounded-[2px] bg-gate" />
            </span>
          ) : (
            <span className="size-2.5 shrink-0 rounded-full bg-agent" />
          )}
        </span>
      ))}
    </div>
  );
}
