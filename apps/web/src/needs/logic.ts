/**
 * Today's list across every organization (items 2YZRd4tmFrXR1UjBWYJF, kt3E7). Pure: the
 * per-organization inputs come from needs/data.tsx, which merges one set of live queries per
 * organization on the client (no server work, so it stays at €0).
 *
 * Projects (and their items) were removed in item OE8FmrTaIxFVGcaeGG3N, slice 10: every row is
 * one of the member's Inbox threads at Needs you or Your call.
 */
import {
  notNowHides,
  outcomeKind,
  threadAsk,
  type ThreadAsk,
  type InboxOutcome,
  type InboxPlan,
  type InboxThread,
} from '@hive/shared';
import type { Row } from '../lib/live';
import { bandOf, type Band } from '../threads/logic';
import { isTidyUp } from '../today/logic';
import type { InboxFilter } from '../inbox/logic';

/** One organization's inputs. */
export interface OrgInput {
  wid: string;
  name: string;
  /** The member's Inbox threads (any state; only Needs you and Your call are listed). */
  threads: readonly Row<InboxThread>[];
  /** The member's open outcome proposals (inboxOutcomes at `proposed`), item kt3E7. */
  openOutcomes: readonly Row<InboxOutcome>[];
  /** The member's live plans (proposed, active, blocked), item qwFAWxZM5xkcE7PPjAzi. */
  livePlans?: readonly Row<InboxPlan>[];
  /** The labels of the member's subjects, by subject id (subjects without one are left out). */
  subjectLabels?: Readonly<Record<string, { label: string; suggested: boolean }>>;
  /** Display names of the organization's members, by uid. */
  names: Readonly<Record<string, string>>;
}

export type NeedsKind = 'thread';

export interface NeedsEntry {
  /** Unique across organizations: `t:<wid>:<tid>`. */
  key: string;
  wid: string;
  org: string;
  kind: NeedsKind;
  since: number;
  /** A flagged Inbox thread comes first. */
  urgent: boolean;
  /** Inbox threads at Needs you or Your call. */
  thread: Row<InboxThread>;
  /** A thread's open proposals, oldest first (item kt3E7). */
  proposals?: Row<InboxOutcome>[];
  /** The thread's newest live plan (item qwFAWxZM5xkcE7PPjAzi): the card shows its waiting step. */
  plan?: Row<InboxPlan>;
  /** A thread whose one proposal is a tidy-up: it goes to the tidy-ups card, not the stack. */
  tidy?: boolean;
  /** The label of the thread's subject, if it has one (item YaOErIjeIFG8Y3EvZuIp). */
  label?: { label: string; suggested: boolean };
}

export interface Needs {
  /** Waiting for this person, ordered (see `orderNeeds`). */
  todo: NeedsEntry[];
}

/** Thread states that wait for the member. */
export const THREAD_NEEDS = ['needsYou', 'yourCall'] as const;

/** Every organization's waiting threads, merged and ordered. */
export function buildNeeds(orgs: readonly OrgInput[], uid: string, now = Date.now()): Needs {
  const todo: NeedsEntry[] = [];
  for (const o of orgs) {
    for (const t of o.threads) {
      if (t.data.memberUid !== uid) continue;
      if (!(THREAD_NEEDS as readonly string[]).includes(t.data.state)) continue;
      const proposals = o.openOutcomes
        .filter(
          (p) =>
            p.data.threadId === t.id &&
            (p.data.state === 'proposed' || p.data.state === 'revising' || theirDraftWaits(p.data)),
        )
        .sort(
          (a, b) =>
            a.data.createdAt.toMillis() - b.data.createdAt.toMillis() || (a.id < b.id ? -1 : 1),
        );
      const plan = (o.livePlans ?? [])
        .filter((p) => p.data.threadId === t.id)
        .sort((a, b) => b.data.createdAt.toMillis() - a.data.createdAt.toMillis())[0];
      // Your call with nothing left to decide: approved, the agent carries it out. A blocked
      // plan (a step failed) waits for the member: retry, skip or stop.
      if (t.data.state === 'yourCall' && proposals.length === 0 && plan?.data.state !== 'blocked')
        continue;
      // A plan whose open steps all wait later (an approval step not reached yet) asks nothing now.
      if (
        plan &&
        proposals.length > 0 &&
        proposals.every((p) => p.data.planId === plan.id) &&
        !planAsksNow(plan.data, proposals)
      )
        continue;
      // Not now (item OE8FmrTaIxFVGcaeGG3N, slice 3): out of Today until 09:00 the next day,
      // while the same decision waits.
      if (t.data.notNow && notNowHides(t.data.notNow, askOf(t, plan, proposals), now)) continue;
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
        thread: t,
        proposals,
        ...(plan ? { plan } : {}),
        tidy,
        ...(t.data.subjectId && o.subjectLabels?.[t.data.subjectId]
          ? { label: o.subjectLabels[t.data.subjectId] }
          : {}),
      });
    }
  }
  return {
    todo: orderNeeds(
      todo,
      orgs.map((o) => o.wid),
    ),
  };
}

/** What a thread asks its member now (shared with the notifier's quick actions). */
export function askOf(
  t: Row<InboxThread>,
  plan: Row<InboxPlan> | undefined | null,
  open: readonly Row<InboxOutcome>[],
): ThreadAsk | null {
  const q = t.data.question;
  return threadAsk({
    thread: {
      state: t.data.state,
      question: q
        ? { text: q.text, atMs: q.at.toMillis(), answer: q.answer, options: q.options }
        : null,
    },
    plan:
      plan && ['proposed', 'active', 'blocked'].includes(plan.data.state)
        ? { id: plan.id, plan: plan.data }
        : null,
    open: open.map((o) => ({
      id: o.id,
      type: o.data.type,
      state: o.data.state,
      planId: o.data.planId ?? null,
      createdAtMs: o.data.createdAt.toMillis(),
      fields: o.data.fields,
      ...(theirDraftWaits(o.data)
        ? { ext: { n: o.data.ext!.ask!.n, kind: o.data.ext!.ask!.kind } }
        : {}),
    })),
  });
}

/**
 * A Their reply step (running, after its turn) whose drafted message waits for the member's
 * approval: it is a decision on Today like a proposal, though the step itself is not proposed.
 */
export function theirDraftWaits(o: Pick<InboxOutcome, 'type' | 'state' | 'ext'>): boolean {
  return (
    o.type === 'their_reply' &&
    (o.state === 'approved' || o.state === 'running') &&
    o.ext?.ask?.state === 'proposed'
  );
}

const rank = (a: NeedsEntry, b: NeedsEntry) =>
  Number(b.urgent) - Number(a.urgent) || a.since - b.since;

/**
 * Grouped by organization, each urgent first and then oldest waiting first. Organizations follow
 * their first row, so the most pressing leads; `orgOrder` breaks ties.
 */
export function orderNeeds(list: readonly NeedsEntry[], orgOrder: readonly string[] = []) {
  const byOrg = new Map<string, NeedsEntry[]>();
  for (const e of [...list].sort(rank)) {
    const g = byOrg.get(e.wid) ?? [];
    byOrg.set(e.wid, g);
    g.push(e);
  }
  const at = (wid: string) => {
    const i = orgOrder.indexOf(wid);
    return i < 0 ? orgOrder.length : i;
  };
  return [...byOrg.entries()]
    .sort(([wa, a], [wb, b]) => rank(a[0]!, b[0]!) || at(wa) - at(wb))
    .flatMap(([, g]) => g);
}

/** One organization narrows the list (null: all of them). */
export function filterOrg(list: readonly NeedsEntry[], org?: string | null): NeedsEntry[] {
  return org ? list.filter((e) => e.wid === org) : [...list];
}

/** The labels on the listed Inbox threads (case-blind), with how many threads carry each. */
export function labelsOfNeeds(
  list: readonly NeedsEntry[],
): Array<{ key: string; label: string; count: number }> {
  const by = new Map<string, { key: string; label: string; count: number }>();
  for (const e of list) {
    if (!e.label) continue;
    const key = e.label.label.toLowerCase();
    const cur = by.get(key);
    if (cur) cur.count++;
    else by.set(key, { key, label: e.label.label, count: 1 });
  }
  return [...by.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** One label (lowercased key) narrows the list to the Inbox threads that carry it. */
export function filterByLabel(list: readonly NeedsEntry[], key: string | null): NeedsEntry[] {
  if (!key) return [...list];
  return list.filter((e) => e.label?.label.toLowerCase() === key);
}

/**
 * The kind filter (All · Approvals · Questions): a thread at Your call is a decision (outcomes
 * wait for approval), one at Needs you is a question.
 */
export function kindGroup(e: NeedsEntry): Exclude<InboxFilter, 'all'> {
  return e.thread.data.state === 'needsYou' ? 'questions' : 'approvals';
}

export function filterKind(list: readonly NeedsEntry[], f: InboxFilter): NeedsEntry[] {
  return f === 'all' ? [...list] : list.filter((e) => kindGroup(e) === f);
}

export function countKinds(list: readonly NeedsEntry[]): Record<InboxFilter, number> {
  const n = { all: list.length, approvals: 0, questions: 0 };
  for (const e of list) n[kindGroup(e)] += 1;
  return n;
}

/** A thread entry's rank band (design 3.5). */
export function entryBand(e: NeedsEntry, now: number): Band {
  return bandOf(e.thread.data, now);
}

/**
 * The Today stack's order (item kt3E7, design 2.1): band-1 threads, band-2 threads, then the
 * rest oldest first. In bands 1 and 2 the earlier due date first. Tidy-ups are not part of it.
 */
export function orderToday(list: readonly NeedsEntry[], now: number): NeedsEntry[] {
  const tier = (e: NeedsEntry) => {
    const b = entryBand(e, now);
    if (b === 1) return 0;
    if (b === 2) return 2;
    return 3;
  };
  const due = (e: NeedsEntry) => e.thread.data.due?.toMillis() ?? Infinity;
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

/**
 * Whether a live plan asks the member something now (item qwFAWxZM5xkcE7PPjAzi): it is blocked,
 * or proposed, or its step at the cursor waits, or an agent step can still be approved ahead.
 * An approval step not reached yet waits for its turn.
 */
export function planAsksNow(
  plan: Pick<InboxPlan, 'state' | 'steps' | 'cursor'>,
  open: readonly Row<InboxOutcome>[],
): boolean {
  if (plan.state === 'blocked' || plan.state === 'proposed') return true;
  const at = plan.steps[plan.cursor];
  return open.some(
    (p) =>
      p.data.planId &&
      (p.id === at || (outcomeKind(p.data.type) === 'agent' && p.data.state === 'proposed')),
  );
}
