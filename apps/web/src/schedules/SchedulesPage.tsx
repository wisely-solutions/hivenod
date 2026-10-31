/**
 * Scheduled tasks, slice 6: the Schedules page (design ~/drafts/schedules/design.md 9.1,
 * schedules-desktop.png, schedules-phone.png). Across every organization the member is in:
 *   - the runs that could not happen (Run now · Try later · Skip) and the scheduler-offline banner;
 *   - a week / month timeline: stored runs with their result, planned ones computed from the rules
 *     (phone: an agenda of the days with runs);
 *   - the list of schedules (what, agent, rule, plan, next and last run);
 *   - the detail (a right column from 1024 px, the page itself on a phone): when, agent, each run,
 *     plan, if it can't run, next runs, past runs with their threads; Edit, Run now, Pause/Resume,
 *     Delete.
 * New schedule asks an agent (a thread "Set up a schedule: …"; the agent proposes it).
 */
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  createMemberThread,
  deleteSchedule,
  fillPlaceholders,
  inboxPaths,
  inboxSubjectSchema,
  agentsOffSchema,
  localDate,
  endSchedule,
  pauseSchedule,
  resumeSchedule,
  ruleSentence,
  type ActionPlan,
  type Schedule,
} from '@hive/shared';
import {
  ArrowLeft,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Plus,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useReady } from '../auth/context';
import { useIsPhone } from '../components/ResponsiveModal';
import { ResponsiveModal } from '../components/ResponsiveModal';
import { useLiveDoc } from '../lib/live';
import { useNeedsAll } from '../needs/data';
import { PageHeader } from '../pages/Chrome';
import { errorText } from '../threads/parts';
import { cantRunText, scheduleSteps } from '../threads/schedule';
import { Pill } from '../ui/badge';
import { Button, IconButton } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Segmented, Select, Textarea } from '../ui/form';
import { Icon } from '../ui/icon';
import { ActionMenu } from '../ui/menu';
import { Dialog, useToast } from '../ui/overlay';
import {
  useAgentsAcross,
  useCantRun,
  useMySchedules,
  useRunsSince,
  useScheduleHistory,
  useSchedulerBeat,
} from './data';
import {
  addDays,
  cantRunCards,
  dayHead,
  listRows,
  monthTitle,
  nextN,
  rangeMs,
  runWords,
  schedulerBanner,
  shiftAnchor,
  shortDay,
  timeline,
  viewDays,
  viewerTz,
  weekTitle,
  whenWords,
  type Chip,
  type ListRow,
  type SchedLite,
  type View,
} from './logic';
import {
  AgentTag,
  agentColor,
  CantRunCardView,
  EYEBROW,
  RunPill,
  SchedulerBanner,
  StepPills,
} from './parts';
import { ScheduleEditDialog } from './ScheduleForm';

const DESKTOP = '(min-width: 1024px)';
function subscribe(cb: () => void) {
  const mq = window.matchMedia(DESKTOP);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

/** A minute clock: next runs and "today" move on by themselves. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** `wid~sid` in the address: the schedule whose detail is open. */
const selKey = (wid: string, id: string) => `${wid}~${id}`;

export function SchedulesPage() {
  const search = useSearch({ strict: false }) as { s?: string; view?: string; at?: string };
  const navigate = useNavigate();
  const { session } = useReady();
  const uid = session.me.uid;
  const all = useNeedsAll();
  const wids = useMemo(() => all.orgs.map((o) => o.wid), [all.orgs]);
  const now = useNow();
  const tz = useMemo(() => viewerTz(), []);
  const phone = useIsPhone();
  const desktop = useIsDesktop();
  const today = localDate(now, tz);

  const view: View = search.view === 'month' ? 'month' : 'week';
  const anchor = search.at && /^\d{4}-\d{2}-\d{2}$/.test(search.at) ? search.at : today;
  const days = useMemo(
    () =>
      phone && view === 'week'
        ? Array.from({ length: 7 }, (_, i) => addDays(anchor, i))
        : viewDays(view, anchor),
    [phone, view, anchor],
  );
  // The runs listener covers the shown range and the last 35 days (the list's last runs); it
  // changes only when the range starts earlier than that.
  const floor = rangeMs(addDays(today, -35), today, tz).fromMs;
  const rangeFrom = rangeMs(days[0]!, days[0]!, tz).fromMs;
  const since = Math.min(floor, rangeFrom);

  const schedules = useMySchedules(uid, wids);
  const runs = useRunsSince(uid, wids, since);
  const cant = useCantRun(uid, wids);
  const beat = useSchedulerBeat();
  const agents = useAgentsAcross(uid, wids);
  const off = useLiveDoc(`workspaces/${session.workspaceId}/agentsOff/${uid}`, agentsOffSchema);
  const agentName = (wid: string, a: string) => agents.get(`${wid}/${a}`)?.name ?? 'Agent';

  const loading = schedules.state === 'loading';
  const chips = useMemo(
    () => timeline(schedules.list, runs.list, days, now, tz),
    [schedules.list, runs.list, days, now, tz],
  );
  const rows = useMemo(
    () => listRows(schedules.list, runs.list, now, tz),
    [schedules.list, runs.list, now, tz],
  );
  const cards = useMemo(
    () => cantRunCards(cant.list, schedules.list, now, tz),
    [cant.list, schedules.list, now, tz],
  );
  const banner = beat === undefined ? null : schedulerBanner(beat, schedules.list, now, tz);
  const offNow = off.state === 'ready' && off.data && (off.data.all || off.data.agents.length > 0);

  const selected = search.s
    ? (rows.find((r) => selKey(r.s.wid, r.s.id) === search.s) ?? null)
    : null;
  const go = (patch: Partial<{ s: string | null; view: View; at: string | null }>) =>
    void navigate({
      to: '/schedules',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const k of Object.keys(next))
          if (next[k] === null || next[k] === undefined) delete next[k];
        if (next.view === 'week') delete next.view;
        return next as never;
      },
      replace: patch.s === undefined,
    });
  const open = (wid: string, sid: string) => go({ s: selKey(wid, sid) });

  const [asking, setAsking] = useState(false);

  // The phone shows the detail as the page itself.
  if (phone && search.s) {
    return (
      <div>
        <button
          type="button"
          onClick={() => go({ s: null })}
          className="mb-3 inline-flex min-h-11 items-center gap-1.5 text-14 font-medium text-agent foc:outline-2 foc:outline-focus"
        >
          <Icon icon={ArrowLeft} size={16} />
          Schedules
        </button>
        {selected ? (
          <Detail
            row={selected}
            doc={schedules.docs.get(`${selected.s.wid}/${selected.s.id}`) ?? null}
            uid={uid}
            now={now}
            tz={tz}
            agentName={agentName}
            onGone={() => go({ s: null })}
            asPage
          />
        ) : loading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <EmptyState
            icon={CalendarClock}
            title="This schedule is gone."
            description="It was deleted, or it is not yours."
          />
        )}
      </div>
    );
  }

  const header = (
    <PageHeader
      title="Schedules"
      allOrgs={all.orgs.length > 1}
      subtitle={all.orgs.length > 1 ? 'Your schedules in every organization' : undefined}
      action={
        <div className="flex shrink-0 items-center gap-2">
          {offNow ? (
            <Pill tone="gate" data-testid="agents-off-pill">
              Agents off
            </Pill>
          ) : null}
          <Button
            variant="primary"
            data-new-schedule=""
            onClick={() => setAsking(true)}
            leading={<Icon icon={Plus} size={16} />}
          >
            {phone ? 'New' : 'New schedule'}
          </Button>
        </div>
      }
    />
  );

  const detailOpen = desktop && !!selected;
  return (
    <>
      {header}
      <SchedulerBanner text={banner} />
      {cards.length ? (
        <div className="mb-4 flex flex-col gap-3" aria-label="Runs that didn’t happen" role="group">
          {cards.map((c) => (
            <CantRunCardView key={c.key} card={c} uid={uid} now={now} tz={tz} compact={phone} />
          ))}
        </div>
      ) : null}
      <div
        className={cn(
          detailOpen && 'lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-5',
        )}
      >
        <div className="flex min-w-0 flex-col gap-4">
          <Timeline
            view={view}
            anchor={anchor}
            today={today}
            days={days}
            chips={chips}
            phone={phone}
            loading={loading}
            agentName={agentName}
            onView={(v) => go({ view: v, at: null })}
            onAnchor={(a) => go({ at: a === today ? null : a })}
            onChip={(c) => open(c.wid, c.scheduleId)}
          />
          {loading ? (
            <Skeleton className="h-48 w-full" />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="No schedules yet."
              description="Ask an agent to set one up: “every 1st at 9, prepare the invoices and ask me before sending”."
            />
          ) : (
            <ScheduleList
              rows={rows}
              phone={phone}
              selected={selected?.key ?? null}
              agentName={agentName}
              onOpen={(r) => open(r.s.wid, r.s.id)}
              docs={schedules.docs}
              uid={uid}
              now={now}
            />
          )}
        </div>
        {detailOpen && selected ? (
          <aside
            aria-label={`Schedule: ${selected.s.title}`}
            className="mt-4 rounded-panel border border-line bg-surface p-4 shadow-e1 lg:sticky lg:top-20 lg:mt-0"
          >
            <div className="-mr-2 -mt-2 flex justify-end">
              <IconButton label="Close the schedule" onClick={() => go({ s: null })}>
                <Icon icon={X} size={18} />
              </IconButton>
            </div>
            <Detail
              row={selected}
              doc={schedules.docs.get(`${selected.s.wid}/${selected.s.id}`) ?? null}
              uid={uid}
              now={now}
              tz={tz}
              agentName={agentName}
              onGone={() => go({ s: null })}
            />
          </aside>
        ) : null}
      </div>
      <AskAgentDialog
        open={asking}
        onOpenChange={setAsking}
        orgs={all.orgs}
        agents={agents}
        defaultWid={session.workspaceId}
      />
    </>
  );
}

// ---------- timeline ----------

function ChipView({
  c,
  agentName,
  onOpen,
  dense,
}: {
  c: Chip;
  agentName: (wid: string, a: string) => string;
  onOpen: () => void;
  dense?: boolean;
}) {
  const w = runWords(c.state);
  const planned = c.state === 'planned';
  const label = `${c.title}, ${c.time}, ${planned ? 'planned' : w.word}${c.agentUid ? `, ${agentName(c.wid, c.agentUid)}` : ''}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      data-chip={c.state}
      className={cn(
        'block w-full min-w-0 rounded-[8px] border border-l-[3px] text-left foc:outline-2 foc:outline-focus hov:bg-canvas',
        dense ? 'px-1.5 py-1' : 'px-2 py-1.5',
        planned ? 'border-dashed border-line-strong bg-surface' : 'border-line bg-surface',
        c.state === 'cantRun' && 'border-sendback-border bg-sendback-bg',
      )}
      style={{ borderLeftColor: agentColor(c.agentUid), borderLeftStyle: 'solid' }}
    >
      <span className={cn('block truncate font-semibold text-ink', dense ? 'text-12' : 'text-13')}>
        {c.title}
      </span>
      {dense ? null : (
        <span className="block truncate text-12 text-text-2">
          {c.time}
          {planned && c.freq ? ` · ${c.freq}` : ''}
        </span>
      )}
      {!planned && !dense ? (
        <span className="mt-0.5 block">
          <RunPill state={c.state} />
        </span>
      ) : null}
    </button>
  );
}

function Timeline(p: {
  view: View;
  anchor: string;
  today: string;
  days: string[];
  chips: Map<string, Chip[]>;
  phone: boolean;
  loading: boolean;
  agentName: (wid: string, a: string) => string;
  onView: (v: View) => void;
  onAnchor: (a: string) => void;
  onChip: (c: Chip) => void;
}) {
  const { view, anchor, today, days, chips, phone } = p;
  const title = view === 'month' ? monthTitle(anchor) : phone ? 'Next 7 days' : weekTitle(days[0]!);
  const back = () => p.onAnchor(shiftAnchor(view, anchor, -1));
  const on = () => p.onAnchor(shiftAnchor(view, anchor, 1));
  const head = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
      <h2 className="mr-auto text-16 font-semibold text-ink" data-timeline-title="">
        {title}
      </h2>
      <div className="flex items-center gap-1">
        <IconButton label={view === 'month' ? 'Previous month' : 'Previous week'} onClick={back}>
          <Icon icon={ChevronLeft} size={18} />
        </IconButton>
        <Button variant="secondary" className="min-h-11 px-3" onClick={() => p.onAnchor(today)}>
          Today
        </Button>
        <IconButton label={view === 'month' ? 'Next month' : 'Next week'} onClick={on}>
          <Icon icon={ChevronRight} size={18} />
        </IconButton>
      </div>
      <Segmented
        label="Timeline"
        value={view}
        onValueChange={(v) => p.onView(v as View)}
        options={[
          { value: 'week', label: phone ? 'Agenda' : 'Week' },
          { value: 'month', label: 'Month' },
        ]}
        className="sm:w-auto"
      />
    </div>
  );

  let body;
  if (phone) {
    // An agenda: the days with runs.
    const withRuns = days.filter((d) => (chips.get(d)?.length ?? 0) > 0);
    body = withRuns.length ? (
      <div className="flex flex-col gap-3 p-3" data-agenda="">
        {withRuns.map((d) => (
          <section key={d} aria-label={dayHead(d, true)}>
            <h3 className={cn(EYEBROW, 'mb-1.5')}>
              {d === today ? `Today · ${dayHead(d, true)}` : dayHead(d, true)}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {chips.get(d)!.map((c) => (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => p.onChip(c)}
                    data-chip={c.state}
                    className="flex w-full min-w-0 items-center gap-3 rounded-card border border-l-[3px] border-line bg-surface px-3 py-2.5 text-left foc:outline-2 foc:outline-focus"
                    style={{ borderLeftColor: agentColor(c.agentUid) }}
                  >
                    <span className="w-12 shrink-0 text-14 font-semibold tabular-nums text-ink">
                      {c.time}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-14 text-ink">{c.title}</span>
                      <span className="block truncate text-12 text-text-2">
                        {c.agentUid ? p.agentName(c.wid, c.agentUid) : ''}
                        {c.freq ? ` · ${c.freq}` : ''}
                      </span>
                    </span>
                    <RunPill state={c.state} className="shrink-0" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    ) : (
      <p className="px-4 py-6 text-14 text-text-2">Nothing scheduled in these days.</p>
    );
  } else if (view === 'week') {
    body = (
      <div className="grid grid-cols-7 divide-x divide-line" data-week="">
        {days.map((d) => (
          <section
            key={d}
            aria-label={dayHead(d, true)}
            className={cn('min-h-40 min-w-0 p-1.5', d === today && 'bg-agent-soft')}
          >
            <h3
              className={cn(
                'mb-1.5 px-0.5 text-13 font-medium',
                d === today ? 'text-agent' : 'text-text-2',
              )}
            >
              {dayHead(d)}
              {d === today ? <span className="block text-12 font-normal">today</span> : null}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {(chips.get(d) ?? []).map((c) => (
                <li key={c.key}>
                  <ChipView c={c} agentName={p.agentName} onOpen={() => p.onChip(c)} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  } else {
    const month = anchor.slice(0, 7);
    body = (
      <div data-month="">
        <div className="grid grid-cols-7 border-b border-line">
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <span key={d} className="px-2 py-1.5 text-12 font-medium text-text-2">
              {d}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 [&>*:nth-child(7n)]:border-r-0">
          {days.map((d) => {
            const list = chips.get(d) ?? [];
            const out = d.slice(0, 7) !== month;
            return (
              <section
                key={d}
                aria-label={dayHead(d, true)}
                className={cn(
                  'min-h-24 min-w-0 border-b border-r border-line p-1',
                  d === today && 'bg-agent-soft',
                )}
              >
                <h3
                  className={cn(
                    'px-0.5 text-12',
                    d === today ? 'font-semibold text-agent' : out ? 'text-text-3' : 'text-text-2',
                  )}
                >
                  {Number(d.slice(8))}
                </h3>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {list.slice(0, 3).map((c) => (
                    <li key={c.key}>
                      <ChipView c={c} dense agentName={p.agentName} onOpen={() => p.onChip(c)} />
                    </li>
                  ))}
                </ul>
                {list.length > 3 ? (
                  <span className="mt-0.5 block px-0.5 text-12 text-text-2">
                    +{list.length - 3}
                  </span>
                ) : null}
              </section>
            );
          })}
        </div>
      </div>
    );
  }
  return (
    <section
      aria-label="Timeline"
      className="overflow-hidden rounded-panel border border-line bg-surface shadow-e1"
    >
      {head}
      {p.loading ? <Skeleton className="m-4 h-32" /> : body}
    </section>
  );
}

// ---------- the list ----------

function useScheduleActions(uid: string) {
  const { actionContext, run } = useReady();
  const toast = useToast();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  async function act(
    wid: string,
    build: (ctx: NonNullable<ReturnType<typeof actionContext>>) => ActionPlan,
    done: string,
  ) {
    const ctx = actionContext(wid);
    if (!ctx) return false;
    setError(null);
    try {
      await run(build(ctx));
      toast.push({ message: done, duration: 3000 });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  return {
    error,
    pause: (s: SchedLite, doc: Schedule) =>
      act(
        s.wid,
        (ctx) => pauseSchedule(ctx, { scheduleId: s.id, schedule: doc }),
        `Paused: ${s.title}`,
      ),
    resume: (s: SchedLite, doc: Schedule) =>
      act(
        s.wid,
        (ctx) => resumeSchedule(ctx, { scheduleId: s.id, schedule: doc }),
        `Resumed: ${s.title}`,
      ),
    end: (s: SchedLite, doc: Schedule) =>
      act(
        s.wid,
        (ctx) => endSchedule(ctx, { scheduleId: s.id, schedule: doc }),
        `Ended: ${s.title}`,
      ),
    remove: (s: SchedLite, doc: Schedule) =>
      act(
        s.wid,
        (ctx) => deleteSchedule(ctx, { scheduleId: s.id, schedule: doc }),
        `Deleted: ${s.title}`,
      ),
    /**
     * Run now, outside the schedule: a thread to its agent with what to do and the plan of each
     * run (the agent proposes it; nothing is sent before the member approves its steps).
     */
    runNow: async (s: SchedLite, agent: string, now: number) => {
      const ctx = actionContext(s.wid);
      if (!ctx) return;
      setError(null);
      const n = nextN(s, now, 1)[0] ?? null;
      const title = (n ? fillPlaceholders(s.runTitle, n) : s.title).slice(0, 180);
      const steps = scheduleSteps(s.steps, n)
        .map((x) => (x.who === 'you' ? `you: ${x.title}` : x.title))
        .join(' → ');
      const text =
        `Run now, outside its schedule: “${s.title}” (${ruleSentence(s.rule, { viewerTz: s.rule.tz })}).\n\n` +
        `${s.what}\n\nThe plan of each run: ${steps}. Propose it as a plan so I approve the steps that need me; the schedule itself does not change.`;
      try {
        const p = createMemberThread(ctx, {
          title: `${title} · run now`,
          text,
          agentUid: s.agentUid,
        });
        await run(p);
        toast.push({ message: `Asked ${agent} to run it now`, duration: 4000 });
        void navigate({ to: '/inbox/$wid/t/$tid', params: { wid: s.wid, tid: p.threadId } });
      } catch (e) {
        setError(errorText(e));
      }
    },
    setError,
    uid,
  };
}

function ScheduleList({
  rows,
  phone,
  selected,
  agentName,
  onOpen,
  docs,
  uid,
  now,
}: {
  rows: ListRow[];
  phone: boolean;
  selected: string | null;
  agentName: (wid: string, a: string) => string;
  onOpen: (r: ListRow) => void;
  docs: Map<string, Schedule>;
  uid: string;
  now: number;
}) {
  const acts = useScheduleActions(uid);
  const [editing, setEditing] = useState<ListRow | null>(null);
  const [deleting, setDeleting] = useState<ListRow | null>(null);
  const [ending, setEnding] = useState<ListRow | null>(null);
  const menu = (r: ListRow) => {
    const doc = docs.get(r.key);
    if (!doc) return null;
    const agent = agentName(r.s.wid, r.s.agentUid);
    return (
      <ActionMenu
        label={`Actions for ${r.s.title}`}
        actions={
          r.s.state === 'ended'
            ? [{ id: 'delete', label: 'Delete', tone: 'danger', onSelect: () => setDeleting(r) }]
            : [
                {
                  id: 'run',
                  label: 'Run now',
                  onSelect: () => void acts.runNow(r.s, agent, now),
                },
                r.s.state === 'active'
                  ? { id: 'pause', label: 'Pause', onSelect: () => void acts.pause(r.s, doc) }
                  : { id: 'resume', label: 'Resume', onSelect: () => void acts.resume(r.s, doc) },
                { id: 'end', label: 'End', onSelect: () => setEnding(r) },
                { id: 'edit', label: 'Edit', onSelect: () => setEditing(r) },
                {
                  id: 'delete',
                  label: 'Delete',
                  tone: 'danger',
                  onSelect: () => setDeleting(r),
                },
              ]
        }
        trigger={
          <IconButton label={`Actions for ${r.s.title}`} data-row-menu="">
            <Icon icon={MoreHorizontal} size={18} />
          </IconButton>
        }
      />
    );
  };
  const steps = (r: ListRow) => scheduleSteps(r.s.steps, r.next?.occ ?? null);
  const last = (r: ListRow) =>
    r.last ? (
      <RunPill state={r.last.run.state} label={r.last.day} />
    ) : (
      <span className="text-text-3">–</span>
    );
  return (
    <section
      aria-label="All schedules"
      className="rounded-panel border border-line bg-surface shadow-e1"
    >
      <h2 className={cn(EYEBROW, 'px-4 pb-2 pt-3')}>All schedules · {rows.length}</h2>
      {phone ? (
        <ul className="flex flex-col gap-2 px-3 pb-3">
          {rows.map((r) => (
            <li
              key={r.key}
              data-schedule-row={r.s.id}
              data-schedule-state={r.s.state}
              className={cn(
                'flex items-start gap-1 rounded-card border border-l-[3px] border-line bg-surface',
                r.s.state === 'ended' && 'bg-canvas',
              )}
              style={{ borderLeftColor: agentColor(r.s.agentUid) }}
            >
              <button
                type="button"
                onClick={() => onOpen(r)}
                className="min-w-0 flex-1 px-3 py-2.5 text-left foc:outline-2 foc:outline-focus"
              >
                <span className="block truncate text-15 font-semibold text-ink">{r.s.title}</span>
                <span className="block text-13 text-text-2 [overflow-wrap:anywhere]">
                  {r.sentence} · {agentName(r.s.wid, r.s.agentUid)}
                  {r.s.state === 'paused'
                    ? ' · paused'
                    : r.s.state === 'ended'
                      ? ' · ended'
                      : r.next
                        ? ` · next ${r.next.words}`
                        : ''}
                </span>
              </button>
              <span className="pr-1 pt-1">{menu(r)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div role="table" aria-label="Schedules" className="text-14">
          <div
            role="row"
            className="grid grid-cols-[minmax(0,1.5fr)_7rem_minmax(0,1.1fr)_minmax(0,1.6fr)_7.5rem_6rem_2.75rem] gap-3 border-y border-line bg-canvas px-4 py-2"
          >
            {['Schedule', 'Agent', 'When', 'Plan each run', 'Next run', 'Last run', ''].map(
              (h, i) => (
                <span key={i} role="columnheader" className={cn(EYEBROW, 'text-12')}>
                  {h || <span className="sr-only">Actions</span>}
                </span>
              ),
            )}
          </div>
          {rows.map((r) => (
            <div
              key={r.key}
              role="row"
              data-schedule-row={r.s.id}
              data-schedule-state={r.s.state}
              aria-selected={selected === r.key}
              className={cn(
                'grid grid-cols-[minmax(0,1.5fr)_7rem_minmax(0,1.1fr)_minmax(0,1.6fr)_7.5rem_6rem_2.75rem] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0',
                selected === r.key && 'bg-agent-soft',
                r.s.state === 'ended' && 'bg-canvas',
              )}
            >
              <span role="cell" className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="block max-w-full truncate text-left font-semibold text-ink hov:underline foc:outline-2 foc:outline-focus"
                >
                  {r.s.title}
                </button>
                <span className="block truncate text-13 text-text-2">{r.s.what}</span>
              </span>
              <span role="cell" className="min-w-0">
                <AgentTag uid={r.s.agentUid} name={agentName(r.s.wid, r.s.agentUid)} />
              </span>
              <span role="cell" className="min-w-0 text-ink [overflow-wrap:anywhere]">
                {r.sentence}
              </span>
              <span role="cell" className="min-w-0">
                <StepPills steps={steps(r)} />
              </span>
              <span role="cell" className="text-ink">
                {r.s.state === 'paused' ? (
                  <Pill className="h-5 px-2 text-12">Paused</Pill>
                ) : r.s.state === 'ended' ? (
                  <Pill className="h-5 px-2 text-12">Ended</Pill>
                ) : (
                  (r.next?.words ?? '–')
                )}
              </span>
              <span role="cell">{last(r)}</span>
              <span role="cell" className="justify-self-end">
                {menu(r)}
              </span>
            </div>
          ))}
        </div>
      )}
      {acts.error ? (
        <p role="alert" className="px-4 pb-3 text-14 text-sendback">
          {acts.error}
        </p>
      ) : null}
      {editing && docs.get(editing.key) ? (
        <ScheduleEditDialog
          open
          onOpenChange={(o) => !o && setEditing(null)}
          wid={editing.s.wid}
          scheduleId={editing.s.id}
          schedule={docs.get(editing.key)!}
        />
      ) : null}
      <EndDialog
        row={ending}
        onClose={() => setEnding(null)}
        onEnd={async (r) => {
          const doc = docs.get(r.key);
          if (doc && (await acts.end(r.s, doc))) setEnding(null);
        }}
      />
      <DeleteDialog
        row={deleting}
        onClose={() => setDeleting(null)}
        onDelete={async (r) => {
          const doc = docs.get(r.key);
          if (doc && (await acts.remove(r.s, doc))) setDeleting(null);
        }}
      />
    </section>
  );
}

function DeleteDialog({
  row,
  onClose,
  onDelete,
}: {
  row: ListRow | null;
  onClose: () => void;
  onDelete: (r: ListRow) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={!!row}
      onOpenChange={(o) => !o && onClose()}
      title={row ? `Delete “${row.s.title}”?` : 'Delete'}
      description="No more runs. The threads of past runs stay in your Inbox."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="sendback"
            data-confirm-delete=""
            loading={busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              try {
                await onDelete(row);
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete schedule
          </Button>
        </>
      }
    />
  );
}

function EndDialog({
  row,
  onClose,
  onEnd,
}: {
  row: ListRow | null;
  onClose: () => void;
  onEnd: (r: ListRow) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={!!row}
      onOpenChange={(o) => !o && onClose()}
      title={row ? `End “${row.s.title}”?` : 'End'}
      description="No more runs, for good. It stays in the list with its history, and the threads of past runs stay in your Inbox."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Keep it running
          </Button>
          <Button
            variant="sendback"
            data-confirm-end=""
            loading={busy}
            onClick={async () => {
              if (!row) return;
              setBusy(true);
              try {
                await onEnd(row);
              } finally {
                setBusy(false);
              }
            }}
          >
            End schedule
          </Button>
        </>
      }
    />
  );
}

// ---------- the detail ----------

function Detail({
  row,
  doc,
  uid,
  now,
  tz,
  agentName,
  onGone,
  asPage,
}: {
  row: ListRow;
  doc: Schedule | null;
  uid: string;
  now: number;
  tz: string;
  agentName: (wid: string, a: string) => string;
  onGone: () => void;
  /** The detail is the page itself (phone): its title is the page's h1. */
  asPage?: boolean;
}) {
  const s = row.s;
  const Title = asPage ? 'h1' : 'h2';
  const Sub = asPage ? 'h2' : 'h3';
  const acts = useScheduleActions(uid);
  const history = useScheduleHistory(uid, s.wid, s.id);
  const subject = useLiveDoc(
    s.subjectId ? inboxPaths.subject(s.wid, s.subjectId) : null,
    inboxSubjectSchema,
  );
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [ending, setEnding] = useState(false);
  const agent = agentName(s.wid, s.agentUid);
  const next = nextN(s, now, 3);
  const steps = scheduleSteps(s.steps, next[0] ?? null);
  const stz = s.rule.tz ?? 'Europe/Lisbon';
  const weekend =
    s.rule.weekend === 'before'
      ? 'weekend: Friday'
      : s.rule.weekend === 'after'
        ? 'weekend: Monday'
        : null;
  const subjectName = subject.state === 'ready' ? subject.data?.name : null;
  const past = history.list.filter((r) => r.dueMs <= now + 60_000);
  const dt = 'text-14 text-text-2';
  const dd = 'text-14 text-ink [overflow-wrap:anywhere]';
  return (
    <div data-schedule-detail={s.id}>
      <p className={EYEBROW}>Schedule</p>
      <Title className="mt-0.5 text-20 font-semibold text-ink [overflow-wrap:anywhere]">
        {s.title}
      </Title>
      <p className="mt-1 whitespace-pre-wrap text-14 text-text-2 [overflow-wrap:anywhere]">
        {s.what}
      </p>
      {s.state === 'paused' ? (
        <p className="mt-2">
          <Pill>Paused: nothing runs until you resume it</Pill>
        </p>
      ) : null}
      {s.state === 'ended' ? (
        <p className="mt-2">
          <Pill>Ended: no more runs. Past runs stay below.</Pill>
        </p>
      ) : null}
      <dl className="mt-4 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5">
        <dt className={dt}>When</dt>
        <dd className={dd} data-detail-when="">
          {ruleSentence(s.rule, { viewerTz: stz })}
          <span className="block text-13 text-text-2">
            {stz}
            {weekend ? ` · ${weekend}` : ''}
          </span>
        </dd>
        <dt className={dt}>Agent</dt>
        <dd className={dd}>
          <AgentTag uid={s.agentUid} name={agent} />
        </dd>
        <dt className={dt}>Each run</dt>
        <dd className={dd}>
          a thread “{next[0] ? fillPlaceholders(s.runTitle, next[0]) : s.runTitle}”
          {subjectName && s.subjectId ? (
            <>
              {' '}
              in{' '}
              <Link
                to="/inbox/$wid/s/$sid"
                params={{ wid: s.wid, sid: s.subjectId }}
                className="text-agent hov:underline"
              >
                {subjectName}
              </Link>
            </>
          ) : null}
        </dd>
        <dt className={dt}>Plan</dt>
        <dd className={dd}>
          <StepPills steps={steps} />
        </dd>
        <dt className={dt}>If it can’t run</dt>
        <dd className="text-13 text-ink">{cantRunText(s.rule.freq)}</dd>
      </dl>

      <Sub className={cn(EYEBROW, 'mt-5')}>Next runs</Sub>
      {next.length ? (
        <ul className="mt-1.5 flex flex-col divide-y divide-line" data-detail-next="">
          {next.map((o) => (
            <li key={o.key} className="flex items-baseline justify-between gap-3 py-1.5 text-14">
              <span className="tabular-nums text-ink">{whenWords(o.local, now, tz)}</span>
              <span className="text-13 text-text-2">{o.period}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-14 text-text-2">
          {s.state === 'paused'
            ? 'None while paused.'
            : s.state === 'ended'
              ? 'None: it has ended.'
              : 'No run left.'}
        </p>
      )}

      <Sub className={cn(EYEBROW, 'mt-5')}>Past runs</Sub>
      {history.state === 'loading' ? (
        <Skeleton className="mt-2 h-16 w-full" />
      ) : past.length ? (
        <ul className="mt-1.5 flex flex-col divide-y divide-line" data-detail-past="">
          {past.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-14"
            >
              <span className="min-w-0 text-ink">
                {shortDay(r.dueMs, now, tz)}
                {r.threadId ? (
                  <>
                    {' · '}
                    <Link
                      to="/inbox/$wid/t/$tid"
                      params={{ wid: s.wid, tid: r.threadId }}
                      className="text-agent hov:underline"
                    >
                      thread
                    </Link>
                  </>
                ) : null}
                {r.why && r.state !== 'done' ? (
                  <span className="block text-12 text-text-2 [overflow-wrap:anywhere]">
                    {r.why.text}
                  </span>
                ) : null}
              </span>
              <RunPill
                state={r.state}
                label={
                  r.decision?.choice === 'skip'
                    ? 'skipped by you'
                    : r.decision?.choice === 'later' && r.state === 'done'
                      ? 'done (tried later)'
                      : undefined
                }
              />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-14 text-text-2">No runs yet.</p>
      )}

      {doc ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {s.state !== 'ended' ? (
            <>
              <Button variant="secondary" data-detail-edit="" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant="secondary"
                data-detail-run-now=""
                onClick={() => void acts.runNow(s, agent, now)}
              >
                Run now
              </Button>
              {s.state === 'active' ? (
                <Button
                  variant="secondary"
                  data-detail-pause=""
                  onClick={() => void acts.pause(s, doc)}
                >
                  Pause
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  data-detail-resume=""
                  onClick={() => void acts.resume(s, doc)}
                >
                  Resume
                </Button>
              )}
              <Button variant="secondary" data-detail-end="" onClick={() => setEnding(true)}>
                End
              </Button>
            </>
          ) : null}
          <Button variant="sendback" data-detail-delete="" onClick={() => setDeleting(true)}>
            Delete
          </Button>
        </div>
      ) : null}
      <p className="mt-3 text-13 text-text-2">
        Edits apply from the next run; a run already made this period never runs again.
      </p>
      {acts.error ? (
        <p role="alert" className="mt-2 text-14 text-sendback">
          {acts.error}
        </p>
      ) : null}
      {editing && doc ? (
        <ScheduleEditDialog
          open
          onOpenChange={setEditing}
          wid={s.wid}
          scheduleId={s.id}
          schedule={doc}
        />
      ) : null}
      <EndDialog
        row={ending ? row : null}
        onClose={() => setEnding(false)}
        onEnd={async () => {
          if (doc && (await acts.end(s, doc))) setEnding(false);
        }}
      />
      <DeleteDialog
        row={deleting ? row : null}
        onClose={() => setDeleting(false)}
        onDelete={async () => {
          if (doc && (await acts.remove(s, doc))) {
            setDeleting(false);
            onGone();
          }
        }}
      />
    </div>
  );
}

// ---------- New schedule: ask an agent ----------

function AskAgentDialog({
  open,
  onOpenChange,
  orgs,
  agents,
  defaultWid,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  orgs: { wid: string; name: string }[];
  agents: Map<string, { name: string; revokedAt: unknown }>;
  defaultWid: string;
}) {
  const { actionContext, run } = useReady();
  const navigate = useNavigate();
  const [wid, setWid] = useState(defaultWid);
  const options = [...agents.entries()]
    .filter(([k, a]) => k.startsWith(`${wid}/`) && !a.revokedAt)
    .map(([k, a]) => ({ value: k.slice(wid.length + 1), label: a.name }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const [agent, setAgent] = useState('');
  const picked = options.some((o) => o.value === agent) ? agent : (options[0]?.value ?? '');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    const ctx = actionContext(wid);
    if (!ctx || busy || !picked) return;
    setBusy(true);
    setError(null);
    try {
      const t = text.trim();
      const p = createMemberThread(ctx, {
        title: `Set up a schedule: ${t.replace(/\s+/g, ' ').slice(0, 120)}`,
        text: `Set up a schedule: ${t}\n\nPropose it with schedule_propose (what, when, the plan of each run) so I can approve it.`,
        agentUid: picked,
      });
      await run(p);
      onOpenChange(false);
      setText('');
      void navigate({ to: '/inbox/$wid/t/$tid', params: { wid, tid: p.threadId } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <ResponsiveModal
      open={open}
      onOpenChange={onOpenChange}
      title="New schedule"
      description="Say what and when; the agent proposes the schedule and you approve it."
    >
      <form onSubmit={send} className="flex flex-col gap-4" data-ask-schedule="">
        <Textarea
          label="What and when?"
          rows={3}
          value={text}
          placeholder="Every 1st at 9, prepare the invoices and ask me before sending"
          onChange={(e) => setText(e.target.value)}
        />
        {orgs.length > 1 ? (
          <Select
            label="Organization"
            value={wid}
            onValueChange={setWid}
            options={orgs.map((o) => ({ value: o.wid, label: o.name }))}
          />
        ) : null}
        {options.length ? (
          <Select label="Agent" value={picked} onValueChange={setAgent} options={options} />
        ) : (
          <p className="text-14 text-text-2">
            No agent in this organization yet: connect one first.
          </p>
        )}
        {error ? (
          <p role="alert" className="text-14 text-sendback">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!text.trim() || !picked}>
            Ask the agent
          </Button>
        </div>
      </form>
    </ResponsiveModal>
  );
}
