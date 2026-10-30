/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo, part 3; regrouped in item kt3E7u9EliL3q2veDDI0, design 2.4):
 * the member's subjects, in one organization or across all of theirs, grouped by their most
 * pressing thread: Needs you (ranked), Agents working, Waiting on others, Recent, then Not filed
 * yet and Quiet. Each row shows the subject, its organization's colour, who asked what last,
 * its area and label, a state chip and its age. The first screen is Find plus a Filters button;
 * Find searches names, people, channels and the text of the threads.
 */
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Clock, Mails, Plus, SlidersHorizontal } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useReady } from '../auth/context';
import { orgColor } from '../orgs/color';
import { useOrgs } from '../orgs/data';
import { PageHeader } from '../pages/Chrome';
import { OrgChips } from '../orgs/OrgChips';
import { useThreadMessages } from '../today/data';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Input, Select } from '../ui/form';
import { Icon } from '../ui/icon';
import { Popover, Sheet } from '../ui/overlay';
import { waitLabel } from '../inbox/logic';
import { useInbox, useMyMessages, useMyRelations } from './data';
import {
  areaCounts,
  countWaitingThreads,
  DEFAULT_QUIET_DAYS,
  filterByAreas,
  filterByLabels,
  findSubjectRows,
  forMember,
  groupByState,
  labelCounts,
  rankThreads,
  subjectRows,
  type SubjectRow,
  type ThreadRow,
} from './logic';
import { summaryLine } from './decision';
import { LabelChip } from './labels';
import { StateChip, UrgentMark } from './parts';
import { NewThreadDialog } from './NewThread';

const DAYS = [
  { value: '0', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

const QUIET = [
  { value: '30', label: 'Quiet after 30 days' },
  { value: '60', label: 'Quiet after 60 days' },
  { value: '90', label: 'Quiet after 90 days' },
  { value: '180', label: 'Quiet after 180 days' },
  { value: '0', label: 'Never fold quiet subjects' },
];
const QUIET_KEY = 'hive.inbox.quietDays';

function loadQuietDays(): number {
  try {
    const saved = localStorage.getItem(QUIET_KEY);
    if (saved !== null && QUIET.some((o) => o.value === saved)) return Number(saved);
  } catch {
    /* storage can be blocked: the default applies */
  }
  return DEFAULT_QUIET_DAYS;
}

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

/** "now", "5 min", "3 h", "2 d". */
const age = (ms: number, now: number) => {
  const l = waitLabel(ms, now);
  return l === 'just now' ? 'now' : l;
};

/** The thread that puts a subject in its group (the one its row speaks for). */
function leadThread(r: SubjectRow, now: number): ThreadRow | undefined {
  const mine = r.threads.filter((t) => forMember(t.data.state));
  if (mine.length) return rankThreads(mine, now)[0];
  return (
    r.threads.find((t) => t.data.state === 'investigating') ??
    r.threads.find((t) => t.data.state === 'waiting') ??
    r.threads[0]
  );
}

export function InboxListPage() {
  const { session } = useReady();
  const uid = session.me.uid;
  const phone = usePhone();
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate();
  const scope = search.org && orgs.some((o) => o.id === search.org) ? search.org : '';
  const wids = useMemo(
    () => (scope ? [scope] : orgs.filter((o) => !o.deleting).map((o) => o.id)),
    [scope, orgs],
  );
  const colorOrgs = useMemo(() => orgs.map((o) => ({ wid: o.id, name: o.name })), [orgs]);
  const inbox = useInbox(uid, wids);
  const [q, setQ] = useState('');
  const [waitingForMe, setWaitingForMe] = useState(false);
  const [hasOpen, setHasOpen] = useState(false);
  const [days, setDays] = useState(0);
  const [quietDays, setQuietDays] = useState(loadQuietDays);
  const [labelKeys, setLabelKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [areaKeys, setAreaKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const finding = q.trim().length > 0 || waitingForMe || hasOpen || days > 0;
  const messages = useMyMessages(uid, wids, finding);
  const relations = useMyRelations(uid, wids, finding);
  const [now] = useState(() => Date.now());
  const rows = useMemo(() => subjectRows(inbox.subjects, inbox.threads), [inbox]);
  const found = useMemo(
    () =>
      finding
        ? findSubjectRows(
            rows,
            wids,
            {
              subjects: inbox.subjects,
              threads: inbox.threads,
              messages: messages.rows,
              relations: relations.rows,
            },
            q,
            { waitingForMe, hasOpen, days },
            now,
          )
        : rows,
    [
      finding,
      rows,
      wids,
      inbox,
      messages.rows,
      relations.rows,
      q,
      waitingForMe,
      hasOpen,
      days,
      now,
    ],
  );
  // The label and area filters combine with everything above.
  const labelOptions = useMemo(() => labelCounts(found), [found]);
  const areaOptions = useMemo(() => areaCounts(found), [found]);
  const shown = useMemo(
    () => filterByAreas(filterByLabels(found, labelKeys), areaKeys),
    [found, labelKeys, areaKeys],
  );
  const toggle = (set: typeof setLabelKeys) => (key: string) =>
    set((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const groups = useMemo(() => groupByState(shown, quietDays, now), [shown, quietDays, now]);
  const orgName = (wid: string) => orgs.find((o) => o.id === wid)?.name ?? '';
  const waiting = countWaitingThreads(rows);
  const active =
    (waitingForMe ? 1 : 0) +
    (hasOpen ? 1 : 0) +
    (days > 0 ? 1 : 0) +
    labelKeys.size +
    areaKeys.size;

  // Who asked what last, for the rows above Recent.
  const leads = useMemo(() => {
    const m = new Map<string, ThreadRow>();
    for (const r of [...groups.needs, ...groups.working, ...groups.waiting]) {
      const t = leadThread(r, now);
      if (t) m.set(`${r.wid}/${r.id}`, t);
    }
    return m;
  }, [groups, now]);
  const leadRefs = useMemo(
    () => [...leads.values()].map((t) => ({ wid: t.wid, id: t.id })),
    [leads],
  );
  const lastMessages = useThreadMessages(uid, leadRefs);
  const askOf = (r: SubjectRow): { text: string; summary: boolean } => {
    const t = leads.get(`${r.wid}/${r.id}`) ?? leadThread(r, now);
    if (!t) return { text: '', summary: false };
    // The summary's top line (slice 3), else the last message.
    const line = summaryLine(t.data);
    if (line) return { text: line, summary: true };
    return { text: lastLine(t), summary: false };
  };
  const lastLine = (t: NonNullable<ReturnType<typeof leadThread>>) => {
    const ms = lastMessages.get(`${t.wid}/${t.id}`) ?? [];
    const last = [...ms].reverse().find((m) => m.direction === 'in');
    if (!last) return t.data.title || 'Untitled thread';
    const first = last.text.split('\n').find((l) => l.trim()) ?? '';
    return `${last.sender.name.split(' ')[0]}: ${first.trim()}`;
  };

  const setScope = (v: string) =>
    void navigate({ to: '/inbox', search: v === 'all' ? {} : { org: v }, replace: true });
  const filterPanel = (
    <div className="flex flex-col gap-4">
      <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-2">
        <FilterChip pressed={waitingForMe} onClick={() => setWaitingForMe((v) => !v)}>
          Waiting for me
        </FilterChip>
        <FilterChip pressed={hasOpen} onClick={() => setHasOpen((v) => !v)}>
          Has open threads
        </FilterChip>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Active"
          value={String(days)}
          onValueChange={(v) => setDays(Number(v))}
          options={DAYS}
        />
        <Select
          label="Quiet subjects"
          value={String(quietDays)}
          onValueChange={(v) => {
            setQuietDays(Number(v));
            try {
              localStorage.setItem(QUIET_KEY, v);
            } catch {
              /* a per-viewer convenience only */
            }
          }}
          options={QUIET}
        />
      </div>
      {areaOptions.length > 0 || areaKeys.size > 0 ? (
        <div role="group" aria-label="Area" className="flex flex-wrap items-center gap-2">
          {[
            ...areaOptions,
            ...[...areaKeys]
              .filter((k) => !areaOptions.some((o) => o.key === k))
              .map((k) => ({ key: k, label: k, count: 0 })),
          ].map((o) => (
            <FilterChip
              key={o.key}
              pressed={areaKeys.has(o.key)}
              onClick={() => toggle(setAreaKeys)(o.key)}
              data-area-filter={o.key}
            >
              {o.label} · {o.count}
            </FilterChip>
          ))}
        </div>
      ) : null}
      {labelOptions.length > 0 || labelKeys.size > 0 ? (
        <div role="group" aria-label="Label" className="flex flex-wrap items-center gap-2">
          {[
            ...labelOptions,
            ...[...labelKeys]
              .filter((k) => !labelOptions.some((o) => o.key === k))
              .map((k) => ({ key: k, label: k, count: 0 })),
          ].map((o) => (
            <FilterChip
              key={o.key}
              pressed={labelKeys.has(o.key)}
              onClick={() => toggle(setLabelKeys)(o.key)}
              data-label-filter={o.key}
            >
              {o.label} · {o.count}
            </FilterChip>
          ))}
        </div>
      ) : null}
    </div>
  );
  const filtersLabel = `Filters${active ? ` · ${active}` : ''}`;
  const filtersTrigger = (
    <Button
      variant="secondary"
      leading={<Icon icon={SlidersHorizontal} size={15} />}
      onClick={phone ? () => setFiltersOpen(true) : undefined}
    >
      {filtersLabel}
    </Button>
  );

  const row = (r: SubjectRow) => (
    <SubjectItem
      key={`${r.wid}/${r.id ?? ''}`}
      row={r}
      org={
        scope || orgs.length < 2
          ? null
          : { name: orgName(r.wid), color: orgColor(r.wid, colorOrgs) }
      }
      uid={uid}
      ask={askOf(r)}
      now={now}
    />
  );
  const section = (key: string, title: string, list: SubjectRow[]) =>
    list.length ? (
      <section key={key} data-group={key} aria-label={title}>
        <h2 className="mb-2 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
          {title} · {list.length}
        </h2>
        <ul className="flex flex-col gap-2" aria-label={title}>
          {list.map(row)}
        </ul>
      </section>
    ) : null;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <NewThreadDialog open={newOpen} onClose={() => setNewOpen(false)} />
      <PageHeader
        title="Inbox"
        action={
          <Button
            variant="primary"
            data-new-thread-open=""
            onClick={() => setNewOpen(true)}
            leading={<Icon icon={Plus} size={16} />}
          >
            New thread
          </Button>
        }
        allOrgs={!scope && orgs.length > 1}
        subtitle={
          inbox.state === 'ready'
            ? waiting > 0
              ? `${waiting} thread${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for you`
              : 'Nothing waits for you'
            : undefined
        }
        reserveSubtitle
      />
      {/* The organization chips (item icVly): a filter of this page only, kept in the URL. */}
      <OrgChips
        className="mb-3"
        orgs={colorOrgs}
        value={scope || null}
        onChange={(w) => setScope(w ?? 'all')}
        hint="Tap an organization to see only its threads"
      />
      <div className="mb-4 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Input
            label="Find subjects"
            type="search"
            placeholder="Find a subject, a person, a channel, words"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {phone ? (
          filtersTrigger
        ) : (
          <Popover
            label="Filters"
            align="end"
            contentClassName="w-[min(28rem,calc(100vw-16px))] p-4"
            trigger={filtersTrigger}
          >
            {filterPanel}
          </Popover>
        )}
      </div>
      {phone ? (
        <Sheet open={filtersOpen} onOpenChange={setFiltersOpen} title="Filters">
          <div className="pb-4">{filterPanel}</div>
        </Sheet>
      ) : null}

      {inbox.state === 'error' ? (
        <p role="alert" className="mb-3 text-14 text-sendback">
          Inbox could not be loaded. Check your connection and try again.
        </p>
      ) : null}
      <p aria-live="polite" className="sr-only">
        {inbox.state === 'ready' ? `${shown.length} subject${shown.length === 1 ? '' : 's'}` : ''}
      </p>
      {inbox.state === 'loading' ? (
        <div className="flex flex-col gap-3" aria-hidden>
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Mails}
          title="Nothing in your Inbox yet"
          description="Your organizations' agents bring in what people send you, file it under a subject and propose what to do."
        />
      ) : shown.length === 0 ? (
        <p className="rounded-card border border-dashed border-line-strong px-4 py-8 text-center text-14 text-text-2">
          No subject matches.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {section('needs', 'Needs you', groups.needs)}
          {section('working', 'Agents working', groups.working)}
          {section('waiting', 'Waiting on others', groups.waiting)}
          {section('recent', 'Recent', groups.recent)}
          {groups.unfiled.length ? (
            <section data-group="unfiled" data-subject="unfiled" aria-label="Not filed yet">
              <h2 className="mb-2 font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
                Not filed yet · {groups.unfiled.reduce((n, r) => n + r.threads.length, 0)}
              </h2>
              <ul className="flex flex-col gap-2" aria-label="Not filed yet">
                {groups.unfiled.flatMap((r) =>
                  r.threads.map((t) => (
                    <li key={`${t.wid}/${t.id}`}>
                      <Link
                        to="/inbox/$wid/t/$tid"
                        params={{ wid: t.wid, tid: t.id }}
                        data-thread={t.id}
                        className="flex min-h-12 items-center gap-3 rounded-card border border-line bg-surface px-4 py-2 transition-colors hov:bg-canvas foc:outline-2 foc:outline-focus"
                      >
                        {scope || orgs.length < 2 ? null : (
                          <span
                            aria-hidden
                            className="size-2 shrink-0 rounded-full"
                            style={{ background: orgColor(t.wid, colorOrgs) }}
                          />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-14 text-ink">
                            {t.data.title || 'Untitled thread'}
                          </span>
                          {summaryLine(t.data) ? (
                            <span
                              data-summary-line=""
                              className="block truncate text-13 text-text-2"
                            >
                              {summaryLine(t.data)}
                            </span>
                          ) : null}
                        </span>
                        <UrgentMark on={t.data.urgent} />
                        <StateChip state={t.data.state} />
                        <span className="w-12 shrink-0 whitespace-nowrap text-right text-12 text-text-3 max-sm:hidden">
                          {age(t.data.lastMessageAt.toMillis(), now)}
                        </span>
                      </Link>
                    </li>
                  )),
                )}
              </ul>
            </section>
          ) : null}
          {groups.quiet.length > 0 ? (
            <details data-quiet className="rounded-card border border-line bg-surface">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-14 font-medium text-text-2 foc:outline-2 foc:outline-focus">
                Quiet ({groups.quiet.length})
              </summary>
              <ul className="flex flex-col gap-2 p-3" aria-label="Subjects with no recent messages">
                {groups.quiet.map(row)}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}

function FilterChip({
  pressed,
  onClick,
  children,
  ...rest
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  'data-label-filter'?: string;
}) {
  return (
    <button
      type="button"
      {...rest}
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 items-center rounded-full border px-3 text-14 font-medium transition-colors foc:outline-2 foc:outline-focus',
        pressed
          ? 'border-ink bg-ink text-surface'
          : 'border-line-strong text-text-2 hover:border-text-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/**
 * One subject in the list (design 2.4): its name (the link), the organization's colour, who asked
 * what last, its area and label, a state chip with its count, its age.
 */
function SubjectItem({
  row,
  org,
  uid,
  ask,
  now,
}: {
  row: SubjectRow;
  org: { name: string; color: string } | null;
  uid: string;
  ask: { text: string; summary: boolean };
  now: number;
}) {
  const working = row.threads.some((t) => t.data.state === 'investigating');
  const waitingOn = row.threads.some((t) => t.data.state === 'waiting');
  const urgent = row.threads.some((t) => t.data.urgent && forMember(t.data.state));
  let chip: ReactNode = null;
  if (row.waiting > 0)
    chip = (
      <Badge tone="gate" className="shrink-0">
        {row.waiting} for you
      </Badge>
    );
  else if (working)
    chip = (
      <Badge tone="agent" className="shrink-0">
        <span data-state="investigating">Working</span>
      </Badge>
    );
  else if (waitingOn)
    chip = (
      <Badge tone="neutral" className="shrink-0">
        <Icon icon={Clock} size={11} />
        <span data-state="waiting">Waiting</span>
      </Badge>
    );
  return (
    <li
      data-subject={row.id ?? 'unfiled'}
      className={cn(
        'relative flex items-center gap-x-3 gap-y-1.5 rounded-card border border-l-4 bg-surface px-3.5 py-2.5 transition-colors hov:bg-canvas max-sm:flex-wrap',
        row.waiting > 0
          ? urgent
            ? 'border-line border-l-sendback'
            : 'border-line border-l-gate'
          : 'border-line border-l-transparent',
      )}
    >
      {org ? (
        <span
          aria-hidden
          title={org.name}
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: org.color }}
        />
      ) : null}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-15 font-semibold text-ink">
          {row.id ? (
            <Link
              to="/inbox/$wid/s/$sid"
              params={{ wid: row.wid, sid: row.id }}
              className="rounded-sm after:absolute after:inset-0 after:content-[''] foc:outline-2 foc:outline-focus"
            >
              {row.name}
            </Link>
          ) : (
            row.name
          )}
          {org ? <span className="sr-only"> · {org.name}</span> : null}
        </h2>
        {ask.text ? (
          <p
            data-summary-line={ask.summary ? '' : undefined}
            className={cn('truncate text-13', ask.summary ? 'text-ink' : 'text-text-2')}
          >
            {ask.text}
          </p>
        ) : null}
      </div>
      <div className="relative z-[1] flex shrink-0 items-center gap-1.5 empty:hidden max-sm:order-last max-sm:basis-full max-sm:flex-wrap">
        {row.area ? (
          <Badge tone="neutral" className="max-sm:hidden">
            {row.area}
          </Badge>
        ) : null}
        {row.id && row.label ? (
          <LabelChip
            wid={row.wid}
            subjectId={row.id}
            subject={{
              memberUid: uid,
              name: row.name,
              label: row.label,
              labelSuggested: row.labelSuggested,
            }}
          />
        ) : null}
      </div>
      {chip}
      <span className="w-12 shrink-0 whitespace-nowrap text-right text-12 tabular-nums text-text-3 max-sm:hidden">
        {row.activityAt ? age(row.activityAt, now) : ''}
      </span>
    </li>
  );
}
