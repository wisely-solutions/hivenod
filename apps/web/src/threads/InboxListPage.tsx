/**
 * Inbox (item 4PEHrOW5IfXBQWgOK9wo, part 3): the member's subjects, in one organization or
 * across all of theirs. Subjects with threads waiting for them come first, then the rest. Find
 * searches names, people, channels and the text of the threads.
 */
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Mails } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { useOrgs } from '../orgs/data';
import { PageHeader } from '../pages/Chrome';
import { Badge } from '../ui/badge';
import { cn } from '../ui/cn';
import { EmptyState, Skeleton } from '../ui/feedback';
import { Input, Select } from '../ui/form';
import { useInbox, useMyMessages, useMyRelations } from './data';
import {
  countWaitingThreads,
  DEFAULT_QUIET_DAYS,
  filterByLabels,
  findSubjectRows,
  groupByArea,
  labelCounts,
  subjectRows,
  type SubjectRow,
} from './logic';
import { LabelChip } from './labels';
import { StateChip, UrgentMark, when } from './parts';

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

export function InboxListPage() {
  const { session } = useReady();
  const uid = session.me.uid;
  const orgs = useOrgs(uid, session.profile.workspaceIds);
  const search = useSearch({ from: '/inbox' });
  const navigate = useNavigate();
  const scope = search.org && orgs.some((o) => o.id === search.org) ? search.org : '';
  const wids = useMemo(
    () => (scope ? [scope] : orgs.filter((o) => !o.deleting).map((o) => o.id)),
    [scope, orgs],
  );
  const inbox = useInbox(uid, wids);
  const [q, setQ] = useState('');
  const [waitingForMe, setWaitingForMe] = useState(false);
  const [hasOpen, setHasOpen] = useState(false);
  const [days, setDays] = useState(0);
  const [quietDays, setQuietDays] = useState(loadQuietDays);
  const [labelKeys, setLabelKeys] = useState<ReadonlySet<string>>(() => new Set());
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
  // The label filter combines with everything above (organization, find, area grouping).
  const labelOptions = useMemo(() => labelCounts(found), [found]);
  const shown = useMemo(() => filterByLabels(found, labelKeys), [found, labelKeys]);
  const toggleLabel = (key: string) =>
    setLabelKeys((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const grouped = useMemo(() => groupByArea(shown, quietDays, now), [shown, quietDays, now]);
  const hasAreas = grouped.groups.some((g) => g.label !== null);
  const orgName = (wid: string) => orgs.find((o) => o.id === wid)?.name ?? '';
  const waiting = countWaitingThreads(rows);

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Inbox"
        subtitle={
          inbox.state === 'ready'
            ? waiting > 0
              ? `${waiting} thread${waiting === 1 ? '' : 's'} wait${waiting === 1 ? 's' : ''} for you`
              : 'Nothing waits for you'
            : undefined
        }
        reserveSubtitle
      />
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select
          label="Organization"
          hideLabel
          inline
          value={scope || 'all'}
          onValueChange={(v) =>
            void navigate({ to: '/inbox', search: v === 'all' ? {} : { org: v }, replace: true })
          }
          options={[
            { value: 'all', label: 'All my organizations' },
            ...orgs.map((o) => ({ value: o.id, label: o.name })),
          ]}
        />
        <div className="min-w-0 flex-1 basis-60">
          <Input
            label="Find subjects"
            type="search"
            placeholder="A name, a person, a channel, words"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      </div>
      <div role="group" aria-label="Filters" className="mb-4 flex flex-wrap items-center gap-2">
        <FilterChip pressed={waitingForMe} onClick={() => setWaitingForMe((v) => !v)}>
          Waiting for me
        </FilterChip>
        <FilterChip pressed={hasOpen} onClick={() => setHasOpen((v) => !v)}>
          Has open threads
        </FilterChip>
        <Select
          label="Active"
          hideLabel
          inline
          value={String(days)}
          onValueChange={(v) => setDays(Number(v))}
          options={DAYS}
        />
        <Select
          label="Quiet subjects"
          hideLabel
          inline
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

      {labelOptions.length > 0 || labelKeys.size > 0 ? (
        <div role="group" aria-label="Label" className="mb-4 flex flex-wrap items-center gap-2">
          {[
            ...labelOptions,
            ...[...labelKeys]
              .filter((k) => !labelOptions.some((o) => o.key === k))
              .map((k) => ({ key: k, label: k, count: 0 })),
          ].map((o) => (
            <FilterChip
              key={o.key}
              pressed={labelKeys.has(o.key)}
              onClick={() => toggleLabel(o.key)}
              data-label-filter={o.key}
            >
              {o.label} · {o.count}
            </FilterChip>
          ))}
        </div>
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
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
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
        <div className="flex flex-col gap-5">
          {grouped.groups.map((g) => (
            <section
              key={g.key}
              data-area={g.label ?? ''}
              aria-label={g.label ?? (hasAreas ? 'No area' : 'Subjects')}
            >
              {hasAreas ? (
                <h2 className="mb-2 text-13 font-semibold uppercase tracking-wide text-text-2">
                  {g.label ?? 'No area'}
                </h2>
              ) : null}
              <ul className="flex flex-col gap-3" aria-label="Subjects">
                {g.rows.map((r) => (
                  <SubjectCard
                    key={`${r.wid}/${r.id ?? ''}`}
                    row={r}
                    org={scope ? '' : orgName(r.wid)}
                    uid={uid}
                  />
                ))}
              </ul>
            </section>
          ))}
          {grouped.quiet.length > 0 ? (
            <details data-quiet className="rounded-card border border-line bg-surface">
              <summary className="min-h-11 cursor-pointer px-4 py-3 text-14 font-medium text-text-2 foc:outline-2 foc:outline-focus">
                Quiet ({grouped.quiet.length})
              </summary>
              <ul className="flex flex-col gap-3 p-3" aria-label="Subjects with no recent messages">
                {grouped.quiet.map((r) => (
                  <SubjectCard
                    key={`${r.wid}/${r.id ?? ''}`}
                    row={r}
                    org={scope ? '' : orgName(r.wid)}
                    uid={uid}
                  />
                ))}
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

/** At most this many threads under a subject in the list; the subject page has them all. */
const SHOWN_THREADS = 4;

function SubjectCard({ row, org, uid }: { row: SubjectRow; org: string; uid: string }) {
  const more = row.threads.length - SHOWN_THREADS;
  return (
    <li
      data-subject={row.id ?? 'unfiled'}
      className={cn(
        'rounded-card border bg-surface shadow-e1',
        row.waiting > 0 ? 'border-gate/60' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-3">
        <h2 className="min-w-[12rem] flex-1 text-16 font-semibold text-ink [overflow-wrap:anywhere]">
          {row.id ? (
            <Link
              to="/inbox/$wid/s/$sid"
              params={{ wid: row.wid, sid: row.id }}
              className="rounded-sm hover:underline foc:outline-2 foc:outline-focus"
            >
              {row.name}
            </Link>
          ) : (
            row.name
          )}
        </h2>
        {row.area ? <Badge tone="neutral">{row.area}</Badge> : null}
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
        {row.waiting > 0 ? <Badge tone="gate">{row.waiting} for you</Badge> : null}
        <span className="text-13 text-text-2">
          {org ? `${org} · ` : ''}
          {row.open} open · {row.threads.length} thread{row.threads.length === 1 ? '' : 's'}
        </span>
      </div>
      <ul>
        {row.threads.slice(0, SHOWN_THREADS).map((t) => (
          <li key={t.id} className="border-b border-line last:border-b-0">
            <Link
              to="/inbox/$wid/t/$tid"
              params={{ wid: t.wid, tid: t.id }}
              data-thread={t.id}
              className="flex min-h-11 items-center gap-3 px-4 py-2 transition-colors hover:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus"
            >
              <span className="min-w-0 flex-1 truncate text-14 text-ink">
                {t.data.title || 'Untitled thread'}
              </span>
              <span className="hidden text-13 text-text-2 sm:inline">
                {when(t.data.lastMessageAt.toMillis())}
              </span>
              <UrgentMark on={t.data.urgent} />
              <StateChip state={t.data.state} />
            </Link>
          </li>
        ))}
      </ul>
      {more > 0 && row.id ? (
        <Link
          to="/inbox/$wid/s/$sid"
          params={{ wid: row.wid, sid: row.id }}
          className="block min-h-11 px-4 py-3 text-14 font-medium text-agent hover:underline foc:outline-2 foc:outline-focus"
        >
          {more} more thread{more === 1 ? '' : 's'}
        </Link>
      ) : null}
    </li>
  );
}
