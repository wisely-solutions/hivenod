import { describe, expect, it } from 'vitest';
import type { Notice } from '@hive/shared';
import type { Delivery } from './engine';
import { ReachOut, REACH_RETRY_MS, type Flag, type ReachPorts, type Watched } from './reach';

const M = 60_000;
const H = 60 * M;

/** A fake clock with timers, and a fake world the ports act on. */
function world(over: { delivery?: Delivery } = {}) {
  const t = { now: Date.UTC(2026, 9, 30, 10, 0, 0) };
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const calls = {
    asks: [] as number[],
    flags: [] as (Flag | null)[],
    told: [] as { uid: string; notice: Notice; at: number }[],
    bells: [] as string[],
    reads: [] as number[],
  };
  const found = { ms: null as number | null };
  const ports: ReachPorts = {
    now: () => t.now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t.now + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
    activity: async (_w, after) => {
      calls.reads.push(after);
      return found.ms !== null && found.ms > after ? found.ms : null;
    },
    ask: async () => void calls.asks.push(t.now),
    flag: async (_w, f) => void calls.flags.push(f),
    deliver: async (uid, notice) => {
      const d = over.delivery ?? 'sent';
      if (d === 'sent') calls.told.push({ uid, notice, at: t.now });
      return d;
    },
    bell: async (uids, id) => void calls.bells.push(...uids.map((u) => `${u}/${id}`)),
    log: () => undefined,
  };
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  };
  /** Moves the clock, running each timer at its time (in order). */
  const advance = async (ms: number) => {
    const end = t.now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, x]) => x.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      t.now = Math.max(t.now, due[1].at);
      due[1].fn();
      await flush();
    }
    t.now = end;
  };
  const reach = new ReachOut(ports);
  return { t, reach, calls, found, advance, timers, flush };
}

const watched = (t: { now: number }, over: Partial<Watched> = {}): Watched => ({
  key: 'w/o/o1',
  ref: { kind: 'step', wid: 'w', oid: 'o1', tid: 't1' },
  run: 'o1',
  activityMs: t.now,
  askMs: null,
  flag: null,
  agentUid: 'hive',
  agentName: 'Hive',
  title: 'Dark mode for the board',
  where: 'Reply, step 2 of 3',
  url: '/inbox/w/t/t1',
  last: { text: 'tests green, opening the PR', atMs: t.now },
  to: ['ana'],
  ...over,
});

describe('reach out on a thread step in agent hands (fake clock)', () => {
  it('the design timeline: ask at 30 min, the answer resets, asks again, silent 10 min later, one message', async () => {
    const w = world();
    const start = w.t.now;
    let doc = watched(w.t);
    w.reach.upsert(doc);
    // One timer per step, to the next due time; nothing read or written before it.
    expect(w.timers.size).toBe(1);
    await w.advance(29 * M);
    expect(w.calls.asks).toEqual([]);
    expect(w.calls.reads).toEqual([]);
    await w.advance(M);
    // 10:30: the thread is read once (nothing newer), then the request goes out.
    expect(w.calls.reads).toEqual([start]);
    expect(w.calls.asks).toEqual([start + 30 * M]);
    // The listener sees the request on the outcome.
    doc = { ...doc, askMs: start + 30 * M };
    w.reach.upsert(doc);
    // 10:31: the agent answers with a status: the timer moves to 11:01.
    await w.advance(M);
    doc = {
      ...doc,
      activityMs: start + 31 * M,
      last: { text: 'tests green, opening the PR', atMs: start + 31 * M },
    };
    w.reach.upsert(doc);
    await w.advance(29 * M);
    expect(w.calls.asks).toHaveLength(1);
    await w.advance(M);
    expect(w.calls.asks).toEqual([start + 30 * M, start + 61 * M]);
    doc = { ...doc, askMs: start + 61 * M };
    w.reach.upsert(doc);
    // 11:11: no answer in 10 min → flagged, one message (and the bell).
    await w.advance(10 * M);
    expect(w.calls.flags).toHaveLength(1);
    expect(w.calls.flags[0]).toEqual({
      since: start + 31 * M,
      at: start + 71 * M,
      asked: start + 61 * M,
      agent: 'Hive',
      told: start + 71 * M,
    });
    expect(w.calls.told).toHaveLength(1);
    expect(w.calls.told[0]!.notice).toEqual({
      title: 'Hive is silent on "Dark mode for the board"',
      body: 'No update for 40 min at Reply, step 2 of 3; no answer to a status check 10 min ago. Last: "tests green, opening the PR" (40 min ago).',
      url: '/inbox/w/t/t1',
    });
    expect(w.calls.bells).toEqual([`ana/n-t1-o1_${start + 31 * M}`]);
    // Still silent: no more requests or messages until the 2-hour reminder; then exactly one.
    doc = { ...doc, flag: w.calls.flags[0]! };
    w.reach.upsert(doc);
    await w.advance(2 * H - M);
    expect(w.calls.told).toHaveLength(1);
    expect(w.calls.asks).toHaveLength(2);
    await w.advance(M);
    expect(w.calls.told).toHaveLength(2);
    expect(w.calls.told[1]!.notice.title).toBe(
      'Still silent: Hive is silent on "Dark mode for the board"',
    );
    doc = { ...doc, flag: w.calls.flags.at(-1)! };
    w.reach.upsert(doc);
    // Any activity clears the flag.
    await w.advance(5 * M);
    w.reach.upsert({ ...doc, activityMs: w.t.now });
    await w.flush();
    await w.advance(0);
    expect(w.calls.flags.at(-1)).toBeNull();
  });

  it('a busy agent (thread activity the outcome does not show) is never asked; one read per 30 min', async () => {
    const w = world();
    w.reach.upsert(watched(w.t));
    for (let i = 0; i < 8; i++) {
      w.found.ms = w.t.now + 25 * M;
      await w.advance(30 * M);
    }
    expect(w.calls.asks).toEqual([]);
    // 4 hours: the first read at 30 min, then one 30 min after each activity found.
    expect(w.calls.reads.length).toBeLessThanOrEqual(8);
  });

  it('quiet hours: flagged now, the message goes out on a later try', async () => {
    const w = world({ delivery: 'held' });
    w.reach.upsert(watched(w.t, { askMs: w.t.now }));
    await w.advance(10 * M);
    expect(w.calls.flags[0]).toMatchObject({ told: null });
    expect(w.calls.told).toEqual([]);
    expect(w.reach.next('w/o/o1')).toMatchObject({ do: 'remind', at: w.t.now + REACH_RETRY_MS });
  });

  it('another step starts over; removed steps keep no timer', async () => {
    const w = world();
    w.reach.upsert(watched(w.t, { askMs: w.t.now }));
    w.reach.upsert(watched(w.t, { run: 'o2' }));
    await w.advance(10 * M);
    expect(w.calls.flags).toEqual([]);
    w.reach.remove('w/o/o1');
    expect(w.timers.size).toBe(0);
    await w.advance(3 * H);
    expect(w.calls.asks).toEqual([]);
  });
});

describe('the silent message keyboard', () => {
  it('Ping again · Open on a thread step', async () => {
    const { reachKeyboard } = await import('./telegram');
    const step = reachKeyboard('c2', 'https://app/inbox/w/t/t');
    expect(step.map((r) => r.map((b) => b.text))).toEqual([['Ping again', 'Open']]);
    expect(step[0]![0]!.callback_data).toBe('rp:c2');
  });
});
