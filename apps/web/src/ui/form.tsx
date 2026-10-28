import { ChevronDown } from 'lucide-react';
import { RadioGroup, Switch, Tabs as RadixTabs } from 'radix-ui';
import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { KEYBOARD_EVENT, growHeight, maxFieldHeight } from '../lib/mobile';
import { cn } from './cn';
import { Icon } from './icon';

const field =
  'w-full min-h-11 rounded-btn border border-line-strong bg-surface px-3 text-16 text-ink ' +
  'placeholder:text-text-3 transition-[border-color,box-shadow] duration-120 ease-standard ' +
  'hov:border-text-2 foc:border-focus foc:outline-2 foc:outline-offset-0 foc:outline-focus ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-sendback';

function Field({
  label,
  hint,
  error,
  id,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  id: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-13 font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className="text-13 text-sendback">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className="text-13 text-text-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string;
  force?: 'hover' | 'focus';
}

/** 16px text so iOS never zooms; 44px tall. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, force, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <Field label={label} hint={hint} error={error} id={fid}>
      <input
        ref={ref}
        id={fid}
        data-force={force}
        enterKeyHint="done"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${fid}-msg` : undefined}
        className={cn(field, className)}
        {...rest}
        onKeyDown={(e) => {
          rest.onKeyDown?.(e);
          // "Done" on the phone keyboard: a lone field (not in a form) just closes the keyboard.
          if (e.key === 'Enter' && !e.defaultPrevented && !e.currentTarget.form)
            e.currentTarget.blur();
        }}
      />
    </Field>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  error?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, error, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const fid = id ?? auto;
  const own = useRef<HTMLTextAreaElement | null>(null);
  // Grows with what is typed (up to ~40% of the screen), so the text is never hidden in a scroller.
  const grow = useCallback(() => {
    const el = own.current;
    if (!el) return;
    const top = el.scrollTop;
    el.style.height = 'auto';
    const kb = parseInt(document.documentElement.style.getPropertyValue('--kb'), 10) || 0;
    const bar = document.querySelector<HTMLElement>('[data-action-bar]');
    const barH = bar && !bar.contains(el) ? bar.offsetHeight : 0;
    const headerH = document.querySelector('header')?.offsetHeight ?? 0;
    const max = maxFieldHeight(window.innerHeight, kb, barH, headerH);
    el.style.height = `${growHeight(el.scrollHeight + 2, 96, max)}px`;
    // Resetting the height drops the inner scroll: keep the caret line in view (usually the end).
    const atEnd = document.activeElement === el && el.selectionStart === el.value.length;
    el.scrollTop = atEnd ? el.scrollHeight : top;
  }, []);
  useLayoutEffect(grow, [grow, rest.value]);
  useLayoutEffect(() => {
    window.addEventListener(KEYBOARD_EVENT, grow);
    return () => window.removeEventListener(KEYBOARD_EVENT, grow);
  }, [grow]);
  return (
    <Field label={label} hint={hint} error={error} id={fid}>
      <textarea
        ref={(el) => {
          own.current = el;
          if (typeof ref === 'function') ref(el);
          else if (ref) ref.current = el;
        }}
        id={fid}
        rows={3}
        enterKeyHint="enter"
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${fid}-msg` : undefined}
        className={cn(field, 'min-h-24 resize-none py-2.5 leading-snug', className)}
        {...rest}
        onInput={(e) => {
          grow();
          rest.onInput?.(e);
        }}
      />
    </Field>
  );
});

/**
 * Native select, styled. On phones it opens the system picker, which is faster and more
 * accessible than any custom listbox, and it keeps 16px text so iOS never zooms.
 */
export function Select({
  label,
  value,
  onValueChange,
  options,
  disabled,
  hideLabel,
  inline,
  title,
  className,
  swipeThrough,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
  /** A drag on the closed select does nothing, so it can sit inside a swipeable screen. */
  swipeThrough?: boolean;
  /** The label stays for assistive tech but is not drawn (the select sits in a row of controls). */
  hideLabel?: boolean;
  /** Size to the chosen text instead of filling the row. */
  inline?: boolean;
  title?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('flex flex-col gap-1.5', inline && 'w-fit max-w-full', className)}>
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-13 font-medium text-ink'}>
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          disabled={disabled}
          title={title}
          aria-label={hideLabel ? label : undefined}
          data-swipe-through={swipeThrough ? '' : undefined}
          onChange={(e) => onValueChange(e.target.value)}
          className={cn(
            inline ? field.replace('w-full ', 'max-w-full ') : field,
            'appearance-none pr-10',
          )}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Icon
          icon={ChevronDown}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-2"
        />
      </div>
    </div>
  );
}

export function RadioCards({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: Array<{ value: string; title: string; description: string; disabled?: boolean }>;
}) {
  return (
    <RadioGroup.Root
      value={value}
      onValueChange={onValueChange}
      aria-label={label}
      className="grid gap-2"
    >
      {options.map((o) => (
        <RadioGroup.Item
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          className={cn(
            'flex min-h-11 items-start gap-3 rounded-card border border-line bg-surface p-3.5 text-left',
            'transition-[border-color,background-color] duration-120 ease-standard',
            'hov:border-line-strong foc:outline-2 foc:outline-offset-2 foc:outline-focus',
            'data-[state=checked]:border-ink data-[state=checked]:bg-canvas disabled:opacity-50',
          )}
        >
          <span
            aria-hidden
            className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-line-strong data-[state=checked]:border-ink"
          >
            <RadioGroup.Indicator className="size-2 rounded-full bg-ink" />
          </span>
          <span className="min-w-0">
            <span className="block text-14 font-medium text-ink">{o.title}</span>
            <span className="block text-13 text-text-2">{o.description}</span>
          </span>
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}

export function Toggle({
  label,
  checked,
  onCheckedChange,
  disabled,
  description,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  const id = useId();
  return (
    <div className="flex min-h-11 items-center justify-between gap-4">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-14 font-medium text-ink">{label}</span>
        {description ? <span className="block text-13 text-text-2">{description}</span> : null}
      </label>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className={cn(
          'group grid h-11 w-14 shrink-0 place-items-center rounded-full',
          'foc:outline-2 foc:outline-offset-0 foc:outline-focus disabled:opacity-50',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'relative block h-7 w-12 rounded-full border border-line-strong bg-canvas',
            'transition-colors duration-200 ease-standard',
            'group-data-[state=checked]:border-ink group-data-[state=checked]:bg-ink',
          )}
        >
          <Switch.Thumb className="absolute left-0.5 top-0.5 block size-5 rounded-full bg-text-2 transition-transform duration-200 ease-standard data-[state=checked]:translate-x-5 data-[state=checked]:bg-surface" />
        </span>
      </Switch.Root>
    </div>
  );
}

/**
 * The one segmented control: a single choice out of a few, 44 px tall, squared. Used for views,
 * ranges, themes and filters (with counts). Scrolls sideways rather than wrapping when it runs out
 * of room. `tabs` makes it a tab list (the choice switches a panel) instead of a button group.
 *
 * Keyboard pattern: as a tab list it follows the ARIA tabs pattern (roving tabindex: only the
 * selected tab is in the Tab order; Left/Right/Home/End move to a tab and select it). As a button
 * group (`aria-pressed`) every button stays in the Tab order and Enter/Space toggles it, as for
 * any row of buttons.
 */
export function Segmented({
  label,
  value,
  onValueChange,
  options,
  tabs,
  className,
}: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: Array<{ value: string; label: string; count?: number }>;
  tabs?: boolean;
  className?: string;
}) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!tabs) return;
    const i = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const o = options[next];
    if (!o) return;
    onValueChange(o.value);
    const btns = e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    btns[next]?.focus();
  }
  return (
    <div
      role={tabs ? 'tablist' : 'group'}
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'flex w-full max-w-full overflow-x-auto rounded-btn sm:inline-flex sm:w-auto border border-line-strong bg-surface [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            {...(tabs
              ? { role: 'tab', 'aria-selected': on, tabIndex: on ? 0 : -1 }
              : { 'aria-pressed': on })}
            onClick={() => onValueChange(o.value)}
            className={cn(
              'inline-flex min-h-11 min-w-[44px] flex-auto items-center justify-center gap-0.5 px-0 text-12 font-medium whitespace-nowrap min-[340px]:px-1 min-[340px]:text-13 min-[360px]:px-2 min-[360px]:text-14 min-[360px]:gap-1 sm:flex-none sm:gap-1.5 sm:px-4',
              'transition-[background-color,color] duration-120 ease-standard',
              'foc:outline-2 foc:-outline-offset-2 foc:outline-focus',
              on ? 'bg-ink text-surface' : 'text-text-2 hov:bg-canvas hov:text-ink',
            )}
          >
            {o.label}
            {o.count !== undefined ? (
              <span
                className={cn(
                  'text-12 tabular-nums min-[340px]:text-13',
                  on ? 'text-surface/80' : 'text-text-2',
                )}
              >
                {o.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs({
  value,
  onValueChange,
  tabs,
  label,
  bleed = true,
}: {
  /** Run the tab bar edge to edge of a padded (p-4) parent; false inside content that is already inset. */
  bleed?: boolean;
  value: string;
  onValueChange: (v: string) => void;
  label: string;
  tabs: Array<{ value: string; label: string; content: ReactNode }>;
}) {
  return (
    <RadixTabs.Root value={value} onValueChange={onValueChange}>
      <RadixTabs.List
        aria-label={label}
        className={cn(
          'relative flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]',
          bleed && '-mx-4 px-4',
        )}
      >
        {tabs.map((t) => (
          <RadixTabs.Trigger
            key={t.value}
            value={t.value}
            className={cn(
              'relative min-h-11 shrink-0 px-3 text-14 font-medium text-text-2',
              'transition-colors duration-120 hov:text-ink foc:outline-2 foc:-outline-offset-2 foc:outline-focus',
              'data-[state=active]:text-ink',
              'after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:origin-left after:scale-x-0 after:bg-ink after:transition-transform after:duration-200 after:ease-standard',
              'data-[state=active]:after:scale-x-100',
            )}
          >
            {t.label}
          </RadixTabs.Trigger>
        ))}
      </RadixTabs.List>
      {tabs.map((t) => (
        <RadixTabs.Content
          key={t.value}
          value={t.value}
          className="pt-4 foc:outline-2 foc:outline-focus"
        >
          {t.content}
        </RadixTabs.Content>
      ))}
    </RadixTabs.Root>
  );
}
