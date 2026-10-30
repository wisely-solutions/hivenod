/** Firestore side of the notifier: the Ports, and the listeners that feed the Engine. */
import {
  BELL_KEEP_MS,
  bellPath,
  DEFAULT_NOTIFY_PREFS,
  notifiedSchema,
  notifyPath,
  notifyPrefsSchema,
  askFallback,
  outcomeType,
  threadAsk,
  type PlanStateOf,
  pushSubSchema,
  telegramLinkSchema,
  type Notified,
} from '@hive/shared';
import type { Firestore } from 'firebase-admin/firestore';
import {
  SUMMARY_WAIT_MS,
  type Engine,
  type InboxWaiting,
  type Ports,
  type SummaryTop,
} from './engine';
import type { ReachOut } from './reach';
import { stepDoc, stepWatched, type StepDoc } from './reachStore';

/** Old bell entries are pruned when a person gets a new one, at most once an hour per person. */
const PRUNE_EVERY_MS = 3_600_000;

export function firestorePorts(
  db: Firestore,
  rest: Pick<Ports, 'sendPush' | 'sendTelegram' | 'log'>,
): Ports {
  const pruned = new Map<string, number>();
  return {
    now: () => Date.now(),
    ...rest,
    async getPrefs(uid) {
      const s = await db.doc(notifyPath.prefs(uid)).get();
      const p = notifyPrefsSchema.safeParse(s.data());
      return p.success ? p.data : DEFAULT_NOTIFY_PREFS;
    },
    async getPushSubs(uid) {
      const q = await db.collection(notifyPath.pushSubs(uid)).get();
      return q.docs.flatMap((d) => {
        const p = pushSubSchema.safeParse(d.data());
        return p.success ? [{ id: d.id, sub: p.data }] : [];
      });
    },
    async deletePushSub(uid, id) {
      await db.doc(notifyPath.pushSub(uid, id)).delete();
    },
    async getTelegram(uid) {
      const p = telegramLinkSchema.safeParse((await db.doc(notifyPath.telegram(uid)).get()).data());
      return p.success ? p.data : null;
    },
    async getNotified(wid, key) {
      const p = notifiedSchema.safeParse(
        (await db.doc(notifyPath.notified(wid, key)).get()).data(),
      );
      return p.success ? p.data : null;
    },
    async setNotified(wid, key, value: Notified) {
      await db.doc(notifyPath.notified(wid, key)).set(value);
    },
    async addBell(uid, id, entry) {
      try {
        await db.doc(bellPath.entry(uid, id)).create(entry);
      } catch (e) {
        // ALREADY_EXISTS: written before (a restart, a replayed listener). Nothing to do.
        if ((e as { code?: number }).code !== 6) throw e;
        return;
      }
      // Kept 30 days (EUR 0: no scheduled job, the notifier prunes as it writes).
      const now = Date.now();
      if (now - (pruned.get(uid) ?? 0) < PRUNE_EVERY_MS) return;
      pruned.set(uid, now);
      const old = await db
        .collection(bellPath.list(uid))
        .where('at', '<', now - BELL_KEEP_MS)
        .limit(200)
        .get();
      if (old.empty) return;
      const batch = db.batch();
      old.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    },
  };
}

/** Display name of a person (their member card) or an agent, cached for the process's life. */
function namer(db: Firestore) {
  const cache = new Map<string, string>();
  return async (wid: string, uid: string): Promise<string> => {
    const key = `${wid}/${uid}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const [m, a] = await Promise.all([
      db.doc(`workspaces/${wid}/members/${uid}`).get(),
      db.doc(`workspaces/${wid}/agents/${uid}`).get(),
    ]);
    const name =
      (m.data()?.name as string | undefined) ?? (a.data()?.name as string | undefined) ?? '';
    cache.set(key, name);
    return name;
  };
}

/**
 * Starts listeners on every organization's Inbox threads waiting for their member, with their
 * proposals and plans (projects, items, questions and decisions are gone, design 7). Returns a stopper.
 */
export function watchAll(
  db: Firestore,
  engine: Engine,
  kick: () => void,
  log: (s: string) => void,
  /** Reach out (item KZ6O9): thread steps in agent hands. */
  reach?: ReachOut,
) {
  const stops: (() => void)[] = [];
  const orgs = new Map<string, () => void>();
  const nameOf = namer(db);

  /**
   * Inbox (item 4PEHr): threads waiting for their member, the proposals that put them at Your
   * call and their live plans. What waits is `threadAsk` (slice 3: the same answer the web
   * gives), and its key is the arrival: a new question, a new round of proposals, a plan, or a
   * plan step reaching its turn is told again. The summary mirror gives the one-liner.
   */
  const watchInbox = (wid: string) => {
    type Q = { text: string; by: string; at: number; answer: string | null; options: string[] };
    type T = {
      memberUid: string;
      subjectId: string | null;
      state: 'needsYou' | 'yourCall';
      title: string;
      urgent: boolean;
      question: Q | null;
      fetchedBy: string;
      summary: (SummaryTop & { at: number }) | null;
      updatedAt: number;
    };
    type O = {
      id: string;
      type: string;
      state: string;
      planId: string | null;
      by: string;
      at: number;
      fields: Record<string, unknown>;
    };
    type P = { id: string; threadId: string; plan: PlanStateOf; at: number; updatedAt: number };
    let threads = new Map<string, T>();
    let proposals = new Map<string, O[]>();
    let plans = new Map<string, P>();
    const keys = new Set<string>();
    const subjects = new Map<string, string>();
    const subjectName = async (sid: string | null) => {
      if (!sid) return '';
      const hit = subjects.get(sid);
      if (hit !== undefined) return hit;
      const d = await db.doc(`workspaces/${wid}/inboxSubjects/${sid}`).get();
      const name = (d.data()?.name as string | undefined) ?? '';
      subjects.set(sid, name);
      return name;
    };
    let gen = 0;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const publish = async () => {
      const mine = ++gen;
      const now = new Map<string, InboxWaiting>();
      let wake = Infinity;
      for (const [tid, t] of threads) {
        const open = proposals.get(tid) ?? [];
        const plan = plans.get(tid) ?? null;
        const ask = threadAsk({
          thread: {
            state: t.state,
            question: t.question
              ? {
                  text: t.question.text,
                  atMs: t.question.at,
                  answer: t.question.answer,
                  options: t.question.options,
                }
              : null,
          },
          plan: plan ? { id: plan.id, plan: plan.plan } : null,
          open: open.map((o) => ({
            id: o.id,
            type: o.type,
            state: o.state,
            planId: o.planId,
            createdAtMs: o.at,
            fields: o.fields,
          })),
        });
        // Nothing to decide (an approved plan step about to run): nobody is told.
        if (!ask) continue;
        const singles = open.filter((o) => !o.planId).sort((a, b) => a.at - b.at);
        let text = askFallback(ask, t.title);
        let by = t.fetchedBy;
        let since = t.updatedAt;
        if (ask.kind === 'question' && t.question) {
          text = t.question.text;
          by = t.question.by;
          since = t.question.at;
        } else if (ask.kind === 'proposal') {
          text = [...new Set(singles.map((p) => outcomeType(p.type)?.label ?? p.type))].join(', ');
          by = singles[0]?.by ?? by;
          since = singles[0]?.at ?? since;
        } else if (plan) {
          since = Math.max(plan.updatedAt, plan.at);
        }
        // The thread and its plan come in on separate listeners: a plan step's turn may show
        // before the thread's own update, so the plan's time counts too.
        const changedAt = Math.max(t.updatedAt, plan?.updatedAt ?? 0);
        const fresh = !!t.summary && t.summary.at >= changedAt;
        // An agent that writes summaries writes one right after each change: wait for it a
        // little. A thread that never had one is told at once.
        const holdUntil = fresh || !t.summary ? 0 : changedAt + SUMMARY_WAIT_MS;
        const w: InboxWaiting = {
          wid,
          tid,
          memberUid: t.memberUid,
          state: t.state,
          title: t.title,
          subjectName: await subjectName(t.subjectId),
          text: text || 'Outcomes proposed',
          byName: by ? await nameOf(wid, by) : '',
          arrival: ask.key,
          sinceMs: since,
          urgent: t.urgent,
          ask,
          summary: t.summary,
          summaryFresh: fresh,
          holdUntil,
          agentName: t.fetchedBy ? await nameOf(wid, t.fetchedBy) : '',
        };
        if (holdUntil > Date.now()) wake = Math.min(wake, holdUntil);
        now.set(`${wid}/${tid}`, w);
      }
      if (mine !== gen) return;
      for (const k of keys) if (!now.has(k)) engine.setInbox(null, k);
      keys.clear();
      for (const [k, w] of now) {
        keys.add(k);
        engine.setInbox(w, k);
      }
      kick();
      // A sweep right after the longest hold ends, so a thread without a summary is not late.
      clearTimeout(holdTimer);
      if (wake < Infinity) holdTimer = setTimeout(kick, Math.max(0, wake - Date.now()) + 250);
    };
    const ms = (v: unknown) => (v as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    const stopThreads = db
      .collection(`workspaces/${wid}/inboxThreads`)
      .where('state', 'in', ['needsYou', 'yourCall'])
      .onSnapshot(
        (snap) => {
          const next = new Map<string, T>();
          for (const d of snap.docs) {
            const x = d.data();
            if (typeof x.memberUid !== 'string') continue;
            const q = x.question as {
              text?: string;
              by?: string;
              at?: unknown;
              answer?: unknown;
              options?: unknown;
            } | null;
            const sm = x.summary as Record<string, unknown> | undefined;
            next.set(d.id, {
              memberUid: x.memberUid,
              subjectId: typeof x.subjectId === 'string' ? x.subjectId : null,
              state: x.state,
              title: typeof x.title === 'string' ? x.title : '',
              // Not written by the agent tools yet: an urgent flag is honoured when it is.
              urgent: x.urgent === true,
              question:
                q && typeof q.text === 'string'
                  ? {
                      text: q.text,
                      by: q.by ?? '',
                      at: ms(q.at),
                      answer: str(q.answer),
                      options: Array.isArray(q.options)
                        ? q.options.filter((o): o is string => typeof o === 'string')
                        : [],
                    }
                  : null,
              fetchedBy: typeof x.fetchedBy === 'string' ? x.fetchedBy : '',
              summary:
                sm && typeof sm.headline === 'string'
                  ? {
                      headline: sm.headline,
                      ask: str(sm.ask),
                      answer: str(sm.answer),
                      recAction: str(sm.recAction),
                      confidence: str(sm.confidence),
                      at: ms(sm.at),
                    }
                  : null,
              updatedAt: ms(x.updatedAt),
            });
          }
          threads = next;
          void publish().catch((e) => log(`inbox ${wid}: ${String(e)}`));
        },
        (e) => log(`inbox threads ${wid}: ${String(e)}`),
      );
    const stopOutcomes = db
      .collection(`workspaces/${wid}/inboxOutcomes`)
      .where('state', '==', 'proposed')
      .onSnapshot(
        (snap) => {
          const next = new Map<string, O[]>();
          for (const d of snap.docs) {
            const x = d.data();
            if (typeof x.threadId !== 'string') continue;
            next.set(x.threadId, [
              ...(next.get(x.threadId) ?? []),
              {
                id: d.id,
                type: String(x.type),
                state: 'proposed',
                planId: typeof x.planId === 'string' ? x.planId : null,
                by: String(x.proposedBy ?? ''),
                at: ms(x.createdAt),
                fields: (x.fields as Record<string, unknown> | undefined) ?? {},
              },
            ]);
          }
          proposals = next;
          void publish().catch((e) => log(`inbox ${wid}: ${String(e)}`));
        },
        (e) => log(`inbox outcomes ${wid}: ${String(e)}`),
      );
    const stopPlans = db
      .collection(`workspaces/${wid}/inboxPlans`)
      .where('state', 'in', ['proposed', 'active', 'blocked'])
      .onSnapshot(
        (snap) => {
          const next = new Map<string, P>();
          for (const d of snap.docs) {
            const x = d.data();
            if (typeof x.threadId !== 'string' || !Array.isArray(x.steps)) continue;
            const p: P = {
              id: d.id,
              threadId: x.threadId,
              plan: { steps: x.steps as string[], cursor: Number(x.cursor ?? 0), state: x.state },
              at: ms(x.createdAt),
              updatedAt: ms(x.updatedAt),
            };
            // The newest live plan of a thread is the one on show (as on the web).
            const cur = next.get(x.threadId);
            if (!cur || cur.at < p.at) next.set(x.threadId, p);
          }
          plans = next;
          void publish().catch((e) => log(`inbox ${wid}: ${String(e)}`));
          void publishSteps().catch((e) => log(`inbox steps ${wid}: ${String(e)}`));
        },
        (e) => log(`inbox plans ${wid}: ${String(e)}`),
      );
    // Reach out (item KZ6O9): the steps in agent hands (approved outcomes, running long steps).
    let steps = new Map<string, StepDoc>();
    const stepKeys = new Set<string>();
    const titles = new Map<string, string>();
    const threadTitle = async (tid: string) => {
      const hit = titles.get(tid);
      if (hit !== undefined) return hit;
      const d = await db.doc(`workspaces/${wid}/inboxThreads/${tid}`).get();
      const t = (d.data()?.title as string | undefined) ?? '';
      titles.set(tid, t);
      return t;
    };
    const publishSteps = async () => {
      if (!reach) return;
      const now = new Set<string>();
      for (const o of steps.values()) {
        const p = o.planId ? [...plans.values()].find((x) => x.id === o.planId) : undefined;
        const w = stepWatched({
          wid,
          o,
          plan: p
            ? {
                steps: p.plan.steps,
                cursor: p.plan.cursor,
                state: p.plan.state,
                updatedAtMs: p.updatedAt,
              }
            : null,
          threadTitle: await threadTitle(o.threadId),
          agentName: o.executor ? await nameOf(wid, o.executor) : '',
        });
        if (!w) continue;
        now.add(w.key);
        reach.upsert(w);
      }
      for (const k of stepKeys) if (!now.has(k)) reach.remove(k);
      stepKeys.clear();
      now.forEach((k) => stepKeys.add(k));
    };
    const stopSteps = reach
      ? db
          .collection(`workspaces/${wid}/inboxOutcomes`)
          .where('state', 'in', ['approved', 'running'])
          .onSnapshot(
            (snap) => {
              const next = new Map<string, StepDoc>();
              for (const d of snap.docs) {
                const o = stepDoc(d.id, d.data());
                if (o) next.set(d.id, o);
              }
              steps = next;
              void publishSteps().catch((e) => log(`inbox steps ${wid}: ${String(e)}`));
            },
            (e) => log(`inbox steps ${wid}: ${String(e)}`),
          )
      : () => undefined;
    return () => {
      stopThreads();
      stopOutcomes();
      stopPlans();
      stopSteps();
      stepKeys.forEach((k) => reach?.remove(k));
      clearTimeout(holdTimer);
      keys.forEach((k) => engine.setInbox(null, k));
    };
  };

  stops.push(
    db.collection('workspaces').onSnapshot(
      (snap) => {
        for (const d of snap.docs) if (!orgs.has(d.id)) orgs.set(d.id, watchInbox(d.id));
      },
      (e) => log(`workspaces: ${String(e)}`),
    ),
  );
  return () => {
    stops.forEach((s) => s());
    orgs.forEach((s) => s());
  };
}
