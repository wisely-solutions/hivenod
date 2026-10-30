import { agentSchema, type Agent, type Project, type Run } from '@hive/shared';
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
import { useLiveQuery, type Live, type Row } from '../lib/live';
import { agentActivity, type ItemsByProject } from './logic';
import { agentsQuery } from './queries';

/**
 * Live data the shell itself needs: the organization's agents. Projects (with their items, agent
 * questions and runs) were removed in item OE8FmrTaIxFVGcaeGG3N, slice 10; `projects`, `items` and
 * `runs` stay empty for the screens slice 9 rebuilds on threads, and go with the shared schemas
 * in slice 11.
 */
export interface ShellData {
  /** Always empty: Projects were removed (legacy field, see above). */
  projects: Row<Project>[];
  agents: Row<Agent>[];
  /** Always empty: runs belonged to project items (legacy field). */
  runs: Row<Run>[];
  /** Always empty (legacy field). */
  items: ItemsByProject;
  /** Agents working (none without runs) and connected but idle. */
  activity: { working: number; idle: number; items: number; waiting: number };
  /** Nothing is spent through runs any more: always 0 and known (legacy field). */
  spend: { spent: number; known: boolean };
  /** True once the server (not just the local cache) has answered the agents feed. */
  agentsKnown: boolean;
  /** True until the agents feed has a real answer. */
  loading: boolean;
  /** True once the server has answered the agents feed (or it failed). */
  settled: boolean;
  /** The first screen may show: the agents feed answered, or 3 s of patience ran out. */
  needsReady: boolean;
  /** True when the agents listener failed (not just empty), so screens can say so. */
  failed: boolean;
  /**
   * True when the server has not answered the agents feed for a while on a cold cache while the
   * browser is online (the SDK then serves an empty cached snapshot and reports no error).
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
const NO_ITEMS: ItemsByProject = {};
const NO_SPEND = { spent: 0, known: true };

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
  const agentsLive = useLiveQuery(`agents:${wid}`, () => agentsQuery(wid), agentSchema, {
    synced: true,
  });

  // Agent presence depends on the clock, so recompute every 30 s.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const agents = agentsLive.state === 'ready' ? agentsLive.data : EMPTY;
  // Cold cache and no answer from the server: still loading, or only an empty cached snapshot.
  const unanswered = (l: Live<Row<unknown>[]>) =>
    l.state === 'loading' || (l.state === 'ready' && Boolean(l.fromCache) && l.data.length === 0);
  const stuck = unanswered(agentsLive);
  const unreachable = useUnreachable(stuck, afterRetry);
  useEffect(() => {
    if (!stuck) settle();
  }, [stuck, settle]);

  // Patience is per organization: a switch makes the new org's feed unanswered again.
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setExpiredFor(wid), 3000);
    return () => clearTimeout(t);
  }, [wid]);
  const patient = expiredFor !== wid;
  const agentsKnown =
    (agentsLive.state === 'ready' && !agentsLive.fromCache) || agentsLive.state === 'error';
  const value = useMemo<ShellData>(
    () => ({
      projects: EMPTY,
      agents,
      runs: EMPTY,
      items: NO_ITEMS,
      activity: { ...agentActivity(agents, EMPTY, now), items: 0, waiting: 0 },
      spend: NO_SPEND,
      agentsKnown,
      loading: agentsLive.state === 'loading',
      settled: agentsKnown,
      needsReady: agentsKnown || !patient,
      failed: agentsLive.state === 'error',
      unreachable,
      retry,
      retrying,
    }),
    [agents, now, agentsKnown, agentsLive.state, patient, unreachable, retry, retrying],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
