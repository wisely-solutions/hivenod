/**
 * The Off switch (scheduled tasks slice 7, design 9.4): the member's Off doc in every
 * organization he is in (one small doc each, live), the runs that could not happen while Off
 * (read only while Off), and turning agents Off and On. "All agents" writes every organization,
 * one batch each; nothing turns them on but the member.
 */
import { agentsOffSchema, scheduleRunSchema, schedulePaths, setAgentsOff } from '@hive/shared';
import { collection, query, where } from 'firebase/firestore';
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
import { db } from '../lib/db';
import { useLiveDoc, useLiveQuery } from '../lib/live';
import { useShellData } from '../shell/data';
import { isOffDoc, summarizeOff, type OffSummary, type OrgOff } from './logic';

export interface OffData {
  /** Every organization whose Off doc has answered. */
  orgs: OrgOff[];
  summary: OffSummary;
  /** Runs that could not happen because of Off, in all organizations. */
  cantRun: number;
  /** Turn Off every agent in every organization, or these agents of the organization on screen. */
  turnOff: (input: { all: true } | { agents: string[] }) => Promise<void>;
  /** Turn every agent On again, everywhere. */
  turnOn: () => Promise<void>;
  /** The one Off panel (OffDialogHost): closed, open, or open on "Turn agents on?". */
  panel: 'closed' | 'open' | 'confirm';
  setPanel: (p: 'closed' | 'open' | 'confirm') => void;
  /** An agent's name (the organization on screen; null elsewhere). */
  agentName: (wid: string, uid: string) => string | null;
}

const Ctx = createContext<OffData | null>(null);

export function useOff(): OffData {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOff needs <OffProvider>');
  return v;
}

type OrgState = { off: OrgOff['off'] | null; cantRun: number };

/** The runs that could not happen while Off, read only while that organization is Off. */
function CantRun({
  wid,
  uid,
  onCount,
}: {
  wid: string;
  uid: string;
  onCount: (n: number) => void;
}) {
  const live = useLiveQuery(
    `off-cantrun:${wid}:${uid}`,
    () =>
      query(
        collection(db, `workspaces/${wid}/scheduleRuns`),
        where('memberUid', '==', uid),
        where('state', '==', 'cantRun'),
      ),
    scheduleRunSchema,
  );
  const n = live.state === 'ready' ? live.data.filter((r) => r.data.why?.code === 'off').length : 0;
  useEffect(() => onCount(n), [n, onCount]);
  useEffect(() => () => onCount(0), [onCount]);
  return null;
}

function OrgDoc({ wid, onOrg }: { wid: string; onOrg: (wid: string, s: OrgState | null) => void }) {
  const { session } = useReady();
  const uid = session.me.uid;
  const live = useLiveDoc(schedulePaths.off(wid, uid), agentsOffSchema);
  const [cantRun, setCantRun] = useState(0);
  const doc = live.state === 'ready' ? live.data : null;
  const off = useMemo<OrgOff['off'] | null>(
    () =>
      doc
        ? { all: doc.all, agents: doc.agents, sinceMs: doc.since ? doc.since.toMillis() : null }
        : null,
    [doc],
  );
  const known = live.state !== 'loading';
  useEffect(() => {
    if (known) onOrg(wid, { off, cantRun });
  }, [wid, off, cantRun, known, onOrg]);
  useEffect(() => () => onOrg(wid, null), [wid, onOrg]);
  return isOffDoc(off) ? <CantRun wid={wid} uid={uid} onCount={setCantRun} /> : null;
}

export function OffProvider({ children }: { children: ReactNode }) {
  const { session, actionContext, run } = useReady();
  const { agents } = useShellData();
  const wid = session.workspaceId;
  const order = useMemo(
    () => [wid, ...session.profile.workspaceIds.filter((w) => w !== wid)],
    [wid, session.profile.workspaceIds],
  );
  const [states, setStates] = useState<Record<string, OrgState>>({});
  const [panel, setPanel] = useState<'closed' | 'open' | 'confirm'>('closed');
  const onOrg = useCallback((w: string, s: OrgState | null) => {
    setStates((cur) => {
      if (s === null) {
        if (!(w in cur)) return cur;
        const next = { ...cur };
        delete next[w];
        return next;
      }
      const was = cur[w];
      if (was && was.off === s.off && was.cantRun === s.cantRun) return cur;
      return { ...cur, [w]: s };
    });
  }, []);
  const names = useMemo(() => new Map(agents.map((a) => [a.id, a.data.name] as const)), [agents]);
  const agentName = useCallback(
    (w: string, uid: string) => (w === wid ? (names.get(uid) ?? null) : null),
    [wid, names],
  );
  const value = useMemo<OffData>(() => {
    const orgs = order.flatMap((w) => {
      const s = states[w];
      return s ? [{ wid: w, off: s.off ?? { all: false, agents: [], sinceMs: null } }] : [];
    });
    const cantRun = order.reduce((n, w) => n + (states[w]?.cantRun ?? 0), 0);
    const write = async (w: string, input: { all: boolean; agents?: string[] }) => {
      const ctx = actionContext(w);
      if (!ctx) throw new Error('Sign in again to change the agents.');
      await run(setAgentsOff(ctx, input));
    };
    return {
      orgs,
      summary: summarizeOff(orgs, agentName),
      cantRun,
      agentName,
      panel,
      setPanel,
      turnOff: async (input) => {
        if ('all' in input) await Promise.all(order.map((w) => write(w, { all: true })));
        else await write(wid, { all: false, agents: input.agents });
      },
      turnOn: async () => {
        await Promise.all(
          orgs.filter((o) => isOffDoc(o.off)).map((o) => write(o.wid, { all: false })),
        );
      },
    };
  }, [order, states, actionContext, run, agentName, wid, panel]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {order.map((w) => (
        <OrgDoc key={w} wid={w} onOrg={onOrg} />
      ))}
    </Ctx.Provider>
  );
}
