import { User } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';

/**
 * "You · all organizations" (item icVly, model A): says on Today, Inbox and Calendar that the page
 * spans every organization the person is in, whatever the switcher shows.
 */
export function ScopePill({ className }: { className?: string }) {
  return (
    <span
      data-scope-pill=""
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-13 text-text-2',
        className,
      )}
    >
      <Icon icon={User} size={13} />
      <span>
        <span className="font-semibold text-ink">You</span> · all organizations
      </span>
    </span>
  );
}

/** The pill and the page's own line next to it ("5 threads wait for you"). */
export function ScopeLine({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <p className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 text-14 text-text-2', className)}>
      <ScopePill />
      {children ? <span className="min-w-0">{children}</span> : null}
    </p>
  );
}
