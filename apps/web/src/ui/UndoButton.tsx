import { useEffect, useState } from 'react';
import { Button, type ButtonVariant } from './button';
import { cn } from './cn';
import { useReducedMotion } from './motion';
import type { Countdown } from './overlay';

/** Whole seconds left, never below 1 while the window is open. */
function secondsLeft(c: Countdown): number {
  return Math.max(1, Math.ceil((c.endsAt - Date.now()) / 1000));
}

/** Whole seconds left in a countdown, ticking. */
export function useSecondsLeft(c: Countdown): number {
  const [secs, setSecs] = useState(() => secondsLeft(c));
  useEffect(() => {
    const t = setInterval(() => setSecs(secondsLeft(c)), 250);
    return () => clearInterval(t);
  }, [c]);
  return secs;
}

/**
 * The button a decision turns into for its Undo window (card eLSSIGOs): "Undo · 5" with a bar
 * shrinking over the window. Same variant and size as the button that was pressed, so nothing
 * jumps. Under reduced motion there is no bar, only the countdown text. The number is hidden from
 * screen readers (the accessible name stays "Undo"; the provider announces the window once).
 */
export function UndoButton({
  countdown,
  variant,
  className,
  keyHint,
}: {
  countdown: Countdown;
  variant: ButtonVariant;
  className?: string;
  /** The key that undoes it, shown on devices with a keyboard. */
  keyHint?: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const secs = useSecondsLeft(countdown);
  return (
    <Button
      variant={variant}
      data-undo=""
      className={cn('overflow-hidden', className)}
      onClick={countdown.undo}
    >
      <span>
        Undo
        <span aria-hidden>
          {' '}
          {'·'} {secs}
        </span>
      </span>
      {keyHint}
      {reduced ? null : (
        <span
          aria-hidden
          data-keep-motion
          data-testid="undo-bar"
          className="absolute inset-x-0 bottom-0 h-1 origin-left animate-countdown bg-current opacity-60"
          style={{ animationDuration: `${countdown.ms}ms` }}
        />
      )}
    </Button>
  );
}
