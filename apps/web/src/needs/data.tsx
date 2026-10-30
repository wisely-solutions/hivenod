/**
 * Needs you across every organization the member is in (item 2YZRd4tmFrXR1UjBWYJF): the member's
 * Inbox threads, open proposals and live plans in each, merged on the client (needs/logic.ts): no
 * server work, so it stays at €0. Projects were removed (item OE8FmrTaIxFVGcaeGG3N, slice 10).
 */
import {
  inboxOutcomeSchema,
  inboxPlanSchema,
  inboxSubjectSchema,
  inboxThreadSchema,
  memberProfileSchema,
  paths,
  workspaceSchema,
  type InboxOutcome,
  type InboxPlan,
  type InboxSubject,
  type InboxThread,
  type MemberProfile,
} from '@hive/shared';
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
import { useLiveCollection, useLiveDoc, useLiveQuery, type Live, type Row } from '../lib/live';
import { displayName } from '../members/data';
import { useShellData } from '../shell/data';
import { mySubjectsQuery, myThreadsQuery } from '../threads/data';
import { buildNeeds, type Needs, type OrgInput } from './logic';

export interface NeedsAll {
  needs: Needs;
  /** Everything waiting. `onlyYou` equals `total`: an Inbox thread is only its member's. */
  counts: { total: number; onlyYou: number };
  /** Every organization's feeds have answered (or 3 s of patience ran out): counts are final. */
  ready: boolean;
  /** The organizations in the list, in the member's order (the one on screen first). */
  orgs: { wid: string; name: string }[];
  /** Member names by organization, then uid (approval lines, tags). */
  names: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Every organization's Needs-you feeds have answered (no patience). */
  settled: boolean;
  /** Each organization's inputs (threads in every state, open proposals), for the Today page. */
  inputs: readonly OrgInput[];
}

const Ctx = createContext<NeedsAll | null>(null);

export function useNeedsAll(): NeedsAll {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNeedsAll needs <NeedsAllProvider>');
  return v;
}

/** One organization's inputs and whether its feeds have all answered. */
type OrgState = { input: OrgInput | null; settled: boolean } | null;

const EMPTY: never[] = [];

function namesFrom(live: Live<Row<MemberProfile>[]>): Record<string, string> {
  if (live.state !== 'ready') return {};
  return Object.fromEntries(live.data.map((r) => [r.id, displayName(r.data, r.id)] as const));
}

function usePart<T>(live: Live<Row<T>[]>): { rows: Row<T>[]; done: boolean } {
  return useMemo(
    () => ({
      rows: live.state === 'ready' ? live.data : EMPTY,
      done: live.state === 'error' || (live.state === 'ready' && !live.fromCache),
    }),
    [live],
  );
}

/** Names and the member's Inbox (threads, open proposals, live plans, subject labels). */
function useExtras(wid: string, uid: string) {
  const members = useLiveCollection(`workspaces/${wid}/members`, memberProfileSchema);
  const names = useMemo(() => namesFrom(members), [members]);
  const threads = usePart<InboxThread>(
    // `synced`: a cached empty answer the server confirms unchanged must still count as answered.
    useLiveQuery(`needs-threads:${wid}:${uid}`, () => myThreadsQuery(wid, uid), inboxThreadSchema, {
      synced: true,
    }),
  );
  // The member's open proposals (item kt3E7): a Your-call thread with none left is not waiting,
  // and the Today page shows them on the decision card.
  const proposals = usePart<InboxOutcome>(
    useLiveQuery(
      `needs-proposals:${wid}:${uid}`,
      () =>
        query(
          collection(db, `workspaces/${wid}/inboxOutcomes`),
          where('memberUid', '==', uid),
          // Revising (Ask for changes) keeps its slot: the card shows the agent at work.
          where('state', 'in', ['proposed', 'revising']),
        ),
      inboxOutcomeSchema,
      { synced: true },
    ),
  );
  // Plans (item qwFAWxZM5xkcE7PPjAzi): a blocked plan waits for the member with nothing proposed.
  const plans = usePart<InboxPlan>(
    useLiveQuery(
      `needs-plans:${wid}:${uid}`,
      () =>
        query(
          collection(db, `workspaces/${wid}/inboxPlans`),
          where('memberUid', '==', uid),
          where('state', 'in', ['proposed', 'active', 'blocked']),
        ),
      inboxPlanSchema,
      { synced: true },
    ),
  );
  const subjects = usePart<InboxSubject>(
    useLiveQuery(
      `needs-subjects:${wid}:${uid}`,
      () => mySubjectsQuery(wid, uid),
      inboxSubjectSchema,
    ),
  );
  const subjectLabels = useMemo(() => {
    const by: Record<string, { label: string; suggested: boolean }> = {};
    for (const s of subjects.rows) {
      const label = s.data.label?.trim();
      if (label) by[s.id] = { label, suggested: s.data.labelSuggested === true };
    }
    return by;
  }, [subjects.rows]);
  return { names, threads, proposals, plans, subjectLabels };
}

/** One organization the member is in: its name, member names and the member's Inbox. */
function Org({ wid, onOrg }: { wid: string; onOrg: (wid: string, s: OrgState) => void }) {
  const { session } = useReady();
  const uid = session.me.uid;
  const current = wid === session.workspaceId;
  // The organization on screen is already in the session; the others are read here.
  const ws = useLiveDoc(current ? null : paths.workspace(wid), workspaceSchema);
  const workspace = current ? session.workspace : ws.state === 'ready' ? ws.data : null;
  const role = workspace?.memberRoles[uid];
  const known = current || ws.state !== 'loading';
  const { names, threads, proposals, plans, subjectLabels } = useExtras(wid, uid);
  const input = useMemo<OrgInput | null>(
    () =>
      workspace && role
        ? {
            wid,
            name: workspace.name,
            threads: threads.rows,
            openOutcomes: proposals.rows,
            livePlans: plans.rows,
            subjectLabels,
            names,
          }
        : null,
    [wid, workspace, role, threads.rows, proposals.rows, plans.rows, subjectLabels, names],
  );
  const settled = known && (!role || (threads.done && proposals.done));
  useEffect(() => {
    // Removed from it (or it is gone): it simply drops out of the list.
    if (known && !input) onOrg(wid, { input: null, settled: true });
    else if (input) onOrg(wid, { input, settled });
  }, [wid, input, settled, known, onOrg]);
  useEffect(() => () => onOrg(wid, null), [wid, onOrg]);
  return null;
}

export function NeedsAllProvider({ children }: { children: ReactNode }) {
  const { session } = useReady();
  const uid = session.me.uid;
  const wid = session.workspaceId;
  const others = useMemo(
    () => session.profile.workspaceIds.filter((w) => w !== wid),
    [session.profile.workspaceIds, wid],
  );
  const [states, setStates] = useState<Record<string, OrgState>>({});
  const onOrg = useCallback((w: string, s: OrgState) => {
    setStates((cur) => {
      if (s === null) {
        if (!(w in cur)) return cur;
        const next = { ...cur };
        delete next[w];
        return next;
      }
      return cur[w] === s ? cur : { ...cur, [w]: s };
    });
  }, []);
  // Three seconds of patience, then show whatever has answered (same rule as the shell).
  const shell = useShellData();
  const [expiredFor, setExpiredFor] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setExpiredFor(wid), 3000);
    return () => clearTimeout(t);
  }, [wid]);
  const patient = expiredFor !== wid;
  const order = useMemo(() => [wid, ...others], [wid, others]);
  const value = useMemo<NeedsAll>(() => {
    const inputs = order.flatMap((w) => {
      const s = states[w];
      return s?.input ? [s.input] : [];
    });
    const needs = buildNeeds(inputs, uid);
    const total = needs.todo.length;
    const settled = order.every((w) => states[w]?.settled);
    return {
      needs,
      counts: { total, onlyYou: total },
      ready: settled || (!patient && shell.needsReady),
      orgs: inputs.map((i) => ({ wid: i.wid, name: i.name })),
      names: Object.fromEntries(inputs.map((i) => [i.wid, i.names])),
      settled,
      inputs,
    };
  }, [order, states, uid, patient, shell.needsReady]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {order.map((w) => (
        <Org key={w} wid={w} onOrg={onOrg} />
      ))}
    </Ctx.Provider>
  );
}
