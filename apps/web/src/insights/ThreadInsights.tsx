import { inboxEventSchema } from '@hive/shared';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { collection, limit, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { ChartNoAxesColumn, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useThreadTitles } from '../activity/data';
import { INDEX_BUILDING_TEXT } from '../activity/logic';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveQuery } from '../lib/live';
import { displayName, useProfiles } from '../members/data';
import { PageHeader } from '../pages/Chrome';
import { Eyebrow } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { CountUp, EmptyState, Kpi, Skeleton } from '../ui/feedback';
import { Segmented, Select } from '../ui/form';
import { download, TagBar } from './parts';
import { formatWait, parseRange, RANGES, rangeStart, type Range } from './logic';
import {
  byStep,
  DECISION_TYPES,
  decisionText,
  threadCsv,
  threadKpis,
  toDecision,
  type DecisionKind,
  type ThreadDecision,
} from './threadLogic';

const CAP = 500;
const PAGE = 25;

const TONE: Record<DecisionKind, string> = {
  approved: 'text-approve-text',
  changes: 'text-sendback',
  rejected: 'text-sendback',
  stopped: 'text-sendback',
};
const GLYPH: Record<DecisionKind, string> = {
  approved: '✓',
  changes: '↩',
  rejected: '✕',
  stopped: '■',
};

const whenOf = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Decision insights on threads (item OE8FmrTaIxFVGcaeGG3N, slice 9, design 6.7): how your
 * decisions on threads go, over 7, 30 or 90 days. Reads your own decision events only.
 */
export function ThreadInsightsView() {
  const { session } = useReady();
  const wid = session.workspaceId;
  const uid = session.me.uid;
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { range?: number };
  const range: Range = parseRange(search.range);
  const [now] = useState(() => Date.now());
  const since = rangeStart(range, now);

  const live = useLiveQuery(
    `thread-decisions:${wid}:${uid}:${since}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/inboxEvents`),
        where('memberUid', '==', uid),
        where('type', 'in', [...DECISION_TYPES]),
        where('at', '>=', Timestamp.fromMillis(since)),
        orderBy('at', 'desc'),
        limit(CAP),
      ),
    inboxEventSchema,
  );
  const rows: ThreadDecision[] = useMemo(
    () =>
      live.state === 'ready'
        ? live.data.flatMap((r) => {
            const d = toDecision(r.id, r.data);
            return d && d.at >= since ? [d] : [];
          })
        : [],
    [live, since],
  );
  const capped = live.state === 'ready' && live.data.length >= CAP;

  const titleOf = useThreadTitles(wid, rows);
  const people = useMemo(() => [...new Set(rows.map((r) => r.byUid))], [rows]);
  const profiles = useProfiles(wid, people);
  const person = (u: string) => displayName(profiles[u], u);

  const kpis = useMemo(() => threadKpis(rows), [rows]);
  const steps = useMemo(() => byStep(rows), [rows]);
  const [stepFilter, setStepFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const log = useMemo(
    () => rows.filter((r) => !stepFilter || r.step === stepFilter).sort((a, b) => b.at - a.at),
    [rows, stepFilter],
  );
  const topBack = kpis.sentBackTo[0];

  function exportCsv() {
    const out = threadCsv(log, { thread: (t) => titleOf(t) ?? t ?? '', person });
    download(`hivenod-decisions-${new Date().toISOString().slice(0, 10)}.csv`, out);
  }

  const loading = live.state === 'loading';
  const error = live.state === 'error';
  const building = error && live.code === 'failed-precondition';

  return (
    <>
      <PageHeader
        title="Decision insights"
        subtitle="How your decisions on threads go: what you approve, what you send back and where, how long things wait for you."
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
          onValueChange={(v) =>
            void navigate({ to: '/insights', search: { range: Number(v) as Range } })
          }
          options={RANGES.map((r) => ({ value: String(r), label: `${r} days` }))}
        />
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" aria-busy>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : error ? (
        <EmptyState
          icon={ChartNoAxesColumn}
          title={building ? 'Still preparing this view' : 'Decisions could not be loaded'}
          description={building ? INDEX_BUILDING_TEXT : 'Check your connection and reload.'}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ChartNoAxesColumn}
          title="No decisions yet in this period"
          description="Approve, ask for changes or stop a step on a thread and it shows up here."
        />
      ) : (
        <div className="flex flex-col gap-8" data-testid="thread-insights">
          <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi label="Decisions" hint={`${kpis.approved} approved`}>
              <span data-testid="kpi-made">
                <CountUp to={kpis.made} />
              </span>
            </Kpi>
            <Kpi label="Approved first time" hint="Per step or proposal">
              <span data-testid="kpi-first">
                {kpis.firstTimePct === null ? 'n/a' : <CountUp to={kpis.firstTimePct} suffix="%" />}
              </span>
            </Kpi>
            <Kpi
              label="Sent back"
              hint={
                topBack
                  ? `${topBack.count} at ${topBack.step}`
                  : kpis.stopped
                    ? `${kpis.stopped} stopped`
                    : 'Nothing sent back'
              }
            >
              <span data-testid="kpi-sentback">
                <CountUp to={kpis.sentBack} />
              </span>
            </Kpi>
            <Kpi label="Median wait" hint="Before you decided">
              <span data-testid="median-wait">{formatWait(kpis.medianWaitMs)}</span>
            </Kpi>
            <Kpi label="Recommendation followed" hint="When the summary recommended">
              <span data-testid="kpi-followed">
                {kpis.followedPct === null ? 'n/a' : <CountUp to={kpis.followedPct} suffix="%" />}
              </span>
            </Kpi>
          </section>

          <section aria-labelledby="back-h">
            <h2 id="back-h" className="mb-2 text-20 font-semibold">
              Sent back, by step
            </h2>
            {kpis.sentBackTo.length ? (
              <div className="flex flex-col" data-testid="sent-back-to">
                {kpis.sentBackTo.map((t) => (
                  <TagBar
                    key={t.step}
                    label={t.step}
                    count={t.count}
                    total={Math.max(kpis.sentBack, 1)}
                    active={false}
                    onClick={() => setStepFilter(t.step.split(' → ')[0] ?? '')}
                  />
                ))}
              </div>
            ) : (
              <p className="text-14 text-text-2">Nothing was sent back in this period.</p>
            )}
          </section>

          <section aria-labelledby="steps-h">
            <h2 id="steps-h" className="mb-3 text-20 font-semibold">
              By step
            </h2>
            <div>
              <table className="hidden w-full text-left text-14 sm:table" data-testid="by-step">
                <thead>
                  <tr className="border-b border-line">
                    {['Step', 'Decided', 'Approved', 'Sent back', 'Stopped', 'Median wait'].map(
                      (h) => (
                        <th key={h} scope="col" className="py-2 pr-3 align-bottom">
                          <Eyebrow>{h}</Eyebrow>
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {steps.map((s) => (
                    <tr key={s.step} className="border-b border-line">
                      <th scope="row" className="py-2.5 pr-3 font-medium text-ink">
                        {s.step}
                      </th>
                      <td className="py-2.5 pr-3 tabular-nums">{s.made}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{s.approved}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{s.sentBack}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{s.stopped + s.rejected}</td>
                      <td className="py-2.5 pr-3 tabular-nums">{formatWait(s.medianWaitMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="flex flex-col gap-2 sm:hidden" data-testid="by-step-cards">
                {steps.map((s) => (
                  <li key={s.step} className="rounded-card border border-line bg-surface p-3">
                    <p className="font-medium text-ink">{s.step}</p>
                    <p className="mt-0.5 text-13 text-text-2">
                      {s.made} decided · {s.approved} approved · {s.sentBack} sent back ·{' '}
                      {s.stopped + s.rejected} stopped · median wait {formatWait(s.medianWaitMs)}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section aria-labelledby="log-title" id="log" className="scroll-mt-20">
            <h2 id="log-title" className="mb-3 text-20 font-semibold">
              Decision log
            </h2>
            <div className="mb-3 max-w-xs">
              <Select
                label="Step"
                value={stepFilter}
                onValueChange={(v) => {
                  setStepFilter(v);
                  setShown(PAGE);
                }}
                options={[
                  { value: '', label: 'All steps' },
                  ...steps.map((s) => ({ value: s.step, label: s.step })),
                ]}
              />
            </div>
            <ul data-testid="decision-log" className="flex flex-col gap-2">
              {log.slice(0, shown).map((r) => (
                <li key={r.id} className="rounded-card border border-line bg-surface p-3">
                  <div className="flex items-start justify-between gap-2">
                    {r.threadId ? (
                      <Link
                        to="/inbox/$wid/t/$tid"
                        params={{ wid, tid: r.threadId }}
                        className="font-medium text-ink underline underline-offset-4 foc:outline-2 foc:outline-offset-2 foc:outline-focus"
                      >
                        {titleOf(r.threadId) ?? 'A thread'}
                      </Link>
                    ) : (
                      <span className="font-medium text-ink">A thread</span>
                    )}
                    <span className="shrink-0 text-13 text-text-2">{whenOf(r.at)}</span>
                  </div>
                  <p className={cn('mt-1 text-14 font-medium', TONE[r.kind])}>
                    <span aria-hidden>{GLYPH[r.kind]}</span> {decisionText(r)}
                    <span className="font-normal text-text-2"> at {r.step}</span>
                  </p>
                  {r.reason ? <p className="mt-1 text-14 text-ink">“{r.reason}”</p> : null}
                  <p className="mt-1 text-13 text-text-2">
                    {person(r.byUid)}
                    {r.waitedMs !== null ? ` · waited ${formatWait(r.waitedMs)}` : ''}
                    {r.recommended
                      ? ` · recommended “${r.recommended}”${r.followed === null ? '' : r.followed ? ', followed' : ', not followed'}`
                      : ''}
                  </p>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex items-center justify-between gap-3 text-13 text-text-2">
              <span>
                Showing {Math.min(shown, log.length)} of {log.length}
                {capped ? ` (the latest ${CAP})` : ''}
              </span>
              {shown < log.length ? (
                <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>
                  Show more
                </Button>
              ) : null}
            </div>
          </section>
          <p className="text-13 text-text-2">
            Older project decisions are not shown here; they are in the organization export.
            {kpis.sentBackTo.length ? ` Most send backs: ${backLabel0(kpis.sentBackTo)}.` : ''}
          </p>
        </div>
      )}
    </>
  );
}

const backLabel0 = (l: Array<{ step: string; count: number }>) => l[0]?.step ?? '';
