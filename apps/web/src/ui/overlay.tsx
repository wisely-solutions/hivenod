import { X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as RadixDialog, Popover as RadixPopover, Tooltip as RadixTooltip } from 'radix-ui';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Drawer } from 'vaul';
import { IconButton } from './button';
import { Button } from './button';
import { cn } from './cn';
import { Icon } from './icon';
import { onLeave } from '../lib/pendingDecisions';
import { undoWindowMs } from '../lib/undoWindow';
import { tween, useReducedMotion } from './motion';

/**
 * Gives focus back to whatever had it when the dialog opened. Radix does this itself only for a
 * Trigger, and these dialogs are opened by state, so it is done here. It happens the moment the
 * dialog starts to close, not when its exit animation ends and Radix gets round to it, so focus
 * is never on BODY in between (a screen reader or a quick Tab would land at the top of the page).
 */
export function useReturnFocus(open: boolean) {
  const from = useRef<HTMLElement | null>(null);
  const give = useCallback(() => {
    const el = from.current;
    if (el && el.isConnected && el !== document.body) {
      el.focus({ preventScroll: true });
      return true;
    }
    return false;
  }, []);
  useLayoutEffect(() => {
    if (open) from.current = document.activeElement as HTMLElement | null;
    else give();
  }, [open, give]);
  return (e: Event) => {
    if (give()) e.preventDefault();
  };
}

/**
 * A click, tap or focus on a notification is never an "outside" interaction for a dialog, sheet,
 * popover or menu: it must not close them. Pass as `onInteractOutside`.
 */
export const TOAST_REGION_ATTR = 'data-toast-region';
export function keepOpenOnToast(e: Event) {
  const detail = (e as CustomEvent<{ originalEvent?: Event }>).detail;
  const t = (detail?.originalEvent?.target ?? e.target) as Element | null;
  if (t && typeof t.closest === 'function' && t.closest(`[${TOAST_REGION_ATTR}]`))
    e.preventDefault();
}

/* ------------------------------ Tooltip ------------------------------ */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 max-w-64 rounded-btn bg-ink px-2.5 py-1.5 text-13 text-surface shadow-e2"
        >
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

/* ------------------------------ Popover ------------------------------ */

export function Popover({
  trigger,
  children,
  label,
  open,
  onOpenChange,
  contentClassName,
  side,
  align,
}: {
  trigger: ReactNode;
  children: ReactNode;
  label: string;
  /** Controlled use; leave both out to let the popover manage itself. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Width and padding of the panel (default: 18rem wide, 16px padding). */
  contentClassName?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          aria-label={label}
          onInteractOutside={keepOpenOnToast}
          sideOffset={8}
          collisionPadding={12}
          side={side}
          align={align}
          className={cn(
            'z-50 rounded-card border border-line bg-surface shadow-e3 outline-hidden',
            contentClassName ?? 'w-72 max-w-[calc(100vw-24px)] p-4',
          )}
        >
          {children}
          <RadixPopover.Arrow className="fill-surface" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

/* ------------------------------ Dialog ------------------------------ */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
  /** A roomier dialog (gallery pickers). Sheets are always full width. */
  wide?: boolean;
}) {
  const reduced = useReducedMotion();
  const returnFocus = useReturnFocus(open);
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <AnimatePresence>
        {open ? (
          <RadixDialog.Portal forceMount>
            <RadixDialog.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-40 bg-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={tween.base}
              />
            </RadixDialog.Overlay>
            <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center p-4">
              <RadixDialog.Content
                asChild
                forceMount
                onCloseAutoFocus={returnFocus}
                onInteractOutside={keepOpenOnToast}
              >
                <motion.div
                  className={cn(
                    'pointer-events-auto max-h-[calc(100dvh-2rem)] w-full overflow-y-auto rounded-panel border border-line bg-surface p-5 shadow-e3 outline-hidden',
                    wide ? 'max-w-3xl' : 'max-w-md',
                  )}
                  initial={{ opacity: 0, scale: reduced ? 1 : 0.96, y: reduced ? 0 : 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: reduced ? 1 : 0.98 }}
                  transition={tween.base}
                >
                  <div className="flex items-start justify-between gap-3">
                    <RadixDialog.Title className="text-20 font-semibold text-ink">
                      {title}
                    </RadixDialog.Title>
                    <RadixDialog.Close asChild>
                      <IconButton label="Close" className="-mr-2 -mt-2">
                        <Icon icon={X} size={18} />
                      </IconButton>
                    </RadixDialog.Close>
                  </div>
                  {description ? (
                    <RadixDialog.Description className="mt-1 text-14 text-text-2">
                      {description}
                    </RadixDialog.Description>
                  ) : (
                    <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
                  )}
                  {children ? <div className="mt-4">{children}</div> : null}
                  {footer ? (
                    <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div>
                  ) : null}
                </motion.div>
              </RadixDialog.Content>
            </div>
          </RadixDialog.Portal>
        ) : null}
      </AnimatePresence>
    </RadixDialog.Root>
  );
}

/* ------------------------------ Sheet (vaul) ------------------------------ */

/** Bottom sheet. Drag down to dismiss; every sheet also has a Close button. Respects safe areas. */
export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const returnFocus = useReturnFocus(open);
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-overlay" />
        <Drawer.Content
          onCloseAutoFocus={returnFocus}
          onInteractOutside={keepOpenOnToast}
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-xl flex-col rounded-t-panel border border-b-0 border-line bg-surface shadow-e3 outline-hidden"
        >
          <div
            aria-hidden
            className="mx-auto mt-2.5 h-1.5 w-10 shrink-0 rounded-full bg-line-strong"
          />
          <div className="flex items-start justify-between gap-3 px-5 pt-3">
            <div className="min-w-0">
              <Drawer.Title className="text-20 font-semibold text-ink">{title}</Drawer.Title>
              {description ? (
                <Drawer.Description className="mt-0.5 text-14 text-text-2">
                  {description}
                </Drawer.Description>
              ) : (
                <Drawer.Description className="sr-only">{title}</Drawer.Description>
              )}
            </div>
            <Drawer.Close asChild>
              <IconButton label="Close" className="-mr-2 -mt-1.5">
                <Icon icon={X} size={18} />
              </IconButton>
            </Drawer.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            {children}
          </div>
          {footer ? (
            <div className="flex flex-col gap-2 border-t border-line px-5 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:justify-end">
              {footer}
            </div>
          ) : (
            <div className="h-[env(safe-area-inset-bottom)]" />
          )}
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/* ------------------------------ Toast ------------------------------ */

export interface ToastInput {
  message: string;
  undoLabel?: string;
  /** A second button (e.g. Open) that runs `onAction` and ends the toast, keeping what was done. */
  actionLabel?: string;
  onAction?: () => void;
  /** Milliseconds until the action is committed. Default 5000. */
  duration?: number;
  onUndo?: () => void;
  /** Runs once when the countdown ends, or when the toast is dismissed or the app unmounts. */
  onCommit?: () => void;
}

/** How many toasts show at once. */
const MAX_TOASTS = 3;

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<{
  push: (t: ToastInput) => number;
  dismiss: (id: number) => void;
  /** Ends every toast on screen (what was done stays done), e.g. when a sheet opens over them. */
  dismissAll: () => void;
} | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast needs <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const live = useRef(new Map<number, ToastItem>());

  const settle = useCallback((id: number, how: 'commit' | 'undo') => {
    const t = live.current.get(id);
    if (!t) return;
    live.current.delete(id);
    setItems((cur) => cur.filter((x) => x.id !== id));
    if (how === 'undo') t.onUndo?.();
    else t.onCommit?.();
  }, []);

  const dismissAll = useCallback(() => {
    for (const id of [...live.current.keys()]) settle(id, 'commit');
  }, [settle]);

  const push = useCallback(
    (input: ToastInput) => {
      const id = ++idRef.current;
      const t = { ...input, id };
      live.current.set(id, t);
      // Only MAX_TOASTS fit on screen. The oldest one leaves now, with no Undo left to press, so
      // it settles now: dropping it from view alone would stop its countdown and strand the commit.
      for (const old of [...live.current.keys()].slice(0, -MAX_TOASTS)) settle(old, 'commit');
      setItems((cur) => [...cur, t]);
      return id;
    },
    [settle],
  );

  // Leaving the page (close, hide, kill) commits what is still counting down: see onLeave.
  useEffect(() => onLeave(dismissAll), [dismissAll]);

  // Navigation or unmount commits whatever is still pending, never drops it.
  useEffect(() => {
    const pending = live.current;
    return () => {
      for (const t of pending.values()) t.onCommit?.();
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ push, dismiss: (id) => settle(id, 'commit'), dismissAll }}>
      {children}
      <div
        role="region"
        aria-label="Notifications"
        // A modal dialog (Radix hideOthers) hides everything but its own content from screen
        // readers, except elements that carry aria-live. "off" keeps this region out of that
        // hiding without making the region itself announce: each toast is its own role="status".
        aria-live="off"
        data-toast-region=""
        className="pointer-events-none fixed inset-x-0 bottom-[var(--kb,0px)] z-[60] max-sm:bottom-[calc(3.5rem+env(safe-area-inset-bottom)+var(--kb,0px)+var(--decision-bar-h,0px))] max-sm:[html[data-focus-open]_&]:bottom-[calc(var(--kb,0px)+var(--decision-bar-h,0px))] flex flex-col items-center gap-2 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pl-[max(16px,env(safe-area-inset-left))] pr-[max(16px,env(safe-area-inset-right))] sm:inset-x-auto sm:bottom-auto sm:right-0 sm:top-0 sm:w-[28rem] sm:max-w-full sm:items-end sm:px-0 sm:pb-0 sm:pl-0 sm:pr-[max(16px,env(safe-area-inset-right))] sm:pt-4"
      >
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <ToastView key={t.id} toast={t} onSettle={settle} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({
  toast,
  onSettle,
}: {
  toast: ToastItem;
  onSettle: (id: number, how: 'commit' | 'undo') => void;
}) {
  // Toasts sit top-right from the sm breakpoint up (they slide in from the right and leave to it);
  // on phones they sit at the bottom and slide up. Read once: a toast lives a few seconds.
  const [fromRight] = useState(
    () =>
      typeof window !== 'undefined' && window.matchMedia?.('(min-width: 640px)').matches === true,
  );
  const total = toast.onUndo ? undoWindowMs(toast.duration ?? 5000) : (toast.duration ?? 5000);
  const remaining = useRef(total);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (paused) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => onSettle(toast.id, 'commit'), remaining.current);
    return () => {
      clearTimeout(timer.current);
      remaining.current -= Date.now() - startedAt.current;
    };
  }, [paused, onSettle, toast.id]);

  return (
    <motion.div
      layout
      role="status"
      initial={{
        opacity: 0,
        ...(fromRight ? { x: reduced ? 0 : 24 } : { y: reduced ? 0 : 24 }),
        scale: reduced ? 1 : 0.98,
      }}
      animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
      exit={{ opacity: 0, ...(fromRight ? { x: reduced ? 0 : 16 } : { y: reduced ? 0 : 8 }) }}
      transition={tween.base}
      // Hover pause is a mouse affordance: only a real mouse moving over the toast pauses (a still
      // cursor under a new toast must not). A tap on a touch screen emulates mouse events but never
      // a leave, so it would freeze the countdown; touch never pauses. Keyboard focus pauses too
      // (focus-visible only: a tap focusing a button must not) and resumes on blur.
      onPointerMove={(e) => e.pointerType === 'mouse' && setPaused(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setPaused(false)}
      onFocusCapture={(e) => {
        if (e.target.matches(':focus-visible')) setPaused(true);
      }}
      onBlurCapture={() => setPaused(false)}
      className="pointer-events-auto relative w-full max-w-md overflow-hidden rounded-card bg-ink text-surface shadow-e3"
    >
      <div className="flex items-center justify-between gap-3 py-1.5 pl-4 pr-1.5">
        <p className="py-2 text-14">{toast.message}</p>
        {toast.actionLabel || toast.undoLabel ? (
          <div className="flex shrink-0 items-center">
            {toast.actionLabel ? (
              <Button
                variant="ghost"
                className="text-surface hov:bg-surface/15 foc:outline-surface"
                onClick={() => {
                  toast.onAction?.();
                  onSettle(toast.id, 'commit');
                }}
              >
                {toast.actionLabel}
              </Button>
            ) : null}
            {toast.undoLabel ? (
              <Button
                variant="ghost"
                className="text-surface hov:bg-surface/15 foc:outline-surface"
                onClick={() => onSettle(toast.id, 'undo')}
              >
                {toast.undoLabel}
              </Button>
            ) : null}
          </div>
        ) : (
          <IconButton
            label="Dismiss"
            className="text-surface hov:bg-surface/15"
            onClick={() => onSettle(toast.id, 'commit')}
          >
            <Icon icon={X} />
          </IconButton>
        )}
      </div>
      <div
        aria-hidden
        data-keep-motion
        data-testid="toast-countdown"
        className="h-0.5 origin-left bg-gate animate-countdown"
        style={{
          animationDuration: `${total}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </motion.div>
  );
}
