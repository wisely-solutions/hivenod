/**
 * Firestore side of reach out (item KZ6O9): the ReachPorts, and the builder that turns what the
 * steps listener reads (outcomes in agent hands, one query per organization) into `Watched`
 * entries.
 */
import { outcomeType, SYSTEM_UID, threadLink } from '@hive/shared';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import type { Engine } from './engine';
import type { Flag, ReachPorts, Watched } from './reach';

const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
/** Node timers take at most ~24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Firestore drops nothing silently: undefined fields are left out. */
const clean = (f: Flag) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined)) as Flag;

export function firestoreReachPorts(
  db: Firestore,
  engine: Engine,
  log: (s: string) => void,
): ReachPorts {
  const notFound = (e: unknown) => (e as { code?: number }).code === 5;
  return {
    now: () => Date.now(),
    setTimer: (fn, delay) => setTimeout(fn, Math.min(delay, MAX_TIMER_MS)),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log,
    async activity(w, afterMs) {
      // A note or anything else the agent did on the thread moves the thread's updatedAt.
      const t = await db.doc(`workspaces/${w.ref.wid}/inboxThreads/${w.ref.tid}`).get();
      const at = ms(t.data()?.updatedAt);
      return at > afterMs ? at : null;
    },
    async ask(w) {
      try {
        await db.doc(`workspaces/${w.ref.wid}/inboxOutcomes/${w.ref.oid}`).update({
          statusAsk: { byUid: SYSTEM_UID, at: FieldValue.serverTimestamp() },
        });
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async flag(w, f) {
      try {
        await db
          .doc(`workspaces/${w.ref.wid}/inboxOutcomes/${w.ref.oid}`)
          .update({ silence: f ? clean(f) : null });
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    deliver: (uid, notice, w, key) =>
      engine.deliver(uid, notice, { kind: 'reach', uid, ref: w.ref }, key),
    bell: (uids, id, entry) => engine.addBells(uids, id, entry),
  };
}

/** What the steps listener reads of an outcome in agent hands. */
export interface StepDoc {
  oid: string;
  threadId: string;
  memberUid: string;
  type: string;
  state: string;
  executor: string | null;
  planId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  decisionAtMs: number;
  progress: { line: string; atMs: number } | null;
  askMs: number | null;
  silence: Flag | null;
}

/** Reads an outcome doc for the steps listener. */
export function stepDoc(oid: string, x: Record<string, unknown>): StepDoc | null {
  if (typeof x.threadId !== 'string' || typeof x.memberUid !== 'string') return null;
  const pr = x.progress as { line?: string; at?: unknown } | undefined;
  const sa = x.statusAsk as { at?: unknown } | null | undefined;
  const sl = x.silence as Flag | null | undefined;
  return {
    oid,
    threadId: x.threadId,
    memberUid: x.memberUid,
    type: String(x.type ?? ''),
    state: String(x.state ?? ''),
    executor: typeof x.executor === 'string' ? x.executor : null,
    planId: typeof x.planId === 'string' ? x.planId : null,
    createdAtMs: ms(x.createdAt),
    updatedAtMs: ms(x.updatedAt),
    decisionAtMs: ms((x.decision as { at?: unknown } | null)?.at),
    progress: pr && typeof pr.line === 'string' ? { line: pr.line, atMs: ms(pr.at) } : null,
    askMs: sa?.at ? ms(sa.at) : null,
    silence: sl && typeof sl.since === 'number' ? sl : null,
  };
}

/**
 * A thread step in agent hands, as reach out watches it: an approved outcome its agent carries
 * out (a plan's only at its turn), or a running long step. Null otherwise.
 */
export function stepWatched(a: {
  wid: string;
  o: StepDoc;
  plan: { steps: string[]; cursor: number; state: string; updatedAtMs: number } | null;
  threadTitle: string;
  agentName: string;
}): Watched | null {
  const { o, plan } = a;
  if (!o.executor) return null;
  const type = outcomeType(o.type);
  if (o.state === 'running' && !type?.long) return null; // a Build it step waits for its item
  if (o.state !== 'approved' && o.state !== 'running') return null;
  let where = type?.label ?? o.type;
  let turnMs = 0;
  if (o.planId) {
    if (!plan || !['active', 'proposed'].includes(plan.state) || plan.steps[plan.cursor] !== o.oid)
      return null;
    where += `, step ${plan.cursor + 1} of ${plan.steps.length}`;
    turnMs = plan.updatedAtMs;
  }
  return {
    key: `${a.wid}/o/${o.oid}`,
    ref: { kind: 'step', wid: a.wid, oid: o.oid, tid: o.threadId },
    run: o.oid,
    activityMs: Math.max(
      o.createdAtMs,
      o.updatedAtMs,
      o.decisionAtMs,
      o.progress?.atMs ?? 0,
      turnMs,
    ),
    askMs: o.askMs,
    flag: o.silence,
    agentUid: o.executor,
    agentName: a.agentName,
    title: a.threadTitle || 'An Inbox thread',
    where,
    url: threadLink(a.wid, o.threadId),
    last: o.progress ? { text: o.progress.line, atMs: o.progress.atMs } : null,
    to: [o.memberUid],
  };
}
