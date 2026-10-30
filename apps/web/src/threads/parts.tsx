import type { InboxThread, ThreadState } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Pill } from '../ui/badge';
import { Icon } from '../ui/icon';
import { STATE_CHIP, waitingText } from './logic';

/** The thread's state chip: Investigating, Needs you, Your call, Waiting, Done, Ignored. */
export function StateChip({
  state,
  waiting,
  agent,
}: {
  state: ThreadState;
  waiting?: InboxThread['waiting'];
  /** The thread's agent, for "Waiting on <agent>". */
  agent?: string;
}) {
  const c = STATE_CHIP[state];
  return (
    <Pill tone={c.tone} className="shrink-0 whitespace-nowrap">
      <span data-state={state}>
        {state === 'waiting' && waiting ? waitingText(waiting, agent) : c.label}
      </span>
    </Pill>
  );
}

/** A small "Urgent" mark next to a thread. */
export function UrgentMark({ on }: { on?: boolean }) {
  return on ? (
    <span data-urgent="" className="shrink-0 text-13 font-semibold text-sendback">
      Urgent
    </span>
  ) : null;
}

/** "teams", "mail", … as a small tag. */
export function SourceTag({ source }: { source: string }) {
  return (
    <span className="inline-flex h-6 items-center rounded-full border border-line px-2 font-mono text-12 text-text-2">
      {source}
    </span>
  );
}

/** Day and time, short. */
export function when(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** Back to Inbox, or to a subject when `subject` is given. */
export function BackLink({
  children,
  subject,
}: {
  children: ReactNode;
  subject?: { wid: string; sid: string };
}) {
  const cls =
    'mb-3 inline-flex min-h-11 items-center gap-1 rounded-btn pr-2 text-14 font-medium text-text-2 hover:text-ink foc:outline-2 foc:outline-focus';
  const inner = (
    <>
      <Icon icon={ChevronLeft} size={16} />
      {children}
    </>
  );
  return subject ? (
    <Link to="/inbox/$wid/s/$sid" params={subject} className={cls}>
      {inner}
    </Link>
  ) : (
    <Link to="/inbox" className={cls}>
      {inner}
    </Link>
  );
}

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mt-6" aria-label={title}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-16 font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export const errorText = (e: unknown) =>
  e instanceof Error && e.message ? e.message : 'Could not save. Try again.';
