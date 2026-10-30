/**
 * Their reply reminders (packages/shared/src/theirreply.ts): one in-memory timer per step that
 * waits on someone outside Hivenod, set to the last send plus the step's working days (reach
 * out's way: listeners feed it, no scans, no polling). When it fires and the step still waits on
 * the same message, it writes `remindDue` = that message's number, once: the agent's CLI then
 * pushes nudge_due and the agent drafts one reminder for the member's approval. Nothing more
 * fires until another message goes out.
 */
import { addWorkingDays, remindAfterDays } from '@hive/shared';

/** A step waiting on them, as the listener reads it. */
export interface RemindStep {
  /** `<wid>/<oid>`. */
  key: string;
  wid: string;
  oid: string;
  /** The message sent last and when (ms). */
  n: number;
  outMs: number;
  fields: Readonly<Record<string, unknown>>;
  /** The message number a reminder already fired for (0: none). */
  remindDue: number;
}

export interface RemindPorts {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Writes remindDue = n on the step if it still waits on message n (false: it moved on). */
  fire(s: RemindStep): Promise<boolean>;
  log(line: string): void;
}

/** When a step's reminder is due, or null when it already fired for this message. */
export function remindAt(s: RemindStep): number | null {
  if (s.remindDue >= s.n) return null;
  return addWorkingDays(s.outMs, remindAfterDays(s.fields));
}

export class Reminders {
  private timers = new Map<string, { s: RemindStep; at: number; h: unknown }>();
  constructor(private p: RemindPorts) {}

  /** The steps of organization `wid` waiting on them now (its listener's snapshot). */
  sync(wid: string, steps: readonly RemindStep[]) {
    const seen = new Set<string>();
    for (const s of steps) {
      seen.add(s.key);
      const at = remindAt(s);
      const cur = this.timers.get(s.key);
      if (cur && (at === null || cur.at !== at || cur.s.n !== s.n)) {
        this.p.clearTimer(cur.h);
        this.timers.delete(s.key);
      } else if (cur) continue;
      if (at === null) continue;
      this.arm(s, at);
    }
    for (const [k, t] of this.timers)
      if (t.s.wid === wid && !seen.has(k)) {
        this.p.clearTimer(t.h);
        this.timers.delete(k);
      }
  }

  get size() {
    return this.timers.size;
  }

  private arm(s: RemindStep, at: number) {
    const h = this.p.setTimer(() => void this.fire(s.key), Math.max(0, at - this.p.now()));
    this.timers.set(s.key, { s, at, h });
  }

  private async fire(key: string) {
    const t = this.timers.get(key);
    if (!t) return;
    // Node timers top out at ~24.8 days: not due yet, wait again.
    if (this.p.now() < t.at) return this.arm(t.s, t.at);
    this.timers.delete(key);
    try {
      if (await this.p.fire(t.s)) this.p.log(`reminder due: ${key} message ${t.s.n}`);
    } catch (e) {
      this.p.log(`reminder ${key}: ${String(e)}`);
      // Tried again in 15 minutes unless the listener moved it on meanwhile.
      if (!this.timers.has(key)) this.arm(t.s, this.p.now() + 15 * 60_000);
    }
  }
}
