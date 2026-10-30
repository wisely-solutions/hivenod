/**
 * Firestore side of the scheduler (scheduler.ts), Admin SDK: the ports and the listeners. Costs
 * (João, 2026-10-30: as cheap as possible): listeners on the active/paused schedules, the open runs
 * and the Off docs of each organization (reads only when one changes); one plan doc listener per
 * fired run while it is open; a read of the agent doc when a run is due; the beat is one write
 * every 15 minutes. Nothing is polled.
 */
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import {
  ActionError,
  DEFAULT_NOTIFY_PREFS,
  fireScheduledRun,
  inboxOutcomeSchema,
  inboxPaths,
  inboxPlanSchema,
  inboxThreadSchema,
  instructThread,
  notifyPath,
  notifyPrefsSchema,
  outcomeKind,
  paths,
  randomId,
  retryPlanStep,
  runDocId,
  runThreadKey,
  SCHEDULER_ACTOR,
  SCHEDULER_BEAT_PATH,
  scheduleSchema,
  schedulePaths,
  type ActionContext,
  type InboxOutcome,
  type Occurrence,
  type RunState,
  type ScheduleOf,
} from '@hive/shared';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { applyPlanAdmin } from './admin';
import type {
  AgentView,
  NewRun,
  PlanView,
  RunAsk,
  RunView,
  Scheduler,
  SchedulerPorts,
} from './scheduler';

const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? null;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const ALREADY_EXISTS = 6;
const OPEN_STATES: RunState[] = ['waitingAgent', 'fired', 'running', 'cantRun', 'runNow', 'later'];

/** The ids of a run's thread and its parts: derived from (schedule, period), so a second fire collides. */
export function runIds(sid: string, key: string, steps: number, attempt: number) {
  const base = runThreadKey(sid, key);
  return {
    threadId: `ts${sha(base).slice(0, 24)}`,
    planId: `ps${sha(`${base}\u0000plan`).slice(0, 24)}`,
    stepIds: Array.from(
      { length: steps },
      (_, i) => `os${sha(`${base}\u0000step\u0000${i}`).slice(0, 24)}`,
    ),
    messageId: `ms${sha(`${base}\u0000message`).slice(0, 24)}`,
    eventId: `es${sha(`${base}\u0000fire\u0000${attempt}`).slice(0, 24)}`,
  };
}

/** The event a run's move is recorded with (Activity, group "Schedules"). */
const EVENT_OF: Partial<Record<RunState, string>> = {
  fired: 'run.fired',
  running: 'run.started',
  done: 'run.done',
  stopped: 'run.done',
  cantRun: 'run.cantRun',
  expired: 'run.expired',
};

export function scheduleOf(data: unknown): ScheduleOf | null {
  const p = scheduleSchema.safeParse(data);
  return p.success ? p.data : null;
}

export function runView(wid: string, id: string, x: Record<string, unknown>): RunView | null {
  if (typeof x.scheduleId !== 'string' || typeof x.state !== 'string') return null;
  const ask = x.ask as Record<string, unknown> | null | undefined;
  const dec = x.decision as Record<string, unknown> | null | undefined;
  const why = x.why as { code?: string; text?: string } | null | undefined;
  return {
    wid,
    id,
    sid: x.scheduleId,
    key: String(x.key ?? ''),
    period: String(x.period ?? ''),
    dueMs: ms(x.dueAt) ?? 0,
    title: String(x.title ?? ''),
    memberUid: String(x.memberUid ?? ''),
    agentUid: String(x.agentUid ?? ''),
    state: x.state as RunState,
    why:
      why && typeof why.code === 'string'
        ? { code: why.code as never, text: String(why.text ?? '') }
        : null,
    threadId: typeof x.threadId === 'string' ? x.threadId : null,
    attempts: Number(x.attempts ?? 0),
    laterAtMs: ms(x.laterAt),
    firedAtMs: ms(x.firedAt),
    ask:
      ask && typeof ask.n === 'number'
        ? {
            level: String(ask.level) as RunAsk['level'],
            n: ask.n,
            firstAtMs: ms(ask.firstAt) ?? 0,
            lastAtMs: ms(ask.lastAt) ?? 0,
          }
        : null,
    decision:
      dec && typeof dec.choice === 'string' ? { choice: dec.choice, atMs: ms(dec.at) ?? 0 } : null,
  };
}

/** Patch values the engine hands over (Dates, the ask in ms) as Firestore values. */
function toStore(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? FieldValue.delete() : v;
  return out;
}

/** The plan of a run, read now: its state, whether it got going, and a failed step's error. */
async function readPlan(
  db: Firestore,
  wid: string,
  planId: string,
  plan?: Record<string, unknown>,
) {
  const x = plan ?? (await db.doc(inboxPaths.plan(wid, planId)).get()).data();
  if (!x) return null;
  const p = inboxPlanSchema.safeParse(x);
  if (!p.success) return null;
  const steps = p.data.steps;
  const at = steps[p.data.cursor];
  let started = p.data.cursor > 0 || p.data.state !== 'active';
  let error: string | null = null;
  if (at && (p.data.state === 'blocked' || !started)) {
    const o = inboxOutcomeSchema.safeParse(
      (await db.doc(inboxPaths.outcome(wid, at)).get()).data(),
    );
    if (o.success) {
      // A person step waiting at the cursor is not the agent failing to start.
      if (!started) started = o.data.state !== 'approved' || outcomeKind(o.data.type) === 'human';
      if (p.data.state === 'blocked') error = o.data.result?.error ?? o.data.result?.text ?? null;
    }
  }
  return {
    state: p.data.state,
    started,
    error,
    updatedAtMs: ms(p.data.updatedAt) ?? 0,
  } satisfies PlanView;
}

export function schedulerPorts(
  db: Firestore,
  rest: Pick<SchedulerPorts, 'tell' | 'log'> & { now?: () => number; version?: string },
): SchedulerPorts {
  const now = rest.now ?? (() => Date.now());
  const runs = (wid: string) => db.collection(`workspaces/${wid}/scheduleRuns`);
  const event = (
    wid: string,
    id: string,
    run: Record<string, unknown>,
    type: string,
    data: Record<string, unknown>,
  ) => ({
    ref: db.doc(inboxPaths.event(wid, id)),
    data: {
      actor: { ...SCHEDULER_ACTOR },
      memberUid: run.memberUid,
      threadId: run.threadId ?? null,
      subjectId: null,
      type,
      data,
      at: FieldValue.serverTimestamp(),
    },
  });
  let beaten = false;
  return {
    now,
    setTimer: (fn, t) => setTimeout(fn, t),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    log: rest.log,
    tell: rest.tell,
    async lastRun(wid, sid) {
      const q = await runs(wid)
        .where('scheduleId', '==', sid)
        .orderBy('dueAt', 'desc')
        .limit(1)
        .get();
      const d = q.docs[0];
      return d ? { dueMs: ms(d.data().dueAt) ?? 0 } : null;
    },
    async recentRuns(wid, sid, n) {
      const q = await runs(wid)
        .where('scheduleId', '==', sid)
        .orderBy('dueAt', 'desc')
        .limit(n)
        .get();
      return q.docs.map((d) => d.data().state as RunState);
    },
    async agent(wid, uid): Promise<AgentView | null> {
      const x = (await db.doc(`workspaces/${wid}/agents/${uid}`).get()).data();
      if (!x) return null;
      return {
        name: typeof x.name === 'string' ? x.name : 'The agent',
        lastSeenMs: ms(x.lastSeenAt),
        signedOutMs: ms(x.signedOutAt),
        revoked: !!x.revokedAt,
        paused: !!x.pausedAt,
        pausedReason: typeof x.pausedReason === 'string' ? x.pausedReason : null,
        cliVersion: typeof x.cliVersion === 'string' ? x.cliVersion : null,
      };
    },
    async fire(wid, sid, s, occ: Occurrence, runExists) {
      const ids = runIds(sid, occ.key, s.steps.length, (runExists?.attempts ?? 0) + 1);
      const plan = fireScheduledRun({
        workspaceId: wid,
        scheduleId: sid,
        schedule: s,
        occurrence: occ,
        ...ids,
        runExists,
      });
      try {
        await applyPlanAdmin(db, plan);
        return 'fired';
      } catch (e) {
        // ALREADY_EXISTS: fired before (a second notifier, a restart). NOT_FOUND on an update: the
        // run moved on meanwhile. Either way nothing was written (one batch).
        const code = (e as { code?: number }).code;
        if (code === ALREADY_EXISTS || code === 5) return 'exists';
        throw e;
      }
    },
    async createRun(wid, nr: NewRun) {
      const id = runDocId(nr.sid, nr.occ.key);
      const evId = randomId();
      const run = {
        memberUid: nr.s.memberUid,
        scheduleId: nr.sid,
        agentUid: nr.s.agentUid,
        key: nr.occ.key,
        period: nr.occ.period,
        dueAt: Timestamp.fromMillis(nr.occ.dueMs),
        title: nr.s.title,
        state: nr.state,
        why: nr.why,
        threadId: null,
        attempts: 0,
        laterAt: null,
        firedAt: null,
        startedAt: null,
        endedAt: null,
        ask: null,
        decision: null,
        scheduleVersion: nr.s.version,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        lastEventId: evId,
      };
      const b = db.batch();
      b.create(db.doc(schedulePaths.run(wid, id)), run);
      const type = EVENT_OF[nr.state];
      if (type) {
        const ev = event(wid, evId, run, type, {
          runId: id,
          scheduleId: nr.sid,
          state: nr.state,
          why: nr.why?.code ?? null,
        });
        b.create(ev.ref, ev.data);
      }
      try {
        await b.commit();
        return true;
      } catch (e) {
        if ((e as { code?: number }).code === ALREADY_EXISTS) return false;
        throw e;
      }
    },
    async moveRun(wid, id, from, patch) {
      const ref = db.doc(schedulePaths.run(wid, id));
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const x = snap.data();
        if (!x || !from.includes(x.state as RunState)) return false;
        const evId = randomId();
        const to = patch.state as RunState | undefined;
        tx.update(ref, {
          ...toStore(patch),
          updatedAt: FieldValue.serverTimestamp(),
          lastEventId: evId,
        });
        const type = to ? EVENT_OF[to] : undefined;
        if (type) {
          const why = (patch.why as { code?: string } | null | undefined)?.code ?? null;
          const ev = event(wid, evId, x, type, {
            runId: id,
            scheduleId: x.scheduleId,
            state: to,
            why,
          });
          tx.create(ev.ref, ev.data);
        }
        return true;
      });
    },
    async claimAsk(wid, id, expectN, ask) {
      const ref = db.doc(schedulePaths.run(wid, id));
      return db.runTransaction(async (tx) => {
        const x = (await tx.get(ref)).data();
        if (!x || x.state !== 'cantRun') return false;
        const n = (x.ask as { n?: number } | null)?.n ?? 0;
        if (n !== expectN) return false;
        tx.update(ref, {
          ask: {
            level: ask.level,
            n: ask.n,
            firstAt: Timestamp.fromMillis(ask.firstAtMs),
            lastAt: Timestamp.fromMillis(ask.lastAtMs),
          },
          updatedAt: FieldValue.serverTimestamp(),
        });
        return true;
      });
    },
    async planOf(wid, run) {
      if (!run.threadId) return null;
      return readPlan(db, wid, runIds(run.sid, run.key, 0, 0).planId);
    },
    async rerun(wid, run) {
      const { threadId, planId } = runIds(run.sid, run.key, 0, 0);
      const [pSnap, tSnap, mSnap] = await Promise.all([
        db.doc(inboxPaths.plan(wid, planId)).get(),
        db.doc(inboxPaths.thread(wid, run.threadId ?? threadId)).get(),
        db.doc(paths.member(wid, run.memberUid)).get(),
      ]);
      const plan = inboxPlanSchema.safeParse(pSnap.data());
      const thread = inboxThreadSchema.safeParse(tSnap.data());
      if (!plan.success || !thread.success) return 'none';
      const ctx: ActionContext = {
        workspaceId: wid,
        actor: {
          type: 'human',
          id: run.memberUid,
          name: (mSnap.data()?.name as string) ?? 'Member',
        },
      };
      try {
        if (plan.data.state === 'blocked') {
          const outs = await db.getAll(
            ...plan.data.steps.map((o) => db.doc(inboxPaths.outcome(wid, o))),
          );
          const outcomes: Record<string, InboxOutcome> = {};
          for (const d of outs) {
            const o = inboxOutcomeSchema.safeParse(d.data());
            if (o.success) outcomes[d.id] = o.data;
          }
          await applyPlanAdmin(
            db,
            retryPlanStep(ctx, {
              planId,
              plan: {
                memberUid: plan.data.memberUid,
                threadId: plan.data.threadId,
                steps: [...plan.data.steps],
                cursor: plan.data.cursor,
                state: plan.data.state,
              },
              outcomes,
              thread: thread.data,
            }),
          );
          return 'retried';
        }
        await applyPlanAdmin(
          db,
          instructThread(ctx, {
            threadId: run.threadId ?? threadId,
            thread: thread.data,
            text: `Start this scheduled run now: ${run.title} (${run.period}). The member chose Run now.`,
            nowMs: now(),
          }),
        );
        return 'instructed';
      } catch (e) {
        if (e instanceof ActionError) {
          rest.log(`scheduler rerun ${wid}/${run.id}: ${e.message}`);
          return 'none';
        }
        throw e;
      }
    },
    async claimDigest(uid, date) {
      const ref = db.doc(`users/${uid}/notify/digest`);
      return db.runTransaction(async (tx) => {
        const x = (await tx.get(ref)).data();
        if (x?.date === date) return false;
        tx.set(ref, { date, at: now() });
        return true;
      });
    },
    async prefs(uid) {
      const p = notifyPrefsSchema.safeParse((await db.doc(notifyPath.prefs(uid)).get()).data());
      return p.success ? p.data : DEFAULT_NOTIFY_PREFS;
    },
    async beat() {
      const ref = db.doc(SCHEDULER_BEAT_PATH);
      let prev: number | null = null;
      if (!beaten) prev = ms((await ref.get()).data()?.beatAt);
      beaten = true;
      await ref.set({
        beatAt: FieldValue.serverTimestamp(),
        host: hostname().slice(0, 80),
        version: rest.version ?? null,
      });
      return prev;
    },
  };
}

/**
 * The scheduler's listeners on every organization: active and paused schedules, open runs, the
 * Off docs, and the plan of each open run that has a thread. Returns a stopper.
 */
export function watchSchedules(db: Firestore, s: Scheduler, log: (l: string) => void) {
  const orgs = new Map<string, () => void>();
  const watchOrg = (wid: string) => {
    const planStops = new Map<string, () => void>();
    const syncPlans = () => {
      const want = new Set<string>();
      for (const r of s.openRuns())
        if (r.wid === wid && r.threadId && ['fired', 'running', 'cantRun'].includes(r.state))
          want.add(r.id);
      for (const [id, stop] of planStops)
        if (!want.has(id)) {
          stop();
          planStops.delete(id);
          s.setPlan(null, wid, id);
        }
      for (const id of want) {
        if (planStops.has(id)) continue;
        const r = s.openRuns().find((x) => x.wid === wid && x.id === id)!;
        const planId = runIds(r.sid, r.key, 0, 0).planId;
        planStops.set(
          id,
          db.doc(inboxPaths.plan(wid, planId)).onSnapshot(
            (snap) => {
              const x = snap.data();
              if (!x) return;
              void readPlan(db, wid, planId, x)
                .then((pv) => pv && s.setPlan(pv, wid, id))
                .catch((e) => log(`scheduler plan ${wid}/${id}: ${String(e)}`));
            },
            (e) => log(`scheduler plan ${wid}/${id}: ${String(e)}`),
          ),
        );
      }
    };
    let schedIds = new Set<string>();
    const stopSchedules = db
      .collection(`workspaces/${wid}/schedules`)
      .where('state', 'in', ['active', 'paused'])
      .onSnapshot(
        (snap) => {
          const seen = new Set<string>();
          for (const d of snap.docs) {
            const v = scheduleOf(d.data());
            if (!v) {
              log(`scheduler: schedule ${wid}/${d.id} does not parse; skipped`);
              continue;
            }
            seen.add(d.id);
            s.setSchedule(
              { wid, sid: d.id, s: v, activeFromMs: ms(d.data().activeFrom) },
              wid,
              d.id,
            );
          }
          for (const id of schedIds) if (!seen.has(id)) s.setSchedule(null, wid, id);
          schedIds = seen;
        },
        (e) => log(`scheduler schedules ${wid}: ${String(e)}`),
      );
    let runIdsSeen = new Set<string>();
    const stopRuns = runsOf(db, wid).onSnapshot(
      (snap) => {
        const seen = new Set<string>();
        for (const d of snap.docs) {
          const v = runView(wid, d.id, d.data());
          if (!v) continue;
          seen.add(d.id);
          s.setRun(v, wid, d.id);
        }
        for (const id of runIdsSeen) if (!seen.has(id)) s.setRun(null, wid, id);
        runIdsSeen = seen;
        syncPlans();
      },
      (e) => log(`scheduler runs ${wid}: ${String(e)}`),
    );
    let offSeen = new Set<string>();
    const stopOff = db.collection(`workspaces/${wid}/agentsOff`).onSnapshot(
      (snap) => {
        const seen = new Set<string>();
        for (const d of snap.docs) {
          const x = d.data();
          seen.add(d.id);
          s.setOff(
            {
              all: x.all === true,
              agents: Array.isArray(x.agents)
                ? x.agents.filter((a): a is string => typeof a === 'string')
                : [],
              sinceMs: ms(x.since),
            },
            wid,
            d.id,
          );
        }
        for (const id of offSeen) if (!seen.has(id)) s.setOff(null, wid, id);
        offSeen = seen;
      },
      (e) => log(`scheduler off ${wid}: ${String(e)}`),
    );
    return () => {
      stopSchedules();
      stopRuns();
      stopOff();
      planStops.forEach((p) => p());
    };
  };
  const stopOrgs = db.collection('workspaces').onSnapshot(
    (snap) => {
      for (const d of snap.docs) if (!orgs.has(d.id)) orgs.set(d.id, watchOrg(d.id));
    },
    (e) => log(`scheduler workspaces: ${String(e)}`),
  );
  return () => {
    stopOrgs();
    orgs.forEach((o) => o());
  };
}

const runsOf = (db: Firestore, wid: string) =>
  db.collection(`workspaces/${wid}/scheduleRuns`).where('state', 'in', OPEN_STATES);
