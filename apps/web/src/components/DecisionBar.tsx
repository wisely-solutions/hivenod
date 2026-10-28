import { cn } from '../ui/cn';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ClipboardEvent,
  type ReactNode,
} from 'react';

/**
 * The one decision bar (cards 9bmMIGlC, ExMNfP8A): pinned at the bottom of the focus view, full
 * width, above the keyboard on a phone. It says where the decision is ("Review \u00b7 you decide"),
 * the rule ("Any one of 2 deciders"), holds the note (it grows as you type) and carries every
 * decision button, in one vocabulary: Approve (key A), Send back (key R), Reject.
 */
export function DecisionBar({
  label,
  rule,
  note,
  compact = false,
  children,
}: {
  /** "Review \u00b7 you decide". */
  label?: string;
  /** "Any one of 2 deciders". */
  rule?: string;
  /** The note field (a BarNote), between the label and the buttons. */
  note?: ReactNode;
  /** In a narrow side panel (the viewer): always stacked, never one row. */
  compact?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Publish the bar's height while it is on screen: the Undo toasts sit above it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--decision-bar-h', `${el.offsetHeight}px`);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--decision-bar-h');
    };
  }, []);
  return (
    <div
      ref={ref}
      data-action-bar
      data-decision-bar
      role="group"
      aria-label="Decision"
      className="border-t border-line bg-surface pb-[max(10px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] pt-2.5"
    >
      <div
        className={cn(
          'mx-auto flex w-full max-w-6xl flex-col gap-2',
          !compact && 'sm:flex-row sm:items-end sm:gap-3 sm:px-6',
        )}
      >
        {label || rule ? (
          <p
            className={cn(
              'flex min-w-0 flex-wrap items-baseline gap-x-2 text-12 text-text-2',
              !compact && 'sm:max-w-44 sm:flex-col sm:gap-0 sm:pb-2.5',
            )}
          >
            {label ? (
              <span className="rounded-btn bg-gate-bg px-2 py-0.5 font-semibold text-gate-text">
                {label}
              </span>
            ) : null}
            {rule ? (
              <span data-testid="gate-rule" className={cn(!compact && 'sm:mt-1')}>
                {rule}
              </span>
            ) : null}
          </p>
        ) : null}
        {note ? (
          <div className={cn('min-w-0', !compact && 'sm:flex-1')}>{note}</div>
        ) : compact ? null : (
          <div className="hidden sm:block sm:flex-1" />
        )}
        <div className="flex gap-2 max-[359px]:flex-wrap [&>button]:min-w-0 max-[374px]:[&>button]:px-2.5 max-[374px]:[&>button]:text-13">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The note in the decision bar: one line to start, it grows as you type (up to a third of the
 * screen) and then scrolls inside itself. Same accessible name as before: "Your note (optional)".
 */
export function BarNote({
  label,
  value,
  onChange,
  placeholder,
  error,
  hint,
  onPaste,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string;
  hint?: string;
  /** Pasted files go here (the note itself keeps plain-text pastes). */
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
  const id = useId();
  const el = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const t = el.current;
    if (!t) return;
    const top = t.scrollTop;
    t.style.height = 'auto';
    const kb = parseInt(document.documentElement.style.getPropertyValue('--kb'), 10) || 0;
    const max = Math.max(88, Math.round((window.innerHeight - kb) / 3));
    t.style.height = `${Math.min(Math.max(t.scrollHeight + 2, 44), max)}px`;
    // Past the cap it scrolls inside itself: keep the caret line (usually the end) in view.
    const atEnd = document.activeElement === t && t.selectionStart === t.value.length;
    t.scrollTop = atEnd ? t.scrollHeight : top;
  }, [value]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        ref={el}
        id={id}
        rows={1}
        value={value}
        placeholder={placeholder ?? label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-msg` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        className="min-h-11 w-full resize-none rounded-btn border border-line-strong bg-surface px-3 py-2.5 text-16 leading-snug text-ink placeholder:text-text-3 hov:border-text-2 foc:border-focus foc:outline-2 foc:outline-offset-0 foc:outline-focus aria-invalid:border-sendback"
      />
      {error || hint ? (
        <p id={`${id}-msg`} className={error ? 'text-13 text-sendback' : 'text-12 text-text-2'}>
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}

/** The key that does it, shown on the button on devices with a keyboard. */
export function Key({ children }: { children: string }) {
  return (
    <kbd
      aria-hidden
      className="ml-1.5 hidden rounded border border-current/30 px-1 font-mono text-[10px] leading-4 opacity-70 sm:[@media(hover:hover)]:inline"
    >
      {children}
    </kbd>
  );
}
