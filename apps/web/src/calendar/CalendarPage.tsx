import { approveOutcome, memberProfileSchema, type ActionPlan } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, ChevronLeft, ChevronRight, Flag, Sparkles } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react';
import { useReady } from '../auth/context';
import { useLiveCollection } from '../lib/live';
import { stash } from '../lib/pendingDecisions';
import { orgColor } from '../orgs/color';
import { useOrgs } from '../orgs/data';
import { PageHeader } from '../pages/Chrome';
import { errorText } from '../threads/parts';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { Segmented } from '../ui/form';
import { OrgChips } from '../orgs/OrgChips';
import { Icon } from '../ui/icon';
import { useCountdown, useToast } from '../ui/overlay';
import { UndoButton } from '../ui/UndoButton';
import { useCalendarBlocks, type Scope } from './data';
import { proposedBlocks, useCalendarInbox, type Deadline, type Proposed } from './inbox';
import {
  allDayOn,
  blockLabel,
  freeInWorkHours,
  hoursText,
  layoutDay,
  rangeOf,
  rangeTitle,
  sameDay,
  shift,
  startOfWeek,
  timeRange,
  weekTotals,
  WORK_HOURS,
  type CalBlock,
  type CalView,
} from './logic';

/** Pixels per hour in the time grid. */
const HOUR = 56;
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const CONFIRM_KEY = 'calendar:confirm-bookings';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const PHONE = '(max-width: 639px)';
function subscribePhone(cb: () => void) {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function usePhone(): boolean {
  return useSyncExternalStore(
    subscribePhone,
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

/** "This week", "Next week", "Last week" or "Week of 26 Oct"; "Today" or the day. */
function rangeName(view: CalView, anchor: Date, today: Date): string {
  if (view === 'day')
    return sameDay(anchor, today)
      ? 'Today'
      : anchor.toLocaleDateString('en-GB', { weekday: 'long' });
  const weeks = Math.round(
    (startOfWeek(anchor).getTime() - startOfWeek(today).getTime()) / (7 * 86_400_000),
  );
  if (weeks === 0) return 'This week';
  if (weeks === 1) return 'Next week';
  if (weeks === -1) return 'Last week';
  return `Week of ${startOfWeek(anchor).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

/**
 * Calendar (Inbox item w9SAf; redesigned in item kt3E7u9EliL3q2veDDI0, design 2.6 and 2.7): day
 * and week, for one organization (its events, plus my busy time elsewhere, greyed) or across all
 * my calendars (my events everywhere, with details). Events wear their organization's colour;
 * in "All my calendars" the free time in working hours is shaded and totalled, bookings agents
 * proposed show dashed with a banner to review or confirm them, and a due strip carries the
 * Inbox's deadlines. Under 640 px it is a week strip and a readable agenda.
 */
export function CalendarPage() {
  const { session } = useReady();
  const uid = session.me.uid;
  const navigate = useNavigate();
  const phone = usePhone();
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  // The organization chips (item icVly): one organization's view, kept in the URL.
  const search = useSearch({ from: '/calendar' });
  const scope: Scope = search.org && orgs.some((o) => o.id === search.org) ? search.org : 'all';
  const setScope = (wid: string | null) =>
    void navigate({ to: '/calendar', search: wid ? { org: wid } : {}, replace: true });
  const [view, setView] = useState<CalView>(() =>
    typeof window !== 'undefined' && window.matchMedia?.(PHONE).matches ? 'day' : 'week',
  );
  const [anchor, setAnchor] = useState(() => new Date());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  // A phone loads the whole week (its strip shows dots) and shows one day.
  const loadView: CalView = phone ? 'week' : view;
  const { from, to, days } = useMemo(() => rangeOf(loadView, anchor), [loadView, anchor]);

  const orgRows = useMemo(() => orgs.map((o) => ({ id: o.id, name: o.name })), [orgs]);
  const colorOrgs = useMemo(() => orgs.map((o) => ({ wid: o.id, name: o.name })), [orgs]);
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
  const inbox = useCalendarInbox(uid, now);

  const mine = scope === 'all';
  const inScope = (wid: string) => mine || wid === scope;
  const proposed = inbox.proposed.filter((p) => inScope(p.wid) && p.end > from && p.start < to);
  const due = inbox.due.filter((d) => inScope(d.wid) && d.due >= from && d.due < to);
  const orgName = (wid: string) => orgs.find((o) => o.id === wid)?.name ?? '';
  const blocks = useMemo(() => {
    const colored = cal.blocks.map((b) => {
      const wid = b.kind === 'busy' ? null : b.id.split('/')[0]!;
      return wid ? { ...b, color: orgColor(scope === 'all' ? wid : scope, colorOrgs) } : b;
    });
    return [...colored, ...proposedBlocks(proposed, orgName)];
    // proposed and orgName follow inbox and orgs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal.blocks, scope, colorOrgs, inbox.proposed, from, to]);
  const real = blocks.filter((b) => b.kind !== 'proposed');

  const today = new Date(now);
  const shownDays = phone ? [anchor] : days;
  const totals = weekTotals(real, shownDays);
  const subtitle = [
    rangeName(phone ? 'day' : view, anchor, today),
    rangeTitle(phone ? 'day' : view, anchor),
    ...(mine
      ? [
          ...(phone ? [] : [`${hoursText(totals.bookedMinutes)} booked`]),
          `${hoursText(totals.freeMinutes)} free in working hours`,
        ]
      : []),
  ].join(' · ');
  const empty = cal.state === 'ready' && blocks.length === 0;

  const openProposal = (p: { wid: string; tid: string }) =>
    void navigate({
      to: '/inbox/$wid/t/$tid',
      params: { wid: p.wid, tid: p.tid },
      search: { from: 'calendar' },
    });

  return (
    <div className="mx-auto w-full max-w-6xl">
      <PageHeader title="Calendar" subtitle={subtitle} allOrgs={mine && orgs.length > 1} />
      <OrgChips
        className="mb-3"
        orgs={colorOrgs}
        value={mine ? null : scope}
        onChange={setScope}
        hint="Tap an organization to see its calendar; others show as busy"
      />
      <div className="mb-4 flex flex-wrap items-end gap-2">
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
            label={view === 'day' || phone ? 'Previous day' : 'Previous week'}
            onClick={() => setAnchor((a) => shift(phone ? 'day' : view, a, -1))}
          >
            <Icon icon={ChevronLeft} />
          </IconButton>
          <Button variant="secondary" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
          <IconButton
            label={view === 'day' || phone ? 'Next day' : 'Next week'}
            onClick={() => setAnchor((a) => shift(phone ? 'day' : view, a, 1))}
          >
            <Icon icon={ChevronRight} />
          </IconButton>
        </div>
      </div>

      {proposed.length ? (
        <ProposalsBanner proposed={proposed} onReview={() => openProposal(proposed[0]!)} />
      ) : null}

      {cal.state === 'error' ? (
        <p role="alert" className="mb-3 text-14 text-sendback">
          This calendar could not be loaded. Check your connection and try again.
        </p>
      ) : null}
      <p aria-live="polite" className={cn('mb-3 text-14 text-text-2', !empty && 'sr-only')}>
        {empty
          ? mine
            ? 'Nothing in your calendars here. Your agents add events from the calendars they sync.'
            : 'Nothing in this calendar here. Its agents add events from the calendars they sync.'
          : cal.state === 'loading'
            ? 'Loading the calendar'
            : `${real.length} event${real.length === 1 ? '' : 's'} shown`}
      </p>

      {phone ? (
        <>
          <WeekStrip
            anchor={anchor}
            today={today}
            blocks={blocks}
            due={due}
            onPick={(d) => setAnchor(d)}
          />
          <Agenda
            day={anchor}
            blocks={blocks}
            due={due}
            showFree={mine}
            onProposal={openProposal}
          />
        </>
      ) : (
        <Grid
          days={days}
          blocks={blocks}
          today={today}
          view={view}
          due={due}
          forYou={inbox.forYou}
          showFree={mine}
          onProposal={openProposal}
        />
      )}
      <Legend orgs={mine ? colorOrgs : colorOrgs.filter((o) => o.wid === scope)} all={colorOrgs} />
    </div>
  );
}

/** Org dots, Busy, Proposed, Free (design 2.6). */
function Legend({
  orgs,
  all,
}: {
  orgs: ReadonlyArray<{ wid: string; name: string }>;
  all: ReadonlyArray<{ wid: string; name: string }>;
}) {
  return (
    <ul
      aria-label="Legend"
      className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-13 text-text-2"
    >
      {orgs.map((o) => (
        <li key={o.wid} data-legend-org={o.wid} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-full"
            style={{ background: orgColor(o.wid, all) }}
          />
          {o.name}
        </li>
      ))}
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="cal-busy inline-block size-3 rounded-sm border border-line-strong"
        />
        Busy (no details)
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="inline-block size-3 rounded-sm border border-dashed border-gate bg-gate-bg"
        />
        Proposed
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="cal-free inline-block size-3 rounded-sm border border-approve/40"
        />
        Free
      </li>
    </ul>
  );
}

/**
 * "2 bookings proposed by your agents. Dashed in the grid." Review opens the first one in
 * briefing mode; Confirm approves every one of them, with Undo on the button (they send).
 */
function ProposalsBanner({ proposed, onReview }: { proposed: Proposed[]; onReview: () => void }) {
  const { session, actionContext, run } = useReady();
  const toast = useToast();
  const counting = useCountdown(CONFIRM_KEY);
  const [error, setError] = useState<string | null>(null);
  const n = proposed.length;

  function confirmAll() {
    if (counting) return;
    setError(null);
    const plans: { wid: string; plan: Pick<ActionPlan, 'ops'> }[] = [];
    try {
      for (const p of proposed) {
        const ctx = actionContext(p.wid);
        if (!ctx || !p.thread) continue;
        plans.push({
          wid: p.wid,
          plan: approveOutcome(ctx, {
            outcomeId: p.oid,
            outcome: p.outcome.data,
            thread: { ...p.thread.data },
          }),
        });
      }
    } catch (e) {
      setError(errorText(e));
      return;
    }
    const forgets = [...new Set(plans.map((p) => p.wid))].map((w) =>
      stash(
        session.me.uid,
        w,
        plans.filter((p) => p.wid === w).map((p) => p.plan.ops),
        `Saved: ${plans.length} bookings confirmed`,
      ),
    );
    const forget = () => forgets.forEach((f) => f());
    toast.push({
      message: `Confirmed ${plans.length}`,
      duration: 5000,
      countdown: {
        key: CONFIRM_KEY,
        tag: 'approve',
        announce: `${plans.length} ${plans.length === 1 ? 'booking' : 'bookings'} confirmed. Undo available for 5 seconds`,
      },
      onUndo: forget,
      onCommit: () => {
        void (async () => {
          try {
            for (const p of plans) await run(p.plan);
          } catch (e) {
            setError(errorText(e));
          } finally {
            forget();
          }
        })();
      },
    });
  }

  return (
    <section
      aria-label="Proposed bookings"
      data-proposals-banner=""
      className="mb-4 flex flex-col gap-3 rounded-card border border-gate/50 bg-gate-bg p-3.5 sm:flex-row sm:items-center"
    >
      <p className="flex min-w-0 flex-1 items-start gap-2.5 text-14 text-ink">
        <Icon icon={Sparkles} size={16} className="mt-0.5 shrink-0 text-gate-text" />
        <span>
          <strong className="font-semibold">
            {n} {n === 1 ? 'booking' : 'bookings'} proposed
          </strong>{' '}
          by your agents. Dashed in the calendar.
        </span>
      </p>
      <div className="flex shrink-0 flex-col gap-1 sm:items-end">
        <div className="flex gap-2 max-sm:[&>*]:flex-1">
          <Button variant="secondary" onClick={onReview}>
            Review
          </Button>
          {counting ? (
            <UndoButton countdown={counting} variant="approve" />
          ) : (
            <Button
              variant="approve"
              onClick={confirmAll}
              leading={<Icon icon={Check} size={16} />}
            >
              {n === 1 ? 'Confirm' : n === 2 ? 'Confirm both' : `Confirm all ${n}`}
            </Button>
          )}
        </div>
        <span className="text-12 text-text-2">
          Sends {n} {n === 1 ? 'reply' : 'replies'} and books {n} {n === 1 ? 'meeting' : 'meetings'}
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-14 text-sendback">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/** Deadlines of a day: "⚑ Price list due 12:00". */
function dueOn(due: readonly Deadline[], day: Date) {
  return due.filter((d) => sameDay(d.due, day));
}

function DueChip({ d }: { d: Deadline }) {
  return (
    <Link
      to="/inbox/$wid/t/$tid"
      params={{ wid: d.wid, tid: d.tid }}
      title={`${d.title} due ${hhmm(d.due)}`}
      data-due-chip=""
      className={cn(
        'flex min-h-6 min-w-0 items-center gap-1 rounded-btn border px-1.5 text-[12px] font-semibold foc:outline-2 foc:outline-focus',
        d.band === 1
          ? 'border-sendback-border bg-sendback-bg text-sendback'
          : 'border-gate/50 bg-gate-bg text-gate-text',
      )}
    >
      <Icon icon={Flag} size={11} className="shrink-0" />
      <span className="truncate">
        {d.title} due {hhmm(d.due)}
      </span>
    </Link>
  );
}

function Grid({
  days,
  blocks,
  today,
  view,
  due,
  forYou,
  showFree,
  onProposal,
}: {
  days: Date[];
  blocks: CalBlock[];
  today: Date;
  view: CalView;
  due: Deadline[];
  forYou: number;
  showFree: boolean;
  onProposal: (p: { wid: string; tid: string }) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Open at 07:00: most of a working day in view without scrolling.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 7 * HOUR - 12;
  }, []);
  const hasAllDay = days.some((d) => allDayOn(blocks, d).length > 0);
  const hasStrip = due.length > 0 || (forYou > 0 && days.some((d) => sameDay(d, today)));
  const week = view === 'week';
  const cols = { gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` };
  const real = blocks.filter((b) => b.kind !== 'proposed');
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="grid border-b border-line" style={cols} aria-hidden>
        <div />
        {days.map((d) => {
          const isToday = sameDay(d, today);
          const free = showFree
            ? freeInWorkHours(real, d).reduce(
                (n, s) => n + (s.end.getTime() - s.start.getTime()),
                0,
              )
            : 0;
          return (
            <div
              key={d.getTime()}
              className={cn(
                'min-w-0 border-l border-line px-2 py-2',
                isToday ? 'text-ink' : 'text-text-2',
              )}
            >
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className="text-[12px] font-medium uppercase">
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
                <span
                  className={cn(
                    'grid size-7 place-items-center rounded-full text-14 font-semibold tabular-nums',
                    isToday && 'bg-ink text-surface',
                  )}
                >
                  {d.getDate()}
                </span>
                {showFree && free > 0 ? (
                  <span className="basis-full truncate text-[11px] text-text-3">
                    {hoursText(Math.round(free / 60_000))} free
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {hasStrip ? (
        <div className="grid border-b border-line bg-surface-2" style={cols} data-due-strip="">
          <div className="px-1 py-1.5 font-mono text-[11px] uppercase text-text-3">Due</div>
          {days.map((d) => (
            <ul key={d.getTime()} className="min-w-0 space-y-1 border-l border-line p-1">
              {sameDay(d, today) && forYou > 0 ? (
                <li>
                  <Link
                    to="/"
                    className="flex min-h-6 items-center rounded-btn border border-gate/50 bg-gate-bg px-1.5 text-[12px] font-semibold text-gate-text foc:outline-2 foc:outline-focus"
                  >
                    {forYou} for you
                  </Link>
                </li>
              ) : null}
              {dueOn(due, d).map((x) => (
                <li key={x.tid}>
                  <DueChip d={x} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : null}
      {hasAllDay ? (
        <div className="grid border-b border-line" style={cols}>
          <div className="px-1 py-1 text-[11px] text-text-2">All day</div>
          {days.map((d) => (
            <ul key={d.getTime()} className="min-w-0 space-y-0.5 border-l border-line p-0.5">
              {allDayOn(blocks, d).map((b) => (
                <li key={b.id}>
                  <Block block={b} compact={week} onProposal={onProposal} />
                </li>
              ))}
            </ul>
          ))}
        </div>
      ) : null}
      <div
        ref={scroller}
        className="relative max-h-[64vh] overflow-y-auto overscroll-contain"
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
                  className="absolute right-1.5 -translate-y-1/2 text-[11px] tabular-nums text-text-2"
                  style={{ top: h * HOUR }}
                >
                  {pad(h)}:00
                </span>
              ),
            )}
          </div>
          {days.map((d) => {
            const placed = layoutDay(blocks, d);
            const free = showFree ? freeInWorkHours(real, d) : [];
            const freeMin = free.reduce((n, s) => n + (s.end.getTime() - s.start.getTime()), 0);
            const label = `${d.toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}${showFree && freeMin ? `, ${hoursText(Math.round(freeMin / 60_000))} free` : ''}`;
            const isToday = sameDay(d, today);
            const nowMin = today.getHours() * 60 + today.getMinutes();
            const dayStart = new Date(d).setHours(0, 0, 0, 0);
            return (
              <div key={d.getTime()} className="relative min-w-0 border-l border-line">
                {HOURS.map((h) => (
                  <div
                    key={h}
                    aria-hidden
                    className={cn(
                      'absolute inset-x-0 border-t border-line/70',
                      (h < WORK_HOURS.start || h >= WORK_HOURS.end) && 'bg-canvas/50',
                    )}
                    style={{ top: h * HOUR, height: HOUR }}
                  />
                ))}
                {free.map((f) => {
                  const top = ((f.start.getTime() - dayStart) / 3_600_000) * HOUR;
                  const height = ((f.end.getTime() - f.start.getTime()) / 3_600_000) * HOUR;
                  const mins = Math.round((f.end.getTime() - f.start.getTime()) / 60_000);
                  return (
                    <div
                      key={f.start.getTime()}
                      aria-hidden
                      data-free=""
                      className="cal-free absolute inset-x-0.5 rounded-[6px]"
                      style={{ top, height }}
                    >
                      {mins >= 60 ? (
                        <span className="absolute left-1.5 top-1 text-[11px] font-semibold text-approve-text">
                          {hoursText(mins)} free
                        </span>
                      ) : null}
                    </div>
                  );
                })}
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
                      className="absolute z-[1] px-0.5"
                      style={{
                        top: (p.top / 60) * HOUR,
                        height: (p.height / 60) * HOUR,
                        left: `${(p.lane / p.lanes) * 100}%`,
                        width: `${100 / p.lanes}%`,
                      }}
                    >
                      <Block
                        block={p.block}
                        compact={week}
                        tall={p.height >= 50}
                        onProposal={onProposal}
                      />
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

const tint = (color?: string): CSSProperties | undefined =>
  color ? ({ '--org': color } as CSSProperties) : undefined;

function Block({
  block,
  compact,
  tall,
  onProposal,
}: {
  block: CalBlock;
  compact: boolean;
  tall?: boolean;
  onProposal: (p: { wid: string; tid: string }) => void;
}) {
  const busy = block.kind === 'busy';
  const proposed = block.kind === 'proposed';
  const cls = cn(
    'block h-full min-h-5 w-full overflow-hidden rounded-[6px] border px-1.5 text-left',
    tall ? 'py-0.5 leading-tight' : 'py-px',
    busy
      ? 'cal-busy border-line-strong text-text-2'
      : proposed
        ? 'border-2 border-dashed border-gate bg-gate-bg text-ink hov:brightness-[0.98] foc:outline-2 foc:outline-offset-1 foc:outline-focus'
        : 'cal-event border-l-[3px] text-ink',
  );
  const body = (
    <>
      <span
        className={cn(
          'block line-clamp-2 font-medium [overflow-wrap:anywhere]',
          // Two lines, never cut to one word (design 2.6); short blocks use a tighter line.
          tall ? (compact ? 'text-[12px]' : 'text-13') : 'text-[11px] leading-[12px]',
        )}
      >
        {busy ? 'Busy' : block.title || (proposed ? 'Meeting' : '(no title)')}
      </span>
      {tall || !compact ? (
        <span className={cn('block truncate text-text-2', compact ? 'text-[11px]' : 'text-[12px]')}>
          {proposed ? 'proposed · ' : ''}
          {timeRange(block)}
          {block.label && !compact ? ` · ${block.label}` : ''}
        </span>
      ) : null}
    </>
  );
  return proposed && block.proposal ? (
    <button
      type="button"
      aria-label={blockLabel(block)}
      title={blockLabel(block)}
      data-kind={block.kind}
      className={cls}
      onClick={() => onProposal(block.proposal!)}
    >
      {body}
    </button>
  ) : (
    <div
      aria-label={blockLabel(block)}
      role="group"
      title={blockLabel(block)}
      data-kind={block.kind}
      className={cls}
      style={tint(block.color)}
    >
      {body}
    </div>
  );
}

/** The phone's week: 7 date buttons, a dot on days with events, proposals or deadlines. */
function WeekStrip({
  anchor,
  today,
  blocks,
  due,
  onPick,
}: {
  anchor: Date;
  today: Date;
  blocks: CalBlock[];
  due: Deadline[];
  onPick: (d: Date) => void;
}) {
  const { days } = rangeOf('week', anchor);
  return (
    <div role="group" aria-label="Week" className="mb-3 grid grid-cols-7 gap-1" data-week-strip="">
      {days.map((d) => {
        const on = sameDay(d, anchor);
        const busy = blocks.some((b) => sameDay(b.start, d)) || due.some((x) => sameDay(x.due, d));
        const proposal = blocks.some((b) => b.kind === 'proposed' && sameDay(b.start, d));
        const events = blocks.filter((b) => b.kind !== 'proposed' && sameDay(b.start, d)).length;
        const proposed = blocks.filter((b) => b.kind === 'proposed' && sameDay(b.start, d)).length;
        // Starts with the visible text ("M 15") so voice control and axe's
        // label-content-name-mismatch agree with what is on screen.
        const label = [
          `${d.toLocaleDateString('en-GB', { weekday: 'narrow' })} ${d.getDate()}`,
          d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
          events ? `${events} ${events === 1 ? 'event' : 'events'}` : '',
          proposed ? `${proposed} proposed` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return (
          <button
            key={d.getTime()}
            type="button"
            aria-pressed={on}
            aria-label={label}
            onClick={() => onPick(d)}
            className={cn(
              'flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-btn text-ink transition-colors foc:outline-2 foc:outline-focus',
              on ? 'bg-ink text-surface' : 'hov:bg-canvas',
            )}
          >
            <span className={cn('text-[12px]', on ? 'text-surface' : 'text-text-2')}>
              {d.toLocaleDateString('en-GB', { weekday: 'narrow' })}
            </span>{' '}
            <span
              className={cn(
                'text-16 font-semibold tabular-nums',
                sameDay(d, today) && !on && 'text-agent',
              )}
            >
              {d.getDate()}
            </span>
            <span
              aria-hidden
              className={cn(
                'size-1.5 rounded-full',
                proposal ? 'bg-gate' : busy ? (on ? 'bg-surface' : 'bg-text-3') : 'bg-transparent',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** The phone's day: full-width rows (time, title, organization) with the free gaps between. */
function Agenda({
  day,
  blocks,
  due,
  showFree,
  onProposal,
}: {
  day: Date;
  blocks: CalBlock[];
  due: Deadline[];
  showFree: boolean;
  onProposal: (p: { wid: string; tid: string }) => void;
}) {
  const allDay = allDayOn(blocks, day);
  const timed = blocks
    .filter(
      (b) =>
        !b.allDay &&
        b.start < new Date(new Date(day).setHours(24)) &&
        b.end > new Date(new Date(day).setHours(0, 0, 0, 0)),
    )
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const real = timed.filter((b) => b.kind !== 'proposed');
  const free = showFree ? freeInWorkHours(real, day) : [];
  type Row = { kind: 'block'; b: CalBlock } | { kind: 'free'; start: Date; end: Date };
  const rows: Row[] = [
    ...timed.map((b) => ({ kind: 'block' as const, b })),
    ...free.map((f) => ({ kind: 'free' as const, ...f })),
  ].sort(
    (a, b) =>
      (a.kind === 'block' ? a.b.start : a.start).getTime() -
      (b.kind === 'block' ? b.b.start : b.start).getTime(),
  );
  const deadlines = dueOn(due, day);
  return (
    <div role="region" aria-label="Agenda" data-agenda="" className="flex flex-col gap-2">
      {deadlines.length ? (
        <ul className="flex flex-col gap-1" data-due-strip="">
          {deadlines.map((d) => (
            <li key={d.tid}>
              <DueChip d={d} />
            </li>
          ))}
        </ul>
      ) : null}
      {allDay.map((b) => (
        <AgendaRow key={b.id} b={b} onProposal={onProposal} />
      ))}
      {rows.length === 0 && allDay.length === 0 ? (
        <p className="py-6 text-center text-14 text-text-2">Nothing on this day.</p>
      ) : null}
      {rows.map((r) =>
        r.kind === 'block' ? (
          <AgendaRow key={r.b.id} b={r.b} onProposal={onProposal} />
        ) : (
          <p
            key={`free-${r.start.getTime()}`}
            data-free=""
            className="cal-free ml-[4.25rem] rounded-btn px-2.5 py-1 text-12 font-medium text-approve-text"
          >
            {hhmm(r.start)}–{hhmm(r.end)} ·{' '}
            {hoursText(Math.round((r.end.getTime() - r.start.getTime()) / 60_000))} free
          </p>
        ),
      )}
    </div>
  );
}

function AgendaRow({
  b,
  onProposal,
}: {
  b: CalBlock;
  onProposal: (p: { wid: string; tid: string }) => void;
}) {
  const busy = b.kind === 'busy';
  const proposed = b.kind === 'proposed';
  const inner = (
    <>
      <span className="block text-14 font-semibold [overflow-wrap:anywhere]">
        {busy ? 'Busy' : proposed ? `${b.title} · proposed` : b.title || '(no title)'}
      </span>
      <span className="block text-12 text-text-2">
        {proposed ? 'Proposed by your agent · tap to review' : b.label || timeRange(b)}
      </span>
    </>
  );
  const cls = cn(
    'min-w-0 flex-1 rounded-btn border px-3 py-2 text-left',
    busy
      ? 'cal-busy border-line-strong text-text-2'
      : proposed
        ? 'border-2 border-dashed border-gate bg-gate-bg text-ink foc:outline-2 foc:outline-focus'
        : 'cal-event border-l-[3px] text-ink',
  );
  return (
    <div className="flex items-stretch gap-3">
      <span className="w-14 shrink-0 pt-2 text-right text-13 tabular-nums">
        <span className="block font-semibold text-ink">{b.allDay ? 'All day' : hhmm(b.start)}</span>
        {b.allDay ? null : <span className="block text-text-2">{hhmm(b.end)}</span>}
      </span>
      {proposed && b.proposal ? (
        <button
          type="button"
          aria-label={blockLabel(b)}
          data-kind={b.kind}
          className={cls}
          onClick={() => onProposal(b.proposal!)}
        >
          {inner}
        </button>
      ) : (
        <div
          role="group"
          aria-label={blockLabel(b)}
          data-kind={b.kind}
          className={cls}
          style={tint(b.color)}
        >
          {inner}
        </div>
      )}
    </div>
  );
}
