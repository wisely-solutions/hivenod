import {
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion as useMotionReduced,
  type HTMLMotionProps,
  type Transition,
} from 'motion/react';
import type { ReactNode } from 'react';

/** Motion tokens (SPEC section 7). Everything animates transform and opacity only. */
export const duration = { fast: 0.12, base: 0.2, slow: 0.32 } as const;
export const ease = [0.2, 0.8, 0.2, 1] as const;
export const spring = {
  ui: { type: 'spring', stiffness: 500, damping: 40 } satisfies Transition,
  sheet: { type: 'spring', stiffness: 260, damping: 26 } satisfies Transition,
} as const;
export const tween = {
  fast: { duration: duration.fast, ease },
  base: { duration: duration.base, ease },
  slow: { duration: duration.slow, ease },
} as const;

/**
 * Wrap the app once. With reducedMotion="user", Motion drops transform and layout
 * animation when the OS asks for less motion and keeps opacity: a cross-fade only.
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** True when the user prefers reduced motion. Use it to swap movement for a fade. */
export function useReducedMotion(): boolean {
  return useMotionReduced() ?? false;
}

/** Fade (and rise 8px) into place. Under reduced motion it only fades. */
export function Reveal({
  children,
  delay = 0,
  y = 8,
  ...rest
}: { children: ReactNode; delay?: number; y?: number } & Omit<
  HTMLMotionProps<'div'>,
  'children' | 'initial' | 'animate' | 'transition'
>) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: reduced ? 0 : y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...tween.base, delay }}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/** Scope for layoutId shared-element transitions (card to detail and back). */
export function SharedLayout({ id, children }: { id?: string; children: ReactNode }) {
  return <LayoutGroup id={id}>{children}</LayoutGroup>;
}

export { AnimatePresence, motion } from 'motion/react';
