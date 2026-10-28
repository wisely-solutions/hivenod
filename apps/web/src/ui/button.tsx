import { Loader2 } from 'lucide-react';
import { Icon } from './icon';
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'approve' | 'sendback' | 'gate';

const base =
  'relative inline-flex min-h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-btn px-4 text-14 font-medium ' +
  'transition-[background-color,border-color,color,transform,opacity] duration-120 ease-standard ' +
  'foc:outline-2 foc:outline-offset-2 foc:outline-focus act:scale-[0.98] ' +
  'disabled:pointer-events-none disabled:opacity-50 aria-busy:cursor-progress';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-ink text-surface border border-transparent hov:opacity-90',
  secondary: 'bg-surface text-ink border border-line-strong hov:bg-canvas',
  ghost: 'bg-transparent text-ink border border-transparent hov:bg-ink/6',
  approve: 'bg-approve-solid text-on-solid border border-transparent hov:brightness-110',
  sendback: 'bg-surface text-sendback border border-sendback-border hov:bg-sendback-bg',
  gate: 'bg-gate text-on-gate border border-transparent hov:brightness-105',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
  /** Shows a forced visual state, for the style guide only. */
  force?: 'hover' | 'focus' | 'active';
  leading?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading, force, leading, className, children, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cn(base, variants[variant], className)}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      data-force={force}
      {...rest}
      onClick={loading ? (e) => e.preventDefault() : rest.onClick}
    >
      {loading ? <Icon icon={Loader2} className="animate-spin" /> : leading}
      <span className={loading ? 'opacity-80' : undefined}>{children}</span>
      {loading ? <span className="sr-only">Loading</span> : null}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  variant?: 'secondary' | 'ghost' | 'primary';
  force?: 'hover' | 'focus' | 'active';
  loading?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', force, loading, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      aria-label={label}
      title={label}
      aria-busy={loading || undefined}
      data-force={force}
      className={cn(
        base.replace('min-h-11', 'size-11 shrink-0').replace('px-4', 'px-0'),
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Icon icon={Loader2} className="animate-spin" /> : children}
    </button>
  );
});
