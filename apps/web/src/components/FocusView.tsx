import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';

/**
 * The focus view (card ExMNfP8A): one item, full screen over wherever the person was. A top bar
 * (back, where the item is, "2 of 3 waiting" with next / previous), the item as a document in the
 * middle, its properties on the right (below the document on a phone) and the decision bar pinned
 * at the bottom. It scrolls in exactly one place; the page behind is locked while it is open.
 */
export function FocusView({
  label,
  inner,
  rootRef,
  role,
  backLabel,
  backText,
  onBack,
  crumb,
  position,
  onStep,
  properties,
  bar,
  children,
}: {
  /** The accessible name of the whole view. */
  label: string;
  /** An article around the scrolling content and the decision bar (the board names it "Item: title"). */
  inner?: string;
  /** The element itself (a swipe handler listens on it). */
  rootRef?: RefObject<HTMLElement | null>;
  /** "region" (board) or "article" (Needs you); the e2e and screen readers rely on these names. */
  role?: 'region' | 'article';
  /** The accessible name of the back button ("Close item", "Back to inbox"). */
  backLabel: string;
  /** What the back button says ("Board", "Needs you"). */
  backText: string;
  onBack: () => void;
  /** "Web app › Go/no-go". */
  crumb: ReactNode;
  /** "2 of 3 waiting"; omitted when the item is not in a list. */
  position?: { index: number; total: number; noun: string };
  onStep?: (dir: 1 | -1) => void;
  /** The right column: step, who decides, agent, cost. */
  properties?: ReactNode;
  /** The decision bar (pinned). */
  bar?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Keyboard users land in the view; the page behind stops scrolling for as long as it is open.
    ref.current?.focus({ preventScroll: true });
    const root = document.documentElement;
    const before = root.style.overflow;
    root.style.overflow = 'hidden';
    // The view covers the phone tab bar: take it out of the tab order and the accessibility tree,
    // and let the toasts sit right above the decision bar (overlay.tsx reads the flag).
    root.setAttribute('data-focus-open', '');
    const tabs = document.querySelector('[data-tab-bar]');
    tabs?.setAttribute('inert', '');
    tabs?.setAttribute('aria-hidden', 'true');
    return () => {
      root.style.overflow = before;
      root.removeAttribute('data-focus-open');
      tabs?.removeAttribute('inert');
      tabs?.removeAttribute('aria-hidden');
    };
  }, []);
  const Tag = role === 'article' ? 'article' : 'section';
  const Inner = inner ? 'article' : 'div';
  const stepper = position && position.total > 0 && onStep;
  return (
    <Tag
      ref={(el: HTMLElement | null) => {
        ref.current = el as HTMLDivElement | null;
        if (rootRef) rootRef.current = el;
      }}
      tabIndex={-1}
      role={role === 'article' ? undefined : 'region'}
      aria-label={label}
      data-focus-view
      className="fixed inset-0 z-40 flex flex-col bg-canvas text-ink outline-hidden pt-[env(safe-area-inset-top)] pb-[var(--kb,0px)]"
    >
      <Inner aria-label={inner} className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface pl-[max(8px,env(safe-area-inset-left))] pr-[max(12px,env(safe-area-inset-right))]">
          <button
            type="button"
            aria-label={backLabel}
            onClick={onBack}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-btn px-2 text-14 font-medium text-text-2 hov:text-ink foc:outline-2 foc:outline-focus"
          >
            <Icon icon={ArrowLeft} size={18} />
            <span className="max-sm:sr-only">{backText}</span>
            <kbd
              aria-hidden
              className="hidden rounded border border-line-strong px-1 font-mono text-[10px] leading-4 sm:[@media(hover:hover)]:inline"
            >
              Esc
            </kbd>
          </button>
          <p className="min-w-0 flex-1 truncate text-13 text-text-2 [&>strong]:font-semibold [&>strong]:text-ink">
            {crumb}
          </p>
          {stepper ? (
            <div className="flex shrink-0 items-center">
              <span aria-live="polite" className="text-12 tabular-nums text-text-2">
                {position.index >= 0
                  ? `${position.index + 1} of ${position.total}`
                  : position.total}{' '}
                {position.noun}
              </span>
              <IconButton
                label="Previous item"
                variant="ghost"
                disabled={position.index <= 0}
                onClick={() => onStep(-1)}
              >
                <Icon icon={ChevronUp} size={18} />
              </IconButton>
              <IconButton
                label="Next item"
                variant="ghost"
                disabled={position.index >= position.total - 1}
                onClick={() => onStep(1)}
              >
                <Icon icon={ChevronDown} size={18} />
              </IconButton>
            </div>
          ) : null}
        </div>
        {/* The one scroller. The columns sit inside it, so there is never a second scrollbar. */}
        <div
          ref={scroller}
          data-focus-scroll
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain pl-[max(0px,env(safe-area-inset-left))] pr-[max(0px,env(safe-area-inset-right))]"
        >
          <div
            className={cn(
              'mx-auto grid w-full max-w-6xl gap-x-8 px-4 py-5 sm:px-6',
              properties ? 'lg:grid-cols-[minmax(0,1fr)_16rem]' : '',
            )}
          >
            <div className="flex min-w-0 flex-col gap-5 lg:rounded-panel lg:border lg:border-line lg:bg-surface lg:p-6 max-lg:rounded-card max-lg:border max-lg:border-line max-lg:bg-surface max-lg:p-4">
              {children}
            </div>
            {properties ? (
              <aside
                aria-label="Properties"
                className="mt-4 flex flex-col gap-4 lg:sticky lg:top-5 lg:mt-0 lg:self-start"
              >
                {properties}
              </aside>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 empty:hidden">{bar}</div>
      </Inner>
    </Tag>
  );
}

/** The properties column: small labelled values. */
export function Properties({
  rows,
  children,
}: {
  rows: Array<{ label: string; value: ReactNode }>;
  children?: ReactNode;
}) {
  return (
    <>
      <dl className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-12 font-semibold uppercase tracking-wide text-text-2">{r.label}</dt>
            <dd className="mt-0.5 text-14 text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
      {/* The slot for Archive / Delete (a separate item adds them). */}
      <div data-properties-actions className="flex flex-col gap-1 empty:hidden">
        {children}
      </div>
    </>
  );
}
