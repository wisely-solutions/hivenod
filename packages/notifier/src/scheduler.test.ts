/**
 * The scheduler engine with a fake clock and a fake world (scheduler.ts): firing once per period,
 * restarts, two instances, DST, catch-up, every can't-run cause, the urgency ladder, the digest,
 * and Run now / Try later / Skip.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFY_PREFS,
  runDocId,
  type Notice,
  type NotifyPrefs,
  type Occurrence,
  type RunState,
  type ScheduleOf,
  type ScheduleRule,
} from '@hive/shared';
import type { Delivery } from './engine';
import {
  Scheduler,
  type AgentView,
  type NewRun,
  type OffView,
  type PlanView,
  type RunTelegram,
  type RunView,
  type SchedulerPorts,
  type TellOpts,
} from './scheduler';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const W = 'w1';
const L = 'Europe/Lisbon';

function schedule(rule: Partial<ScheduleRule>, over: Partial<ScheduleOf> = {}): ScheduleOf {
  return {
    memberUid: 'joao',
    agentUid: 'hive',
    title: 'Send invoices',
    what: 'Prepare the invoices.',
    runTitle: 'Send invoices · {period}',
    steps: [
      { type: 'reply', fields: { text: 'Invoices for {period}' } },
      { type: 'approval', fields: { what: 'Send them' } },
    ],
    templateId: null,
    subjectId: null,
    state: 'active',
    proposal: null,
    replaces: null,
    version: 2,
    rule: { freq: 'daily', at: '09:00', tz: L, ...rule } as ScheduleRule,
    ...over,
  };
}

interface Told {
  uid: string;
  notice: Notice;
  action?: RunTelegram;
  key: string;
  opts: TellOpts;
  at: number;
}

/** One shared world (Firestore stand-in); each Scheduler instance gets its own ports and timers. */
function world(start: number) {
  const t = { now: start };
  const runs = new Map<string, RunView>();
  const fires: { runId: string; at: number; attempts: number }[] = [];
  const told: Told[] = [];
  const reruns: string[] = [];
  const digests = new Map<string, string>();
  const agents = new Map<string, AgentView>();
  const plans = new Map<string, PlanView>();
  const prefs: { v: NotifyPrefs } = {
    v: { ...DEFAULT_NOTIFY_PREFS, quiet: { ...DEFAULT_NOTIFY_PREFS.quiet, tz: L } },
  };
  let beatAt: number | null = null;
  const beats: number[] = [];
  const instances: { s: Scheduler; timers: Map<number, { at: number; fn: () => void }> }[] = [];
  agents.set('hive', {
    name: 'Hive',
    // Infinity: always online (seen just now).
    lastSeenMs: Infinity,
    signedOutMs: null,
    revoked: false,
    paused: false,
    pausedReason: null,
    cliVersion: '0.2.300',
  });

  const publish = (r: RunView) => {
    runs.set(r.id, r);
    for (const i of instances) i.s.setRun({ ...r }, r.wid, r.id);
  };
  const toMs = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number | null));

  function ports(timers: Map<number, { at: number; fn: () => void }>): SchedulerPorts {
    let nextId = 1;
    return {
      now: () => t.now,
      setTimer: (fn, ms) => {
        const id = nextId++;
        timers.set(id, { at: t.now + ms, fn });
        return id;
      },
      clearTimer: (h) => void timers.delete(h as number),
      lastRun: async (_w, sid) => {
        const mine = [...runs.values()].filter((r) => r.sid === sid);
        if (!mine.length) return null;
        return { dueMs: Math.max(...mine.map((r) => r.dueMs)) };
      },
      recentRuns: async (_w, sid, n) =>
        [...runs.values()]
          .filter((r) => r.sid === sid)
          .sort((a, b) => b.dueMs - a.dueMs)
          .slice(0, n)
          .map((r) => r.state),
      agent: async (_w, uid) => {
        const a = agents.get(uid);
        return a ? { ...a, lastSeenMs: a.lastSeenMs === Infinity ? t.now : a.lastSeenMs } : null;
      },
      fire: async (wid, sid, s, occ, runExists) => {
        const id = runDocId(sid, occ.key);
        const had = runs.get(id);
        if (!runExists && had) return 'exists';
        if (runExists && had?.threadId) return 'exists';
        const attempts = (runExists?.attempts ?? 0) + 1;
        fires.push({ runId: id, at: t.now, attempts });
        publish({
          ...(had ?? base(wid, sid, s, occ)),
          state: 'fired',
          why: null,
          threadId: `t-${id}`,
          firedAtMs: t.now,
          attempts,
        });
        plans.set(id, { state: 'active', started: false, error: null, updatedAtMs: t.now });
        return 'fired';
      },
      createRun: async (wid, nr: NewRun) => {
        const id = runDocId(nr.sid, nr.occ.key);
        if (runs.has(id)) return false;
        publish({ ...base(wid, nr.sid, nr.s, nr.occ), state: nr.state, why: nr.why });
        return true;
      },
      moveRun: async (_w, id, from, patch) => {
        const r = runs.get(id);
        if (!r || !from.includes(r.state)) return false;
        const next: RunView = { ...r };
        for (const [k, v] of Object.entries(patch)) {
          if (k === 'firedAt') next.firedAtMs = toMs(v);
          else if (k === 'laterAt') next.laterAtMs = toMs(v);
          else if (k === 'startedAt' || k === 'endedAt') continue;
          else (next as unknown as Record<string, unknown>)[k] = v;
        }
        publish(next);
        return true;
      },
      claimAsk: async (_w, id, expectN, ask) => {
        const r = runs.get(id);
        if (!r || r.state !== 'cantRun' || (r.ask?.n ?? 0) !== expectN) return false;
        publish({ ...r, ask });
        return true;
      },
      planOf: async (_w, r) => plans.get(r.id) ?? null,
      rerun: async (_w, r) => {
        reruns.push(r.id);
        return 'retried';
      },
      claimDigest: async (uid, date) => {
        if (digests.get(uid) === date) return false;
        digests.set(uid, date);
        return true;
      },
      prefs: async () => prefs.v,
      tell: async (uid, notice, action, key, opts): Promise<Delivery> => {
        told.push({ uid, notice, action, key, opts, at: t.now });
        return 'sent';
      },
      beat: async () => {
        const prev = beatAt;
        beatAt = t.now;
        beats.push(t.now);
        return prev;
      },
      log: (l) =>
        process.env.SCHED_DEBUG ? console.log(new Date(t.now).toISOString(), l) : undefined,
    };
  }

  function base(wid: string, sid: string, s: ScheduleOf, occ: Occurrence): RunView {
    return {
      wid,
      id: runDocId(sid, occ.key),
      sid,
      key: occ.key,
      period: occ.period,
      dueMs: occ.dueMs,
      title: s.title,
      memberUid: s.memberUid,
      agentUid: s.agentUid,
      state: 'fired',
      why: null,
      threadId: null,
      attempts: 0,
      laterAtMs: null,
      firedAtMs: null,
      ask: null,
      decision: null,
    };
  }

  const flush = async () => {
    for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
  };

  /** A scheduler instance on this world (a process). */
  async function boot(schedules: { sid: string; s: ScheduleOf; activeFromMs: number }[]) {
    const timers = new Map<number, { at: number; fn: () => void }>();
    const s = new Scheduler(ports(timers));
    const inst = { s, timers };
    instances.push(inst);
    for (const x of schedules) s.setSchedule({ wid: W, ...x }, W, x.sid);
    for (const r of runs.values()) s.setRun({ ...r }, r.wid, r.id);
    await s.start();
    await flush();
    await runDue(0);
    return inst;
  }

  function kill(inst: { s: Scheduler }) {
    inst.s.stop();
    instances.splice(instances.indexOf(inst as never), 1);
  }

  /** Runs every instance's timers due up to now + ms, in time order. */
  async function runDue(ms: number) {
    const end = t.now + ms;
    for (let guard = 0; guard < 5000; guard++) {
      let best: {
        inst: (typeof instances)[number];
        id: number;
        at: number;
        fn: () => void;
      } | null = null;
      for (const inst of instances)
        for (const [id, x] of inst.timers)
          if (x.at <= end && (!best || x.at < best.at)) best = { inst, id, ...x };
      if (!best) break;
      best.inst.timers.delete(best.id);
      t.now = Math.max(t.now, best.at);
      best.fn();
      await flush();
    }
    t.now = end;
  }

  /** The member decides (the web or Telegram: decideRun writes these fields). */
  function decide(id: string, choice: 'runNow' | 'later' | 'skip', laterAtMs?: number) {
    const r = runs.get(id)!;
    const state: RunState = choice === 'skip' ? 'skipped' : choice;
    publish({
      ...r,
      state,
      decision: { choice, atMs: t.now },
      laterAtMs: choice === 'later' ? laterAtMs! : r.laterAtMs,
    });
  }

  function setPlan(id: string, v: Partial<PlanView>) {
    const pv = {
      ...(plans.get(id) ?? { state: 'active', started: false, error: null }),
      ...v,
      updatedAtMs: t.now,
    } as PlanView;
    plans.set(id, pv);
    for (const i of instances) i.s.setPlan(pv, W, id);
  }

  /** A plan listener that stopped and started again: null, then the same (stale) view. */
  function replayPlan(id: string) {
    for (const i of instances) {
      i.s.setPlan(null, W, id);
      i.s.setPlan(plans.get(id)!, W, id);
    }
  }

  function setOff(v: OffView | null) {
    for (const i of instances) i.s.setOff(v, W, 'joao');
  }

  return {
    t,
    runs,
    fires,
    told,
    reruns,
    agents,
    plans,
    prefs,
    beats,
    boot,
    kill,
    runDue,
    decide,
    setPlan,
    replayPlan,
    setOff,
    digests,
  };
}

const at = (iso: string) => Date.parse(iso);
vi.setConfig({ testTimeout: 30_000 });
/** What was told, without the daily digests. */
const asks = (w: { told: Told[] }) =>
  w.told.filter((x) => !x.notice.title.startsWith('Daily digest'));

describe('firing', () => {
  it('fires a daily run once at its time, then again the next day', async () => {
    const w = world(at('2026-11-02T08:00:00Z'));
    await w.boot([
      {
        sid: 's1',
        s: schedule({ freq: 'daily', at: '09:00' }),
        activeFromMs: at('2026-11-02T08:00:00Z'),
      },
    ]);
    expect(w.fires).toEqual([]);
    await w.runDue(59 * M);
    expect(w.fires).toEqual([]);
    await w.runDue(2 * M);
    expect(w.fires).toEqual([
      { runId: 's1_2026-11-02', at: at('2026-11-02T09:00:00Z'), attempts: 1 },
    ]);
    await w.runDue(12 * H);
    expect(w.fires.length).toBe(1);
    await w.runDue(12 * H);
    expect(w.fires.map((f) => f.runId)).toEqual(['s1_2026-11-02', 's1_2026-11-03']);
  });

  it('never fires an occurrence older than activeFrom', async () => {
    const w = world(at('2026-11-02T09:30:00Z'));
    await w.boot([
      { sid: 's1', s: schedule({ at: '09:00' }), activeFromMs: at('2026-11-02T09:29:00Z') },
    ]);
    await w.runDue(12 * H);
    expect(w.fires).toEqual([]);
    expect(w.runs.size).toBe(0);
  });

  it('fires once per period across a restart', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    const sch = [
      { sid: 's1', s: schedule({ at: '09:00' }), activeFromMs: at('2026-11-02T08:00:00Z') },
    ];
    const a = await w.boot(sch);
    await w.runDue(2 * M);
    expect(w.fires.length).toBe(1);
    w.kill(a);
    await w.runDue(5 * M);
    await w.boot(sch);
    await w.runDue(6 * H);
    expect(w.fires.length).toBe(1);
  });

  it('two schedulers at once fire one run', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    const sch = [
      { sid: 's1', s: schedule({ at: '09:00' }), activeFromMs: at('2026-11-02T08:00:00Z') },
    ];
    await w.boot(sch);
    await w.boot(sch);
    await w.runDue(3 * M);
    expect(w.fires.length).toBe(1);
    expect(w.runs.size).toBe(1);
  });

  it('fires once on the DST fall-back day and at the shifted time on the spring gap', async () => {
    const w = world(at('2026-10-24T12:00:00Z'));
    await w.boot([
      { sid: 's1', s: schedule({ at: '01:30' }), activeFromMs: at('2026-10-24T00:00:00Z') },
    ]);
    await w.runDue(D + 2 * H);
    // 25 Oct 01:30 local happens twice (summer, then winter): it runs once, the first time.
    const oct25 = w.fires.filter((f) => f.runId === 's1_2026-10-25');
    expect(oct25).toEqual([
      { runId: 's1_2026-10-25', at: at('2026-10-25T00:30:00Z'), attempts: 1 },
    ]);

    const s = world(at('2026-03-28T12:00:00Z'));
    await s.boot([
      { sid: 's1', s: schedule({ at: '01:30' }), activeFromMs: at('2026-03-28T00:00:00Z') },
    ]);
    await s.runDue(D);
    // 29 Mar 01:30 does not exist in Lisbon (01:00 → 02:00): it runs at 02:30 local = 01:30 UTC.
    expect(s.fires.find((f) => f.runId === 's1_2026-03-29')?.at).toBe(at('2026-03-29T01:30:00Z'));
  });

  it('fires a run at most 15 minutes late (a restart is not a miss)', async () => {
    const w = world(at('2026-11-02T09:10:00Z'));
    await w.boot([
      { sid: 's1', s: schedule({ at: '09:00' }), activeFromMs: at('2026-11-02T08:00:00Z') },
    ]);
    expect(w.fires.map((f) => f.runId)).toEqual(['s1_2026-11-02']);
  });

  it('beats every 15 minutes', async () => {
    const w = world(at('2026-11-02T08:00:00Z'));
    await w.boot([]);
    await w.runDue(H);
    expect(w.beats.map((b) => (b - at('2026-11-02T08:00:00Z')) / M)).toEqual([0, 15, 30, 45, 60]);
  });
});

describe('catch-up after the scheduler was down', () => {
  it('asks about misses, never fires them late: 3 daily in the digest, the monthly at once', async () => {
    const w = world(at('2026-11-05T12:00:00Z'));
    // The last daily ran on 31 Oct; the monthly was due 1 Nov 09:00.
    w.runs.set('s1_2026-10-31', {
      wid: W,
      id: 's1_2026-10-31',
      sid: 's1',
      key: '2026-10-31',
      period: '31 Oct 2026',
      dueMs: at('2026-10-31T08:00:00Z'),
      title: 'Clean-up',
      memberUid: 'joao',
      agentUid: 'hive',
      state: 'done',
      why: null,
      threadId: 't',
      attempts: 1,
      laterAtMs: null,
      firedAtMs: 0,
      ask: null,
      decision: null,
    });
    await w.boot([
      {
        sid: 's1',
        s: schedule({ freq: 'daily', at: '08:00' }, { title: 'Clean-up' }),
        activeFromMs: at('2026-10-01T00:00:00Z'),
      },
      {
        sid: 's2',
        s: schedule({ freq: 'monthly', at: '09:00', monthDay: 1 }),
        activeFromMs: at('2026-10-01T00:00:00Z'),
      },
    ]);
    expect(w.fires).toEqual([]);
    const st = (id: string) => w.runs.get(id)?.state;
    expect(['s1_2026-11-01', 's1_2026-11-02'].map(st)).toEqual(['expired', 'expired']);
    expect(['s1_2026-11-03', 's1_2026-11-04', 's1_2026-11-05'].map(st)).toEqual([
      'cantRun',
      'cantRun',
      'cantRun',
    ]);
    expect(w.runs.get('s1_2026-11-05')!.why).toMatchObject({ code: 'hostDown' });
    expect(w.runs.get('s1_2026-11-05')!.why!.text).toContain('And 2 earlier runs');
    expect(st('s2_2026-11')).toBe('cantRun');
    // The monthly is told at once; the dailies go into the digest.
    expect(asks(w).map((x) => x.notice.title)).toEqual(["Important · Monthly run didn't happen"]);
    expect(asks(w)[0]!.notice.body).toContain('Why: Hivenod’s scheduler was down');
    await w.runDue(D);
    const digest = w.told.find((x) => x.notice.title.startsWith('Daily digest'))!;
    // Today's digest had not gone out: it goes now, late (it has misses to tell).
    expect(digest.at).toBe(at('2026-11-05T12:00:00Z'));
    expect(digest.notice.body.match(/Couldn't run/g)?.length).toBe(3);
    expect(digest.action?.runs.length).toBe(3);
    expect(digest.action?.digest).toBe(true);
    // Today's 08:00 daily (6 Nov) fired normally and the asked misses before it expired.
    expect(w.fires.map((f) => f.runId)).toEqual(['s1_2026-11-06']);
    expect(w.runs.get('s1_2026-11-05')!.state).toBe('expired');
    expect(w.runs.get('s2_2026-11')!.state).toBe('cantRun'); // monthly never expires
  });
});

describe("can't run", () => {
  const weekly = () =>
    schedule({ freq: 'weekly', weekdays: [1], at: '09:00' }, { title: 'Timesheet' });
  const from = at('2026-11-02T07:00:00Z');

  it('Off: no thread, the ask says agents are Off', async () => {
    const w = world(at('2026-11-02T08:00:00Z'));
    const i = await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
    i.s.setOff({ all: true, agents: [], sinceMs: at('2026-11-02T07:02:00Z') }, W, 'joao');
    await w.runDue(2 * H);
    expect(w.fires).toEqual([]);
    expect(w.runs.get('s1_2026-11-02')).toMatchObject({ state: 'cantRun', why: { code: 'off' } });
    expect(asks(w).map((x) => x.notice.title)).toEqual(["Weekly run didn't happen"]);
    expect(asks(w)[0]!.notice.body).toContain('Agents are Off since 07:02');
    await w.runDue(3 * D);
    expect(asks(w).length).toBe(1); // weekly: once
  });

  it('paused, removed, and a CLI too old', async () => {
    for (const [patch, code, words] of [
      [
        { paused: true, pausedReason: '3 failed runs' },
        'paused',
        'Hive is paused (3 failed runs).',
      ],
      [{ revoked: true }, 'paused', 'Hive was removed from the organization.'],
      [{ cliVersion: '0.2.100' }, 'cliOld', 'CLI 0.2.100 is too old'],
    ] as const) {
      const w = world(at('2026-11-02T08:59:00Z'));
      Object.assign(w.agents.get('hive')!, patch);
      await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
      await w.runDue(2 * M);
      expect(w.fires).toEqual([]);
      expect(w.runs.get('s1_2026-11-02')!.why!.code).toBe(code);
      expect(asks(w)[0]!.notice.body).toContain(words);
    }
  });

  it('offline: waits up to 15 minutes, fires when the agent comes online', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    w.agents.get('hive')!.lastSeenMs = at('2026-11-02T08:12:00Z');
    await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
    await w.runDue(2 * M);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('waitingAgent');
    w.agents.get('hive')!.lastSeenMs = at('2026-11-02T09:05:00Z');
    w.t.now = at('2026-11-02T09:05:00Z');
    await w.runDue(2 * M);
    expect(w.fires).toEqual([{ runId: 's1_2026-11-02', at: expect.any(Number), attempts: 1 }]);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('fired');
  });

  it('offline for 15 minutes: asked, with the last-seen time', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    w.agents.get('hive')!.lastSeenMs = at('2026-11-02T08:12:00Z');
    await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
    await w.runDue(20 * M);
    expect(w.runs.get('s1_2026-11-02')).toMatchObject({
      state: 'cantRun',
      why: { code: 'offline', text: 'Hive was offline (last seen 08:12).' },
    });
    expect(asks(w).length).toBe(1);
  });

  it('not started 30 minutes after firing, or started late', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
    await w.runDue(29 * M);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('fired');
    await w.runDue(5 * M);
    expect(w.runs.get('s1_2026-11-02')).toMatchObject({
      state: 'cantRun',
      why: { code: 'noStart' },
    });
    expect(asks(w)[0]!.notice.body).toContain('Hive did not start it within 30 minutes.');
    // It starts after all: the run is running again, nobody is asked more.
    w.setPlan('s1_2026-11-02', { started: true });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('running');
  });

  it('a step failed: asked with the error; the member stopping the plan is not asked', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    await w.boot([
      { sid: 's1', s: weekly(), activeFromMs: from },
      { sid: 's2', s: { ...weekly(), title: 'Other' }, activeFromMs: from },
    ]);
    await w.runDue(2 * M);
    w.setPlan('s1_2026-11-02', { started: true });
    w.setPlan('s2_2026-11-02', { started: true });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('running');
    w.setPlan('s1_2026-11-02', { state: 'blocked', error: 'the portal refused the login' });
    w.setPlan('s2_2026-11-02', { state: 'stopped' });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11-02')).toMatchObject({
      state: 'cantRun',
      why: { code: 'failed', text: 'Hive could not do it: the portal refused the login' },
    });
    expect(w.runs.get('s2_2026-11-02')!.state).toBe('stopped');
    expect(asks(w).map((x) => x.notice.body.split('\n')[0])).toEqual([
      'Timesheet (Weekly · Mon · 09:00) did not run today at 09:00.',
    ]);
  });

  it('done when the plan is done', async () => {
    const w = world(at('2026-11-02T08:59:00Z'));
    await w.boot([{ sid: 's1', s: weekly(), activeFromMs: from }]);
    await w.runDue(2 * M);
    w.setPlan('s1_2026-11-02', { state: 'done', started: true });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('done');
    await w.runDue(D);
    expect(asks(w)).toEqual([]);
  });
});

describe('the urgency ladder', () => {
  const from = at('2026-11-01T00:00:00Z');
  const offline = (w: ReturnType<typeof world>) => {
    w.agents.get('hive')!.lastSeenMs = null;
  };
  const quiet = (w: ReturnType<typeof world>) => {
    w.prefs.v = { ...w.prefs.v, quiet: { enabled: true, from: '22:00', to: '08:00', tz: L } };
  };

  it('yearly: urgent at once even in quiet hours, then every 2 h outside them, until decided', async () => {
    const w = world(at('2026-11-02T22:50:00Z'));
    offline(w);
    quiet(w);
    await w.boot([
      {
        sid: 's1',
        s: schedule(
          { freq: 'yearly', month: 11, monthDay: 2, at: '22:45' },
          { title: 'Renew the domain' },
        ),
        activeFromMs: from,
      },
    ]);
    await w.runDue(15 * M);
    expect(asks(w).map((x) => [x.notice.title, new Date(x.at).toISOString()])).toEqual([
      ["URGENT · Yearly run didn't happen", '2026-11-02T23:00:00.000Z'],
    ]);
    expect(asks(w)[0]!.opts.urgent).toBe(true);
    expect(asks(w)[0]!.notice.body).toContain('If skipped, the next run is 2 Nov 2027.');
    expect(asks(w)[0]!.notice.body).toContain('every 2 hours');
    await w.runDue(14 * H);
    expect(asks(w).map((x) => new Date(x.at).toISOString().slice(11, 16))).toEqual([
      '23:00',
      '08:00', // quiet hours held the 01:00 repeat
      '10:00',
      '12:00',
    ]);
    w.decide('s1_2026', 'skip');
    await w.runDue(D);
    expect(asks(w).length).toBe(4);
  });

  it('monthly: at once, after 4 h, then daily at 09:00', async () => {
    const w = world(at('2026-11-01T08:50:00Z'));
    offline(w);
    await w.boot([
      { sid: 's1', s: schedule({ freq: 'monthly', monthDay: 1, at: '09:00' }), activeFromMs: from },
    ]);
    await w.runDue(3 * D);
    expect(asks(w).map((x) => new Date(x.at).toISOString().slice(5, 16))).toEqual([
      '11-01T09:15',
      '11-01T13:15',
      '11-02T09:00',
      '11-03T09:00',
    ]);
    expect(asks(w)[1]!.notice.title).toBe("Important · Monthly run didn't happen (reminder)");
  });

  it('daily: a digest line; after the digest a silent line; the third miss in a row a message', async () => {
    const w = world(at('2026-11-02T05:00:00Z'));
    offline(w);
    await w.boot([
      {
        sid: 's1',
        s: schedule({ freq: 'daily', at: '06:00' }, { title: 'Clean-up' }),
        activeFromMs: at('2026-11-02T00:00:00Z'),
      },
      {
        sid: 's2',
        s: schedule({ freq: 'daily', at: '14:00' }, { title: 'Sweep' }),
        activeFromMs: at('2026-11-02T00:00:00Z'),
      },
    ]);
    await w.runDue(4 * H); // 06:00 miss (06:15), digest 08:30
    expect(w.told.map((x) => x.notice.title)).toEqual(['Daily digest · Mon 2 Nov']);
    expect(w.told[0]!.notice.body).toContain("Couldn't run: Clean-up (Daily · 06:00)");
    expect(w.told[0]!.notice.body).toContain('Coming up today: 14:00 Sweep');
    await w.runDue(6 * H); // 14:00 miss after the digest: a silent line at once
    expect(w.told[1]).toMatchObject({ opts: { silent: true }, at: at('2026-11-02T14:15:00Z') });
    // Two more days offline: the third Clean-up miss in a row is a message of its own.
    await w.runDue(2 * D);
    const loud = w.told.filter(
      (x) => x.notice.title === "Daily run didn't happen" && !x.opts.silent,
    );
    expect(loud.map((x) => new Date(x.at).toISOString().slice(5, 16))).toContain('11-04T06:15');
    // Reported daily misses expire when the next run comes (here: the next miss).
    expect(w.runs.get('s1_2026-11-02')?.state).toBe('expired');
  });
});

describe('Run now, Try later, Skip', () => {
  const from = at('2026-11-01T00:00:00Z');
  const monthly = () => schedule({ freq: 'monthly', monthDay: 1, at: '09:00' });

  it('Run now fires a run that never had a thread', async () => {
    const w = world(at('2026-11-01T08:50:00Z'));
    w.agents.get('hive')!.lastSeenMs = null;
    await w.boot([{ sid: 's1', s: monthly(), activeFromMs: from }]);
    await w.runDue(30 * M);
    expect(w.runs.get('s1_2026-11')!.state).toBe('cantRun');
    w.agents.get('hive')!.lastSeenMs = Infinity;
    w.decide('s1_2026-11', 'runNow');
    await w.runDue(M);
    expect(w.fires).toEqual([{ runId: 's1_2026-11', at: expect.any(Number), attempts: 1 }]);
    expect(w.runs.get('s1_2026-11')!.state).toBe('fired');
  });

  it('Run now on a failed run retries it on its thread', async () => {
    const w = world(at('2026-11-01T08:59:00Z'));
    await w.boot([{ sid: 's1', s: monthly(), activeFromMs: from }]);
    await w.runDue(2 * M);
    w.setPlan('s1_2026-11', { state: 'blocked', error: 'no access' });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11')!.state).toBe('cantRun');
    w.decide('s1_2026-11', 'runNow');
    w.replayPlan('s1_2026-11');
    await w.runDue(M);
    expect(w.reruns).toEqual(['s1_2026-11']);
    w.replayPlan('s1_2026-11');
    expect(w.fires.length).toBe(1);
    expect(w.runs.get('s1_2026-11')).toMatchObject({ state: 'fired', attempts: 2 });
    // The stale blocked plan view does not fail it again; the retried plan going on does count.
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11')!.state).toBe('fired');
    w.setPlan('s1_2026-11', { state: 'active', started: true });
    await w.runDue(M);
    expect(w.runs.get('s1_2026-11')!.state).toBe('running');
  });

  it('Try later runs the gates again at that time and asks again when it fails again', async () => {
    const w = world(at('2026-11-02T08:58:00Z'));
    w.agents.get('hive')!.lastSeenMs = null;
    await w.boot([
      {
        sid: 's1',
        s: schedule({ freq: 'weekly', weekdays: [1], at: '09:00' }),
        activeFromMs: from,
      },
    ]);
    await w.runDue(20 * M);
    expect(asks(w).length).toBe(1);
    w.decide('s1_2026-11-02', 'later', at('2026-11-02T11:00:00Z'));
    await w.runDue(H);
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('later');
    await w.runDue(H + 20 * M); // 11:00 → waiting 15 min → can't run again
    expect(w.runs.get('s1_2026-11-02')!.state).toBe('cantRun');
    expect(asks(w).length).toBe(2);
    expect(asks(w)[1]!.notice.title).toBe("Weekly run didn't happen");
    // Back online: Try later fires it.
    w.decide('s1_2026-11-02', 'later', at('2026-11-02T13:00:00Z'));
    w.agents.get('hive')!.lastSeenMs = Infinity;
    await w.runDue(2 * H);
    expect(w.fires.map((f) => f.at)).toEqual([at('2026-11-02T13:00:00Z')]);
  });

  it('Skip: nothing more happens', async () => {
    const w = world(at('2026-11-01T08:50:00Z'));
    w.agents.get('hive')!.lastSeenMs = null;
    await w.boot([{ sid: 's1', s: monthly(), activeFromMs: from }]);
    await w.runDue(30 * M);
    w.decide('s1_2026-11', 'skip');
    await w.runDue(3 * D);
    expect(w.fires).toEqual([]);
    expect(asks(w).length).toBe(1);
    expect(w.runs.get('s1_2026-11')!.state).toBe('skipped');
  });
});
