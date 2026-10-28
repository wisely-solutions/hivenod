/**
 * Inbox events of a channel session (item 4PEHrOW5IfXBQWgOK9wo, part 2; docs/INBOX.md, "Channel
 * events"). The session pushes `<channel kind="inbox">` events for the threads that need agent
 * work. They do not count toward max_items and are never claimed: the main session runs each in
 * a background sub-agent of its own.
 *
 * Who gets what:
 *  - investigating a thread (a new thread or message, the person's answer to inbox_ask, a
 *    snooze waking, a rejected or failed outcome, a thread brought back) and a nudge due: the
 *    thread's home agent (`fetchedBy`, the agent that brought it in: the organization's main
 *    agent for that inbox);
 *  - carrying out an approved outcome: its executor (the rules fix it to the home agent).
 * So exactly one agent's session gets each event.
 *
 * Dedupe: one event per thread state change. The feed remembers, per thread, the last event id
 * it has handled (`lastEventId`); a listener that reconnects delivers the same documents again
 * and nothing is pushed twice. Inside a session an approved outcome is pushed once. A new session
 * (a restart) sends each thread that still needs work once more (reason `resume`, or the reason
 * it is waiting for), within the same cap and rate, since the sub-agents of the old one are gone.
 *
 * Flow control: at most `maxInbox` threads are in flight at once (default 3, 0 turns inbox events
 * off). One is in flight from its event until the thread leaves the state it was sent for (or
 * the outcome leaves approved), or for at most `leaseMs`. At most `perMinute` events go out per
 * minute. Waiting ones go out in order: approved outcomes, answers, new messages, the rest, then
 * nudges; oldest first. The Go CLI mirrors this file (cli/internal/hive/inboxfeed.go).
 */

/** What the feed sees of a thread (the home agent's open threads). */
export interface FeedThread {
  id: string;
  memberUid: string;
  state: string;
  title: string;
  lastEventId: string;
  updatedAtMs: number;
  lastMessageAtMs: number;
  waiting: { on: string; untilMs: number | null } | null;
}

/** An approved outcome this agent carries out. */
export interface FeedOutcome {
  id: string;
  threadId: string;
  memberUid: string;
  type: string;
  createdAtMs: number;
}

export interface FeedEventDoc {
  type: string;
  data: Record<string, unknown>;
}

/** Where the feed reads from (Firestore in the client; fakes in tests). */
export interface InboxSource {
  /** Open threads this agent brought in (investigating or waiting), live. */
  watchThreads(on: (rows: FeedThread[]) => void, onError: (e: unknown) => void): () => void;
  /** Approved outcomes this agent carries out, live. */
  watchOutcomes(on: (rows: FeedOutcome[]) => void, onError: (e: unknown) => void): () => void;
  /** An inbox event (the timeline), or null when it is gone. */
  eventOf(eventId: string): Promise<FeedEventDoc | null>;
  /** thread_wake: a snoozed thread whose date has come. */
  wake(threadId: string): Promise<void>;
}

export interface InboxFeedOptions {
  /** Inbox threads in flight at once (default 3; 0 turns inbox events off). */
  maxInbox?: number;
  /** Inbox events per minute at most (default 10). */
  perMinute?: number;
  /** A thread waiting on them for this long is due a nudge (default 3 days). */
  nudgeAfterMs?: number;
  /** A thread counts as in flight for at most this long (default 30 minutes). */
  leaseMs?: number;
  /** How often snoozes, nudges and leases are checked (default 60 s). */
  tickMs?: number;
}

export const INBOX_DEFAULTS = {
  maxInbox: 3,
  perMinute: 10,
  nudgeAfterMs: 3 * 24 * 3_600_000,
  leaseMs: 30 * 60_000,
  tickMs: 60_000,
} as const;
/** The highest `--max-inbox` accepted. */
export const MAX_INBOX_LIMIT = 10;

export type InboxReason =
  | 'carry_out'
  | 'answered'
  | 'new'
  | 'message'
  | 'woke'
  | 'rejected'
  | 'failed'
  | 'restored'
  | 'resume'
  | 'nudge_due';

/** The inbox event types that put a thread (back) into investigating, with their reason. */
const TRIGGERS: Record<string, InboxReason> = {
  'inbox.added': 'message',
  'thread.answered': 'answered',
  'thread.woke': 'woke',
  'thread.restored': 'restored',
  'outcome.rejected': 'rejected',
  'outcome.failed': 'failed',
};

/** Lower goes first. */
const PRIORITY: Record<InboxReason, number> = {
  carry_out: 0,
  answered: 1,
  new: 2,
  message: 2,
  woke: 3,
  rejected: 3,
  failed: 3,
  restored: 3,
  resume: 3,
  nudge_due: 4,
};

/** What an inbox event says (the Go CLI has the same function; surface.json checks it). */
export interface InboxEventInfo {
  reason: InboxReason;
  threadId: string;
  title?: string;
  outcomeId?: string;
  outcomeType?: string;
  question?: string;
  answer?: string;
  why?: string;
  nudgeDays?: number;
  /** A sub-agent already works on this thread. */
  update?: boolean;
}

/** Shortens to n UTF-16 units with an ellipsis (the Go clip() is the same). */
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The content of an `inbox` event (plain text for the model). */
export function inboxText(e: InboxEventInfo): string {
  const t = `"${clip(e.title || 'Untitled', 200)}" (thread ${e.threadId})`;
  const lines: string[] = [];
  switch (e.reason) {
    case 'new':
      lines.push(`New in Inbox: ${t}.`);
      break;
    case 'message':
      lines.push(`A new message on ${t}.`);
      break;
    case 'answered':
      lines.push(`The person answered your question on ${t}.`);
      if (e.question) lines.push(`Your question: ${clip(e.question, 1500)}`);
      if (e.answer !== undefined) lines.push(`Their answer: ${clip(e.answer, 3000)}`);
      break;
    case 'woke':
      lines.push(`${t} woke up: its snooze is over.`);
      break;
    case 'rejected':
      lines.push(
        `The person turned down the proposed outcome on ${t}${e.why ? `: ${clip(e.why, 1000)}` : '.'}`,
      );
      break;
    case 'failed':
      lines.push(
        `Carrying out an outcome on ${t} failed${e.why ? `: ${clip(e.why, 1000)}` : '.'} Investigate it again.`,
      );
      break;
    case 'restored':
      lines.push(`The person brought ${t} back to the agents.`);
      break;
    case 'resume':
      lines.push(
        `${t} is still being investigated (this session is new: an earlier sub-agent may have stopped).`,
      );
      break;
    case 'nudge_due':
      lines.push(`${t} has waited on them for ${e.nudgeDays ?? 3} days or more.`);
      break;
    case 'carry_out':
      lines.push(
        `The person approved a ${e.outcomeType ?? '?'} outcome (outcome ${e.outcomeId ?? '?'}) on thread ${e.threadId}.`,
      );
      break;
  }
  const what =
    e.reason === 'carry_out'
      ? `carry out outcome ${e.outcomeId ?? '?'} exactly as approved (its fields, as the person left them), then report it with outcome_done`
      : e.reason === 'nudge_due'
        ? 'propose a nudge (outcome_propose, type nudge) if one makes sense, otherwise say why not with inbox_note'
        : "investigate it (inbox_note for what you find, subject_assign if it is not filed, inbox_ask only if you must), then propose what should come of it (outcome_propose)";
  if (e.update) {
    lines.push(
      `A sub-agent of yours already works on thread ${e.threadId}: pass this on to it (if it has finished, start a new one with thread_read).`,
    );
  } else {
    lines.push(
      `Run it in a new background sub-agent of its own, with this brief: "You work Hivenod inbox thread ${e.threadId}. Start with thread_read (threadId ${e.threadId}), then ${what}, and report back in one line. Nothing is sent, booked or handed over without the person's approval." Stay free for the next event; inbox work does not count toward max_items and never holds up an item.`,
    );
  }
  return lines.join('\n');
}

interface Due {
  slot: string;
  reason: InboxReason;
  threadId: string;
  /** Sort key: when it happened. */
  atMs: number;
  info: InboxEventInfo;
  memberUid: string;
  outcome?: FeedOutcome;
  /** What it was pushed for: the thread state, and for a nudge the updatedAt. */
  state?: string;
  updatedAtMs?: number;
}

interface InFlight {
  at: number;
  kind: 'thread' | 'outcome';
  state?: string;
  updatedAtMs?: number;
}

export interface FeedPush {
  content: string;
  meta: Record<string, string>;
}

export class InboxFeed {
  readonly maxInbox: number;
  private readonly perMinute: number;
  private readonly nudgeAfterMs: number;
  private readonly leaseMs: number;
  private readonly tickMs: number;
  private threads = new Map<string, FeedThread>();
  private outcomes = new Map<string, FeedOutcome>();
  /** Per thread, the last event id handled (the dedupe). */
  private handled = new Map<string, string>();
  /** Threads seen in this session (a thread not seen yet is resumed). */
  private seen = new Set<string>();
  /** Investigations waiting to go out, by thread. */
  private due = new Map<string, Due>();
  /** Nudges pushed: thread → its updatedAt then. */
  private nudged = new Map<string, number>();
  /** Outcomes pushed in this session. */
  private carried = new Set<string>();
  private inflight = new Map<string, InFlight>();
  private sent: number[] = [];
  private types = new Map<string, FeedEventDoc | null>();
  private fetching = new Set<string>();
  private wakes = new Map<string, string>();
  private stops: (() => void)[] = [];
  private timer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly src: InboxSource,
    private readonly push: (e: FeedPush) => Promise<void>,
    opts: InboxFeedOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    const n = opts.maxInbox ?? INBOX_DEFAULTS.maxInbox;
    this.maxInbox = Math.max(0, Math.min(MAX_INBOX_LIMIT, Math.floor(n)));
    this.perMinute = Math.max(1, opts.perMinute ?? INBOX_DEFAULTS.perMinute);
    this.nudgeAfterMs = opts.nudgeAfterMs ?? INBOX_DEFAULTS.nudgeAfterMs;
    this.leaseMs = opts.leaseMs ?? INBOX_DEFAULTS.leaseMs;
    this.tickMs = opts.tickMs ?? INBOX_DEFAULTS.tickMs;
  }

  /** Inbox threads in flight now. */
  get active(): number {
    return this.inflight.size;
  }

  start(): void {
    if (this.maxInbox === 0 || this.closed) return;
    this.subscribe();
    this.timer = setInterval(() => this.evaluate(), this.tickMs);
    this.timer.unref();
  }

  /**
   * Starts the listeners (again). A reconnecting listener delivers every document again; tests
   * call this to check that nothing is pushed twice.
   */
  subscribe(): void {
    this.stops.splice(0).forEach((f) => f());
    const err = () => undefined; // the listener retries; the next snapshot catches up
    this.stops.push(
      this.src.watchThreads((rows) => this.onThreads(rows), err),
      this.src.watchOutcomes((rows) => this.onOutcomes(rows), err),
    );
  }

  stop(): void {
    this.closed = true;
    this.stops.splice(0).forEach((f) => f());
    if (this.timer) clearInterval(this.timer);
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
  }

  onThreads(rows: FeedThread[]): void {
    this.threads = new Map(rows.map((r) => [r.id, r]));
    this.evaluate();
  }

  onOutcomes(rows: FeedOutcome[]): void {
    this.outcomes = new Map(rows.map((r) => [r.id, r]));
    this.evaluate();
  }

  /** Works out what is due from the current documents and sends what the cap and rate allow. */
  evaluate(): void {
    if (this.closed) return;
    const now = this.now();
    // In flight ends when the thread leaves the state it was sent for, or after the lease.
    for (const [slot, f] of this.inflight) {
      let over = now - f.at >= this.leaseMs;
      if (f.kind === 'outcome') over ||= !this.outcomes.has(slot.slice(2));
      else {
        const t = this.threads.get(slot.slice(2));
        over ||= !t || t.state !== f.state;
        if (t && f.updatedAtMs !== undefined) over ||= t.updatedAtMs !== f.updatedAtMs;
      }
      if (over) this.inflight.delete(slot);
    }
    for (const t of this.threads.values()) {
      if (t.state === 'investigating') this.investigating(t);
      else {
        this.due.delete(`i:${t.id}`);
        if (t.state === 'waiting') this.waiting(t, now);
      }
      if (t.state !== 'investigating' || this.handled.get(t.id) === t.lastEventId)
        this.seen.add(t.id);
    }
    for (const key of [...this.due.keys()])
      if (key.startsWith('i:') && this.threads.get(key.slice(2))?.state !== 'investigating')
        this.due.delete(key);
    for (const o of this.outcomes.values()) {
      const slot = `o:${o.id}`;
      if (this.carried.has(o.id) || this.due.has(slot)) continue;
      this.due.set(slot, {
        slot,
        reason: 'carry_out',
        threadId: o.threadId,
        atMs: o.createdAtMs,
        memberUid: o.memberUid,
        outcome: o,
        info: {
          reason: 'carry_out',
          threadId: o.threadId,
          outcomeId: o.id,
          outcomeType: o.type,
        },
      });
    }
    for (const [slot, d] of this.due)
      if (d.outcome && !this.outcomes.has(d.outcome.id)) this.due.delete(slot);
    this.pump();
  }

  private investigating(t: FeedThread) {
    const last = this.handled.get(t.id);
    if (last === t.lastEventId) return;
    if (!this.types.has(t.lastEventId)) {
      this.fetch(t.lastEventId);
      return;
    }
    const ev = this.types.get(t.lastEventId) ?? null;
    this.handled.set(t.id, t.lastEventId);
    let reason: InboxReason | undefined = ev ? TRIGGERS[ev.type] : undefined;
    if (reason === 'message' && ev?.data.newThread === true) reason = 'new';
    if (!reason) {
      if (this.seen.has(t.id)) return; // a note, a filing, a title: nothing new to do
      reason = 'resume';
    }
    const d = ev?.data ?? {};
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    this.due.set(`i:${t.id}`, {
      slot: `t:${t.id}`,
      reason,
      threadId: t.id,
      atMs: t.lastMessageAtMs,
      memberUid: t.memberUid,
      state: 'investigating',
      info: {
        reason,
        threadId: t.id,
        title: t.title,
        ...(reason === 'answered'
          ? { question: str(d.question), answer: str(d.answer) ?? '' }
          : {}),
        ...(reason === 'rejected' ? { why: str(d.reason) } : {}),
        ...(reason === 'failed' ? { why: str(d.error) } : {}),
      },
    });
  }

  private waiting(t: FeedThread, now: number) {
    const until = t.waiting?.untilMs ?? null;
    if (until !== null) {
      if (until <= now && this.wakes.get(t.id) !== t.lastEventId) {
        // The snooze is over: wake it (the home agent's job); thread.woke then sends the event.
        this.wakes.set(t.id, t.lastEventId);
        this.src.wake(t.id).catch(() => this.wakes.delete(t.id)); // tried again at the next tick
      }
      return;
    }
    if (t.waiting?.on !== 'them' || now - t.updatedAtMs < this.nudgeAfterMs) return;
    if (this.nudged.get(t.id) === t.updatedAtMs || this.due.has(`n:${t.id}`)) return;
    this.due.set(`n:${t.id}`, {
      slot: `t:${t.id}`,
      reason: 'nudge_due',
      threadId: t.id,
      atMs: t.updatedAtMs,
      memberUid: t.memberUid,
      state: 'waiting',
      updatedAtMs: t.updatedAtMs,
      info: {
        reason: 'nudge_due',
        threadId: t.id,
        title: t.title,
        nudgeDays: Math.max(1, Math.round(this.nudgeAfterMs / 86_400_000)),
      },
    });
  }

  private fetch(eventId: string) {
    if (this.fetching.has(eventId)) return;
    this.fetching.add(eventId);
    this.src.eventOf(eventId).then(
      (e) => {
        this.fetching.delete(eventId);
        this.types.set(eventId, e);
        this.evaluate();
      },
      () => {
        this.fetching.delete(eventId); // tried again at the next snapshot or tick
      },
    );
  }

  private pump() {
    for (const [key, d] of this.due) {
      if (key.startsWith('n:')) {
        const t = this.threads.get(d.threadId);
        if (!t || t.state !== 'waiting' || t.updatedAtMs !== d.updatedAtMs) this.due.delete(key);
      }
    }
    const order = [...this.due.entries()].sort(
      ([ka, a], [kb, b]) =>
        PRIORITY[a.reason] - PRIORITY[b.reason] || a.atMs - b.atMs || (ka < kb ? -1 : 1),
    );
    for (const [key, d] of order) {
      const update = this.inflight.has(d.slot);
      if (!update && this.inflight.size >= this.maxInbox) continue;
      if (!this.allowed()) {
        this.retryPump();
        return;
      }
      this.due.delete(key);
      if (d.outcome) this.carried.add(d.outcome.id);
      if (d.reason === 'nudge_due') this.nudged.set(d.threadId, d.updatedAtMs!);
      if (!update)
        this.inflight.set(d.slot, {
          at: this.now(),
          kind: d.outcome ? 'outcome' : 'thread',
          state: d.state,
          ...(d.updatedAtMs !== undefined ? { updatedAtMs: d.updatedAtMs } : {}),
        });
      this.sent.push(this.now());
      const meta: Record<string, string> = {
        kind: 'inbox',
        thread_id: d.threadId,
        reason: d.reason,
        member: d.memberUid,
        inbox_cap: String(this.maxInbox),
        inbox_active: String(this.inflight.size),
      };
      if (d.outcome) {
        meta.outcome_id = d.outcome.id;
        meta.outcome_type = d.outcome.type;
      }
      if (update) meta.update = 'true';
      const content = inboxText({ ...d.info, ...(update ? { update: true } : {}) });
      // One push at a time, in order.
      this.chain = this.chain.then(() => this.push({ content, meta }).catch(() => undefined));
    }
  }

  private allowed() {
    const now = this.now();
    this.sent = this.sent.filter((t) => now - t < 60_000);
    return this.sent.length < this.perMinute;
  }

  private retryPump() {
    if (this.pumpTimer || this.closed) return;
    const wait = Math.max(50, 60_000 - (this.now() - (this.sent[0] ?? this.now())));
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.evaluate();
    }, wait);
    this.pumpTimer.unref();
  }

  /** Everything pushed so far has gone out (tests). */
  flushed(): Promise<void> {
    return this.chain;
  }
}
