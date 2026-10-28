import { useEffect, useRef } from 'react';

/* ------------------------------ Haptics ------------------------------ */

/** Short buzz patterns. Sound stays off: Hivenod never plays audio. */
const PATTERNS = { tick: 8, decide: [10, 40, 14], warn: [18, 50, 18] } as const;

/** Vibrates on devices that support it (SPEC 7.10). Silent everywhere else. */
export function haptic(kind: keyof typeof PATTERNS = 'tick'): void {
  try {
    navigator.vibrate?.(PATTERNS[kind] as number | number[]);
  } catch {
    /* not supported or blocked: no feedback, no problem */
  }
}

/* ------------------------------ Swipe classification ------------------------------ */

export type SwipeDirection = 'left' | 'right' | 'down' | null;

export interface SwipeInput {
  dx: number;
  dy: number;
  ms: number;
  startX: number;
}

export const SWIPE = { distance: 72, edge: 24, maxMs: 700, downMaxMs: 3000, slope: 1.6 } as const;

/**
 * Turns a finished touch into a navigation gesture. Mostly-horizontal and fast enough for
 * left/right, mostly-vertical downwards for pull-down. A swipe right that starts at the very left
 * edge is reported separately by the caller (edge-swipe back).
 */
export function classifySwipe({ dx, dy, ms }: SwipeInput): SwipeDirection {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Pull-down is distance-based: a slow, deliberate pull must close too. Left/right stay quick flicks.
  if (dy >= SWIPE.distance * 1.4 && ay > ax * SWIPE.slope && ms <= SWIPE.downMaxMs) return 'down';
  if (ms > SWIPE.maxMs) return null;
  if (ax >= SWIPE.distance && ax > ay * SWIPE.slope) return dx > 0 ? 'right' : 'left';
  return null;
}

export function isEdgeStart(startX: number): boolean {
  return startX <= SWIPE.edge;
}

/** True when the touch began somewhere that scrolls or edits on its own, so we must not steal it. */
export function ownsGesture(el: Element | null, root: Element): boolean {
  for (let n: Element | null = el; n && n !== root; n = n.parentElement) {
    const tag = n.tagName;
    // A closed select can opt in (data-swipe-through): a drag on it does nothing, a tap opens the picker.
    if (tag === 'SELECT' && n.hasAttribute('data-swipe-through')) continue;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'IFRAME') return true;
    if ((n as HTMLElement).isContentEditable) return true;
    if (n.hasAttribute('data-no-swipe')) return true;
    if (n.scrollWidth > n.clientWidth + 1) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
  }
  return false;
}

export interface SwipeHandlers {
  onLeft?: () => void;
  onRight?: () => void;
  onDown?: () => void;
  /** Swipe right from the very left edge. Only wire this in an installed app: browsers own it otherwise. */
  onEdgeBack?: () => void;
}

/** Touch swipes on an element. Passive: it never blocks scrolling. */
export function useSwipe(ref: React.RefObject<HTMLElement | null>, handlers: SwipeHandlers) {
  const h = useRef(handlers);
  useEffect(() => {
    h.current = handlers;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number; ok: boolean } | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return (start = null);
      start = {
        x: t.clientX,
        y: t.clientY,
        t: e.timeStamp,
        ok: !ownsGesture(e.target as Element, el),
      };
    };
    const up = (e: TouchEvent) => {
      const s = start;
      start = null;
      const t = e.changedTouches[0];
      if (!s || !t || !s.ok) return;
      const dir = classifySwipe({
        dx: t.clientX - s.x,
        dy: t.clientY - s.y,
        ms: e.timeStamp - s.t,
        startX: s.x,
      });
      if (dir === 'right' && isEdgeStart(s.x) && h.current.onEdgeBack) {
        haptic('tick');
        return h.current.onEdgeBack();
      }
      const fn =
        dir === 'left'
          ? h.current.onLeft
          : dir === 'right'
            ? h.current.onRight
            : dir === 'down'
              ? h.current.onDown
              : undefined;
      if (fn) {
        haptic('tick');
        fn();
      }
    };
    el.addEventListener('touchstart', down, { passive: true });
    el.addEventListener('touchend', up, { passive: true });
    el.addEventListener('touchcancel', () => (start = null), { passive: true });
    return () => {
      el.removeEventListener('touchstart', down);
      el.removeEventListener('touchend', up);
    };
  }, [ref]);
}

/* ------------------------------ Keyboard ------------------------------ */

/** How many CSS pixels of the layout viewport the on-screen keyboard covers. */
export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const covered = innerHeight - vvHeight - vvOffsetTop;
  // Small differences are browser chrome sliding in and out, not a keyboard.
  return covered > 80 ? Math.round(covered) : 0;
}

export const KEYBOARD_EVENT = 'hive:keyboard';

const TEXT_INPUT =
  'input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select';

/**
 * Keeps the focused field visible: publishes the keyboard height as `--kb` (sticky bars sit above
 * it) and scrolls the field into view when the keyboard opens or the field changes.
 */
export function useKeyboardAvoidance(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    let lastInset = 0;
    const set = () => {
      const inset = vv ? keyboardInset(window.innerHeight, vv.height, vv.offsetTop) : 0;
      root.style.setProperty('--kb', `${inset}px`);
      root.dataset.keyboard = inset > 0 ? 'open' : 'closed';
      if (inset !== lastInset) {
        lastInset = inset;
        window.dispatchEvent(new Event(KEYBOARD_EVENT)); // textareas re-fit the visible band
      }
      return inset;
    };
    const reveal = () => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || !el.matches(TEXT_INPUT)) return;
      const kb = keyboardInset(
        window.innerHeight,
        vv?.height ?? window.innerHeight,
        vv?.offsetTop ?? 0,
      );
      // A sticky action bar rides above the keyboard; the field has to clear it too.
      const bar = document.querySelector<HTMLElement>('[data-action-bar]');
      const barH = bar && !bar.contains(el) ? bar.offsetHeight : 0;
      const header = document.querySelector<HTMLElement>('header');
      const top = (header?.offsetHeight ?? 0) + 8;
      const dy = revealDelta(el.getBoundingClientRect(), top, window.innerHeight - kb - barH - 8);
      if (dy) window.scrollBy({ top: dy, behavior: 'auto' });
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      const inset = set();
      if (inset > 0) reveal();
    };
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof HTMLElement) || !e.target.matches(TEXT_INPUT)) return;
      // The keyboard takes a moment to slide up; look again once it has.
      clearTimeout(timer);
      timer = setTimeout(() => {
        set();
        reveal();
      }, 300);
    };
    // Typing grows the field and moves the caret: look again after every input, not only on focus.
    let raf = 0;
    const onInput = (e: Event) => {
      if (!(e.target instanceof HTMLElement) || !e.target.matches(TEXT_INPUT)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (set() > 0) reveal();
      });
    };
    set();
    document.addEventListener('input', onInput);
    vv?.addEventListener('resize', onResize);
    vv?.addEventListener('scroll', onResize);
    document.addEventListener('focusin', onFocus);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      document.removeEventListener('input', onInput);
      vv?.removeEventListener('resize', onResize);
      vv?.removeEventListener('scroll', onResize);
      document.removeEventListener('focusin', onFocus);
      root.style.removeProperty('--kb');
      delete root.dataset.keyboard;
    };
  }, []);
}

/**
 * The tallest a growing textarea may get: 40% of the screen, and with the keyboard open never
 * more than the band between the header and the action bar (then it scrolls inside itself and the
 * browser keeps the caret in view).
 */
export function maxFieldHeight(
  innerHeight: number,
  keyboard: number,
  barHeight: number,
  headerHeight: number,
): number {
  const cap = Math.round(innerHeight * 0.4);
  if (keyboard <= 0) return Math.max(96, cap);
  const band = innerHeight - keyboard - barHeight - headerHeight - 24;
  return Math.max(96, Math.min(cap, band));
}

/** Height a textarea needs for its content, between a minimum and a maximum (pure, for tests). */
export function growHeight(scrollHeight: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, scrollHeight));
}

/** How far to scroll so a field sits inside the visible band; the top edge wins for tall fields. */
export function revealDelta(
  rect: { top: number; bottom: number },
  visibleTop: number,
  visibleBottom: number,
): number {
  if (rect.bottom > visibleBottom)
    return Math.min(rect.bottom - visibleBottom, rect.top - visibleTop);
  if (rect.top < visibleTop) return rect.top - visibleTop;
  return 0;
}
