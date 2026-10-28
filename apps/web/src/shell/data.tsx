import {
  agentSchema,
  canEditAgentSettings,
  isSuggestion,
  stepProposalSchema,
  type StepProposal,
  itemSchema,
  messageSchema,
  projectSchema,
  runSchema,
  type Agent,
  type Item,
  type Message,
  type Project,
  type Run,
} from '@hive/shared';
import { collection, orderBy, query, Timestamp, where } from 'firebase/firestore';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useReady } from '../auth/context';
import { useRetry, useUnreachable } from './unreachable';
import { db } from '../lib/db';
import { useLiveCollection, useLiveQuery, type Live, type Row } from '../lib/live';
import {
  agentActivity,
  itemsWaiting,
  itemsInWork,
  MONTH_RUNS,
  monthSpend,
  type ItemsByProject,
  type NeedsYou,
} from './logic';
import { buildInbox } from '../inbox/logic';
import { usePendingKeys } from '../inbox/pending';
import { agentsQuery, myProjectsQuery, openItemsQuery, openQuestionsQuery } from './queries';
import { markSynced, wasSynced } from '../lib/syncedFeeds';
import { USE_EMULATOR } from '../lib/app';

export interface ShellData {
  projects: Row<Project>[];
  agents: Row<Agent>[];
  /** This month's runs (the shell's own window). */
  runs: Row<Run>[];
  items: ItemsByProject;
  /** Agent suggestions (untriaged findings, status `suggested`) by project; never in `items`. */
  suggestions: ItemsByProject;
  /** Unanswered agent questions by project. */
  questions: Record<string, Row<Message>[]>;
  /** Open step proposals (card st5INNZj), only for projects where this person decides them. */
  proposals: Record<string, Row<StepProposal>[]>;
  needs: NeedsYou;
  /** `items`: items in work right now (one agent may hold several, card cGSENsRF). */
  activity: { working: number; idle: number; items: number; waiting: number };
  /** `known`: every project's runs are confirmed by the server (a cached subset under-reports). */
  spend: { spent: number; known: boolean };
  /** Projects whose month of runs the server has confirmed; spend for the others is not final. */
  runsSynced: ReadonlySet<string>;
  /** True once the server (not just the local cache) has answered the agents feed. */
  agentsKnown: boolean;
  /**
   * True until the projects feed has a real answer: no snapshot yet, or only an empty one from
   * the local cache that the server has not confirmed (an empty cache is not "no projects").
   */
  loading: boolean;
  /**
   * True once the server (not just the cache) has answered the projects feed. A project missing
   * from a cached list may still exist: "not found" screens wait for this.
   */
  projectsConfirmed: boolean;
  /**
   * True once the server has answered every project's items, questions and runs (needs-you
   * counts and spend are only final then; a feed that failed counts as answered). Screens that
   * print them wait for it, so cards do not grow.
   */
  settled: boolean;
  /**
   * True once every project's open items and questions are answered: what "Needs you" lists.
   * Comes before `settled` (runs load after them, see RunsFeed), so the first screen does not wait
   * for a month of runs (card CGPynEQY).
   */
  needsSettled: boolean;
  /**
   * The Needs-you count is final: `needsSettled`, or after 3 s of patience whatever exists. The nav
   * badges and the app icon badge wait for it so the number never climbs (card JtZDsMEb).
   */
  needsReady: boolean;
  /** True when the projects or agents listener failed (not just empty), so screens can say so. */
  failed: boolean;
  /**
   * True when the server has not answered the projects or agents feed for a while on a cold
   * cache (nothing cached to show) while the browser is online. The Firestore SDK reports no
   * error then: it serves an empty cached snapshot. Screens must not read that as "nothing here".
   */
  unreachable: boolean;
  /** Starts every shell listener afresh and nudges the connection (the Retry action). */
  retry: () => void;
  /** A Retry is under way: the button stays but is disabled. */
  retrying: boolean;
}

const Ctx = createContext<ShellData | null>(null);

export function useShellData(): ShellData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useShellData needs <ShellDataProvider>');
  return v;
}

const EMPTY: never[] = [];

/** Everything waiting on this person: approvals, unanswered questions and findings to triage. */
function needsOf(
  projects: Row<Project>[],
  items: ItemsByProject,
  suggestions: ItemsByProject,
  questions: Record<string, Row<Message>[]>,
  uid: string,
  isAdmin: boolean,
  pending: ReadonlySet<string>,
  proposals: Record<string, Row<StepProposal>[]> = {},
): NeedsYou {
  const { todo: all } = buildInbox({
    projects,
    items,
    suggestions,
    questions,
    proposals,
    uid,
    isAdmin,
  });
  const todo = all.filter((e) => !pending.has(e.key));
  const byProject: Record<string, number> = {};
  for (const e of todo) byProject[e.pid] = (byProject[e.pid] ?? 0) + 1;
  return { total: todo.length, byProject };
}

/** Splits one project's open rows into items and agent suggestions (card TU5pDmzE). */
export function splitSuggestions(byProject: ItemsByProject) {
  const items: ItemsByProject = {};
  const suggestions: ItemsByProject = {};
  for (const [pid, rows] of Object.entries(byProject)) {
    items[pid] = rows.filter((r) => !isSuggestion(r.data));
    suggestions[pid] = rows.filter((r) => isSuggestion(r.data));
  }
  return { items, suggestions };
}

/**
 * Where a per-project feed is: rows only from the local cache, confirmed by the server, failed,
 * or `warm`: from the cache of a feed the server has answered on this device before, so the
 * cached rows are its last full answer (see lib/syncedFeeds) and can be shown at once.
 */
export type FeedState = 'cached' | 'warm' | 'synced' | 'failed';
type OnFeed<T> = (pid: string, rows: Row<T>[] | null, state: FeedState) => void;

/** Reports a per-project live query to the provider, and logs a failure instead of hanging. */
function useReport<T>(
  name: string,
  pid: string,
  live: Live<Row<T>[]>,
  onRows: OnFeed<T>,
  uid: string,
  feed: string,
) {
  useEffect(() => {
    if (live.state === 'ready') {
      if (!live.fromCache) markSynced(uid, feed);
      onRows(pid, live.data, !live.fromCache ? 'synced' : wasSynced(uid, feed) ? 'warm' : 'cached');
    } else if (live.state === 'error') {
      console.error(`Hivenod: the ${name} feed of project ${pid} failed (${live.code})`);
      onRows(pid, null, 'failed');
    }
  }, [live, name, pid, onRows, uid, feed]);
}

interface FeedProps<T> {
  wid: string;
  pid: string;
  uid: string;
  onRows: OnFeed<T>;
}

/** One live listener per project for its open items and suggestions (counts, palette, lanes). */
function ItemsFeed({ wid, pid, uid, onRows }: FeedProps<Item>) {
  const key = `items:${wid}:${pid}`;
  const live = useLiveQuery(key, () => openItemsQuery(wid, pid), itemSchema, { synced: true });
  useReport('items', pid, live, onRows, uid, key);
  return null;
}

/** One live listener per project for the agent questions nobody has answered yet. */
function QuestionsFeed({ wid, pid, uid, onRows }: FeedProps<Message>) {
  const key = `questions:${wid}:${pid}`;
  const live = useLiveQuery(key, () => openQuestionsQuery(wid, pid), messageSchema, {
    synced: true,
  });
  useReport('questions', pid, live, onRows, uid, key);
  return null;
}

/** One listener per project this person approves steps for: its open step proposals. */
function ProposalsFeed({ wid, pid, uid, onRows }: FeedProps<StepProposal>) {
  const key = `proposals:${wid}:${pid}`;
  const live = useLiveQuery(
    key,
    () =>
      query(
        collection(db, `workspaces/${wid}/projects/${pid}/stepProposals`),
        where('status', '==', 'open'),
      ),
    stepProposalSchema,
  );
  useReport('proposals', pid, live, onRows, uid, key);
  return null;
}

/**
 * The month-of-runs query of one project. The order matters: production only has the
 * (projectId, startedAt DESC) index, and without the orderBy Firestore wants an ascending one, so
 * the listener failed there (the emulator does not check indexes) and spend came only from runs
 * other screens had cached. `firestore.indexes.json` is checked against this in a unit test.
 */
export function monthRunsQuery(wid: string, pid: string, since: Date) {
  return query(
    collection(db, `workspaces/${wid}/runs`),
    where(MONTH_RUNS.equal, '==', pid),
    where(MONTH_RUNS.range, '>=', Timestamp.fromDate(since)),
    orderBy(MONTH_RUNS.range, MONTH_RUNS.direction),
  );
}

/**
 * One live listener per project for this month's runs (members may only read runs per project).
 * The provider starts these after the items and questions: a month of runs is by far the largest
 * payload, and on a slow link it held back the first screen (card CGPynEQY).
 */
function RunsFeed({ wid, pid, uid, since, onRows }: FeedProps<Run> & { since: Date }) {
  const key = `runs:${wid}:${pid}:${since.getTime()}`;
  const live = useLiveQuery(key, () => monthRunsQuery(wid, pid, since), runSchema, {
    synced: true,
  });
  useReport('runs', pid, live, onRows, uid, key);
  return null;
}

/** Rows and feed state per project, for one kind of feed. */
function useFeedRows<T>() {
  const [rows, setRows] = useState<Record<string, Row<T>[]>>({});
  const [states, setStates] = useState<Record<string, FeedState>>({});
  const onRows = useMemo<OnFeed<T>>(
    () => (pid, next, state) => {
      if (next) setRows((cur) => ({ ...cur, [pid]: next }));
      setStates((cur) => (cur[pid] === state ? cur : { ...cur, [pid]: state }));
    },
    [],
  );
  return [rows, states, onRows] as const;
}

const answered = (s: FeedState | undefined) => s === 'synced' || s === 'warm' || s === 'failed';

/**
 * Live data the shell itself needs: projects, agents, this month's runs and open items. Admins
 * list every project; a member lists only the projects they were added to (the rules insist).
 */
export function ShellDataProvider({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  // The listeners restart through the new key.
  const restart = useCallback(() => setAttempt((n) => n + 1), []);
  const { retry, retrying, settle } = useRetry(restart);
  return (
    <ShellDataInner
      key={attempt}
      retry={retry}
      retrying={retrying}
      settle={settle}
      afterRetry={attempt > 0}
    >
      {children}
    </ShellDataInner>
  );
}

function ShellDataInner({
  children,
  retry,
  retrying,
  settle,
  afterRetry,
}: {
  children: ReactNode;
  retry: () => void;
  retrying: boolean;
  settle: () => void;
  /** Mounted by a Retry: keep "Can't reach the server" up until the server answers. */
  afterRetry: boolean;
}) {
  const { session } = useReady();
  const wid = session.workspaceId;
  const uid = session.me.uid;

  const isAdmin = session.isAdmin;
  const allProjects = useLiveCollection(
    isAdmin ? `workspaces/${wid}/projects` : null,
    projectSchema,
    { synced: true },
  );
  const myProjects = useLiveQuery(
    isAdmin ? null : `projects:${wid}:${uid}`,
    () => myProjectsQuery(wid, uid),
    projectSchema,
    { synced: true },
  );
  const projectsLive = isAdmin ? allProjects : myProjects;
  const agentsLive = useLiveQuery(`agents:${wid}`, () => agentsQuery(wid), agentSchema, {
    synced: true,
  });
  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }, []);
  const [runsBy, runsState, setRuns] = useFeedRows<Run>();
  const [openRows, itemsState, setRows] = useFeedRows<Item>();
  const { items, suggestions } = useMemo(() => splitSuggestions(openRows), [openRows]);
  const [questions, questionsState, setQs] = useFeedRows<Message>();
  const [proposals, , setProposals] = useFeedRows<StepProposal>();

  // Run liveness depends on the clock, so recompute every 30 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const projects = projectsLive.state === 'ready' ? projectsLive.data : EMPTY;
  const agents = agentsLive.state === 'ready' ? agentsLive.data : EMPTY;
  const runs = useMemo(() => projects.flatMap((p) => runsBy[p.id] ?? []), [projects, runsBy]);

  const runsSynced = useMemo(
    () => new Set(projects.filter((p) => runsState[p.id] === 'synced').map((p) => p.id)),
    [projects, runsState],
  );

  // Cold cache and no answer from the server: still loading, or only an empty cached snapshot.
  const unanswered = (l: Live<Row<unknown>[]>) =>
    l.state === 'loading' || (l.state === 'ready' && Boolean(l.fromCache) && l.data.length === 0);
  const stuck = unanswered(projectsLive) || unanswered(agentsLive);
  const unreachable = useUnreachable(stuck, afterRetry);
  useEffect(() => {
    if (!stuck) settle();
  }, [stuck, settle]);

  const pendingKeys = usePendingKeys();
  const needsSettled =
    projectsLive.state !== 'loading' &&
    !unanswered(projectsLive) &&
    projects.every((p) => answered(itemsState[p.id]) && answered(questionsState[p.id]));
  const isSettled = needsSettled && projects.every((p) => answered(runsState[p.id]));
  // Runs start once Needs you has its answer, or after a moment whatever happens. Against the
  // emulators only, the e2e checks can hold them back (window.__hiveRunsDelayMs) to see the
  // screens while runs are still loading.
  const heldMs = USE_EMULATOR
    ? Number((window as unknown as { __hiveRunsDelayMs?: number }).__hiveRunsDelayMs ?? 0)
    : 0;
  const [runsOn, setRunsOn] = useState(false);
  if (needsSettled && !runsOn && !heldMs) {
    setRunsOn(true); // latched: they never stop again
    performance.mark?.('hive:needs-settled'); // read by the perf check (e2e/perf-load.spec.ts)
  }
  useEffect(() => {
    if (runsOn) return;
    if (heldMs && !needsSettled) return;
    const t = setTimeout(() => setRunsOn(true), heldMs || 2500);
    return () => clearTimeout(t);
  }, [runsOn, heldMs, needsSettled]);
  // Patience is per organization: a switch makes the new org's feeds unanswered again.
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setExpiredFor(wid), 3000);
    return () => clearTimeout(t);
  }, [wid]);
  const patient = expiredFor !== wid;
  const needsReady =
    projectsLive.state !== 'loading' && !unanswered(projectsLive) && (needsSettled || !patient);
  const value = useMemo<ShellData>(
    () => ({
      projects,
      agents,
      runs,
      items,
      suggestions,
      questions,
      proposals,
      needs: needsOf(projects, items, suggestions, questions, uid, isAdmin, pendingKeys, proposals),
      activity: {
        ...agentActivity(
          agents,
          runs,
          now,
          projects.flatMap((p) => items[p.id] ?? []),
        ),
        items: itemsInWork(
          runs,
          now,
          projects.flatMap((p) => items[p.id] ?? []),
        ),
        waiting: itemsWaiting(
          now,
          projects.flatMap((p) => items[p.id] ?? []),
        ),
      },
      spend: {
        spent: monthSpend(runs, new Date(now)),
        known: projectsLive.state === 'ready' && runsSynced.size === projects.length,
      },
      runsSynced,
      agentsKnown:
        (agentsLive.state === 'ready' && !agentsLive.fromCache) || agentsLive.state === 'error',
      loading: projectsLive.state === 'loading' || unanswered(projectsLive),
      projectsConfirmed:
        projectsLive.state === 'error' ||
        (projectsLive.state === 'ready' && !projectsLive.fromCache),
      settled: isSettled,
      needsSettled,
      needsReady,
      failed: projectsLive.state === 'error' || agentsLive.state === 'error',
      unreachable,
      retry,
      retrying,
    }),
    [
      pendingKeys,
      isSettled,
      needsSettled,
      needsReady,
      projects,
      agents,
      runs,
      runsSynced,
      items,
      suggestions,
      questions,
      proposals,
      uid,
      isAdmin,
      now,
      projectsLive,
      agentsLive,
      unreachable,
      retry,
      retrying,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {projects.map((p) => (
        <ItemsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setRows} />
      ))}
      {projects.map((p) => (
        <QuestionsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setQs} />
      ))}
      {projects
        .filter((p) => canEditAgentSettings({ uid, isAdmin }, p.data))
        .map((p) => (
          <ProposalsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setProposals} />
        ))}
      {runsOn
        ? projects.map((p) => (
            <RunsFeed
              key={p.id}
              wid={wid}
              pid={p.id}
              uid={uid}
              since={monthStart}
              onRows={setRuns}
            />
          ))
        : null}
    </Ctx.Provider>
  );
}
