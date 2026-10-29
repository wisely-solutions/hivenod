/**
 * Needs you across every organization the member is in (item 2YZRd4tmFrXR1UjBWYJF).
 *
 * The organization on screen comes from the shell's own feeds (shell/data.tsx); every other one
 * gets the same per-project queries here (projects, open items, open questions, step proposals),
 * plus its groups, member names and the member's Inbox threads. Everything is merged on the client
 * (needs/logic.ts): no server work, so it stays at €0.
 */
import {
  canEditAgentSettings,
  groupSchema,
  inboxSubjectSchema,
  inboxThreadSchema,
  memberProfileSchema,
  paths,
  projectSchema,
  workspaceSchema,
  type InboxSubject,
  type InboxThread,
  type Item,
  type MemberProfile,
  type Message,
  type StepProposal,
} from '@hive/shared';
import { collection, query } from 'firebase/firestore';
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
import { usePendingKeys } from '../inbox/pending';
import {
  answered,
  ItemsFeed,
  ProposalsFeed,
  QuestionsFeed,
  splitSuggestions,
  useFeedRows,
  useShellData,
} from '../shell/data';
import { myProjectsQuery } from '../shell/queries';
import { mySubjectsQuery, myThreadsQuery } from '../threads/data';
import { buildNeeds, countNeeds, type Needs, type OrgInput } from './logic';

export interface NeedsAll {
  needs: Needs;
  /** Everything waiting (the list and the suggestions), less what is counting down. */
  counts: { total: number; onlyYou: number };
  /** Every organization's feeds have answered (or 3 s of patience ran out): counts are final. */
  ready: boolean;
  /** The organizations in the list, in the member's order (the one on screen first). */
  orgs: { wid: string; name: string }[];
  /** Member names by organization, then uid (approval lines, tags). */
  names: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Every organization's Needs-you feeds have answered (no patience). */
  settled: boolean;
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

/** Groups, names and Inbox threads: what every organization needs besides its items. */
function useExtras(wid: string, uid: string) {
  const groups = usePart(useLiveCollection(`workspaces/${wid}/groups`, groupSchema));
  const members = useLiveCollection(`workspaces/${wid}/members`, memberProfileSchema);
  const names = useMemo(() => namesFrom(members), [members]);
  const threads = usePart<InboxThread>(
    // `synced`: a cached empty answer the server confirms unchanged must still count as answered.
    useLiveQuery(`needs-threads:${wid}:${uid}`, () => myThreadsQuery(wid, uid), inboxThreadSchema, {
      synced: true,
    }),
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
  return { groups, names, threads, subjectLabels };
}

/** The organization on screen: the shell already listens to its projects and items. */
function CurrentOrg({ onOrg }: { onOrg: (wid: string, s: OrgState) => void }) {
  const { session } = useReady();
  const shell = useShellData();
  const wid = session.workspaceId;
  const uid = session.me.uid;
  const { groups, names, threads, subjectLabels } = useExtras(wid, uid);
  const input = useMemo<OrgInput>(
    () => ({
      wid,
      name: session.workspace.name,
      adminUids: session.workspace.adminUids,
      isAdmin: session.isAdmin,
      projects: shell.projects,
      items: shell.items,
      suggestions: shell.suggestions,
      questions: shell.questions,
      proposals: shell.proposals,
      groups: groups.rows,
      threads: threads.rows,
      subjectLabels,
      names,
    }),
    [wid, session, shell, groups.rows, threads.rows, subjectLabels, names],
  );
  const settled = !shell.loading && shell.needsSettled && threads.done;
  useEffect(() => onOrg(wid, { input, settled }), [wid, input, settled, onOrg]);
  useEffect(() => () => onOrg(wid, null), [wid, onOrg]);
  return null;
}

/** Another organization the member is in: its own feeds, the same queries the shell would run. */
function OtherOrg({ wid, onOrg }: { wid: string; onOrg: (wid: string, s: OrgState) => void }) {
  const { session } = useReady();
  const uid = session.me.uid;
  const ws = useLiveDoc(paths.workspace(wid), workspaceSchema);
  const workspace = ws.state === 'ready' ? ws.data : null;
  const role = workspace?.memberRoles[uid];
  const isAdmin = role === 'admin';
  const known = ws.state !== 'loading';
  const projectsLive = useLiveQuery(
    role ? `needs-projects:${wid}:${uid}:${isAdmin ? 'all' : 'mine'}` : null,
    () =>
      isAdmin ? query(collection(db, `workspaces/${wid}/projects`)) : myProjectsQuery(wid, uid),
    projectSchema,
    { synced: true },
  );
  const projects = useMemo(
    () =>
      projectsLive.state === 'ready' ? projectsLive.data.filter((p) => !p.data.archivedAt) : EMPTY,
    [projectsLive],
  );
  const [openRows, itemsState, setItems] = useFeedRows<Item>();
  const [questions, questionsState, setQs] = useFeedRows<Message>();
  const [proposals, , setProposals] = useFeedRows<StepProposal>();
  const { items, suggestions } = useMemo(() => splitSuggestions(openRows), [openRows]);
  const { groups, names, threads, subjectLabels } = useExtras(wid, uid);

  const input = useMemo<OrgInput | null>(
    () =>
      workspace && role
        ? {
            wid,
            name: workspace.name,
            adminUids: workspace.adminUids,
            isAdmin,
            projects,
            items,
            suggestions,
            questions,
            proposals,
            groups: groups.rows,
            threads: threads.rows,
            subjectLabels,
            names,
          }
        : null,
    [
      wid,
      workspace,
      role,
      isAdmin,
      projects,
      items,
      suggestions,
      questions,
      proposals,
      groups.rows,
      threads.rows,
      subjectLabels,
      names,
    ],
  );
  const projectsDone =
    projectsLive.state === 'error' || (projectsLive.state === 'ready' && !projectsLive.fromCache);
  const settled =
    known &&
    (!role ||
      (projectsDone &&
        threads.done &&
        projects.every((p) => answered(itemsState[p.id]) && answered(questionsState[p.id]))));
  useEffect(() => {
    // Removed from it (or it is gone): it simply drops out of the list.
    if (known && !input) onOrg(wid, { input: null, settled: true });
    else if (input) onOrg(wid, { input, settled });
  }, [wid, input, settled, known, onOrg]);
  useEffect(() => () => onOrg(wid, null), [wid, onOrg]);
  if (!role || workspace?.deletingAt) return null;
  return (
    <>
      {projects.map((p) => (
        <ItemsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setItems} />
      ))}
      {projects.map((p) => (
        <QuestionsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setQs} />
      ))}
      {projects
        .filter((p) => canEditAgentSettings({ uid, isAdmin }, p.data))
        .map((p) => (
          <ProposalsFeed key={p.id} wid={wid} pid={p.id} uid={uid} onRows={setProposals} />
        ))}
    </>
  );
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
  const pending = usePendingKeys();
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
    const live = [...needs.todo, ...needs.suggestions].filter((e) => !pending.has(e.key));
    const c = countNeeds(live);
    const settled = order.every((w) => states[w]?.settled);
    return {
      needs,
      counts: { total: c.total, onlyYou: c.onlyYou },
      ready: settled || (!patient && shell.needsReady),
      orgs: inputs.map((i) => ({ wid: i.wid, name: i.name })),
      names: Object.fromEntries(inputs.map((i) => [i.wid, i.names])),
      settled,
    };
  }, [order, states, uid, pending, patient, shell.needsReady]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <CurrentOrg onOrg={onOrg} />
      {others.map((w) => (
        <OtherOrg key={w} wid={w} onOrg={onOrg} />
      ))}
    </Ctx.Provider>
  );
}
