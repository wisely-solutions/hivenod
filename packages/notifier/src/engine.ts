/**
 * The decisions of the notifier, free of any SDK: who is told what, when, and how often. It talks
 * to the world through `Ports`, so the tests run it with fakes. One `Engine` per process.
 *
 * Rules:
 *  - An arrival at a gate (item waiting, keyed by step + send-back count) tells every decider who has
 *    not voted, once. A question tells the project's people, once.
 *  - Arrivals older than FRESH_MS are recorded silently (a restart must not replay the backlog).
 *  - Quiet hours hold a message back; it goes out once they end (several held become one summary).
 *  - The bell (item 3ENs): every new arrival, question, answer and send-back is written to the
 *    history of the people it is for, whatever their channels, quiet hours or its age. Pop-ups
 *    stay live only; the bell is where the rest waits.
 *  - After the gate's remindAfterHours a reminder goes out once, and only then is `remindedAt` set,
 *    which the app shows as "reminder sent".
 */
import {
  approvalNotice,
  bellId,
  clipText,
  type BellEntry,
  inQuietHours,
  gateKey,
  questionNotice,
  reminderDue,
  summaryNotice,
  notifyPath,
  DEFAULT_NOTIFY_PREFS,
  type Item,
  type Notice,
  type Notified,
  type NotifyPrefs,
  type Project,
  type PushSub,
  type TelegramLink,
} from '@hive/shared';
import type { PushOutcome } from './push.js';

export const FRESH_MS = 30 * 60_000;
/** More than this many messages for one person in one pass become one summary. */
export const SUMMARY_OVER = 3;

export interface ApprovalAction {
  wid: string;
  pid: string;
  iid: string;
  uid: string;
  gateKey: string;
}

export interface Ports {
  now(): number;
  getPrefs(uid: string): Promise<NotifyPrefs>;
  getPushSubs(uid: string): Promise<{ id: string; sub: PushSub }[]>;
  deletePushSub(uid: string, id: string): Promise<void>;
  getTelegram(uid: string): Promise<TelegramLink | null>;
  getNotified(wid: string, key: string): Promise<Notified | null>;
  setNotified(wid: string, key: string, value: Notified): Promise<void>;
  /** 'gone' = the endpoint is dead and should be forgotten. */
  sendPush(sub: PushSub, notice: Notice): Promise<PushOutcome>;
  sendTelegram(chatId: number, notice: Notice, action?: ApprovalAction): Promise<boolean>;
  /** Writes a bell entry unless one with this id exists (users/{uid}/notifications/{id}). */
  addBell(uid: string, id: string, entry: BellEntry): Promise<void>;
  log(line: string): void;
}

/** 'retry': push failed on every device (a transient error); try again next sweep. */
export type Delivery = 'sent' | 'held' | 'none' | 'retry';
/** After this many sweeps of failing pushes we stop retrying one message. */
export const MAX_RETRY_SWEEPS = 5;

export interface WaitingItem {
  wid: string;
  pid: string;
  iid: string;
  project: Project;
  item: Item;
}
export interface QuestionMsg {
  wid: string;
  pid: string;
  iid: string;
  mid: string;
  project: Project;
  itemTitle: string;
  text: string;
  atMs: number;
  /** Who asked (the agent's name), for the bell. */
  byName?: string;
}
/** A decision the bell cares about: a send-back or an answer. */
export interface DecisionMsg {
  wid: string;
  pid: string;
  did: string;
  project: Project;
  itemId: string;
  itemTitle: string;
  outcome: 'sentBack' | 'answered';
  toStepId: string | null;
  byUid: string;
  byName: string;
  /** The reason or the answer. */
  text: string;
  atMs: number;
  /** The person who created the item (null when an agent did). */
  creatorUid: string | null;
}

export class Engine {
  private waiting = new Map<string, WaitingItem>();
  private questions = new Map<string, QuestionMsg>();
  /** Channels that already got a message, by `key|uid|channel` (kept for the process's life). */
  private chanDone = new Set<string>();
  private tries = new Map<string, number>();
  private prefsCache = new Map<string, { at: number; prefs: NotifyPrefs }>();

  constructor(private p: Ports) {}

  private async bell(uids: readonly string[], id: string, entry: BellEntry): Promise<void> {
    for (const uid of uids) {
      try {
        await this.p.addBell(uid, id, entry);
      } catch (e) {
        this.p.log(`bell ${uid}/${id}: ${String(e)}`);
      }
    }
  }

  /** A send-back tells the person who created the item; an answer tells the other project people. */
  async onDecision(d: DecisionMsg): Promise<void> {
    const base = {
      workspaceId: d.wid,
      projectId: d.pid,
      itemId: d.itemId,
      projectName: d.project.name,
      itemTitle: clipText(d.itemTitle, 300),
      actorName: clipText(d.byName, 200),
      text: clipText(d.text.replace(/\s+/g, ' ').trim(), 200),
      at: d.atMs,
      readAt: null,
    };
    if (d.outcome === 'sentBack') {
      if (!d.creatorUid || d.creatorUid === d.byUid) return;
      const step = d.project.steps.find((s) => s.id === d.toStepId);
      await this.bell([d.creatorUid], bellId.sentBack(d.did), {
        ...base,
        kind: 'sentBack',
        stepName: step?.name ?? 'an earlier step',
      });
    } else {
      const to = d.project.memberUids.filter((u) => u !== d.byUid);
      await this.bell(to, bellId.answer(d.did), { ...base, kind: 'answer', stepName: '' });
    }
  }

  /** Forget what is no longer waiting (the listener removed or changed it). */
  setWaiting(w: WaitingItem | null, key: string) {
    if (w) this.waiting.set(key, w);
    else this.waiting.delete(key);
  }
  setQuestion(q: QuestionMsg | null, key: string) {
    if (q) this.questions.set(key, q);
    else this.questions.delete(key);
  }

  private async prefs(uid: string): Promise<NotifyPrefs> {
    const hit = this.prefsCache.get(uid);
    if (hit && this.p.now() - hit.at < 60_000) return hit.prefs;
    const prefs = (await this.p.getPrefs(uid)) ?? DEFAULT_NOTIFY_PREFS;
    this.prefsCache.set(uid, { at: this.p.now(), prefs });
    return prefs;
  }

  /**
   * Tries every channel the person chose. 'held': quiet hours. 'none': nothing to reach them with.
   * 'retry': push was tried and failed everywhere, so the message is not marked sent. `key` names the
   * message so a channel that already got it (Telegram) is not used again on a retry.
   */
  async deliver(uid: string, notice: Notice, action?: ApprovalAction, key = ''): Promise<Delivery> {
    const prefs = await this.prefs(uid);
    if (inQuietHours(prefs.quiet, new Date(this.p.now()))) return 'held';
    const id = `${key}|${uid}`;
    let sent = this.chanDone.has(`${id}|push`) || this.chanDone.has(`${id}|tg`);
    let pushFailed = false;
    if (prefs.push && !this.chanDone.has(`${id}|push`)) {
      let pushOk = false;
      let failed = false;
      for (const { id: subId, sub } of await this.p.getPushSubs(uid)) {
        const r = await this.p.sendPush(sub, notice);
        const tail = r.result === 'ok' ? '' : ` ${r.detail ?? ''}`;
        this.p.log(
          `push ${r.result} uid=${uid} sub=${subId} status=${r.status ?? 'none'} tries=${r.attempts}${tail}`,
        );
        if (r.result === 'ok') pushOk = true;
        else if (r.result === 'gone') await this.p.deletePushSub(uid, subId);
        else failed = true;
      }
      if (pushOk) {
        sent = true;
        this.chanDone.add(`${id}|push`);
      } else if (failed) pushFailed = true;
    }
    if (prefs.telegram && !this.chanDone.has(`${id}|tg`)) {
      const tg = await this.p.getTelegram(uid);
      if (tg && (await this.p.sendTelegram(tg.chatId, notice, action))) {
        sent = true;
        this.chanDone.add(`${id}|tg`);
      }
    }
    if (pushFailed) {
      const n = (this.tries.get(id) ?? 0) + 1;
      this.tries.set(id, n);
      if (n < MAX_RETRY_SWEEPS) return 'retry';
      this.p.log(`push gave up uid=${uid} after ${n} sweeps`);
    }
    this.tries.delete(id);
    return sent ? 'sent' : 'none';
  }

  /** One pass over everything waiting: new arrivals, held messages, reminders, questions. */
  async sweep(): Promise<void> {
    const now = this.p.now();
    const records = new Map<string, { wid: string; key: string; rec: Notified; dirty: boolean }>();
    const cands: Candidate[] = [];
    const record = async (wid: string, key: string, make: () => Notified | null) => {
      const id = `${wid}/${key}`;
      let r = records.get(id);
      if (!r) {
        const found = await this.p.getNotified(wid, key);
        const created = found ? null : make();
        const rec = found ?? created;
        if (!rec) return null;
        r = { wid, key, rec, dirty: !found };
        records.set(id, r);
      }
      return r;
    };

    for (const w of [...this.waiting.values()]) {
      try {
        const step = w.project.steps.find((s) => s.id === w.item.stepId);
        if (w.item.status !== 'waiting' || !w.item.gate || step?.kind !== 'human' || !step.gate)
          continue;
        const gate = step.gate;
        const key = gateKey(w.item);
        const since = w.item.updatedAt.toMillis();
        const voted = new Set([
          ...Object.keys(w.item.gate.approvals),
          ...Object.keys(w.item.gate.rejections),
        ]);
        const todo = gate.deciderUids.filter((u) => !voted.has(u));
        const docKey = notifyPath.notifiedGate(w.iid);
        const r = await record(w.wid, docKey, () => ({
          itemId: w.iid,
          projectId: w.pid,
          gateKey: key,
          // An old arrival is recorded without a message: a restart must not replay the backlog.
          sent: now - since > FRESH_MS ? [...gate.deciderUids] : [],
          remindedAt: null,
          at: now,
        }));
        if (!r) continue;
        // Just created (dirty before anything else touched it): an arrival this notifier never saw.
        let arrived = r.dirty;
        if (r.rec.gateKey !== key) {
          // The item came back to a gate (sent back and forward): a new arrival.
          r.rec = { ...r.rec, gateKey: key, sent: [], remindedAt: null, at: now };
          r.dirty = true;
          arrived = true;
        }
        const rec = r.rec;
        const base = {
          projectName: w.project.name,
          stepName: step.name,
          itemTitle: w.item.title,
          projectId: w.pid,
          itemId: w.iid,
        };
        if (arrived)
          await this.bell(todo, bellId.gate(w.iid, key), {
            kind: 'gate',
            workspaceId: w.wid,
            projectId: w.pid,
            itemId: w.iid,
            projectName: w.project.name,
            itemTitle: w.item.title,
            stepName: step.name,
            actorName: '',
            text: '',
            at: since,
            readAt: null,
          });
        for (const uid of todo) {
          if (rec.sent.includes(uid)) continue;
          cands.push({
            uid,
            notice: approvalNotice(base),
            action: { wid: w.wid, pid: w.pid, iid: w.iid, uid, gateKey: key },
            key: `arr|${w.iid}|${key}`,
            done: () => {
              rec.sent = [...rec.sent, uid];
              r.dirty = true;
            },
          });
        }
        if (!rec.remindedAt && reminderDue(since, now, gate.remindAfterHours)) {
          const hours = Math.max(1, Math.floor((now - since) / 3_600_000));
          let reached = false;
          let retry = false;
          for (const uid of todo) {
            const d = await this.deliver(
              uid,
              approvalNotice({ ...base, reminderHours: hours }),
              { wid: w.wid, pid: w.pid, iid: w.iid, uid, gateKey: key },
              `rem|${w.iid}|${key}`,
            );
            if (d === 'sent') reached = true;
            if (d === 'retry') retry = true;
          }
          if (reached && !retry) {
            rec.remindedAt = now;
            r.dirty = true;
          }
        }
      } catch (e) {
        this.p.log(`waiting ${w.iid}: ${String(e)}`);
      }
    }

    for (const q of [...this.questions.values()]) {
      try {
        const key = `q-${q.mid}`;
        const r = await record(q.wid, key, () => ({
          itemId: q.iid,
          projectId: q.pid,
          gateKey: `q:${q.mid}`,
          sent: now - q.atMs > FRESH_MS ? [...q.project.memberUids] : [],
          remindedAt: null,
          at: now,
        }));
        if (!r) continue;
        if (r.dirty)
          await this.bell(q.project.memberUids, bellId.question(q.mid), {
            kind: 'question',
            workspaceId: q.wid,
            projectId: q.pid,
            itemId: q.iid,
            projectName: q.project.name,
            itemTitle: clipText(q.itemTitle, 300),
            stepName: '',
            actorName: clipText(q.byName ?? '', 200),
            text: clipText(q.text.replace(/\s+/g, ' ').trim(), 200),
            at: q.atMs,
            readAt: null,
          });
        const notice = questionNotice({
          projectName: q.project.name,
          itemTitle: q.itemTitle,
          text: q.text,
          projectId: q.pid,
          itemId: q.iid,
        });
        for (const uid of q.project.memberUids) {
          if (r.rec.sent.includes(uid)) continue;
          cands.push({
            uid,
            notice,
            key: `q|${q.iid}|${q.mid}`,
            done: () => {
              r.rec.sent = [...r.rec.sent, uid];
              r.dirty = true;
            },
          });
        }
      } catch (e) {
        this.p.log(`question ${q.mid}: ${String(e)}`);
      }
    }

    const byUid = new Map<string, Candidate[]>();
    for (const c of cands) byUid.set(c.uid, [...(byUid.get(c.uid) ?? []), c]);
    for (const [uid, list] of byUid) {
      try {
        if (list.length > SUMMARY_OVER) {
          const d = await this.deliver(
            uid,
            summaryNotice(list.length),
            undefined,
            `sum|${list.map((c) => c.key).join(',')}`,
          );
          if (d !== 'held' && d !== 'retry') list.forEach((c) => c.done());
        } else {
          for (const c of list) {
            const d = await this.deliver(uid, c.notice, c.action, c.key);
            if (d !== 'held' && d !== 'retry') c.done();
          }
        }
      } catch (e) {
        this.p.log(`deliver ${uid}: ${String(e)}`);
      }
    }
    for (const r of records.values()) if (r.dirty) await this.p.setNotified(r.wid, r.key, r.rec);
  }
}

interface Candidate {
  uid: string;
  notice: Notice;
  action?: ApprovalAction;
  key: string;
  done: () => void;
}
