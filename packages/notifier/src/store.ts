/** Firestore side of the notifier: the Ports, and the listeners that feed the Engine. */
import {
  BELL_KEEP_MS,
  bellPath,
  DEFAULT_NOTIFY_PREFS,
  decisionSchema,
  itemSchema,
  notifiedSchema,
  notifyPath,
  notifyPrefsSchema,
  projectSchema,
  pushSubSchema,
  telegramLinkSchema,
  type Notified,
  type Project,
} from '@hive/shared';
import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { FRESH_MS, type Engine, type Ports } from './engine';

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

/** Starts listeners on every organization, project, waiting item and open question. Returns a stopper. */
export function watchAll(
  db: Firestore,
  engine: Engine,
  kick: () => void,
  log: (s: string) => void,
) {
  const stops: (() => void)[] = [];
  const orgs = new Map<string, () => void>();
  const nameOf = namer(db);
  /** Decisions already handed to the bell by this process (a project change re-subscribes). */
  const seenDecisions = new Set<string>();

  const watchOrg = (wid: string) => {
    const projects = new Map<string, () => void>();
    const stopProjects = db.collection(`workspaces/${wid}/projects`).onSnapshot(
      (snap) => {
        const live = new Set<string>();
        for (const d of snap.docs) {
          const p = projectSchema.safeParse(d.data());
          if (!p.success || p.data.archivedAt) continue;
          live.add(d.id);
          projects.get(d.id)?.();
          projects.set(d.id, watchProject(wid, d.id, p.data));
        }
        for (const [pid, stop] of projects)
          if (!live.has(pid)) {
            stop();
            projects.delete(pid);
          }
        kick();
      },
      (e) => log(`projects ${wid}: ${String(e)}`),
    );
    return () => {
      stopProjects();
      projects.forEach((s) => s());
    };
  };

  const watchProject = (wid: string, pid: string, project: Project) => {
    const keys = new Set<string>();
    const qkeys = new Set<string>();
    const titles = new Map<string, string>();
    const stopItems = db
      .collection(`workspaces/${wid}/projects/${pid}/items`)
      .where('status', '==', 'waiting')
      .onSnapshot(
        (snap) => {
          const now = new Set<string>();
          for (const d of snap.docs) {
            const item = itemSchema.safeParse(d.data());
            if (!item.success) continue;
            titles.set(d.id, item.data.title);
            const key = `${wid}/${pid}/${d.id}`;
            now.add(key);
            engine.setWaiting({ wid, pid, iid: d.id, project, item: item.data }, key);
          }
          for (const k of keys) if (!now.has(k)) engine.setWaiting(null, k);
          keys.clear();
          now.forEach((k) => keys.add(k));
          kick();
        },
        (e) => log(`items ${wid}/${pid}: ${String(e)}`),
      );
    // Same query shape as the app's, so the same composite index serves it.
    const stopQs = db
      .collectionGroup('messages')
      .where('workspaceId', '==', wid)
      .where('projectId', '==', pid)
      .where('kind', '==', 'question')
      .where('answered', '==', false)
      .orderBy('at', 'asc')
      .onSnapshot(
        async (snap) => {
          const now = new Set<string>();
          for (const d of snap.docs) {
            const m = d.data() as {
              itemId?: string;
              text?: string;
              at?: { toMillis(): number };
              by?: { id?: string };
            };
            if (!m.itemId || !m.at) continue;
            let title = titles.get(m.itemId);
            if (!title) {
              const it = await db.doc(`workspaces/${wid}/projects/${pid}/items/${m.itemId}`).get();
              title = (it.data()?.title as string | undefined) ?? 'An item';
            }
            const key = `${wid}/${pid}/${d.id}`;
            now.add(key);
            engine.setQuestion(
              {
                wid,
                pid,
                iid: m.itemId,
                mid: d.id,
                project,
                itemTitle: title,
                text: m.text ?? '',
                atMs: m.at.toMillis(),
                byName: m.by?.id ? await nameOf(wid, m.by.id) : '',
              },
              key,
            );
          }
          for (const k of qkeys) if (!now.has(k)) engine.setQuestion(null, k);
          qkeys.clear();
          now.forEach((k) => qkeys.add(k));
          kick();
        },
        (e) => log(`questions ${wid}/${pid}: ${String(e)}`),
      );
    // Send-backs and answers, for the bell (item 3ENs). Only additions: a decision never changes.
    // Older ones (the notifier was off) are not replayed: the bell never had them.
    const stopDecisions = db
      .collection(`workspaces/${wid}/projects/${pid}/decisions`)
      .where('at', '>=', Timestamp.fromMillis(Date.now() - FRESH_MS))
      .onSnapshot(
        async (snap) => {
          for (const ch of snap.docChanges()) {
            if (ch.type !== 'added' || seenDecisions.has(ch.doc.ref.path)) continue;
            seenDecisions.add(ch.doc.ref.path);
            const p = decisionSchema.safeParse(ch.doc.data());
            if (!p.success) continue;
            const dec = p.data;
            if (dec.outcome !== 'sentBack' && dec.outcome !== 'answered') continue;
            try {
              let creatorUid: string | null = null;
              let title = dec.itemTitle;
              if (dec.outcome === 'sentBack') {
                const it = await db
                  .doc(`workspaces/${wid}/projects/${pid}/items/${dec.itemId}`)
                  .get();
                const by = it.data()?.createdBy as { type?: string; id?: string } | undefined;
                creatorUid = by?.type === 'human' && by.id ? by.id : null;
                title = title || ((it.data()?.title as string | undefined) ?? 'An item');
              }
              await engine.onDecision({
                wid,
                pid,
                did: ch.doc.id,
                project,
                itemId: dec.itemId,
                itemTitle: title || 'An item',
                outcome: dec.outcome,
                toStepId: dec.toStepId,
                byUid: dec.byUid,
                byName: await nameOf(wid, dec.byUid),
                text: dec.rationale,
                atMs: dec.at.toMillis(),
                creatorUid,
              });
            } catch (e) {
              log(`decision ${wid}/${pid}/${ch.doc.id}: ${String(e)}`);
            }
          }
        },
        (e) => log(`decisions ${wid}/${pid}: ${String(e)}`),
      );
    return () => {
      stopItems();
      stopQs();
      stopDecisions();
      keys.forEach((k) => engine.setWaiting(null, k));
      qkeys.forEach((k) => engine.setQuestion(null, k));
    };
  };

  stops.push(
    db.collection('workspaces').onSnapshot(
      (snap) => {
        for (const d of snap.docs) if (!orgs.has(d.id)) orgs.set(d.id, watchOrg(d.id));
      },
      (e) => log(`workspaces: ${String(e)}`),
    ),
  );
  return () => {
    stops.forEach((s) => s());
    orgs.forEach((s) => s());
  };
}
