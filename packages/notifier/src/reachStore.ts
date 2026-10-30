/**
 * Firestore side of reach out (item KZ6O9): the ReachPorts, and the builders that turn what the
 * listeners already read (working items, steps in agent hands) into `Watched` entries. No new
 * scans: the working-items listener existed (item AzveC); the steps listener is one query per
 * organization on the outcomes in agent hands.
 */
import {
  INBOX_BELL_PROJECT,
  itemLink,
  liveTerminal,
  messageDoc,
  outcomeType,
  parkOf,
  reachKind,
  releaseStale,
  silenceDeciders,
  silenceAfterOf,
  STALE_CLAIM_MINUTES,
  statusAskOf,
  statusLine,
  statusOf,
  SYSTEM_NAME,
  SYSTEM_UID,
  threadLink,
  paths,
  type Item,
  type Project,
} from '@hive/shared';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { toAdminValue } from './admin';
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
      const after = Timestamp.fromMillis(afterMs);
      if (w.ref.kind === 'step') {
        // A note or anything else the agent did on the thread moves the thread's updatedAt.
        const t = await db.doc(`workspaces/${w.ref.wid}/inboxThreads/${w.ref.tid}`).get();
        const at = ms(t.data()?.updatedAt);
        return at > afterMs ? at : null;
      }
      const { wid, iid, runId } = w.ref;
      let best = 0;
      const lines = await db
        .collection(`workspaces/${wid}/runs/${runId}/log`)
        .where('at', '>', after)
        .orderBy('at', 'desc')
        .limit(1)
        .get();
      for (const d of lines.docs) best = Math.max(best, ms(d.data().at));
      // The agent's tool writes on the item: its events, heartbeats aside. Newest first, page by
      // page, only those after `afterMs`.
      let q = db
        .collection(`workspaces/${wid}/events`)
        .where('itemId', '==', iid)
        .where('at', '>', after)
        .orderBy('at', 'desc')
        .limit(100);
      for (;;) {
        const page = await q.get();
        const hit = page.docs.find((d) => {
          const e = d.data();
          return e.actor?.id === w.agentUid && e.type !== 'run.heartbeat';
        });
        if (hit) {
          best = Math.max(best, ms(hit.data().at));
          break;
        }
        if (page.size < 100) break;
        q = q.startAfter(page.docs[page.size - 1]!);
      }
      return best || null;
    },
    async ask(w) {
      try {
        if (w.ref.kind === 'item')
          await db.doc(paths.item(w.ref.wid, w.ref.pid, w.ref.iid)).update({
            statusAsk: { runId: w.ref.runId, byUid: SYSTEM_UID, at: FieldValue.serverTimestamp() },
          });
        else
          await db.doc(`workspaces/${w.ref.wid}/inboxOutcomes/${w.ref.oid}`).update({
            statusAsk: { byUid: SYSTEM_UID, at: FieldValue.serverTimestamp() },
          });
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async flag(w, f) {
      try {
        if (w.ref.kind === 'item')
          await db
            .doc(paths.item(w.ref.wid, w.ref.pid, w.ref.iid))
            .update({ silence: f ? { runId: w.ref.runId, ...clean(f) } : null });
        else
          await db
            .doc(`workspaces/${w.ref.wid}/inboxOutcomes/${w.ref.oid}`)
            .update({ silence: f ? clean(f) : null });
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    async sessionLive(w) {
      const a = await db.doc(`workspaces/${w.ref.wid}/agents/${w.agentUid}`).get();
      const d = a.data();
      if (!d) return false;
      return (
        liveTerminal(
          {
            lastSeenAt: (d.lastSeenAt as Item['updatedAt'] | null) ?? null,
            signedOutAt: (d.signedOutAt as Item['updatedAt'] | null) ?? null,
            seenHost: (d.seenHost as string | undefined) ?? null,
          } as Parameters<typeof liveTerminal>[0],
          Date.now(),
        ) !== null
      );
    },
    async release(w) {
      if (w.ref.kind !== 'item') return;
      const { wid, pid, iid, runId } = w.ref;
      const ref = db.doc(paths.item(wid, pid, iid));
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const claim = snap.data()?.claim as Item['claim'] | undefined;
        // Moved on meanwhile (released, completed, or a fresh heartbeat): nothing to do.
        if (!claim || claim.runId !== runId) return;
        if (Date.now() - ms(claim.heartbeatAt) < STALE_CLAIM_MINUTES * 60_000) return;
        const ctx = {
          workspaceId: wid,
          actor: { type: 'human' as const, id: SYSTEM_UID, name: SYSTEM_NAME },
        };
        const p = releaseStale(ctx, {
          projectId: pid,
          itemId: iid,
          runId,
          agentUid: claim.agentUid,
        });
        const who = w.agentName || 'The agent';
        const text = `${who} had no live session and its claim no heartbeat for ${STALE_CLAIM_MINUTES + 30} min: Hivenod put the item back in the queue.`;
        const ops = [
          ...p.ops,
          {
            kind: 'set' as const,
            path: paths.message(wid, pid, iid, `${p.eventId}-reach`),
            data: messageDoc(ctx, pid, iid, 'note', text, null, p.eventId),
          },
        ];
        for (const op of ops) {
          const r = db.doc(op.path);
          const data = toAdminValue(op.data ?? {}) as Record<string, unknown>;
          if (op.kind === 'set') tx.set(r, data);
          else if (op.kind === 'update') tx.update(r, data);
          else tx.delete(r);
        }
        // The release also clears the flag (a queued item is in nobody's hands).
        tx.update(ref, { silence: null });
      });
    },
    deliver: (uid, notice, w, key) =>
      engine.deliver(uid, notice, { kind: 'reach', uid, ref: w.ref }, key),
    bell: (uids, id, entry) => engine.addBells(uids, id, entry),
  };
}

/**
 * An item the working-items listener sees, as reach out watches it; null when it is in no agent's
 * hands (or the project turned silence off).
 */
export function itemWatched(a: {
  wid: string;
  pid: string;
  iid: string;
  project: Project;
  item: Item;
  startedMs: number;
  agentName: string;
  nowMs: number;
}): Watched | null {
  const { item, project } = a;
  const kind = reachKind(item, a.nowMs);
  if (!kind || !item.claim || silenceAfterOf(project) === 0) return null;
  const runId = item.claim.runId;
  const st = statusOf(item);
  const park = parkOf(item);
  const updated = ms(item.updatedAt);
  const activityMs = Math.max(
    a.startedMs,
    updated >= a.startedMs ? updated : 0,
    st ? ms(st.at) : 0,
    park ? ms(park.at) : 0,
  );
  const ask = statusAskOf(item);
  const f = item.silence && item.silence.runId === runId ? item.silence : null;
  const step = project.steps.find((s) => s.id === item.stepId);
  return {
    key: `${a.wid}/${a.iid}`,
    ref: { kind: 'item', wid: a.wid, pid: a.pid, iid: a.iid, runId },
    run: runId,
    kind,
    activityMs,
    askMs: ask ? ms(ask.at) : null,
    flag: f
      ? {
          since: f.since,
          at: f.at,
          ...(f.asked !== undefined ? { asked: f.asked } : {}),
          ...(f.told !== undefined ? { told: f.told } : {}),
          ...(f.agent !== undefined ? { agent: f.agent } : {}),
        }
      : null,
    heartbeatMs: ms(item.claim.heartbeatAt),
    agentUid: item.claim.agentUid,
    agentName: a.agentName,
    title: item.title,
    where: step?.name ?? '',
    url: itemLink(a.pid, a.iid),
    last: st ? { text: statusLine(st), atMs: ms(st.at) } : null,
    to: silenceDeciders(project, item),
    bell: { projectId: a.pid, projectName: project.name, itemId: a.iid },
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
    kind: 'held',
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
    bell: { projectId: INBOX_BELL_PROJECT, projectName: 'Inbox', itemId: o.threadId },
  };
}
