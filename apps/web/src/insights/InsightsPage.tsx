import { decisionSchema, type Project } from '@hive/shared';
import { getRouteApi, useNavigate, useSearch } from '@tanstack/react-router';
import { collection, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { ChartNoAxesColumn, Download, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveQuery, type Row } from '../lib/live';
import { displayName, useProfiles } from '../members/data';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { CountUp, EmptyState, Kpi, Skeleton } from '../ui/feedback';
import { Input, Segmented, Select } from '../ui/form';
import { ThreadInsightsView } from './ThreadInsights';
import { download, TagBar } from './parts';
import {
  CSV_BOM,
  NO_FILTER,
  RANGES,
  computeKpis,
  filterLog,
  formatWait,
  inRange,
  latestRationales,
  outcomeLabel,
  parseRange,
  rangeStart,
  tagCounts,
  toCsv,
  type DecisionRow,
  type LogFilter,
  type OutcomeFilter,
  type Range,
  type StepName,
} from './logic';

const CAP = 500;
const PAGE = 25;

/** One live listener per project for decisions inside the window (members may only read per project). */
function DecisionsFeed({
  wid,
  pid,
  since,
  onRows,
}: {
  wid: string;
  pid: string;
  since: number;
  onRows: (pid: string, rows: Row<ReturnType<typeof decisionSchema.parse>>[] | null) => void;
}) {
  const live = useLiveQuery(
    `decisions-feed:${wid}:${pid}:${since}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/projects/${pid}/decisions`),
        where('at', '>=', Timestamp.fromMillis(since)),
        orderBy('at', 'desc'),
        limit(CAP),
      ),
    decisionSchema,
  );
  useEffect(() => {
    if (live.state === 'ready') onRows(pid, live.data);
    else if (live.state === 'error') onRows(pid, []);
  }, [live, pid, onRows]);
  return null;
}

const whenOf = (r: DecisionRow) =>
  new Date(r.d.at.toMillis()).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const OUTCOME_TONE: Record<string, string> = {
  approved: 'text-approve-text',
  sentBack: 'text-sendback',
  stopped: 'text-sendback',
  answered: 'text-text-2',
};

/**
 * Screen 5: how decisions go. `pid` limits it to one project (the project's Insights tab); without
 * it, every project the person can see (SPEC 9.5). All maths is client-side over the window.
 */
export function InsightsView({ pid }: { pid?: string }) {
  const { session } = useReady();
  const wid = session.workspaceId;
  const shell = useShellData();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { range?: number; project?: string };
  const range: Range = parseRange(search.range);
  const projectFilter = pid ?? search.project ?? '';
  const [now] = useState(() => Date.now());
  const since = rangeStart(range, now);

  const projects = useMemo(() => {
    const m = new Map<string, Project>();
    for (const p of shell.projects) m.set(p.id, p.data);
    return m;
  }, [shell.projects]);
  const pids = useMemo(
    () => shell.projects.map((p) => p.id).filter((id) => !projectFilter || id === projectFilter),
    [shell.projects, projectFilter],
  );

  const [byProject, setByProject] = useState<
    Record<string, Row<ReturnType<typeof decisionSchema.parse>>[]>
  >({});
  const onRows = useCallback(
    (id: string, rows: Row<ReturnType<typeof decisionSchema.parse>>[] | null) =>
      setByProject((cur) => ({ ...cur, [id]: rows ?? [] })),
    [],
  );
  const loading = shell.loading || pids.some((id) => !(id in byProject));
  const rows: DecisionRow[] = useMemo(
    () =>
      inRange(
        pids.flatMap((id) => (byProject[id] ?? []).map((r) => ({ id: r.id, pid: id, d: r.data }))),
        since,
      ),
    [pids, byProject, since],
  );
  const capped = pids.some((id) => (byProject[id]?.length ?? 0) >= CAP);

  const stepName: StepName = useCallback(
    (r, stepId) => projects.get(r.pid)?.steps.find((s) => s.id === stepId)?.name ?? stepId,
    [projects],
  );
  const stepNameIn = (id: string, stepId: string) => stepName({ pid: id } as DecisionRow, stepId);

  const people = useMemo(() => [...new Set(rows.map((r) => r.d.byUid))], [rows]);
  const profiles = useProfiles(wid, people);
  const person = (uid: string) => displayName(profiles[uid], uid);

  const [filter, setFilter] = useState<LogFilter>(NO_FILTER);
  const [shown, setShown] = useState(PAGE);
  const set = (patch: Partial<LogFilter>) => {
    setFilter((f) => ({ ...f, ...patch }));
    setShown(PAGE);
  };

  const kpis = useMemo(() => computeKpis(rows, stepName), [rows, stepName]);
  const tags = useMemo(() => tagCounts(rows), [rows]);
  const quotes = useMemo(() => latestRationales(rows, 4), [rows]);
  const log = useMemo(() => filterLog(rows, filter, stepName), [rows, filter, stepName]);
  const stepOptions = useMemo(
    () => [...new Set(rows.map((r) => stepName(r, r.d.stepId)))].sort(),
    [rows, stepName],
  );
  const topBack = kpis.sentBackTo[0];

  function setRange(r: Range) {
    if (pid) void navigate({ to: '/p/$pid/insights', params: { pid }, search: { range: r } });
    else
      void navigate({
        to: '/insights',
        search: { range: r, ...(projectFilter ? { project: projectFilter } : {}) },
      });
  }

  function exportCsv() {
    // Step ids are per project, so the CSV is built from copies that carry step names.
    const named = log.map((r) => ({
      ...r,
      d: {
        ...r.d,
        stepId: stepName(r, r.d.stepId),
        toStepId: r.d.toStepId ? stepName(r, r.d.toStepId) : null,
      },
    }));
    const out = toCsv(named, {
      step: (s) => s,
      person,
      project: (id) => projects.get(id)?.name ?? id,
    });
    download(`hivenod-decisions-${new Date().toISOString().slice(0, 10)}.csv`, out || CSV_BOM);
  }

  const project = pid ? projects.get(pid) : undefined;
  const isEmpty = !loading && rows.length === 0;

  return (
    <>
      {pids.map((id) => (
        <DecisionsFeed key={id} wid={wid} pid={id} since={since} onRows={onRows} />
      ))}
      <PageHeader
        title={pid ? 'Insights' : 'Decision insights'}
        subtitle={
          pid && project
            ? `How decisions go in ${project.name}.`
            : 'Why things get sent back, how long you take, and what to fix in agent instructions.'
        }
        action={
          <Button
            variant="secondary"
            leading={<Download size={16} />}
            onClick={exportCsv}
            disabled={!log.length}
          >
            Export CSV
          </Button>
        }
      />

      <div className="mb-6 flex flex-wrap items-end gap-3">
        <Segmented
          label="Range"
          value={String(range)}
          onValueChange={(v) => setRange(Number(v) as Range)}
          options={RANGES.map((r) => ({ value: String(r), label: `${r} days` }))}
        />
        {!pid && shell.projects.length > 1 ? (
          <div className="min-w-44">
            <Select
              label="Project"
              value={projectFilter}
              onValueChange={(v) => {
                setFilter(NO_FILTER);
                void navigate({ to: '/insights', search: { range, ...(v ? { project: v } : {}) } });
              }}
              options={[
                { value: '', label: 'All projects' },
                ...shell.projects.map((p) => ({
                  value: p.id,
                  label: `${p.data.emoji} ${p.data.name}`.trim(),
                })),
              ]}
            />
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : isEmpty ? (
        <EmptyState
          icon={ChartNoAxesColumn}
          title="No decisions yet in this period"
          description="Approve, send back or stop an item and it shows up here with your reason."
        />
      ) : (
        <div className="flex flex-col gap-8">
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi label="Decisions made" hint={`${kpis.approved} approved`}>
              <CountUp to={kpis.made} />
            </Kpi>
            <Kpi label="Approved first time" hint="Per item and step">
              {kpis.firstTimePct === null ? 'n/a' : <CountUp to={kpis.firstTimePct} suffix="%" />}
            </Kpi>
            <Kpi
              label="Sent back"
              hint={
                topBack
                  ? `${topBack.count} to ${topBack.step}${kpis.sentBackTo.length > 1 ? ' and more' : ''}`
                  : kpis.stopped
                    ? `${kpis.stopped} stopped`
                    : 'Nothing sent back'
              }
            >
              <CountUp to={kpis.sentBack} />
            </Kpi>
            <Kpi label="Median wait for you" hint="Time before you decide">
              <span data-testid="median-wait">{formatWait(kpis.medianWaitMs)}</span>
            </Kpi>
          </section>

          <section aria-labelledby="why">
            <h2 id="why" className="mb-2 text-20 font-semibold">
              Why things were sent back
            </h2>
            {tags.length ? (
              <div className="flex flex-col">
                {tags.slice(0, 8).map((t) => (
                  <TagBar
                    key={t.tag}
                    label={t.tag}
                    count={t.count}
                    total={Math.max(kpis.sentBack, tags[0]?.count ?? 1)}
                    active={filter.tag === t.tag}
                    onClick={() => {
                      set(filter.tag === t.tag ? { tag: '' } : { tag: t.tag, outcome: 'sentBack' });
                      document.getElementById('log')?.scrollIntoView?.({ behavior: 'smooth' });
                    }}
                  />
                ))}
              </div>
            ) : (
              <p className="text-14 text-text-2">
                No tagged send-backs yet. Tags you pick when sending an item back are counted here.
              </p>
            )}
          </section>

          {quotes.length ? (
            <section aria-labelledby="latest">
              <h2 id="latest" className="mb-3 text-20 font-semibold">
                Latest rationales
              </h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {quotes.map((r) => (
                  <figure key={r.id} className="rounded-card border border-line bg-surface p-4">
                    <blockquote className="text-14 text-ink">“{r.d.rationale}”</blockquote>
                    <figcaption className="mt-2 text-13 text-text-2">
                      {person(r.d.byUid)} · {r.d.itemTitle} · {stepName(r, r.d.stepId)}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}

          <section aria-labelledby="log-title" id="log" className="scroll-mt-20">
            <h2 id="log-title" className="mb-3 text-20 font-semibold">
              Decision log
            </h2>
            <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Select
                label="Step"
                value={filter.step}
                onValueChange={(v) => set({ step: v })}
                options={[
                  { value: '', label: 'All steps' },
                  ...stepOptions.map((s) => ({ value: s, label: s })),
                ]}
              />
              <Select
                label="Outcome"
                value={filter.outcome}
                onValueChange={(v) => set({ outcome: v as OutcomeFilter })}
                options={[
                  { value: 'all', label: 'All outcomes' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'sentBack', label: 'Sent back' },
                  { value: 'stopped', label: 'Stopped' },
                  { value: 'answered', label: 'Answered' },
                ]}
              />
              <Select
                label="Person"
                value={filter.person}
                onValueChange={(v) => set({ person: v })}
                options={[
                  { value: '', label: 'Everyone' },
                  ...people.map((u) => ({ value: u, label: person(u) })),
                ]}
              />
              <div className="relative">
                <Input
                  label="Search reasons"
                  value={filter.search}
                  onChange={(e) => set({ search: e.target.value })}
                  placeholder="Search in rationale"
                />
                <Search
                  size={16}
                  aria-hidden
                  className="pointer-events-none absolute bottom-3.5 right-3 text-text-2"
                />
              </div>
            </div>
            {filter.tag ? (
              <p className="mb-3 text-14 text-text-2">
                Showing decisions tagged <span className="font-medium text-ink">{filter.tag}</span>.{' '}
                <button
                  type="button"
                  className="font-medium text-ink underline"
                  onClick={() => set({ tag: '', outcome: 'all' })}
                >
                  Clear
                </button>
              </p>
            ) : null}

            {log.length ? (
              <>
                <table className="hidden w-full text-left text-14 md:table">
                  <thead>
                    <tr className="border-b border-line">
                      {['When', 'Item', 'Step', 'Decision', 'By', 'Rationale'].map((h) => (
                        <th key={h} scope="col" className="py-2 pr-3">
                          <Eyebrow>{h}</Eyebrow>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {log.slice(0, shown).map((r) => {
                      const o = outcomeLabel(r, (id) => stepNameIn(r.pid, id));
                      return (
                        <tr key={r.id} className="border-b border-line align-top">
                          <td className="whitespace-nowrap py-2.5 pr-3 text-text-2">{whenOf(r)}</td>
                          <td className="max-w-48 py-2.5 pr-3 font-medium text-ink">
                            {r.d.itemTitle}
                          </td>
                          <td className="py-2.5 pr-3 text-text-2">
                            {stepNameIn(r.pid, r.d.stepId)}
                          </td>
                          <td className={cn('py-2.5 pr-3 font-medium', OUTCOME_TONE[r.d.outcome])}>
                            <span aria-hidden>{o.glyph}</span> {o.text}
                          </td>
                          <td className="py-2.5 pr-3 text-text-2">{person(r.d.byUid)}</td>
                          <td className="py-2.5 text-ink">{r.d.rationale || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <ul data-testid="log-cards" className="flex flex-col gap-2 md:hidden">
                  {log.slice(0, shown).map((r) => {
                    const o = outcomeLabel(r, (id) => stepNameIn(r.pid, id));
                    return (
                      <li key={r.id} className="rounded-card border border-line bg-surface p-3">
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium text-ink">{r.d.itemTitle}</span>
                          <span className="shrink-0 text-13 text-text-2">{whenOf(r)}</span>
                        </div>
                        <p className={cn('mt-1 text-14 font-medium', OUTCOME_TONE[r.d.outcome])}>
                          <span aria-hidden>{o.glyph}</span> {o.text}
                          <span className="font-normal text-text-2">
                            {' '}
                            at {stepNameIn(r.pid, r.d.stepId)}
                          </span>
                        </p>
                        {r.d.rationale ? (
                          <p className="mt-1 text-14 text-ink">{r.d.rationale}</p>
                        ) : null}
                        <p className="mt-1 text-13 text-text-2">{person(r.d.byUid)}</p>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-3 flex items-center justify-between gap-3 text-13 text-text-2">
                  <span>
                    Showing {Math.min(shown, log.length)} of {log.length}
                    {capped ? ` (the latest ${CAP} per project)` : ''}
                  </span>
                  {shown < log.length ? (
                    <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                      Show more
                    </Button>
                  ) : null}
                </div>
              </>
            ) : (
              <p className="py-6 text-center text-14 text-text-2">
                No decisions match these filters.
              </p>
            )}
          </section>

          <p className="text-13 text-text-2">
            Every decision keeps its item, step, outcome and your reason. Agents can read this log
            when they work.
          </p>
        </div>
      )}
    </>
  );
}

/** Decision insights on threads (slice 9); the per-project page keeps the item decisions. */
export function InsightsPage() {
  return <ThreadInsightsView />;
}

const projectRoute = getRouteApi('/p/$pid/insights');
export function ProjectInsightsPage() {
  const { pid } = projectRoute.useParams();
  return <InsightsView pid={pid} />;
}
