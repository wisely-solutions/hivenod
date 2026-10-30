/**
 * Reach out (item KZ6O9): one in-memory timer per thread step in agent hands, set to the next
 * time something is due (`reachNext`): a status request, the silent flag and its message, or a
 * reminder. The listeners feed it (`upsert`/`remove`); it reads Firestore only when a timer fires
 * (the thread since the last known activity, once), and writes only on transitions. No scans, no
 * polling.
 */
import {
  bellId,
  INBOX_BELL_PROJECT,
  reachNext,
  silentNotice,
  type BellEntry,
  type Notice,
  type ReachFlag,
  type ReachStep,
} from '@hive/shared';
import type { Delivery } from './engine';

/** How long to wait before trying again after a failure or quiet hours. */
export const REACH_RETRY_MS = 15 * 60_000;

/** The silent flag as written on the outcome. */
export interface Flag extends ReachFlag {
  agent?: string;
}

/** What the button of a silent message acts on. */
export type ReachRef = { kind: 'step'; wid: string; oid: string; tid: string };

/** A thread step in agent hands, as the listeners see it. */
export interface Watched {
  key: string;
  ref: ReachRef;
  /** Identity of the step (the outcome id): a new one resets. */
  run: string;
  /** Newest activity seen on the doc itself (ms). */
  activityMs: number;
  askMs: number | null;
  flag: Flag | null;
  agentUid: string;
  agentName: string;
  title: string;
  /** The step ("Reply, step 2 of 3"). */
  where: string;
  url: string;
  last: { text: string; atMs: number } | null;
  /** Who is told (the thread's member). */
  to: string[];
}

export interface ReachPorts {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Newest activity after `afterMs` not on the doc (the thread), or null. */
  activity(w: Watched, afterMs: number): Promise<number | null>;
  /** Writes Hivenod's status request (statusAsk by SYSTEM_UID at the server time). */
  ask(w: Watched): Promise<void>;
  /** Sets or clears the silent flag. */
  flag(w: Watched, flag: Flag | null): Promise<void>;
  /** Tells one person (all their channels; quiet hours respected). */
  deliver(uid: string, notice: Notice, w: Watched, key: string): Promise<Delivery>;
  bell(uids: string[], id: string, entry: BellEntry): Promise<void>;
  log(line: string): void;
}

interface Entry {
  w: Watched;
  /** Activity found by reads (log lines, events), newer than the doc's. */
  found: number;
  timer?: unknown;
  busy: boolean;
  /** Nothing is done before this (after a failure or quiet hours). */
  notBefore: number;
}

export class ReachOut {
  private entries = new Map<string, Entry>();
  constructor(private p: ReachPorts) {}

  /** The listeners' view of one step; schedules its timer. */
  upsert(w: Watched) {
    const e = this.entries.get(w.key);
    if (!e || e.w.run !== w.run) {
      if (e) this.p.clearTimer(e.timer);
      const next: Entry = { w, found: 0, busy: false, notBefore: 0 };
      this.entries.set(w.key, next);
      this.schedule(next);
      return;
    }
    e.w = w;
    this.schedule(e);
  }

  remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.p.clearTimer(e.timer);
    this.entries.delete(key);
  }

  /** How many timers run (for the log and the tests). */
  size() {
    return this.entries.size;
  }

  stop() {
    for (const e of this.entries.values()) this.p.clearTimer(e.timer);
    this.entries.clear();
  }

  private input(e: Entry) {
    return {
      activityMs: Math.max(e.w.activityMs, e.found),
      askMs: e.w.askMs,
      flag: e.w.flag,
    };
  }

  /** The next step and when it runs (never before notBefore). */
  next(key: string): ReachStep | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const s = reachNext(this.input(e));
    return { ...s, at: Math.max(s.at, e.notBefore) };
  }

  private schedule(e: Entry) {
    this.p.clearTimer(e.timer);
    e.timer = undefined;
    if (e.busy) return;
    const s = this.next(e.w.key)!;
    const key = e.w.key;
    e.timer = this.p.setTimer(() => void this.fire(key), Math.max(0, s.at - this.p.now()));
  }

  /** A timer fired: do what is due, then set the next timer. */
  async fire(key: string): Promise<void> {
    const e = this.entries.get(key);
    if (!e || e.busy) return;
    const now = this.p.now();
    const s = this.next(key)!;
    if (s.at > now) return this.schedule(e);
    e.busy = true;
    try {
      await this.run(e, s, now);
    } catch (err) {
      this.p.log(`reach ${key}: ${String(err)}`);
      e.notBefore = now + REACH_RETRY_MS;
    } finally {
      e.busy = false;
      // Removed meanwhile (the step moved on): no new timer.
      if (this.entries.get(key) === e) this.schedule(e);
    }
  }

  /** Reads what the doc does not show; true when it found newer activity than `afterMs`. */
  private async newer(e: Entry, afterMs: number): Promise<boolean> {
    const found = await this.p.activity(e.w, afterMs);
    if (found === null || found <= afterMs) return false;
    e.found = Math.max(e.found, found);
    return true;
  }

  private async run(e: Entry, s: ReachStep, now: number) {
    const w = e.w;
    const activity = Math.max(w.activityMs, e.found);
    switch (s.do) {
      case 'clear':
        await this.p.flag(w, null);
        w.flag = null;
        return;
      case 'ask':
        // The thread may show work the doc does not: read it once.
        if (await this.newer(e, activity)) return;
        await this.p.ask(w);
        w.askMs = now;
        this.p.log(`reach ${w.key}: asked ${w.agentName || w.agentUid} for a status`);
        return;
      case 'silent': {
        if (await this.newer(e, Math.max(activity, s.askMs))) return;
        const flag: Flag = {
          since: activity,
          at: now,
          asked: s.askMs,
          agent: w.agentName,
          told: null,
        };
        flag.told = (await this.tell(e, flag, now, false)) ? now : null;
        await this.p.flag(w, flag);
        w.flag = flag;
        if (flag.told === null) e.notBefore = now + REACH_RETRY_MS;
        return;
      }
      case 'remind': {
        const flag = w.flag!;
        if (await this.newer(e, flag.since)) return;
        const reminder = flag.told !== null && flag.told !== undefined;
        if (await this.tell(e, flag, now, reminder)) {
          const next = { ...flag, told: now };
          await this.p.flag(w, next);
          w.flag = next;
        } else e.notBefore = now + REACH_RETRY_MS;
        return;
      }
    }
  }

  /** The silent message to everyone it is for; false when it must be tried again later. */
  private async tell(e: Entry, flag: Flag, now: number, reminder: boolean): Promise<boolean> {
    const w = e.w;
    const notice = silentNotice({
      agentName: w.agentName,
      title: w.title,
      where: w.where,
      sinceMs: flag.since,
      askMs: flag.asked ?? null,
      last: w.last,
      nowMs: now,
      url: w.url,
      reminder,
    });
    const key = `reach|${w.key}|${w.run}|${flag.since}|${now}`;
    const minutes = Math.max(1, Math.floor((now - flag.since) / 60_000));
    if (!reminder)
      await this.p.bell(w.to, bellId.silence(w.ref.tid, `${w.run}:${flag.since}`), {
        kind: 'silence',
        workspaceId: w.ref.wid,
        projectId: INBOX_BELL_PROJECT,
        itemId: w.ref.tid,
        projectName: 'Inbox',
        itemTitle: w.title.slice(0, 300),
        stepName: '',
        actorName: w.agentName.slice(0, 200),
        text: `silent for ${minutes} min`,
        at: now,
        readAt: null,
      });
    // Told unless quiet hours or a failure held it back for everyone (nothing to reach someone
    // with counts as told: the bell has it).
    let sent = false;
    let later = false;
    for (const uid of w.to) {
      try {
        const d = await this.p.deliver(uid, notice, w, key);
        if (d === 'sent' || d === 'none') sent = true;
        else later = true;
      } catch (err) {
        later = true;
        this.p.log(`reach tell ${uid}: ${String(err)}`);
      }
    }
    return sent || !later;
  }
}
