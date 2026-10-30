import { useNavigate, useSearch } from '@tanstack/react-router';
import { Inbox, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { firstName, useReady } from '../auth/context';
import { useShellData } from '../shell/data';
import { useShortcut } from '../shell/shortcuts';
import { useOptionalCapture } from '../capture/CaptureProvider';
import { Segmented, Select } from '../ui/form';
import { Button } from '../ui/button';
import { EmptyState, Skeleton } from '../ui/feedback';
import { AnimatePresence, motion } from '../ui/motion';
import { Popover } from '../ui/overlay';
import { BriefCard } from '../today/BriefCard';
import { DecisionCard, type DecisionCardHandle } from '../today/DecisionCard';
import { DecisionRow, DoneRow } from '../today/DecisionRow';
import { TidyUps } from '../today/TidyUps';
import { TodayRail } from '../today/TodayRail';
import { useToday } from '../today/useToday';
import { Icon } from '../ui/icon';
import { nextKey, parseFilter } from './logic';
import { useNeedsAll } from '../needs/data';
import { ScopeLine } from '../shell/ScopePill';
import { OrgChips } from '../orgs/OrgChips';
import {
  countKinds,
  filterByLabel,
  filterKind,
  filterOrg,
  labelsOfNeeds,
  orderToday,
  type NeedsEntry,
} from '../needs/logic';

const DESKTOP = '(min-width: 1024px)';
/** Rows drawn in the first paint (more than a tall phone shows). */
const FIRST_ROWS = 10;
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

/**
 * Today, the heart of Hivenod: every Inbox thread waiting on me, decided in seconds (SPEC 9.1),
 * across every organization I am in (item 2YZRd). Projects were removed (item
 * OE8FmrTaIxFVGcaeGG3N, slice 10): only threads are listed.
 */
export function InboxPage() {
  const {
    sel,
    f: rawFilter,
    org: rawOrg,
    label: rawLabel,
  } = useSearch({ strict: false }) as {
    sel?: string;
    f?: string;
    org?: string;
    label?: string;
  };
  const { session } = useReady();
  const all = useNeedsAll();
  const navigate = useNavigate();
  const shell = useShellData();
  const desktop = useIsDesktop();
  const filter = parseFilter(rawFilter);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Counts, rows and the all-caught-up state wait until the server has answered every feed, so
  // nothing climbs or flashes. A feed that never answers must not hide the list for good: after
  // 3 s show what we have.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setPatient(false), 3000);
    return () => clearTimeout(t);
  }, []);
  // Runs (agent and summary on each row) may follow: they are not what the list waits for.
  const loading = shell.loading || (!all.settled && patient);
  const orgFilter = rawOrg && all.orgs.some((o) => o.wid === rawOrg) ? rawOrg : null;
  const manyOrgs = all.orgs.length > 1;
  // The first paint draws only the rows a phone screen can show; the rest follow a frame later,
  // so a long list does not hold back the first rows (card CGPynEQY). Counts use the whole list.
  const [allRows, setAllRows] = useState(false);
  useEffect(() => {
    if (loading || allRows) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const raf = requestAnimationFrame(() => {
      t = setTimeout(() => {
        setAllRows(true);
      }, 0);
    });
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [loading, allRows]);

  const needs = all.needs;
  const everything = needs.todo;
  // The org picker narrows everything.
  const inOrgAll = useMemo(() => filterOrg(everything, orgFilter), [everything, orgFilter]);
  // The label filter (Inbox threads only) combines with the organization and the rest.
  const labelOptions = useMemo(() => labelsOfNeeds(inOrgAll), [inOrgAll]);
  const labelFilter = rawLabel ? rawLabel.toLowerCase() : null;
  const inOrg = useMemo(() => filterByLabel(inOrgAll, labelFilter), [inOrgAll, labelFilter]);
  const counts = countKinds(inOrg);
  const filtered = filterKind(inOrg, filter);
  // Today (item kt3E7): one stack in rank order (design 2.1). Tidy-ups go to their own card
  // unless kept for me; Skip moves a decision to the end for this visit.
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [done, setDone] = useState<{ key: string; label: string; at: number }[]>([]);
  const tidyAll = filtered.filter((e) => e.tidy);
  const tidy = tidyAll.filter((e) => !kept.has(e.key));
  const ordered = orderToday(
    filtered.map((e) => (e.tidy && kept.has(e.key) ? { ...e, tidy: false } : e)),
    now,
  );
  const list = [
    ...ordered.filter((e) => !skipped.includes(e.key)),
    ...skipped.flatMap((k) => ordered.filter((e) => e.key === k)),
  ];
  // Keyboard order.
  const nav = list;

  // The row that is highlighted (desktop: the first one until you pick).
  const focusedRow = nav.find((e) => e.key === sel) ?? null;
  const selectedRow = focusedRow ?? (desktop ? (nav[0] ?? null) : null);
  // The thread drawn as the decision card: the focused one, or the first of the stack.
  const cardEntry = selectedRow ?? nav[0] ?? null;
  const cardRef = useRef<DecisionCardHandle>(null);
  const capture = useOptionalCapture();
  const today = useToday(all, list, tidy, now, done.length);

  const keep = {
    ...(filter !== 'all' ? { f: filter } : {}),
    ...(orgFilter ? { org: orgFilter } : {}),
    ...(labelFilter ? { label: labelFilter } : {}),
  };
  const go = (key: string | null, replace = true) =>
    void navigate({
      to: '/',
      search: { ...(key ? { sel: key } : {}), ...keep },
      replace,
    });

  /** Opens a row: the thread, on the Inbox screen. */
  const openRow = (e: NeedsEntry) =>
    void navigate({
      to: '/inbox/$wid/t/$tid',
      params: { wid: e.wid, tid: e.thread.id },
      search: { from: 'today' },
    });

  // Undo runs up to 5 s after the decision: read where the person is now, not where they were.
  const latest = useRef({ sel, desktop, go, nav, list });
  // Where each decision was, and what came after it: a written decision leaves the list before
  // its card hears back, and the focus must still move to the one below it.
  const placeOf = useRef(new Map<string, { at: number; next: string | null }>());
  useEffect(() => {
    latest.current = { sel, desktop, go, nav, list };
    list.forEach((e, i) => placeOf.current.set(e.key, { at: i, next: nextKey(nav, e.key) }));
  });
  /** A decision card's plan was written: it collapses to its done row, the next one takes focus. */
  const cardDone = (key: string, label: string) => {
    const cur = latest.current;
    const place = placeOf.current.get(key);
    const i = cur.list.findIndex((e) => e.key === key);
    const at = i >= 0 ? i : (place?.at ?? 0);
    setDone((d) => [...d, { key, label, at }]);
    if (cur.sel === key) {
      const next =
        i >= 0
          ? nextKey(cur.nav, key)
          : place?.next && cur.nav.some((e) => e.key === place.next)
            ? place.next
            : (cur.nav[Math.min(at, cur.nav.length - 1)]?.key ?? null);
      cur.go(next);
    }
  };
  const skip = (key: string) => {
    setSkipped((cur) => [...cur.filter((k) => k !== key), key]);
    const following = nextKey(nav, key);
    if (following && following !== key) go(following);
  };

  const step = (dir: 1 | -1) => {
    if (!nav.length) return;
    // Nothing selected yet on a phone: the first j/k lands on the first item, not the second.
    // On desktop the first one is already the focused decision (Today's card), so j moves on.
    if (!focusedRow && !desktop) return go(nav[0]!.key);
    const i = Math.max(
      0,
      nav.findIndex((e) => e.key === selectedRow?.key),
    );
    const to = nav[Math.min(nav.length - 1, Math.max(0, i + dir))];
    if (to) go(to.key);
  };
  useShortcut({
    id: 'inbox:next',
    keys: ['j'],
    label: 'Next item',
    group: 'Needs you',
    run: () => step(1),
  });
  useShortcut({
    id: 'inbox:prev',
    keys: ['k'],
    label: 'Previous item',
    group: 'Needs you',
    run: () => step(-1),
  });
  useShortcut({
    id: 'inbox:open',
    keys: ['Enter'],
    label: 'Open item',
    group: 'Needs you',
    run: () => {
      const e = selectedRow ?? nav[0];
      if (e) openRow(e);
    },
  });
  useShortcut({
    id: 'inbox:approve',
    keys: ['a'],
    label: 'Approve',
    group: 'Needs you',
    run: () => {
      if (cardEntry && (!selectedRow || selectedRow.key === cardEntry.key))
        cardRef.current?.approve();
    },
  });
  useShortcut({
    id: 'today:edit',
    keys: ['e'],
    label: 'Edit the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.edit(),
  });
  useShortcut({
    id: 'today:ask',
    keys: ['c'],
    label: 'Ask the agent for changes',
    group: 'Needs you',
    priority: 1,
    run: () => {
      if (!cardRef.current?.ask?.()) capture?.open();
    },
  });
  useShortcut({
    id: 'today:prev-version',
    keys: ['['],
    label: 'Earlier version of the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.version?.(-1),
  });
  useShortcut({
    id: 'today:next-version',
    keys: [']'],
    label: 'Later version of the proposal',
    group: 'Needs you',
    run: () => cardRef.current?.version?.(1),
  });
  useShortcut({
    id: 'today:skip',
    keys: ['s'],
    label: 'Skip for now',
    group: 'Needs you',
    run: () => {
      const r = selectedRow ?? nav[0];
      if (r) skip(r.key);
    },
  });
  useShortcut({
    id: 'inbox:iterate',
    keys: ['r'],
    label: 'Send back or reject',
    group: 'Needs you',
    run: () => {
      if (cardEntry && (!selectedRow || selectedRow.key === cardEntry.key))
        cardRef.current?.reject();
    },
  });
  useShortcut({
    id: 'inbox:close',
    keys: ['Escape'],
    label: 'Close',
    group: 'Needs you',
    run: () => {
      if (focusedRow) go(null, false);
    },
  });

  const filterOptions = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'approvals', label: 'Approvals', count: counts.approvals },
    { value: 'questions', label: 'Questions', count: counts.questions },
  ];

  // From the search as it is now (not this render's copy): two quick changes must both stick.
  const setSearch = (patch: Partial<{ f: string; org: string; label: string }>) =>
    void navigate({
      to: '/',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        delete next.sel;
        for (const k of Object.keys(next)) if (!next[k] || next[k] === 'all') delete next[k];
        return next as never;
      },
      replace: true,
    });
  const activeFilters = (filter !== 'all' ? 1 : 0) + (labelFilter ? 1 : 0);
  const chips = (
    <div className="flex flex-col gap-3">
      <Segmented
        label="Filter"
        value={filter}
        onValueChange={(v) => setSearch({ f: v })}
        options={filterOptions}
      />
      {labelOptions.length > 0 || labelFilter ? (
        <Select
          label="Filter by label"
          hideLabel
          inline
          value={labelFilter ?? 'all'}
          onValueChange={(v) => setSearch({ label: v })}
          options={[
            { value: 'all', label: 'All labels' },
            ...labelOptions.map((o) => ({ value: o.key, label: `${o.label} (${o.count})` })),
            ...(labelFilter && !labelOptions.some((o) => o.key === labelFilter)
              ? [{ value: labelFilter, label: labelFilter }]
              : []),
          ]}
        />
      ) : null}
    </div>
  );

  const agentNameOf = (w: string, id: string) =>
    (w === session.workspaceId ? shell.agents.find((a) => a.id === id)?.data.name : undefined) ??
    'Your agent';
  const orgTag = (wid: string) => (manyOrgs ? today.orgOf(wid) : null);
  const renderRow = (r: NeedsEntry) =>
    cardEntry?.key === r.key ? (
      <motion.li key={r.key} layout={false} className="pb-3" data-card-row={r.key}>
        <DecisionCard
          ref={cardRef}
          key={r.key}
          entry={r}
          org={today.orgOf(r.wid)}
          area={today.areaOf(r)}
          sender={today.senderOf(r)}
          now={now}
          agentName={(id) => agentNameOf(r.wid, id)}
          onOpen={() => openRow(r)}
          onSkip={() => skip(r.key)}
          onDone={(label) => cardDone(r.key, label)}
          swipe={!desktop}
        />
      </motion.li>
    ) : (
      <DecisionRow
        key={r.key}
        entry={r}
        sender={today.senderOf(r)?.name ?? null}
        org={orgTag(r.wid)}
        now={now}
        onFocus={() => go(r.key, false)}
      />
    );

  /** The stack's rows, with the decisions made this visit collapsed where they were. */
  const flat = (entries: NeedsEntry[], withDone: boolean) => {
    const out: ReactNode[] = [];
    const doneRows = withDone ? [...done].sort((a, b) => a.at - b.at) : [];
    let d = 0;
    entries.forEach((r, i) => {
      while (d < doneRows.length && doneRows[d]!.at <= i) {
        const x = doneRows[d++]!;
        if (!entries.some((e) => e.key === x.key))
          out.push(<DoneRow key={`done:${x.key}:${d}`} label={x.label} />);
      }
      out.push(renderRow(r));
    });
    for (; d < doneRows.length; d++) {
      const x = doneRows[d]!;
      if (!entries.some((e) => e.key === x.key))
        out.push(<DoneRow key={`done:${x.key}:${d}`} label={x.label} />);
    }
    return out;
  };

  const rows = (
    <ul aria-label="Needs you" className="flex flex-col">
      <AnimatePresence initial={false} mode="popLayout">
        {flat(allRows ? list : list.slice(0, FIRST_ROWS), true)}
      </AnimatePresence>
    </ul>
  );

  const activeAgents = shell.agents.some((a) => !a.data.revokedAt);
  const empty = loading ? null : (
    <EmptyState
      icon={Inbox}
      title="Nothing needs you."
      description={
        activeAgents
          ? 'Agents are idle. New decisions show up here as they arrive.'
          : 'New decisions show up here as they arrive.'
      }
    />
  );

  // Everything, in every organization and filter.
  const total = everything.length;
  const summaryLine = total
    ? `${total} ${total === 1 ? 'thing needs' : 'things need'} you.`
    : 'You are all caught up.';

  const filtersButton = (
    <Popover
      label="Filters"
      align="end"
      contentClassName="w-[min(26rem,calc(100vw-16px))] p-3 sm:p-4"
      trigger={
        <Button
          variant="secondary"
          className="min-h-9"
          leading={<Icon icon={SlidersHorizontal} size={15} />}
        >
          Filters{activeFilters ? ` · ${activeFilters}` : ''}
        </Button>
      }
    >
      {chips}
    </Popover>
  );
  // The organization chips (item icVly): a filter of this page only, kept in the URL.
  const orgChips = manyOrgs ? (
    <OrgChips
      className="mb-4"
      orgs={all.orgs}
      value={orgFilter}
      onChange={(w) => setSearch({ org: w ?? 'all' })}
      hint="Tap an organization to see only its decisions"
    />
  ) : null;
  const stackHead = (
    <div className="mb-3 flex items-center gap-3">
      <h2 className="font-mono text-12 font-medium uppercase tracking-[0.08em] text-text-3">
        Needs you · {list.length}
      </h2>
      <span className="ml-auto hidden items-center gap-1 text-12 text-text-3 [@media(hover:hover)]:sm:inline-flex">
        J/K move · A approve · E edit
      </span>
      <span className="max-sm:ml-auto">{filtersButton}</span>
    </div>
  );

  return (
    <>
      <div className="mb-5">
        <BriefCard
          brief={loading ? null : today.brief}
          name={firstName(session.profile.name)}
          now={now}
          loading={loading}
          scope={
            manyOrgs ? (
              <ScopeLine className="mt-1.5">
                {loading ? null : (
                  <span data-today-count="">
                    {total === 0 ? 'Nothing waits for you' : `${total} waiting for you`}
                  </span>
                )}
              </ScopeLine>
            ) : null
          }
        />
        {/* The count for screen readers (and the old summary line's place). */}
        <p aria-live="polite" className="sr-only">
          {loading || total === 0 ? '\u00a0' : summaryLine}
        </p>
      </div>
      {loading ? (
        <div role="status" aria-label="Loading Needs you" className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-9 w-full max-w-sm" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : null}
      {loading ? null : (
        <div className="xl:grid xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start xl:gap-6">
          <div className="min-w-0">
            {total === 0 ? (
              <>
                {orgFilter ? orgChips : null}
                {activeFilters ? stackHead : null}
                <div className="mt-2">{empty}</div>
              </>
            ) : (
              <>
                {orgChips}
                {stackHead}
                {list.length === 0 && tidyAll.length === 0 ? (
                  <p className="py-4 text-14 text-text-2">Nothing in this filter.</p>
                ) : list.length ? (
                  rows
                ) : null}
                <TidyUps
                  entries={tidyAll}
                  kept={kept}
                  onKeep={(key, on) =>
                    setKept((cur) => {
                      const next = new Set(cur);
                      if (on) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                  onDone={(keys) => {
                    if (keys.length)
                      setDone((d) => [
                        ...d,
                        {
                          key: `tidy:${keys.join(',')}`,
                          label: `Approved ${keys.length} ${keys.length === 1 ? 'tidy-up' : 'tidy-ups'}`,
                          at: list.length,
                        },
                      ]);
                  }}
                />
              </>
            )}
          </div>
          <aside aria-label="Your day" className="mt-6 xl:mt-0">
            <TodayRail waiting={today.waiting} working={today.working} now={now} />
          </aside>
        </div>
      )}
    </>
  );
}
