import { cn } from '../ui/cn';

/** The Hivenod mark: the favicon hexagon in amber on ink. */
export function Logo({ className, size = 28 }: { className?: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden
      className={cn('shrink-0', className)}
    >
      <rect width="32" height="32" rx="8" fill="var(--ink)" />
      <path
        d="M16 6l8.7 5v10L16 26l-8.7-5V11z"
        fill="none"
        stroke="var(--gate)"
        strokeWidth="2.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
