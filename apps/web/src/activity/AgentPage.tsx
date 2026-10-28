import {
  attachmentSchema,
  decisionSchema,
  formatTokens,
  newTokens,
  releaseStale,
  runSchema,
  tokenTotals,
  type Decision,
  type Run,
} from '@hive/shared';
import { getRouteApi, Link } from '@tanstack/react-router';
import { collection, collectionGroup, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { Bot, ChevronDown, ChevronLeft, ChevronRight, Hand } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AgentSettings, PausedBanner } from '../agents/AgentSettings';
import { agentStatus, colorIndex, presenceText, scopeText } from '../agents/logic';
import { useReady } from '../auth/context';
import { db } from '../lib/db';
import { useLiveCollection, useLiveDoc, type Row } from '../lib/live';
import { PageHeader } from '../pages/Chrome';
import { useShellData } from '../shell/data';
import { formatEur } from '../shell/logic';
import { AgentAvatar } from '../ui/avatar';
import { Badge, Eyebrow, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { EmptyState, Kpi, Skeleton, WorkingDots } from '../ui/feedback';
import { Tabs } from '../ui/form';
import { Icon } from '../ui/icon';
import { Dialog, useToast } from '../ui/overlay';
import { itemSchema } from '@hive/shared';
import {
  clock,
  dayLabel,
  agentStats,
  formatDuration,
  formatElapsed,
  runState,
  INDEX_BUILDING,
  INDEX_BUILDING_TEXT,
  runWorkMs,
  verdictFor,
  WINDOWS,
  windowStart,
  type RunState,
  type WindowId,
} from './logic';
import { useItemTitles, useNow, useScopedQuery } from './data';
import { RunLog } from './RunLog';

const route = getRouteApi('/agents/$id');
const DAY = 86_400_000;

const STATE_TONE: Record<RunState, { tone: Tone; label: string }> = {
  running: { tone: 'agent', label: 'Running' },
  stalled: { tone: 'gate', label: 'Stalled' },
  done: { tone: 'approve', label: 'Done' },
  failed: { tone: 'sendback', label: 'Failed' },
  released: { tone: 'neutral', label: 'Released' },
  // A person pressed Stop work (card BrK0r2FE): not a failure.
  stopped: { tone: 'neutral', label: 'Stopped' },
};

export function AgentPage() {
  const { id } = route.useParams();
  const { agents, projects, items, agentsKnown } = useShellData();
  // An agent missing from a cached list may still exist: "not found" only on the server's word.
  const loading = !agentsKnown;
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    return (
      <>
        <BackLink />
        <PageHeader title={loading ? 'Agent' : 'Agent not found'} />
        {loading ? (
          <Skeleton className="h-24" />
        ) : (
          <EmptyState
            icon={Bot}
            title="No such agent"
            description="It may have been removed, or it belongs to another organization."
          />
        )}
      </>
    );
  }
  return <Profile id={id} agent={agent} projects={projects} items={items} />;
}

function BackLink() {
  return (
    <Link
      to="/agents"
      className="-ml-2 mb-1 inline-flex min-h-11 items-center gap-1 rounded-btn px-2 text-14 text-text-2 hover:text-ink"
    >
      <Icon icon={ChevronLeft} />
      Agents
    </Link>
  );
}

function Profile({
  id,
  agent,
  projects,
  items,
}: {
  id: string;
  agent: Row<import('@hive/shared').Agent>;
  projects: ReturnType<typeof useShellData>['projects'];
  items: ReturnType<typeof useShellData>['items'];
}) {
  const { session } = useReady();
  const wid = session.workspaceId;
  const isAdmin = session.isAdmin;
  const now = useNow(1000);
  const [since] = useState(() => Timestamp.fromMillis(Date.now() - 30 * DAY));
  const projectIds = useMemo(() => projects.map((p) => p.id), [projects]);

  const runsLive = useScopedQuery({
    key: `runs-of-agent:${wid}:${id}`,
    enabled: true,
    isAdmin,
    projectIds,
    admin: () =>
      query(
        collection(db, `workspaces/${wid}/runs`),
        where('agentUid', '==', id),
        where('startedAt', '>=', since),
        orderBy('startedAt', 'desc'),
      ),
    perProject: (pid) =>
      query(
        collection(db, `workspaces/${wid}/runs`),
        where('projectId', '==', pid),
        where('agentUid', '==', id),
        where('startedAt', '>=', since),
        orderBy('startedAt', 'desc'),
      ),
    schema: runSchema,
  });
  const decisionsLive = useScopedQuery({
    key: `decisions-30d:${wid}`,
    enabled: true,
    isAdmin,
    projectIds,
    admin: () =>
      query(
        collectionGroup(db, 'decisions'),
        where('workspaceId', '==', wid),
        where('at', '>=', since),
        orderBy('at', 'desc'),
      ),
    perProject: (pid) =>
      query(
        collection(db, `workspaces/${wid}/projects/${pid}/decisions`),
        where('at', '>=', since),
        orderBy('at', 'desc'),
      ),
    schema: decisionSchema,
  });

  const runs = useMemo(
    () =>
      runsLive.state === 'ready'
        ? [...runsLive.data].sort(
            (a, b) => b.data.startedAt.toMillis() - a.data.startedAt.toMillis(),
          )
        : [],
    [runsLive],
  );
  const decisions = useMemo(
    () => (decisionsLive.state === 'ready' ? decisionsLive.data : []),
    [decisionsLive],
  );

  const building =
    (runsLive.state === 'error' && runsLive.code === INDEX_BUILDING) ||
    (decisionsLive.state === 'error' && decisionsLive.code === INDEX_BUILDING);
  const known = useMemo(() => {
    const m = new Map<string, string>();
    for (const [pid, rows] of Object.entries(items))
      for (const r of rows) m.set(`${pid}/${r.id}`, r.data.title);
    return (pid: string, iid: string) => m.get(`${pid}/${iid}`);
  }, [items]);
  const titleOf = useItemTitles(
    wid,
    runs.map((r) => r.data),
    known,
  );

  const status = agentStatus(id, agent.data, runs, items, now);
  const lives = runs.filter((r) => runState(r.data, now) === 'running');
  const live = lives[0];
  // Card cGSENsRF: a channel session with max_items works on several items at once.
  const liveItems = new Set(lives.map((r) => `${r.data.projectId}/${r.data.itemId}`)).size;
  const projectById = new Map(projects.map((p) => [p.id, p.data] as const));
  const pausedShown = Boolean(agent.data.pausedAt) && !live;
  const [win, setWin] = useState<WindowId>('today');

  return (
    <>
      <BackLink />
      <header className="mb-6 flex items-start gap-4">
        <AgentAvatar
          name={agent.data.name}
          color={colorIndex(agent.data.color, id)}
          live={status.kind === 'online'}
          size="lg"
        />
        <div className="min-w-0">
          <h1 className="truncate text-28 font-semibold">{agent.data.name}</h1>
          <p
            aria-live="polite"
            className={cn(
              'flex flex-wrap items-center gap-x-2 text-14',
              pausedShown
                ? 'text-gate-text'
                : status.kind === 'online'
                  ? 'text-approve-text'
                  : 'text-text-2',
            )}
          >
            {status.kind === 'revoked' ? (
              'Revoked'
            ) : pausedShown ? (
              'Paused'
            ) : live && status.kind === 'online' && status.working?.waiting ? (
              <>
                <WorkingDots />
                <span data-testid="working-items">
                  {presenceText({
                    working: status.working.items ?? 0,
                    waiting: status.working.waiting,
                  }).replace(/^w/, 'W')}
                </span>
              </>
            ) : live && liveItems > 1 ? (
              <>
                <WorkingDots />
                <span data-testid="working-items">Working {liveItems} items</span>
              </>
            ) : live ? (
              <>
                <WorkingDots />
                <span>
                  Working on {`“${titleOf(live.data.projectId, live.data.itemId) ?? 'an item'}”`}
                </span>
                <span className="tabular-nums" data-testid="elapsed">
                  {formatElapsed(now - live.data.startedAt.toMillis())}
                </span>
                {live.data.tokensIn || live.data.tokensOut ? (
                  <span className="tabular-nums" data-testid="live-tokens">
                    · {formatTokens(live.data.tokensIn)} in / {formatTokens(live.data.tokensOut)}{' '}
                    out{live.data.model ? ` · ${live.data.model}` : ''}
                  </span>
                ) : null}
              </>
            ) : status.kind === 'online' ? (
              'Online · waiting for work'
            ) : (
              'Offline'
            )}
          </p>
          <p className="text-13 text-text-2">{scopeText(agent.data, projects)}</p>
        </div>
      </header>

      <PausedBanner agentId={id} agent={agent.data} isAdmin={isAdmin} />
      <AgentSettings agentId={id} agent={agent.data} projects={projects} />

      {runsLive.state === 'error' || decisionsLive.state === 'error' ? (
        <EmptyState
          icon={Bot}
          title={building ? 'Still preparing this view' : 'This agent’s work could not be loaded'}
          description={building ? INDEX_BUILDING_TEXT : 'Check your connection and reload.'}
        />
      ) : (
        <>
          <Tabs
            label="Period"
            value={win}
            onValueChange={(v) => setWin(v as WindowId)}
            tabs={WINDOWS.map((w) => ({
              value: w.id,
              label: w.label,
              content: (
                <Kpis
                  loaded={runsLive.state === 'ready' && decisionsLive.state === 'ready'}
                  runs={runs}
                  decisions={decisions}
                  from={windowStart(w.id, now)}
                  now={now}
                />
              ),
            }))}
          />

          <section aria-labelledby="runs-h" className="mt-8">
            <h2 id="runs-h" className="mb-3">
              <Eyebrow>Runs · last 30 days</Eyebrow>
            </h2>
            {runsLive.state !== 'ready' ? (
              <Skeleton className="h-16" />
            ) : runs.length === 0 ? (
              <p className="rounded-card border border-dashed border-line-strong p-4 text-14 text-text-2">
                No runs yet. When this agent picks up work, each run shows up here with its log.
              </p>
            ) : (
              <ul
                aria-label="Runs"
                className="overflow-hidden rounded-card border border-line bg-surface shadow-e1"
              >
                {runs.map((r) => (
                  <RunRow
                    key={r.id}
                    wid={wid}
                    run={r}
                    now={now}
                    isAdmin={isAdmin}
                    agentName={agent.data.name}
                    title={titleOf(r.data.projectId, r.data.itemId)}
                    project={projectById.get(r.data.projectId)}
                    verdict={verdictFor(r.data, decisions)}
                  />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Kpis({
  loaded,
  runs,
  decisions,
  from,
  now,
}: {
  loaded: boolean;
  runs: Row<Run>[];
  decisions: Row<Decision>[];
  from: number;
  now: number;
}) {
  const s = useMemo(() => agentStats(runs, decisions, from, now), [runs, decisions, from, now]);
  const t = useMemo(
    () => tokenTotals(runs.filter((r) => r.data.startedAt.toMillis() >= from).map((r) => r.data)),
    [runs, from],
  );
  if (!loaded) return <Skeleton className="h-24" />;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Kpi label="Runs">
          <span data-testid="kpi-runs">{s.runs}</span>
        </Kpi>
        <Kpi label="Items completed">
          <span data-testid="kpi-completed">{s.completed}</span>
        </Kpi>
        <Kpi label="Time working">
          <span data-testid="kpi-time">{formatDuration(s.workMs)}</span>
        </Kpi>
        <Kpi label="Cost">
          <span data-testid="kpi-cost">{formatEur(s.costEur)}</span>
        </Kpi>
        <Kpi
          label="Approved first time"
          hint={s.judged ? `${s.firstTimeApproved} of ${s.judged} judged` : 'Nothing judged yet'}
        >
          <span data-testid="kpi-rate">
            {s.approvalRate === null ? '–' : `${Math.round(s.approvalRate * 100)}%`}
          </span>
        </Kpi>
        <Kpi label="Sent back">
          <span data-testid="kpi-sendbacks">{s.sendBacks}</span>
        </Kpi>
        <Kpi
          label="Tokens (new)"
          hint={`${formatTokens(t.tokensIn - t.tokensCached)} in · ${formatTokens(t.tokensOut)} out · ${formatTokens(t.tokensCached)} cached`}
        >
          <span data-testid="kpi-tokens">{formatTokens(t.newTokens)}</span>
        </Kpi>
        <Kpi label="Models" hint={t.models.length > 1 ? `${t.models.length} models` : undefined}>
          <span data-testid="kpi-models" className="block truncate text-16">
            {t.models[0] ?? '–'}
            {t.models.length > 1 ? ` +${t.models.length - 1}` : ''}
          </span>
        </Kpi>
      </div>
      {s.reasons.length ? (
        <div className="rounded-card border border-line bg-surface p-4">
          <Eyebrow>Top send-back reasons</Eyebrow>
          <ul className="mt-2 flex flex-col gap-1 text-14 text-ink">
            {s.reasons.map((r) => (
              <li key={r.text} className="flex gap-2">
                <Badge tone="sendback">{r.count}</Badge>
                <span className="min-w-0 break-words">{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RunRow({
  wid,
  run,
  now,
  isAdmin,
  agentName,
  title,
  project,
  verdict,
}: {
  wid: string;
  run: Row<Run>;
  now: number;
  isAdmin: boolean;
  agentName: string;
  title: string | null;
  project?: { name: string; emoji: string };
  verdict: Row<Decision> | null;
}) {
  const r = run.data;
  const [open, setOpen] = useState(false);
  const state = runState(r, now);
  const tone = STATE_TONE[state];
  const started = r.startedAt.toMillis();
  return (
    <li className="border-t border-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid min-h-14 w-full grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 px-3 py-2.5 text-left hov:bg-canvas foc:outline-2 foc:-outline-offset-2 foc:outline-focus sm:px-4"
      >
        <Icon icon={open ? ChevronDown : ChevronRight} size={16} />
        <span className="min-w-0">
          <span className="block truncate text-14 font-medium text-ink">{title ?? 'An item'}</span>
          <span className="block truncate text-13 text-text-2">
            {dayLabel(started, now)} {clock(started)}
            {project ? ` · ${project.emoji} ${project.name}` : ''} ·{' '}
            {state === 'running' ? formatElapsed(now - started) : formatDuration(runWorkMs(r, now))}{' '}
            · {formatEur(r.costEur)}
            {r.tokensIn || r.tokensOut ? ` · ${formatTokens(newTokens(r))} tokens` : ''}
          </span>
        </span>
        <Badge tone={tone.tone}>{tone.label}</Badge>
      </button>
      {open ? (
        <RunDetail
          wid={wid}
          run={run}
          state={state}
          isAdmin={isAdmin}
          agentName={agentName}
          title={title}
          verdict={verdict}
        />
      ) : null}
    </li>
  );
}

function RunDetail({
  wid,
  run,
  state,
  isAdmin,
  agentName,
  title,
  verdict,
}: {
  wid: string;
  run: Row<Run>;
  state: RunState;
  isAdmin: boolean;
  agentName: string;
  title: string | null;
  verdict: Row<Decision> | null;
}) {
  const r = run.data;
  const files = useLiveCollection(
    `workspaces/${wid}/projects/${r.projectId}/items/${r.itemId}/attachments`,
    attachmentSchema,
  );
  const mine = files.state === 'ready' ? files.data.filter((f) => f.data.runId === run.id) : [];
  return (
    <div className="flex flex-col gap-3 border-t border-line bg-canvas/50 px-3 py-3 sm:px-4">
      {r.summary ? <p className="text-14 text-ink">{r.summary}</p> : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-13 sm:grid-cols-5">
        <div>
          <dt className="text-text-2">Cost</dt>
          <dd className="tabular-nums text-ink">{formatEur(r.costEur)}</dd>
        </div>
        <div>
          <dt className="text-text-2">New tokens in / out</dt>
          <dd className="tabular-nums text-ink" data-testid="run-tokens">
            {(r.tokensIn - (r.tokensCached ?? 0)).toLocaleString('en')} /{' '}
            {r.tokensOut.toLocaleString('en')}
          </dd>
        </div>
        <div>
          <dt className="text-text-2">Cache reads</dt>
          <dd className="tabular-nums text-ink" data-testid="run-cached">
            {(r.tokensCached ?? 0).toLocaleString('en')}
          </dd>
        </div>
        <div>
          <dt className="text-text-2">Model</dt>
          <dd className="text-ink">{r.model ?? '–'}</dd>
        </div>
        {r.remote ? (
          <div>
            <dt className="text-text-2">Claude session</dt>
            <dd>
              <a
                href={r.remote.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink underline underline-offset-4"
                data-testid="run-remote"
              >
                Open in Claude (Remote Control)
              </a>
            </dd>
          </div>
        ) : null}
        <div>
          <dt className="text-text-2">Item</dt>
          <dd>
            <Link
              to="/p/$pid"
              params={{ pid: r.projectId }}
              search={{ item: r.itemId }}
              className="text-ink underline underline-offset-4"
            >
              {title ?? 'Open item'}
            </Link>
          </dd>
        </div>
      </dl>

      {state === 'stalled' ? (
        <StalledNotice wid={wid} run={run} isAdmin={isAdmin} agentName={agentName} />
      ) : null}

      <div>
        <Eyebrow>Log</Eyebrow>
        <div className="mt-1.5">
          <RunLog wid={wid} runId={run.id} live={state === 'running'} />
        </div>
      </div>

      <div>
        <Eyebrow>Attachments</Eyebrow>
        {mine.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {mine.map((f) => (
              <li key={f.id}>
                <Link
                  to="/p/$pid/i/$iid/view/$aid"
                  params={{ pid: r.projectId, iid: r.itemId, aid: f.id }}
                  className="inline-flex min-h-11 items-center rounded-btn border border-line-strong bg-surface px-3 text-13 font-medium text-ink"
                >
                  {f.data.name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-13 text-text-2">Nothing attached in this run.</p>
        )}
      </div>

      <div>
        <Eyebrow>What happened next</Eyebrow>
        {verdict ? (
          <p className="mt-1 text-14 text-ink">
            {verdict.data.outcome === 'approved'
              ? 'Approved'
              : verdict.data.outcome === 'stopped'
                ? 'Stopped'
                : 'Sent back'}
            {verdict.data.rationale ? `: ${verdict.data.rationale}` : ''}
          </p>
        ) : (
          <p className="mt-1 text-13 text-text-2">
            {state === 'done' ? 'No decision yet.' : 'Not finished yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

function StalledNotice({
  wid,
  run,
  isAdmin,
  agentName,
}: {
  wid: string;
  run: Row<Run>;
  isAdmin: boolean;
  agentName: string;
}) {
  const { actionContext, run: perform } = useReady();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const r = run.data;
  const item = useLiveDoc(
    isAdmin ? `workspaces/${wid}/projects/${r.projectId}/items/${r.itemId}` : null,
    itemSchema,
  );
  // Does this run still hold the item? Only then does Release put the item back in the queue;
  // otherwise only the run ends and the item stays where it is (tester R80).
  const held = item.state === 'ready' && item.data?.claim?.runId === run.id;
  async function release() {
    const ctx = actionContext(wid);
    if (!ctx) return;
    setBusy(true);
    try {
      await perform(
        releaseStale(ctx, {
          projectId: r.projectId,
          itemId: r.itemId,
          runId: run.id,
          agentUid: r.agentUid,
          clearItem: held,
        }),
      );
      setConfirm(false);
      toast.push({
        message: held
          ? 'Released. The item is back in the queue.'
          : 'Released. The run is ended; the item was no longer held by it and stays where it is.',
      });
    } catch {
      toast.push({ message: 'Could not release. Try again.' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-gate/50 bg-gate-bg p-3">
      <p className="min-w-0 flex-1 text-14 text-gate-text">
        Stalled: {agentName} has not reported for over 10 minutes.
      </p>
      {isAdmin ? (
        <>
          <Button variant="gate" leading={<Icon icon={Hand} />} onClick={() => setConfirm(true)}>
            Release
          </Button>
          <Dialog
            open={confirm}
            onOpenChange={(o) => !o && !busy && setConfirm(false)}
            title="Release this run?"
            description={
              held
                ? 'The agent’s claim is cleared and the item goes back in the queue for any agent to pick up. This is recorded in Activity.'
                : 'The run is ended. Its item is no longer held by this run, so the item stays where it is. This is recorded in Activity.'
            }
            footer={
              <>
                <Button variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
                  Keep waiting
                </Button>
                <Button variant="gate" loading={busy} onClick={release}>
                  Release
                </Button>
              </>
            }
          />
        </>
      ) : null}
    </div>
  );
}
