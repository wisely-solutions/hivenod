/**
 * The bell (item 3ENs): the history of what was for you. Desktop: a button next to the
 * organization in the sidebar, opening a popover. Phones: a button in the top bar, opening the
 * full-screen list (/notifications). The tab bar stays as it is.
 */
import { bellText, type BellKind } from '@hive/shared';
import { Link } from '@tanstack/react-router';
import { Bell, Clock, Mail, MailQuestion, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useReady } from '../auth/context';
import { useNeedsAll } from '../needs/data';
import { cn } from '../ui/cn';
import { Icon } from '../ui/icon';
import { Popover } from '../ui/overlay';
import { useBell } from './data';
import { filterRows, groupByDay, timeLabel, type BellFilter, type BellRow } from './logic';

const KIND: Record<BellKind, { icon: LucideIcon; tone: string }> = {
  inboxAsk: { icon: MailQuestion, tone: 'bg-agent-soft text-agent' },
  inboxCall: { icon: Mail, tone: 'bg-gate-bg text-gate-text' },
  silence: { icon: Clock, tone: 'bg-sendback-bg text-sendback' },
};

/** The unread count on the bell: 99+ past 99. */
function countText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/**
 * What the bell button shows. No aria-label: its name is its own (screen-reader) text,
 * "Notifications, 3 unread", and the badge repeats the count for the eye.
 */
function BellFace({ size = 18 }: { size?: number }) {
  const { unread, ready } = useBell();
  const n = ready ? unread : 0;
  return (
    <>
      <Icon icon={Bell} size={size} />
      <span className="sr-only">{n > 0 ? `Notifications, ${n} unread` : 'Notifications'}</span>
      {n > 0 ? (
        <span
          aria-hidden
          data-testid="bell-count"
          className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-sendback px-1 text-12 font-semibold leading-none text-surface"
        >
          {countText(n)}
        </span>
      ) : null}
    </>
  );
}

const faceClass =
  'relative grid size-11 shrink-0 place-items-center rounded-btn text-text-2 transition-colors hover:bg-canvas hover:text-ink foc:outline-2 foc:outline-focus';

/** Desktop and tablet: the bell next to the organization, opening the popover. */
export function BellButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      label="Notifications"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      contentClassName="w-[26rem] max-w-[calc(100vw-24px)] overflow-hidden p-0"
      trigger={
        <button type="button" data-bell="" className={cn(faceClass, className)}>
          <BellFace />
        </button>
      }
    >
      <BellList variant="popover" onDone={() => setOpen(false)} />
    </Popover>
  );
}

/** Phones: the bell in the top bar, opening the full-screen list. */
export function BellLink({ className }: { className?: string }) {
  return (
    <Link to="/notifications" data-bell="" className={cn(faceClass, className)}>
      <BellFace size={20} />
    </Link>
  );
}

function Entry({
  row,
  org,
  onOpen,
}: {
  row: BellRow;
  /** The organization's name, for an entry of another one than on screen. */
  org?: string;
  onOpen: (r: BellRow) => void;
}) {
  const e = row.data;
  const t = bellText(e);
  const k = KIND[e.kind];
  const unread = e.readAt === null;
  return (
    <li>
      <button
        type="button"
        data-entry={row.id}
        data-unread={unread ? '' : undefined}
        onClick={() => onOpen(row)}
        className={cn(
          'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus',
          unread && 'bg-agent-soft/40',
        )}
      >
        <span
          aria-hidden
          className={cn('mt-0.5 grid size-7 shrink-0 place-items-center rounded-full', k.tone)}
        >
          <Icon icon={k.icon} size={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-14 text-ink [overflow-wrap:anywhere]">
            {t.before}
            <strong className="font-semibold">{t.title}</strong>
            {t.after}
          </span>
          <span className="mt-0.5 block text-13 text-text-2">
            {org ? `${org} · ` : ''}
            {e.projectName} · {timeLabel(e.at)}
          </span>
        </span>
        {unread ? (
          <span className="mt-2 flex shrink-0 items-center">
            <span aria-hidden className="size-2 rounded-full bg-agent" />
            <span className="sr-only">, unread</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

const FILTERS: { id: BellFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'needs', label: 'Needs you' },
];

/** The list itself, in the popover or on the full page. */
export function BellList({
  variant,
  onDone,
}: {
  variant: 'popover' | 'page';
  onDone?: () => void;
}) {
  const { rows, unread, ready, markAllRead, open } = useBell();
  const { session } = useReady();
  const { orgs } = useNeedsAll();
  const orgName = (w: string) =>
    w === session.workspaceId ? undefined : orgs.find((o) => o.wid === w)?.name;
  const [filter, setFilter] = useState<BellFilter>('all');
  // "Today" is fixed when the list opens; a list left open past midnight is rare and harmless.
  const [now] = useState(() => Date.now());
  const shown = filterRows(rows, filter);
  const groups = groupByDay(shown, now);
  const Title = variant === 'page' ? 'h1' : 'h2';
  return (
    <div className="flex min-h-0 flex-col">
      <div
        className={cn(
          'flex items-center justify-between gap-3 border-b border-line',
          variant === 'page' ? 'pb-3' : 'px-4 py-3',
        )}
      >
        <Title className={cn('font-semibold text-ink', variant === 'page' ? 'text-28' : 'text-16')}>
          Notifications
        </Title>
        <button
          type="button"
          onClick={markAllRead}
          disabled={unread === 0}
          className="min-h-11 rounded-btn px-2 text-14 font-medium text-agent transition-colors hover:underline disabled:text-text-3 disabled:no-underline foc:outline-2 foc:outline-focus"
        >
          Mark all read
        </button>
      </div>
      <div
        role="group"
        aria-label="Show"
        className={cn('flex flex-wrap gap-2', variant === 'page' ? 'py-3' : 'px-4 py-3')}
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'inline-flex min-h-9 items-center rounded-full border px-3 text-13 font-medium transition-colors foc:outline-2 foc:outline-focus',
              filter === f.id
                ? 'border-ink bg-ink text-surface'
                : 'border-line text-text-2 hover:border-line-strong hover:text-ink',
            )}
          >
            {f.label}
            {f.id === 'unread' && unread > 0 ? ` · ${countText(unread)}` : ''}
          </button>
        ))}
      </div>
      <div
        className={cn(
          variant === 'popover' && 'max-h-[min(30rem,calc(100dvh-14rem))] overflow-y-auto',
          variant === 'page' &&
            '-mx-4 sm:mx-0 sm:rounded-card sm:border sm:border-line sm:bg-surface',
        )}
      >
        {!ready ? (
          <p className="px-4 py-6 text-14 text-text-2">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="px-4 py-6 text-14 text-text-2">
            {filter === 'all'
              ? 'Nothing yet. What waits for you, questions and send-backs show up here for 30 days.'
              : filter === 'unread'
                ? 'All read.'
                : 'Nothing that asks for you.'}
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <p className="px-4 pb-1 pt-3 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
                {g.label}
              </p>
              <ul>
                {g.rows.map((r) => (
                  <Entry
                    key={r.id}
                    row={r}
                    org={orgName(r.data.workspaceId)}
                    onOpen={(x) => {
                      onDone?.();
                      open(x);
                    }}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {variant === 'popover' ? (
        <div className="border-t border-line p-1 text-center">
          <Link
            to="/notifications"
            onClick={() => onDone?.()}
            className="flex min-h-11 items-center justify-center rounded-btn text-14 font-medium text-agent hover:underline foc:outline-2 foc:outline-focus"
          >
            See all notifications
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** /notifications: the whole history (phones open it from the top bar). */
export function NotificationsHistoryPage() {
  return <BellList variant="page" />;
}
