/**
 * The decisions of the notifier, free of any SDK: who is told what, when, and how often. It talks
 * to the world through `Ports`, so the tests run it with fakes. One `Engine` per process.
 *
 * Rules:
 *  - Inbox threads only (projects were removed, design 7): a thread arriving at Needs you (an
 *    agent's question) or Your call (outcomes proposed, a plan step at its turn) tells its member
 *    alone, once per arrival, on the bell, push and Telegram. An urgent thread skips quiet hours
 *    and the summary.
 *  - Arrivals older than FRESH_MS are recorded silently (a restart must not replay the backlog).
 *  - Quiet hours hold a message back; it goes out once they end (several held become one summary).
 *  - The bell (item 3ENs): every new arrival is written to the member's history, whatever their
 *    channels, quiet hours or its age. Pop-ups stay live only; the bell is where the rest waits.
 *  - Silence (item KZ6O9): thread steps in agent hands are watched by ReachOut (reach.ts) with one
 *    timer each, not by the sweep. It uses `deliver` and `addBells`.
 */
import {
  askApproves,
  decisionLines,
  type ThreadAsk,
  bellId,
  clipText,
  type BellEntry,
  inQuietHours,
  inboxNotice,
  INBOX_BELL_PROJECT,
  summaryNotice,
  DEFAULT_NOTIFY_PREFS,
  type Notice,
  type Notified,
  type NotifyPrefs,
  type PushSub,
  type TelegramLink,
} from '@hive/shared';
import type { PushOutcome } from './push.js';
import type { ThreadAction } from './threadDecide.js';
import type { ReachRef } from './reach.js';
import type { RunTelegram } from './scheduler.js';

export const FRESH_MS = 30 * 60_000;
/** More than this many messages for one person in one pass become one summary. */
export const SUMMARY_OVER = 3;

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
  /** `silent`: delivered without a notification sound (Telegram disable_notification). */
  sendTelegram(
    chatId: number,
    notice: Notice,
    action?: TelegramAction,
    silent?: boolean,
  ): Promise<boolean>;
  /** Writes a bell entry unless one with this id exists (users/{uid}/notifications/{id}). */
  addBell(uid: string, id: string, entry: BellEntry): Promise<void>;
  log(line: string): void;
}

/** 'retry': push failed on every device (a transient error); try again next sweep. */
export type Delivery = 'sent' | 'held' | 'none' | 'retry';
/** After this many sweeps of failing pushes we stop retrying one message. */
export const MAX_RETRY_SWEEPS = 5;

/** The buttons of a silent message (item KZ6O9): Ping again · Open on a thread step. */
export interface ReachTelegram {
  kind: 'reach';
  uid: string;
  ref: ReachRef;
}
export type TelegramAction = ThreadTelegram | ReachTelegram | RunTelegram;

/**
 * The quick actions of a thread message (slice 3): what the buttons decide, and which ones the
 * message shows (Approve and Ask for changes for a person step, the answers of a question).
 */
export interface ThreadTelegram extends ThreadAction {
  ask: ThreadAsk['kind'];
  options: string[];
}

/** The summary mirror's top line (inboxThreads/{tid}.summary). */
export interface SummaryTop {
  headline: string;
  ask: string | null;
  answer: string | null;
  recAction: string | null;
  confidence: string | null;
}

/** A thread waits this long for its summary before it is told without one (ms). */
export const SUMMARY_WAIT_MS = 45_000;

/** An Inbox thread waiting for its member (Needs you or Your call). */
export interface InboxWaiting {
  wid: string;
  tid: string;
  memberUid: string;
  state: 'needsYou' | 'yourCall';
  title: string;
  subjectName: string;
  /** The question, or what is proposed ("Reply, Snooze"). */
  text: string;
  /** Who asked or proposed (an agent's name). */
  byName: string;
  /** Identifies this arrival: a new question or a new round of proposals is a new one. */
  arrival: string;
  /** When it arrived (ms). */
  sinceMs: number;
  urgent: boolean;
  /** What waits (slice 3): its key is `arrival`; the quick actions follow its kind. */
  ask?: ThreadAsk | null;
  /** The summary's top line, and whether it was written after the thread's last change. */
  summary?: SummaryTop | null;
  summaryFresh?: boolean;
  /** Not told before this time (ms): the summary that follows a change may still come. */
  holdUntil?: number;
  /** The home agent's name ("Hive recommends …"). */
  agentName?: string;
}

/**
 * The message of a waiting thread (slice 3, design 9b): with a fresh summary, the bold one-liner
 * is its ask (or headline) and the second line the recommendation and confidence; without one,
 * the app's own lines.
 */
export function threadNotice(t: InboxWaiting): Notice {
  const base = inboxNotice({
    kind: t.state,
    subjectName: t.subjectName,
    threadTitle: t.title,
    text: t.text,
    workspaceId: t.wid,
    threadId: t.tid,
    urgent: t.urgent,
  });
  if (!t.ask || !t.summary || !t.summaryFresh) return base;
  const l = decisionLines({
    ask: t.ask,
    title: t.title,
    subjectName: t.subjectName,
    agentName: t.agentName ?? '',
    summary: t.summary,
    fresh: true,
  });
  return { ...base, title: `${t.urgent ? 'Urgent · ' : ''}${l.line}`, body: l.detail };
}

/** The buttons of a waiting thread's Telegram message, or none (nothing to decide in one tap). */
export function threadAction(t: InboxWaiting): ThreadTelegram | undefined {
  const a = t.ask;
  if (!a) return undefined;
  if (!askApproves(a) && a.kind !== 'question') return undefined;
  return {
    kind: 'thread',
    wid: t.wid,
    tid: t.tid,
    uid: t.memberUid,
    arrival: t.arrival,
    ask: a.kind,
    options: a.kind === 'question' ? a.options : [],
  };
}

export class Engine {
  private inbox = new Map<string, InboxWaiting>();
  /** Channels that already got a message, by `key|uid|channel` (kept for the process's life). */
  private chanDone = new Set<string>();
  private tries = new Map<string, number>();
  private prefsCache = new Map<string, { at: number; prefs: NotifyPrefs }>();

  constructor(private p: Ports) {}

  /** Bell entries for these people (one each; an existing one is kept). */
  async addBells(uids: readonly string[], id: string, entry: BellEntry): Promise<void> {
    return this.bell(uids, id, entry);
  }

  private async bell(uids: readonly string[], id: string, entry: BellEntry): Promise<void> {
    for (const uid of uids) {
      try {
        await this.p.addBell(uid, id, entry);
      } catch (e) {
        this.p.log(`bell ${uid}/${id}: ${String(e)}`);
      }
    }
  }

  setInbox(t: InboxWaiting | null, key: string) {
    if (t) this.inbox.set(key, t);
    else this.inbox.delete(key);
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
  async deliver(
    uid: string,
    notice: Notice,
    action?: TelegramAction,
    key = '',
    urgent = false,
    /** A quiet line (scheduled tasks: a daily miss after the digest): Telegram only, no sound. */
    silent = false,
  ): Promise<Delivery> {
    const prefs = await this.prefs(uid);
    if (!urgent && inQuietHours(prefs.quiet, new Date(this.p.now()))) return 'held';
    const id = `${key}|${uid}`;
    let sent = this.chanDone.has(`${id}|push`) || this.chanDone.has(`${id}|tg`);
    let pushFailed = false;
    if (prefs.push && !silent && !this.chanDone.has(`${id}|push`)) {
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
      if (tg && (await this.p.sendTelegram(tg.chatId, notice, action, silent || undefined))) {
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

  /** One pass over every waiting thread: new arrivals and held messages. */
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

    for (const t of [...this.inbox.values()]) {
      try {
        // The summary written right after a change may still come: wait for it a little.
        if (t.holdUntil && now < t.holdUntil) continue;
        const key = `i-${t.tid}`;
        const r = await record(t.wid, key, () => ({
          itemId: t.tid,
          projectId: INBOX_BELL_PROJECT,
          gateKey: t.arrival,
          sent: now - t.sinceMs > FRESH_MS ? [t.memberUid] : [],
          remindedAt: null,
          at: now,
        }));
        if (!r) continue;
        let arrived = r.dirty;
        if (r.rec.gateKey !== t.arrival) {
          // A new arrival; an old one (a restart, or keys of an earlier release) is not replayed.
          const sent = now - t.sinceMs > FRESH_MS ? [t.memberUid] : [];
          r.rec = { ...r.rec, gateKey: t.arrival, sent, remindedAt: null, at: now };
          r.dirty = true;
          arrived = true;
        }
        if (arrived)
          await this.bell([t.memberUid], bellId.inbox(t.tid, t.arrival), {
            kind: t.state === 'needsYou' ? 'inboxAsk' : 'inboxCall',
            workspaceId: t.wid,
            projectId: INBOX_BELL_PROJECT,
            itemId: t.tid,
            projectName: clipText(t.subjectName ? `Inbox · ${t.subjectName}` : 'Inbox', 200),
            itemTitle: clipText(t.title || 'An Inbox thread', 300),
            stepName: '',
            actorName: clipText(t.byName, 200),
            text: clipText(t.text.replace(/\s+/g, ' ').trim(), 200),
            at: t.sinceMs,
            readAt: null,
          });
        if (r.rec.sent.includes(t.memberUid)) continue;
        cands.push({
          uid: t.memberUid,
          notice: threadNotice(t),
          action: threadAction(t),
          key: `in|${t.tid}|${t.arrival}`,
          urgent: t.urgent,
          done: () => {
            r.rec.sent = [...r.rec.sent, t.memberUid];
            r.dirty = true;
          },
        });
      } catch (e) {
        this.p.log(`inbox ${t.tid}: ${String(e)}`);
      }
    }

    const byUid = new Map<string, Candidate[]>();
    for (const c of cands) byUid.set(c.uid, [...(byUid.get(c.uid) ?? []), c]);
    for (const [uid, all] of byUid) {
      try {
        // Urgent threads go out at once, on their own, whatever the hour.
        for (const c of all.filter((x) => x.urgent)) {
          const d = await this.deliver(uid, c.notice, c.action, c.key, true);
          if (d !== 'retry') c.done();
        }
        const list = all.filter((x) => !x.urgent);
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
  action?: TelegramAction;
  key: string;
  urgent?: boolean;
  done: () => void;
}
