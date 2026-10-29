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
import { countWaitingThreads, findSubjectRows, subjectRows, type SubjectRow } from './logic';
import { StateChip, UrgentMark, when } from './parts';

const DAYS = [
  { value: '0', label: 'Any time' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];

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
  const finding = q.trim().length > 0 || waitingForMe || hasOpen || days > 0;
  const messages = useMyMessages(uid, wids, finding);
  const relations = useMyRelations(uid, wids, finding);
  const [now] = useState(() => Date.now());
  const rows = useMemo(() => subjectRows(inbox.subjects, inbox.threads), [inbox]);
  const shown = useMemo(
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
      </div>

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
        <ul className="flex flex-col gap-3" aria-label="Subjects">
          {shown.map((r) => (
            <SubjectCard key={`${r.wid}/${r.id ?? ''}`} row={r} org={scope ? '' : orgName(r.wid)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
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

function SubjectCard({ row, org }: { row: SubjectRow; org: string }) {
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
