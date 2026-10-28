import { memberProfileSchema } from '@hive/shared';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReady } from '../auth/context';
import { useLiveCollection } from '../lib/live';
import { useOrgs } from '../orgs/data';
import { PageHeader } from '../pages/Chrome';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Select, Segmented } from '../ui/form';
import { Icon } from '../ui/icon';
import { useCalendarBlocks, type Scope } from './data';
import {
  allDayOn,
  blockLabel,
  layoutDay,
  rangeOf,
  rangeTitle,
  sameDay,
  shift,
  timeRange,
  type CalBlock,
  type CalView,
} from './logic';

/** Pixels per hour in the time grid. */
const HOUR = 48;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Calendar (Inbox item w9SAf): day and week, for one organization (its events, plus my busy time
 * elsewhere, greyed) or across all my calendars (my events everywhere, with details).
 */
export function CalendarPage() {
  const { session } = useReady();
  const uid = session.me.uid;
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  const [scope, setScope] = useState<Scope>('all');
  const [view, setView] = useState<CalView>(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 639px)').matches
      ? 'day'
      : 'week',
  );
  const [anchor, setAnchor] = useState(() => new Date());
  const { from, to, days } = useMemo(() => rangeOf(view, anchor), [view, anchor]);

  const orgRows = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const members = useLiveCollection(
    scope === 'all' ? null : `workspaces/${scope}/members`,
    memberProfileSchema,
  );
  const memberName = useCallback(
    (_wid: string, m: string) =>
      (members.state === 'ready' && members.data.find((r) => r.id === m)?.data.name) || 'A member',
    [members],
  );
  const cal = useCalendarBlocks({ scope, uid, orgs: orgRows, memberName, from, to });

  const scopeOptions = [
    { value: 'all', label: 'All my calendars' },
    ...orgs.map((o) => ({ value: o.id, label: o.name })),
  ];
  const today = new Date();
  const empty = cal.state === 'ready' && cal.blocks.length === 0;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader title="Calendar" subtitle={rangeTitle(view, anchor)} />
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Select
          label="Calendar"
          hideLabel
          inline
          value={scope}
          onValueChange={(v) => setScope(v)}
          options={scopeOptions}
        />
        <Segmented
          label="View"
          className="sm:w-auto"
          value={view}
          onValueChange={(v) => setView(v as CalView)}
          options={[
            { value: 'day', label: 'Day' },
            { value: 'week', label: 'Week' },
          ]}
        />
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={view === 'day' ? 'Previous day' : 'Previous week'}
            onClick={() => setAnchor((a) => shift(view, a, -1))}
          >
            <Icon icon={ChevronLeft} />
          </IconButton>
          <Button variant="secondary" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <IconButton
            label={view === 'day' ? 'Next day' : 'Next week'}
            onClick={() => setAnchor((a) => shift(view, a, 1))}
          >
            <Icon icon={ChevronRight} />
          </IconButton>
        </div>
      </div>

      {cal.state === 'error' ? (
        <p role="alert" className="mb-3 text-14 text-sendback">
          This calendar could not be loaded. Check your connection and try again.
        </p>
      ) : null}
      <p aria-live="polite" className={cn('mb-3 text-14 text-text-2', !empty && 'sr-only')}>
        {empty
          ? scope === 'all'
            ? 'Nothing in your calendars here. Your agents add events from the calendars they sync.'
            : 'Nothing in this calendar here. Its agents add events from the calendars they sync.'
          : cal.state === 'loading'
            ? 'Loading the calendar'
            : `${cal.blocks.length} event${cal.blocks.length === 1 ? '' : 's'} shown`}
      </p>

      <Grid days={days} blocks={cal.blocks} today={today} view={view} />
      <p className="mt-3 flex items-center gap-2 text-13 text-text-2">
        <span
          aria-hidden
          className="inline-block size-3 rounded-sm border border-line-strong cal-busy"
        />
        Busy: time from another organization or a private event, shown without details.
      </p>
    </div>
  );
}

function Grid({
  days,
  blocks,
  today,
  view,
}: {
  days: Date[];
  blocks: CalBlock[];
  today: Date;
  view: CalView;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Open at 07:00: most of a working day in view without scrolling.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR - 12;
  }, []);
  const hasAllDay = days.some((d) => allDayOn(blocks, d).length > 0);
  const week = view === 'week';
  const cols = { gridTemplateColumns: `2.5rem repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="grid border-b border-line" style={cols} aria-hidden>
        <div />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          return (
            <div
              key={d.getTime()}
              className={cn(
                'min-w-0 border-l border-line px-1 py-2 text-center',
                isToday ? 'text-ink' : 'text-text-2',
              )}
            >
              <div className="truncate text-[12px] font-medium uppercase">
                {d.toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
              <div
                className={cn(
                  'mx-auto mt-0.5 grid size-7 place-items-center rounded-full text-14 font-semibold tabular-nums',
                  isToday && 'bg-ink text-surface',
                )}
              >
                {d.getDate()}
              </div>
            </div>
          );
        })}
      </div>
      {hasAllDay ? (
        <div className="grid border-b border-line" style={cols}>
          <div className="px-1 py-1 text-[11px] text-text-2">All day</div>
          {days.map((d) => (
            <ul key={d.getTime()} className="min-w-0 space-y-0.5 border-l border-line p-0.5">
              {allDayOn(blocks, d).map((b) => (
                <li key={b.id}>
                  <Block block={b} compact={week} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : null}
      <div
        ref={scroller}
        className="relative max-h-[62vh] overflow-y-auto overscroll-contain"
        // A scrolling region must take focus so the keyboard can scroll it.
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        role="region"
        aria-label="Time grid"
      >
        <div className="grid" style={{ ...cols, height: 24 * HOUR }}>
          <div className="relative" aria-hidden>
            {HOURS.map((h) =>
              h === 0 ? null : (
                <span
                  key={h}
                  className="absolute right-1 -translate-y-1/2 text-[11px] tabular-nums text-text-2"
                  style={{ top: h * HOUR }}
                >
                  {pad(h)}
                </span>
              ),
            )}
          </div>
          {days.map((d) => {
            const placed = layoutDay(blocks, d);
            const label = d.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            });
            const isToday = sameDay(d, today);
            const nowMin = today.getHours() * 60 + today.getMinutes();
            return (
              <div key={d.getTime()} className="relative min-w-0 border-l border-line">
                {HOURS.map((h) => (
                  <div
                    key={h}
                    aria-hidden
                    className="absolute inset-x-0 border-t border-line/70"
                    style={{ top: h * HOUR }}
                  />
                ))}
                {isToday ? (
                  <div
                    aria-hidden
                    className="absolute inset-x-0 z-10 border-t-2 border-sendback"
                    style={{ top: (nowMin / 60) * HOUR }}
                  />
                ) : null}
                <ol aria-label={label} className="contents">
                  {placed.map((p) => (
                    <li
                      key={p.block.id}
                      className="absolute px-px"
                      style={{
                        top: (p.top / 60) * HOUR,
                        height: (p.height / 60) * HOUR,
                        left: `${(p.lane / p.lanes) * 100}%`,
                        width: `${100 / p.lanes}%`,
                      }}
                    >
                      <Block block={p.block} compact={week} tall={p.height >= 45} />
                    </li>
                  ))}
                </ol>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Block({ block, compact, tall }: { block: CalBlock; compact: boolean; tall?: boolean }) {
  const busy = block.kind === 'busy';
  return (
    <div
      aria-label={blockLabel(block)}
      role="group"
      title={blockLabel(block)}
      data-kind={block.kind}
      className={cn(
        'h-full min-h-5 overflow-hidden rounded-[6px] border px-1.5 py-0.5 text-left leading-tight',
        busy
          ? 'cal-busy border-line-strong text-text-2'
          : 'border-agent/40 border-l-[3px] border-l-agent bg-agent-soft text-ink',
      )}
    >
      <div
        className={cn('truncate font-medium', compact ? 'text-[11px] sm:text-[12px]' : 'text-13')}
      >
        {busy ? 'Busy' : block.title || '(no title)'}
      </div>
      {tall || !compact ? (
        <div className={cn('truncate text-text-2', compact ? 'text-[11px]' : 'text-[12px]')}>
          {timeRange(block)}
          {block.label && !compact ? ` · ${block.label}` : ''}
        </div>
      ) : null}
    </div>
  );
}
