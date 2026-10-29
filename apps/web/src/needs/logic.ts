/**
 * Needs you across every organization (item 2YZRd4tmFrXR1UjBWYJF). Pure: the per-organization
 * inputs come from needs/data.tsx, which merges one set of live queries per organization on the
 * client (no server work, so it stays at €0).
 *
 * Every row says who else can act on it: "Only you" when nobody else can (a sole decider, a gate
 * that needs everyone, the member's own Inbox thread), or "You or others · <names>" when any one of
 * several people (or a group, shown by its name) can.
 */
import {
  splitDeciders,
  type Group,
  type InboxOutcome,
  type InboxThread,
  type Project,
} from '@hive/shared';
import type { Row } from '../lib/live';
import { bandOf, type Band } from '../threads/logic';
import { isTidyUp } from '../today/logic';
import {
  buildInbox,
  isStuckHold,
  type InboxEntry,
  type InboxFilter,
  type InboxInput,
} from '../inbox/logic';

/** One organization's share of the inputs (InboxInput plus what the tags and threads need). */
export interface OrgInput extends Omit<InboxInput, 'uid'> {
  wid: string;
  name: string;
  /** The organization's admins (they see every project, triage and approve steps). */
  adminUids: readonly string[];
  groups: readonly Row<Group>[];
  /** The member's Inbox threads (any state; only Needs you and Your call are listed). */
  threads: readonly Row<InboxThread>[];
  /** The member's open outcome proposals (inboxOutcomes at `proposed`), item kt3E7. */
  openOutcomes: readonly Row<InboxOutcome>[];
  /** Display names of the organization's members, by uid. */
  names: Readonly<Record<string, string>>;
}

export type Who = { only: true } | { only: false; others: string[] };

export type NeedsKind = InboxEntry['kind'] | 'thread';

export interface NeedsEntry {
  /** Unique across organizations: the inbox key, or `t:<wid>:<tid>` for a thread. */
  key: string;
  wid: string;
  org: string;
  kind: NeedsKind;
  since: number;
  /** Urgent rows come first in their project: a flagged Inbox thread, or agents stuck on an item. */
  urgent: boolean;
  who: Who;
  /** The group the row is listed in: a project id, or `inbox` for Inbox threads. */
  group: string;
  /** Item entries (approvals, questions, findings, path changes, step proposals). */
  entry?: InboxEntry;
  /** Inbox threads at Needs you or Your call. */
  thread?: Row<InboxThread>;
  /** A thread's open proposals, oldest first (item kt3E7). */
  proposals?: Row<InboxOutcome>[];
  /** A thread whose one proposal is a tidy-up: it goes to the tidy-ups card, not the stack. */
  tidy?: boolean;
}

export interface Needs {
  /** Waiting for this person (no suggestions), grouped and ordered (see `orderNeeds`). */
  todo: NeedsEntry[];
  /** New agent suggestions to add or dismiss: their own small section. */
  suggestions: NeedsEntry[];
  /** Gates this person already decided, waiting for the others. */
  waiting: NeedsEntry[];
}

/** Thread states that wait for the member. */
export const THREAD_NEEDS = ['needsYou', 'yourCall'] as const;

const others = (uids: Iterable<string>, uid: string) => [...new Set(uids)].filter((u) => u !== uid);

/** The display names of `uids`, with whole groups shown by the group's name (a group, not its people). */
function namesOf(
  uids: readonly string[],
  groupIds: readonly string[],
  ctx: Pick<OrgInput, 'groups' | 'names'>,
): string[] {
  const groups = ctx.groups
    .filter((g) => groupIds.includes(g.id))
    .map((g) => ({ id: g.id, name: g.data.name, memberUids: g.data.memberUids }));
  const out: string[] = [];
  const covered = new Set<string>();
  for (const g of groups) {
    const inIt = g.memberUids.filter((u) => uids.includes(u));
    if (inIt.length === 0) continue;
    out.push(g.name);
    for (const u of inIt) covered.add(u);
  }
  for (const u of uids) if (!covered.has(u)) out.push(ctx.names[u] ?? 'Someone');
  return out;
}

const shared = (list: string[]): Who =>
  list.length ? { only: false, others: list } : { only: true };

/**
 * Who besides this person can act on an item entry. Votes count: someone who already approved
 * cannot approve again, and a gate that needs everyone (or names this person as a must) needs
 * this person whatever the others do.
 */
export function whoCanAct(
  e: InboxEntry,
  uid: string,
  ctx: Pick<OrgInput, 'groups' | 'names' | 'adminUids'>,
): Who {
  const { project, item } = e;
  if (e.kind === 'approval') {
    const gate = project.steps.find((s) => s.id === item.stepId)?.gate;
    if (!gate) return { only: true };
    if (gate.rule === 'all' || gate.mustInclude.includes(uid)) return { only: true };
    const voted = new Set([
      ...Object.keys(item.gate?.approvals ?? {}),
      ...Object.keys(item.gate?.rejections ?? {}),
    ]);
    const approved = Object.keys(item.gate?.approvals ?? {}).filter((u) =>
      gate.deciderUids.includes(u),
    ).length;
    const needed = gate.rule === 'any' ? 1 : gate.n;
    const left = Math.max(1, needed - approved);
    const free = others(gate.deciderUids, uid).filter((u) => !voted.has(u));
    // Others could fill every remaining approval without this person.
    if (free.length < left) return { only: true };
    const { groupIds } = splitDeciders(gate, groupRefs(ctx.groups));
    return shared(namesOf(free, groupIds, ctx));
  }
  if (e.kind === 'path') {
    const gate = project.steps.find((s) => s.id === e.stepId)?.gate;
    if (!gate) return { only: true };
    const { groupIds } = splitDeciders(gate, groupRefs(ctx.groups));
    return shared(namesOf(others(gate.deciderUids, uid), groupIds, ctx));
  }
  if (e.kind === 'proposal') {
    return shared(namesOf(others([...ctx.adminUids, project.createdBy], uid), [], ctx));
  }
  if (e.kind === 'finding') {
    const first = project.steps[0];
    const deciders = first?.kind === 'human' ? (first.gate?.deciderUids ?? []) : [];
    // The people who may triage it (canTriage): admins, the project's creator, first-step deciders.
    const triagers = [...ctx.adminUids, project.createdBy, ...deciders];
    return shared(namesOf(others(triagers, uid), [], ctx));
  }
  // A question goes to the item's project: any of its people (and the admins) can answer it.
  return shared(namesOf(others([...project.memberUids, ...ctx.adminUids], uid), [], ctx));
}

const groupRefs = (groups: readonly Row<Group>[]) =>
  groups.map((g) => ({ id: g.id, name: g.data.name, memberUids: g.data.memberUids }));

/** Every organization's Needs you, merged and ordered. */
export function buildNeeds(orgs: readonly OrgInput[], uid: string, now = Date.now()): Needs {
  const todo: NeedsEntry[] = [];
  const suggestions: NeedsEntry[] = [];
  const waiting: NeedsEntry[] = [];
  for (const o of orgs) {
    const inbox = buildInbox({ ...o, uid, wid: o.wid });
    const wrap = (e: InboxEntry, who: Who): NeedsEntry => ({
      key: e.key,
      wid: o.wid,
      org: o.name,
      kind: e.kind,
      since: e.since,
      urgent: isStuckHold(e),
      who,
      group: e.pid,
      entry: e,
    });
    for (const e of inbox.todo) {
      const row = wrap(e, whoCanAct(e, uid, o));
      (e.kind === 'finding' ? suggestions : todo).push(row);
    }
    for (const e of inbox.waiting) waiting.push(wrap(e, { only: false, others: [] }));
    for (const t of o.threads) {
      if (t.data.memberUid !== uid) continue;
      if (!(THREAD_NEEDS as readonly string[]).includes(t.data.state)) continue;
      const proposals = o.openOutcomes
        .filter((p) => p.data.threadId === t.id && p.data.state === 'proposed')
        .sort(
          (a, b) =>
            a.data.createdAt.toMillis() - b.data.createdAt.toMillis() || (a.id < b.id ? -1 : 1),
        );
      // Your call with nothing left to decide: approved, the agent carries it out.
      if (t.data.state === 'yourCall' && proposals.length === 0) continue;
      const tidy =
        t.data.state === 'yourCall' &&
        proposals.length === 1 &&
        isTidyUp(proposals[0]!.data, t.data, 1, now);
      todo.push({
        key: `t:${o.wid}:${t.id}`,
        wid: o.wid,
        org: o.name,
        kind: 'thread',
        since:
          (t.data.state === 'needsYou' ? t.data.question?.at : undefined)?.toMillis() ??
          t.data.updatedAt.toMillis(),
        urgent: t.data.urgent === true,
        who: { only: true },
        group: 'inbox',
        thread: t,
        proposals,
        tidy,
      });
    }
  }
  const order = orgs.map((o) => o.wid);
  return {
    todo: orderNeeds(todo, order),
    suggestions: orderNeeds(suggestions, order),
    waiting: orderNeeds(waiting, order),
  };
}

const rank = (a: NeedsEntry, b: NeedsEntry) =>
  Number(b.urgent) - Number(a.urgent) || a.since - b.since;

/**
 * Grouped by organization, then by project (Inbox threads are a group of their own), each group
 * urgent first and then oldest waiting first. Organizations and projects follow their first row,
 * so the most pressing group leads; `orgOrder` breaks ties.
 */
export function orderNeeds(list: readonly NeedsEntry[], orgOrder: readonly string[] = []) {
  const byOrg = new Map<string, Map<string, NeedsEntry[]>>();
  for (const e of [...list].sort(rank)) {
    const groups = byOrg.get(e.wid) ?? new Map<string, NeedsEntry[]>();
    byOrg.set(e.wid, groups);
    const g = groups.get(e.group) ?? [];
    groups.set(e.group, g);
    g.push(e);
  }
  const orgs = [...byOrg.entries()].map(([wid, groups]) => ({
    wid,
    groups: [...groups.values()].sort((a, b) => rank(a[0]!, b[0]!)),
  }));
  const at = (wid: string) => {
    const i = orgOrder.indexOf(wid);
    return i < 0 ? orgOrder.length : i;
  };
  orgs.sort((a, b) => rank(a.groups[0]![0]!, b.groups[0]![0]!) || at(a.wid) - at(b.wid));
  return orgs.flatMap((o) => o.groups.flat());
}

export type Scope = 'all' | 'mine' | 'shared';

export function parseScope(v: unknown): Scope {
  return v === 'mine' || v === 'shared' ? v : 'all';
}

/** Only me: rows nobody else can act on. Shared: rows others can act on too. `org` narrows to one. */
export function filterNeeds(
  list: readonly NeedsEntry[],
  scope: Scope,
  org?: string | null,
): NeedsEntry[] {
  return list.filter(
    (e) =>
      (!org || e.wid === org) && (scope === 'all' || (scope === 'mine' ? e.who.only : !e.who.only)),
  );
}

export function countNeeds(list: readonly NeedsEntry[]): {
  total: number;
  onlyYou: number;
  shared: number;
} {
  const onlyYou = list.filter((e) => e.who.only).length;
  return { total: list.length, onlyYou, shared: list.length - onlyYou };
}

/** "You or others · Ana, Product team +2": at most three names, then how many more. */
export function whoLabel(who: Who): string {
  if (who.only) return 'Only you';
  if (who.others.length === 0) return 'You or others';
  const shown = who.others.slice(0, 3).join(', ');
  const more = who.others.length - 3;
  return `You or others · ${shown}${more > 0 ? ` +${more}` : ''}`;
}

export interface NeedsGroup {
  wid: string;
  org: string;
  /** A project id, or `inbox`. */
  group: string;
  project: Project | null;
  entries: NeedsEntry[];
}

/** The ordered list cut into its headed groups (organization, then project), keeping the order. */
export function groupsOf(list: readonly NeedsEntry[]): NeedsGroup[] {
  const out: NeedsGroup[] = [];
  for (const e of list) {
    const last = out[out.length - 1];
    if (last && last.wid === e.wid && last.group === e.group) last.entries.push(e);
    else
      out.push({
        wid: e.wid,
        org: e.org,
        group: e.group,
        project: e.entry?.project ?? null,
        entries: [e],
      });
  }
  return out;
}

/**
 * The kind filter (All · Approvals · Questions · Findings) on the merged list: path changes and
 * step proposals are decisions (Approvals); an Inbox thread at Your call is too (outcomes wait for
 * approval), one at Needs you is a question. Findings are the suggestions section.
 */
export function kindGroup(e: NeedsEntry): Exclude<InboxFilter, 'all'> {
  if (e.kind === 'finding') return 'findings';
  if (e.kind === 'question') return 'questions';
  if (e.kind === 'thread') return e.thread?.data.state === 'needsYou' ? 'questions' : 'approvals';
  return 'approvals';
}

export function filterKind(list: readonly NeedsEntry[], f: InboxFilter): NeedsEntry[] {
  return f === 'all' ? [...list] : list.filter((e) => kindGroup(e) === f);
}

export function countKinds(list: readonly NeedsEntry[]): Record<InboxFilter, number> {
  const n = { all: list.length, approvals: 0, questions: 0, findings: 0 };
  for (const e of list) n[kindGroup(e)] += 1;
  return n;
}

/** A thread entry's rank band (design 3.5); project entries have none. */
export function entryBand(e: NeedsEntry, now: number): Band | null {
  return e.thread ? bandOf(e.thread.data, now) : null;
}

/**
 * The Today stack's order (item kt3E7, design 2.1): band-1 threads, urgent project entries,
 * band-2 threads, then everything else (band-3/4 threads and the other project entries) oldest
 * first. In bands 1 and 2 the earlier due date first. Tidy-ups are not part of it.
 */
export function orderToday(list: readonly NeedsEntry[], now: number): NeedsEntry[] {
  const tier = (e: NeedsEntry) => {
    const b = entryBand(e, now);
    if (b === 1) return 0;
    if (b === null && e.urgent) return 1;
    if (b === 2) return 2;
    return 3;
  };
  const due = (e: NeedsEntry) => e.thread?.data.due?.toMillis() ?? Infinity;
  return list
    .filter((e) => !e.tidy)
    .map((e, i) => ({ e, i, t: tier(e) }))
    .sort(
      (a, b) =>
        a.t - b.t ||
        (a.t === 0 || a.t === 2 ? due(a.e) - due(b.e) : 0) ||
        a.e.since - b.e.since ||
        a.i - b.i,
    )
    .map((x) => x.e);
}
