/**
 * Scheduled tasks, slices 3 and 4 (design ~/drafts/schedules/design.md, sections 5 and 8): the
 * scheduler and its "can't run" asks, free of any SDK. It talks to the world through
 * `SchedulerPorts`, so the tests run it with a fake clock and fake (or emulator-backed) ports.
 *
 * - The listeners (schedulerStore.ts) feed it the active and paused schedules, the open runs,
 *   the Off docs and the plans of fired runs. It keeps ONE in-memory timer, set to the earliest
 *   thing due (a run, an agent re-check, a start deadline, an ask, a digest), recomputed when a
 *   listener changes something or a pass ends. No polling: an idle scheduler does nothing but its
 *   beat (`config/scheduler.beatAt`, every 15 minutes), which also re-runs a pass.
 * - Timing is pure code (./schedules.ts `dueNow`). A run fires at most 15 minutes late; anything
 *   older (the notifier was down) becomes a can't-run question, never a late fire. On start the
 *   same rule catches up: at most 3 questions per schedule, older misses expire.
 * - Exactly once: every run is `scheduleRuns/{sid}_{key}` written with create() (and its thread,
 *   plan and event ids derive from the same pair), every later move is a transaction on its state,
 *   every ask message is claimed first. Two notifiers, or a restart mid-fire, cannot double a run
 *   or a message.
 * - Can't run (offline 15 min, Off, paused/removed, host down, not started in 30 min, a step
 *   failed, a CLI too old): the member is asked Run now · Try later · Skip, as loudly as the
 *   schedule is rare (urgencyOf, scheduleAsk.ts nextAskAt); daily misses go into the daily digest.
 */
import {
  AGENT_ONLINE_MS,
  cliSupports,
  DAILY_MISSES_LOUD,
  DEFAULT_NOTIFY_PREFS,
  digestNotice,
  isOffFor,
  localDate,
  localParts,
  memberTz,
  nextAskAt,
  nextDigestAt,
  nextLocalTime,
  nextRun,
  dueNow,
  nextDue,
  occurrences,
  outcomeType,
  RUN_CATCH_UP_ASKS,
  RUN_GRACE_MS,
  RUN_NO_START_MS,
  RUN_WAIT_AGENT_MS,
  RUN_WAIT_RECHECK_MS,
  ruleSentence,
  runAskNotice,
  runDocId,
  SCHEDULER_BEAT_MS,
  threadLink,
  urgencyOf,
  whyText,
  DEFAULT_SCHEDULE_TZ,
  type NotifyPrefs,
  type Notice,
  type Occurrence,
  type RunState,
  type RunWhy,
  type ScheduleOf,
  type ScheduleUrgency,
} from '@hive/shared';
import type { Delivery } from './engine';

const DAY = 86_400_000;
/** The longest timer (setTimeout overflows at ~24.8 days); the beat re-runs a pass anyway. */
const MAX_TIMER_MS = 6 * 3_600_000;
/** After an error on one thing, it is not tried again before this. */
const BACKOFF_MS = 60_000;

export interface SchedView {
  wid: string;
  sid: string;
  s: ScheduleOf;
  activeFromMs: number | null;
}

export interface RunAsk {
  level: ScheduleUrgency;
  n: number;
  firstAtMs: number;
  lastAtMs: number;
}

export interface RunView {
  wid: string;
  id: string;
  sid: string;
  key: string;
  period: string;
  dueMs: number;
  title: string;
  memberUid: string;
  agentUid: string;
  state: RunState;
  why: { code: RunWhy; text: string } | null;
  threadId: string | null;
  attempts: number;
  laterAtMs: number | null;
  firedAtMs: number | null;
  ask: RunAsk | null;
  decision: { choice: string; atMs: number } | null;
}

export interface AgentView {
  name: string;
  lastSeenMs: number | null;
  signedOutMs: number | null;
  revoked: boolean;
  paused: boolean;
  pausedReason: string | null;
  cliVersion: string | null;
}

export interface OffView {
  all: boolean;
  agents: string[];
  sinceMs: number | null;
}

/** The plan of a fired run, as its listener (or a read) sees it. */
export interface PlanView {
  state: 'proposed' | 'active' | 'blocked' | 'done' | 'stopped';
  /** Some step got going (the cursor moved, the step at it is running/done/failed, or waits for the member). */
  started: boolean;
  /** The failed step's error, when blocked. */
  error: string | null;
  /** The plan doc's update time (ms): a view older than the last re-run is ignored. */
  updatedAtMs: number;
}

/** What a run that is newly written holds (the store fills ids and the server times). */
export interface NewRun {
  sid: string;
  s: ScheduleOf;
  occ: Occurrence;
  state: 'waitingAgent' | 'cantRun' | 'expired';
  why: { code: RunWhy; text: string } | null;
}

/** The buttons of a run ask (Telegram): Run now · Try later · Skip · Open, per run. */
export interface RunTelegram {
  kind: 'run';
  uid: string;
  runs: { wid: string; runId: string; title: string }[];
  /** A digest: two buttons per run (Run now, Skip). */
  digest?: boolean;
}

export interface TellOpts {
  /** Through quiet hours (the first urgent message). */
  urgent?: boolean;
  /** A Telegram line without a notification sound, and no push. */
  silent?: boolean;
}

export interface SchedulerPorts {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The newest run of a schedule (one query, index scheduleId + dueAt desc). */
  lastRun(wid: string, sid: string): Promise<{ dueMs: number } | null>;
  /** The newest `n` runs' states, newest first (daily misses in a row). */
  recentRuns(wid: string, sid: string, n: number): Promise<RunState[]>;
  agent(wid: string, uid: string): Promise<AgentView | null>;
  /** Fires one run (fireScheduledRun, one batch). 'exists': it was fired before (no-op). */
  fire(
    wid: string,
    sid: string,
    s: ScheduleOf,
    occ: Occurrence,
    runExists: { attempts: number } | null,
  ): Promise<'fired' | 'exists'>;
  /** Writes a new run with create(); false when it exists (another notifier, a restart). */
  createRun(wid: string, run: NewRun): Promise<boolean>;
  /** Moves a run in a transaction, only while its state is one of `from`; false otherwise. */
  moveRun(
    wid: string,
    runId: string,
    from: readonly RunState[],
    patch: Record<string, unknown>,
  ): Promise<boolean>;
  /** Claims the next ask message: only while the run is cantRun and its ask.n is `expectN`. */
  claimAsk(wid: string, runId: string, expectN: number, ask: RunAsk): Promise<boolean>;
  /** The plan of a fired run, read now (the start deadline). */
  planOf(wid: string, run: RunView): Promise<PlanView | null>;
  /** Run now on a run whose thread exists: retries its failed step, or asks its agent to start. */
  rerun(wid: string, run: RunView): Promise<'retried' | 'instructed' | 'none'>;
  /** Claims a member's daily digest for a local date; false when it went out already. */
  claimDigest(uid: string, date: string): Promise<boolean>;
  prefs(uid: string): Promise<NotifyPrefs>;
  tell(
    uid: string,
    notice: Notice,
    action: RunTelegram | undefined,
    key: string,
    opts: TellOpts,
  ): Promise<Delivery>;
  /** The scheduler's heartbeat: writes config/scheduler; returns the previous beat (ms) or null. */
  beat(): Promise<number | null>;
  log(line: string): void;
}

const OPEN: readonly RunState[] = [
  'waitingAgent',
  'fired',
  'running',
  'cantRun',
  'runNow',
  'later',
];
const kname = (wid: string, id: string) => `${wid}/${id}`;

/** The occurrence a run stands for (its schedule's rule may have changed since). */
export function occOf(
  run: Pick<RunView, 'key' | 'dueMs' | 'period'>,
  s: ScheduleOf | null,
): Occurrence {
  if (s) {
    const hit = occurrences(s.rule, run.dueMs - DAY, run.dueMs + DAY, 10).find(
      (o) => o.key === run.key,
    );
    if (hit) return hit;
  }
  const tz = s?.rule.tz ?? DEFAULT_SCHEDULE_TZ;
  const l = localParts(run.dueMs, tz);
  const p = (n: number) => String(n).padStart(2, '0');
  const date = `${l.y}-${p(l.m)}-${p(l.d)}`;
  return {
    key: run.key,
    dueMs: run.dueMs,
    local: `${date} ${p(l.h)}:${p(l.min)}`,
    date,
    period: run.period,
    year: l.y,
    month: l.m,
    quarter: Math.floor((l.m - 1) / 3) + 1,
  };
}

/** True while the agent's terminal counts as online (as liveTerminal in agents.ts). */
function online(a: AgentView, now: number): boolean {
  const seen = a.lastSeenMs ?? 0;
  return !!seen && seen > (a.signedOutMs ?? 0) && now - seen < AGENT_ONLINE_MS;
}

type Gate =
  { kind: 'fire' } | { kind: 'wait' } | { kind: 'cant'; why: { code: RunWhy; text: string } };

export class Scheduler {
  private schedules = new Map<string, SchedView>();
  private runs = new Map<string, RunView>();
  private offs = new Map<string, OffView>();
  private plans = new Map<string, PlanView>();
  /** The newest run's dueMs per schedule (undefined: not read yet; null: none). */
  private lastDue = new Map<string, number | null>();
  /** Plan views at or before this time are stale for that run (it was re-run since). */
  private planFloor = new Map<string, number>();
  private notBefore = new Map<string, number>();
  /** Members whose daily digest went out, by local date. */
  private digested = new Map<string, string>();
  /** Daily misses found to be the third in a row (asked as normal). */
  private loud = new Map<string, boolean>();
  private prefsCache = new Map<string, { at: number; prefs: NotifyPrefs }>();
  private timer: unknown;
  private beatTimer: unknown;
  private running = false;
  private again = false;
  private stopped = false;
  /** The previous beat when this process started (the scheduler was down since then). */
  private downSinceMs: number | null = null;
  private started = false;

  constructor(private p: SchedulerPorts) {}

  // ---------- fed by the listeners ----------

  setSchedule(v: SchedView | null, wid: string, sid: string) {
    const k = kname(wid, sid);
    const old = this.schedules.get(k);
    if (v) this.schedules.set(k, v);
    else this.schedules.delete(k);
    // A new activation or rule change starts from its activeFrom: the cached last run stays valid.
    if (!v || (old && old.s.state !== v.s.state)) this.notBefore.delete(k);
    this.kick();
  }
  setRun(v: RunView | null, wid: string, id: string) {
    const k = kname(wid, id);
    if (v && OPEN.includes(v.state)) this.runs.set(k, v);
    else this.runs.delete(k);
    if (v) {
      const sk = kname(wid, v.sid);
      const last = this.lastDue.get(sk);
      if (last !== undefined && (last === null || v.dueMs > last)) this.lastDue.set(sk, v.dueMs);
    }
    this.kick();
  }
  setOff(v: OffView | null, wid: string, uid: string) {
    if (v) this.offs.set(kname(wid, uid), v);
    else this.offs.delete(kname(wid, uid));
    this.kick();
  }
  setPlan(v: PlanView | null, wid: string, runId: string) {
    if (v) this.plans.set(kname(wid, runId), v);
    else this.plans.delete(kname(wid, runId));
    this.kick();
  }

  /** For the store: the open runs whose plan it should watch. */
  openRuns(): RunView[] {
    return [...this.runs.values()];
  }

  // ---------- life ----------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.downSinceMs = await this.p.beat();
    } catch (e) {
      this.p.log(`scheduler beat: ${String(e)}`);
    }
    this.scheduleBeat();
    this.kick();
  }

  stop() {
    this.stopped = true;
    this.p.clearTimer(this.timer);
    this.p.clearTimer(this.beatTimer);
  }

  private scheduleBeat() {
    if (this.stopped) return;
    this.beatTimer = this.p.setTimer(() => {
      void this.p
        .beat()
        .catch((e) => this.p.log(`scheduler beat: ${String(e)}`))
        .finally(() => {
          this.scheduleBeat();
          this.kick();
        });
    }, SCHEDULER_BEAT_MS);
  }

  /** Runs a pass now (coalesced). */
  kick() {
    if (this.stopped || !this.started) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.p.clearTimer(this.timer);
    this.timer = this.p.setTimer(() => void this.pass(), 0);
  }

  /** One pass; exported for the tests (they await it). */
  async pass(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    let next = Infinity;
    try {
      next = await this.work();
    } catch (e) {
      this.p.log(`scheduler: ${String(e)}`);
      next = this.p.now() + BACKOFF_MS;
    } finally {
      this.running = false;
    }
    if (this.again) {
      this.again = false;
      return this.pass();
    }
    this.plan(next);
  }

  private plan(at: number) {
    if (this.stopped) return;
    this.p.clearTimer(this.timer);
    if (at === Infinity) return;
    const ms = Math.min(MAX_TIMER_MS, Math.max(1000, at - this.p.now()));
    this.timer = this.p.setTimer(() => void this.pass(), ms);
  }

  private blocked(k: string, now: number) {
    return (this.notBefore.get(k) ?? 0) > now;
  }
  private fail(k: string, what: string, e: unknown) {
    this.notBefore.set(k, this.p.now() + BACKOFF_MS);
    this.p.log(`scheduler ${what} ${k}: ${String(e)}`);
  }

  private async prefs(uid: string): Promise<NotifyPrefs> {
    const hit = this.prefsCache.get(uid);
    const now = this.p.now();
    if (hit && now - hit.at < 60 * 60_000) return hit.prefs;
    let prefs = DEFAULT_NOTIFY_PREFS;
    try {
      prefs = (await this.p.prefs(uid)) ?? DEFAULT_NOTIFY_PREFS;
    } catch (e) {
      this.p.log(`scheduler prefs ${uid}: ${String(e)}`);
    }
    this.prefsCache.set(uid, { at: now, prefs });
    return prefs;
  }

  /** Everything due now; returns when the next thing is due. */
  private async work(): Promise<number> {
    let next = Infinity;
    const at = (t: number | null | undefined) => {
      if (t != null && t < next) next = t;
    };
    const now = this.p.now();

    // 1. Schedules: fire what is due (catch-up included), then the timer to the next occurrence.
    for (const [k, v] of [...this.schedules]) {
      if (v.s.state !== 'active') continue;
      if (this.blocked(k, now)) {
        at(this.notBefore.get(k));
        continue;
      }
      try {
        at(await this.onSchedule(k, v, now));
      } catch (e) {
        this.fail(k, 'schedule', e);
        at(this.notBefore.get(k));
      }
    }

    // 2. Daily digests (before the asks: a daily miss after today's digest is a silent line).
    for (const uid of this.members()) {
      try {
        at(await this.digest(uid, now));
      } catch (e) {
        this.fail(`digest/${uid}`, 'digest', e);
      }
    }

    // 3. Open runs.
    for (const [k, r] of [...this.runs]) {
      if (this.blocked(k, now)) {
        at(this.notBefore.get(k));
        continue;
      }
      try {
        at(await this.onRun(k, r, now));
      } catch (e) {
        this.fail(k, 'run', e);
        at(this.notBefore.get(k));
      }
    }
    return next;
  }

  // ---------- schedules ----------

  private async onSchedule(k: string, v: SchedView, now: number): Promise<number | null> {
    let last = this.lastDue.get(k);
    if (last === undefined) {
      last = (await this.p.lastRun(v.wid, v.sid))?.dueMs ?? null;
      // A run the listener delivered meanwhile may be newer.
      const seen = this.lastDue.get(k);
      if (seen != null && (last === null || seen > last)) last = seen;
      this.lastDue.set(k, last);
    }
    const clock = { rule: v.s.rule, activeFromMs: v.activeFromMs, lastDueMs: last };
    const due = dueNow(clock, now, 400);
    if (due.length) {
      const late = due.filter((o) => now - o.dueMs > RUN_GRACE_MS);
      const onTime = due.filter((o) => now - o.dueMs <= RUN_GRACE_MS);
      if (late.length) await this.missed(v, late, now);
      for (const o of onTime) await this.gateAndFire(v, o, null, now);
      await this.expireOlder(v, due[due.length - 1]!);
      this.lastDue.set(k, due[due.length - 1]!.dueMs);
    }
    const n = nextDue(
      { rule: v.s.rule, activeFromMs: v.activeFromMs, lastDueMs: this.lastDue.get(k) ?? null },
      now,
    );
    return n?.dueMs ?? null;
  }

  /** Occurrences the scheduler slept through: the newest 3 are asked, older ones expire. */
  private async missed(v: SchedView, late: Occurrence[], now: number) {
    const asked = late.slice(-RUN_CATCH_UP_ASKS);
    const gone = late.slice(0, late.length - asked.length);
    const tz = v.s.rule.tz ?? DEFAULT_SCHEDULE_TZ;
    const text = (more: number) =>
      whyText({ code: 'hostDown', fromMs: this.downSinceMs, toMs: now, tz, more });
    for (const o of gone)
      await this.p.createRun(v.wid, {
        sid: v.sid,
        s: v.s,
        occ: o,
        state: 'expired',
        why: { code: 'hostDown', text: text(0) },
      });
    for (const o of asked)
      await this.p.createRun(v.wid, {
        sid: v.sid,
        s: v.s,
        occ: o,
        state: 'cantRun',
        why: { code: 'hostDown', text: text(o === asked[asked.length - 1] ? gone.length : 0) },
      });
    if (late.length) this.p.log(`scheduler ${v.wid}/${v.sid}: ${late.length} missed while down`);
  }

  private async gate(v: SchedView, base: number, now: number): Promise<Gate> {
    const s = v.s;
    const tz = s.rule.tz ?? DEFAULT_SCHEDULE_TZ;
    const off = this.offs.get(kname(v.wid, s.memberUid)) ?? null;
    if (isOffFor(off, s.agentUid))
      return {
        kind: 'cant',
        why: { code: 'off', text: whyText({ code: 'off', sinceMs: off?.sinceMs ?? null, tz }) },
      };
    const a = await this.p.agent(v.wid, s.agentUid);
    const name = a?.name || 'The agent';
    if (!a || a.revoked)
      return {
        kind: 'cant',
        why: { code: 'paused', text: whyText({ code: 'paused', agent: name, removed: true }) },
      };
    if (a.paused)
      return {
        kind: 'cant',
        why: {
          code: 'paused',
          text: whyText({ code: 'paused', agent: name, reason: a.pausedReason }),
        },
      };
    const long = s.steps.some((st) => outcomeType(st.type)?.long === true);
    if (cliSupports(long ? 'longstep' : 'plan', a.cliVersion) === 'old')
      return {
        kind: 'cant',
        why: {
          code: 'cliOld',
          text: whyText({ code: 'cliOld', agent: name, version: a.cliVersion }),
        },
      };
    if (!online(a, now)) {
      if (now - base < RUN_WAIT_AGENT_MS) return { kind: 'wait' };
      return {
        kind: 'cant',
        why: {
          code: 'offline',
          text: whyText({ code: 'offline', agent: name, lastSeenMs: a.lastSeenMs, tz }),
        },
      };
    }
    return { kind: 'fire' };
  }

  /**
   * The gates, then fire. `r`: a run that exists already (waiting for its agent, or decided Run
   * now / Try later); with a thread it is re-run on that thread instead of a new one.
   */
  private async gateAndFire(v: SchedView, o: Occurrence, r: RunView | null, now: number) {
    const g = await this.gate(v, r ? waitBase(r) : o.dueMs, now);
    const runId = runDocId(v.sid, o.key);
    const k = kname(v.wid, runId);
    if (g.kind === 'wait') {
      if (!r)
        await this.p.createRun(v.wid, {
          sid: v.sid,
          s: v.s,
          occ: o,
          state: 'waitingAgent',
          why: null,
        });
      else if (r.state !== 'waitingAgent') {
        if (await this.p.moveRun(v.wid, runId, [r.state], { state: 'waitingAgent' }))
          this.local(k, { state: 'waitingAgent' });
      }
      this.notBefore.set(k, now + RUN_WAIT_RECHECK_MS);
      return;
    }
    if (g.kind === 'cant') {
      if (!r)
        await this.p.createRun(v.wid, { sid: v.sid, s: v.s, occ: o, state: 'cantRun', why: g.why });
      else if (await this.p.moveRun(v.wid, runId, [r.state], { state: 'cantRun', why: g.why }))
        this.local(k, { state: 'cantRun', why: g.why });
      return;
    }
    if (r?.threadId) {
      // Re-run on its thread: claim the move first, so a second notifier does nothing.
      const firedAt = new Date(now);
      if (
        !(await this.p.moveRun(v.wid, runId, [r.state], {
          state: 'fired',
          why: null,
          firedAt,
          attempts: r.attempts + 1,
        }))
      )
        return;
      this.planFloor.set(k, this.plans.get(k)?.updatedAtMs ?? 0);
      this.local(k, { state: 'fired', why: null, firedAtMs: now, attempts: r.attempts + 1 });
      const how = await this.p.rerun(v.wid, { ...r, state: 'fired' });
      this.p.log(`scheduler ${k}: run again (${how})`);
      return;
    }
    const s = v.s.state === 'active' ? v.s : { ...v.s, state: 'active' as const };
    const res = await this.p.fire(v.wid, v.sid, s, o, r ? { attempts: r.attempts } : null);
    this.p.log(`scheduler ${k}: ${res}`);
    if (res === 'fired' && r)
      this.local(k, { state: 'fired', firedAtMs: now, why: null, attempts: r.attempts + 1 });
  }

  /**
   * A daily or weekly miss already reported expires when the next run comes (design 5.2: it was
   * told, and the next one supersedes it), whether that one fires or cannot run either.
   */
  private async expireOlder(v: SchedView, o: Occurrence) {
    if (v.s.rule.freq !== 'daily' && v.s.rule.freq !== 'weekly') return;
    for (const [k, r] of [...this.runs]) {
      if (r.wid !== v.wid || r.sid !== v.sid || r.state !== 'cantRun') continue;
      if (r.dueMs >= o.dueMs || !r.ask || r.ask.n < 1) continue;
      if (await this.p.moveRun(r.wid, r.id, ['cantRun'], { state: 'expired' })) this.runs.delete(k);
    }
  }

  private local(k: string, patch: Partial<RunView>) {
    const r = this.runs.get(k);
    if (r) this.runs.set(k, { ...r, ...patch });
  }

  // ---------- runs ----------

  private async onRun(k: string, r: RunView, now: number): Promise<number | null> {
    const v = this.schedules.get(kname(r.wid, r.sid)) ?? null;
    switch (r.state) {
      case 'waitingAgent':
      case 'runNow':
      case 'later': {
        if (r.state === 'later' && (r.laterAtMs ?? 0) > now) return r.laterAtMs;
        if (!v) {
          // Its schedule was deleted: nothing can run it any more.
          if (await this.p.moveRun(r.wid, r.id, [r.state], { state: 'expired' }))
            this.runs.delete(k);
          return null;
        }
        await this.gateAndFire(v, occOf(r, v.s), r, now);
        return this.notBefore.get(k) ?? null;
      }
      case 'fired':
      case 'running':
        return this.track(k, r, now);
      case 'cantRun':
        if (r.threadId && (await this.planMoves(k, r, now))) return now + 1000;
        return this.ask(k, r, v, now);
      default:
        return null;
    }
  }

  /**
   * What the run's plan says (its listener): done, stopped by the member (no ask: his choice),
   * blocked (a step failed: asked), or under way. Also settles a can't-run run whose plan went on
   * after all (the agent started late, the member retried the step on the web). True: it moved.
   */
  private async planMoves(k: string, r: RunView, now: number): Promise<boolean> {
    const pv = this.plans.get(k);
    if (!pv || pv.updatedAtMs <= (this.planFloor.get(k) ?? -1)) return false;
    const live: RunState[] = ['fired', 'running', 'cantRun'];
    const move = async (from: RunState[], patch: Record<string, unknown>, end: boolean) => {
      if (!from.includes(r.state)) return false;
      if (!(await this.p.moveRun(r.wid, r.id, from, patch))) return false;
      if (end) this.runs.delete(k);
      else this.local(k, patch as Partial<RunView>);
      return true;
    };
    if (pv.state === 'done') return move(live, { state: 'done', endedAt: new Date(now) }, true);
    if (pv.state === 'stopped')
      return move(live, { state: 'stopped', endedAt: new Date(now) }, true);
    if (pv.state === 'blocked') {
      if (r.state === 'cantRun') return false;
      const agent = (await this.p.agent(r.wid, r.agentUid))?.name || 'The agent';
      const why = {
        code: 'failed' as const,
        text: whyText({ code: 'failed', agent, error: pv.error }),
      };
      // Newer plan views (a retry) count again.
      this.planFloor.set(k, pv.updatedAtMs);
      return move(['fired', 'running'], { state: 'cantRun', why }, false);
    }
    if (pv.state === 'active' && pv.started) {
      if (r.state === 'fired')
        return move(['fired'], { state: 'running', startedAt: new Date(now) }, false);
      if (r.state === 'cantRun' && (r.why?.code === 'noStart' || r.why?.code === 'failed'))
        return move(['cantRun'], { state: 'running', why: null }, false);
    }
    return false;
  }

  /** A fired run: its plan, or not started 30 minutes after it fired. */
  private async track(k: string, r: RunView, now: number): Promise<number | null> {
    if (await this.planMoves(k, r, now)) return now + 1000;
    if (r.state !== 'fired') return null;
    const deadline = (r.firedAtMs ?? now) + RUN_NO_START_MS;
    if (now < deadline) return deadline;
    const read = await this.p.planOf(r.wid, r);
    if (read) this.plans.set(k, read);
    if (read && (read.state !== 'active' || read.started)) {
      await this.planMoves(k, r, now);
      return now + 1000;
    }
    const agent = (await this.p.agent(r.wid, r.agentUid))?.name || 'The agent';
    const why = { code: 'noStart' as const, text: whyText({ code: 'noStart', agent }) };
    if (read) this.planFloor.set(k, read.updatedAtMs);
    if (await this.p.moveRun(r.wid, r.id, ['fired'], { state: 'cantRun', why }))
      this.local(k, { state: 'cantRun', why });
    return now + 1000;
  }

  // ---------- asks ----------

  private async level(r: RunView, v: SchedView | null): Promise<ScheduleUrgency> {
    if (r.ask) return r.ask.level;
    const base = v ? urgencyOf(v.s.rule.freq) : 'normal';
    // Misses while the scheduler was down are one outage, not misses in a row.
    if (base !== 'low' || r.why?.code === 'hostDown') return base;
    const k = kname(r.wid, r.id);
    let loud = this.loud.get(k);
    if (loud === undefined) {
      const recent = await this.p.recentRuns(r.wid, r.sid, DAILY_MISSES_LOUD);
      loud =
        recent.length >= DAILY_MISSES_LOUD &&
        recent.every((s) => s === 'cantRun' || s === 'expired');
      this.loud.set(k, loud);
    }
    return loud ? 'normal' : 'low';
  }

  private notice(r: RunView, v: SchedView | null, level: ScheduleUrgency, n: number, now: number) {
    const rule = v?.s.rule;
    const tz = rule?.tz ?? DEFAULT_SCHEDULE_TZ;
    const next = rule && rule.freq !== 'once' ? nextRun(rule, Math.max(r.dueMs, now)) : null;
    return runAskNotice({
      level,
      freq: rule?.freq ?? 'weekly',
      title: v?.s.title ?? r.title,
      sentence: rule ? ruleSentence(rule) : r.period,
      dueMs: r.dueMs,
      tz,
      why: r.why?.text ?? 'It could not start.',
      nextMs: next?.dueMs ?? null,
      nowMs: now,
      n,
      url: r.threadId ? threadLink(r.wid, r.threadId) : '/',
    });
  }

  private async ask(
    k: string,
    r: RunView,
    v: SchedView | null,
    now: number,
  ): Promise<number | null> {
    const level = await this.level(r, v);
    const prefs = await this.prefs(r.memberUid);
    const tz = memberTz(prefs, v?.s.rule.tz);
    const sent = episode(r);
    if (level === 'low') {
      if (sent) return null;
      // Before today's digest: the digest tells it. After it: a silent line at once.
      if (this.digested.get(r.memberUid) !== localDate(now, tz)) return null;
      return this.send(r, v, 'low', now, { silent: true, urgent: true });
    }
    const due = nextAskAt(level, sent, now, prefs.quiet, tz);
    if (!due) return null;
    if (due.atMs > now) return due.atMs;
    // The ladder already placed it outside quiet hours (or it breaks through): deliver it now.
    await this.send(r, v, level, now, { urgent: true });
    const after = nextAskAt(level, { n: (sent?.n ?? 0) + 1, lastAtMs: now }, now, prefs.quiet, tz);
    return after?.atMs ?? null;
  }

  private async send(
    r: RunView,
    v: SchedView | null,
    level: ScheduleUrgency,
    now: number,
    opts: TellOpts,
  ): Promise<null> {
    const n = r.ask?.n ?? 0;
    const shown = episode(r)?.n ?? 0;
    const k = kname(r.wid, r.id);
    const ask: RunAsk = {
      level,
      n: n + 1,
      firstAtMs: episode(r) ? r.ask!.firstAtMs : now,
      lastAtMs: now,
    };
    if (!(await this.p.claimAsk(r.wid, r.id, n, ask))) {
      // Another notifier sent it (or the run moved on): its listener update follows.
      this.notBefore.set(k, now + BACKOFF_MS);
      return null;
    }
    this.local(k, { ask });
    const d = await this.p.tell(
      r.memberUid,
      this.notice(r, v, level, shown, now),
      {
        kind: 'run',
        uid: r.memberUid,
        runs: [{ wid: r.wid, runId: r.id, title: v?.s.title ?? r.title }],
      },
      `run|${r.wid}|${r.id}|${n + 1}`,
      opts,
    );
    this.p.log(`scheduler ask ${k} ${level} #${n + 1}: ${d}`);
    return null;
  }

  // ---------- the daily digest ----------

  private members(): Set<string> {
    const out = new Set<string>();
    for (const v of this.schedules.values()) if (v.s.state === 'active') out.add(v.s.memberUid);
    for (const r of this.runs.values()) if (r.state === 'cantRun') out.add(r.memberUid);
    return out;
  }

  /** Today's digest time for a member (local), and whether it is due. */
  private async digest(uid: string, now: number): Promise<number | null> {
    if (this.blocked(`digest/${uid}`, now)) return this.notBefore.get(`digest/${uid}`) ?? null;
    const prefs = await this.prefs(uid);
    const mine = [...this.schedules.values()].filter(
      (v) => v.s.memberUid === uid && v.s.state === 'active',
    );
    const tz = memberTz(prefs, mine[0]?.s.rule.tz);
    const today = localDate(now, tz);
    if (this.digested.get(uid) === today) return nextDigestAt(prefs, tz, now);
    let at = nextDigestAt(prefs, tz, now - DAY);
    if (localDate(at, tz) !== today) at = nextDigestAt(prefs, tz, at);
    if (localDate(at, tz) !== today || at > now) return at;
    // Due: claim today's (another notifier, or this one before a restart, may have sent it).
    const claimed = await this.p.claimDigest(uid, today);
    this.digested.set(uid, today);
    if (!claimed) return nextDigestAt(prefs, tz, now);
    const missed: RunView[] = [];
    for (const r of this.runs.values()) {
      if (r.memberUid !== uid || r.state !== 'cantRun' || episode(r)) continue;
      const v = this.schedules.get(kname(r.wid, r.sid)) ?? null;
      if ((await this.level(r, v)) === 'low') missed.push(r);
    }
    const end = nextLocalTime(now, tz, '23:59');
    const coming = mine
      .flatMap((v) =>
        occurrences(v.s.rule, Math.max(now, v.activeFromMs ?? 0), end, 5).map((o) => ({
          atMs: o.dueMs,
          title: v.s.title,
        })),
      )
      .sort((a, b) => a.atMs - b.atMs)
      .slice(0, 8);
    // Nothing missed: nothing to say, or only "coming up" hours after its time (a restart).
    if (!missed.length && (!coming.length || now - at > 3_600_000))
      return nextDigestAt(prefs, tz, now);
    const claimedRuns: RunView[] = [];
    for (const r of missed) {
      const n = r.ask?.n ?? 0;
      const ask: RunAsk = { level: 'low', n: n + 1, firstAtMs: now, lastAtMs: now };
      if (await this.p.claimAsk(r.wid, r.id, n, ask)) {
        this.local(kname(r.wid, r.id), { ask });
        claimedRuns.push(r);
      }
    }
    const title = (r: RunView) => this.schedules.get(kname(r.wid, r.sid))?.s.title ?? r.title;
    const notice = digestNotice({
      dateMs: now,
      tz,
      missed: claimedRuns.map((r) => {
        const rule = this.schedules.get(kname(r.wid, r.sid))?.s.rule;
        return {
          title: title(r),
          sentence: rule ? ruleSentence(rule) : r.period,
          why: r.why?.text ?? '',
        };
      }),
      coming,
    });
    const d = await this.p.tell(
      uid,
      notice,
      claimedRuns.length
        ? {
            kind: 'run',
            uid,
            digest: true,
            runs: claimedRuns.map((r) => ({ wid: r.wid, runId: r.id, title: title(r) })),
          }
        : undefined,
      `digest|${uid}|${today}`,
      { urgent: true },
    );
    this.p.log(
      `scheduler digest ${uid} ${today}: ${claimedRuns.length} missed, ${coming.length} coming: ${d}`,
    );
    return nextDigestAt(prefs, tz, now);
  }
}

/** When an existing run's wait for its agent began: its decision, or when it was due. */
function waitBase(r: RunView): number {
  if (r.decision?.choice === 'later' && r.laterAtMs) return r.laterAtMs;
  if (r.decision) return r.decision.atMs;
  return r.dueMs;
}

/**
 * The messages of the current can't-run episode: a run decided (Try later, Run now) that could
 * not happen again is a new episode, asked again from the start. Null: nothing sent in it yet.
 */
function episode(r: RunView): { n: number; lastAtMs: number } | null {
  if (!r.ask || r.ask.n < 1) return null;
  if (r.decision && r.decision.atMs > r.ask.lastAtMs) return null;
  return { n: r.ask.n, lastAtMs: r.ask.lastAtMs };
}
