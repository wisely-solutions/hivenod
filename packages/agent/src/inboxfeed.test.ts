import { describe, expect, it } from 'vitest';
import {
  InboxFeed,
  inboxText,
  parseMaxInbox,
  type FeedEventDoc,
  type FeedOutcome,
  type FeedPush,
  type FeedThread,
  type InboxFeedOptions,
} from './inboxfeed';

const DAY = 86_400_000;

/** A feed on a fake source: set rows, deliver them, read what was pushed. */
function rig(opts: InboxFeedOptions = {}) {
  let now = 1_000_000_000_000;
  const events = new Map<string, FeedEventDoc>();
  const pushed: FeedPush[] = [];
  const woken: string[] = [];
  let onT: ((r: FeedThread[]) => void) | null = null;
  let onO: ((r: FeedOutcome[]) => void) | null = null;
  let subscriptions = 0;
  let threads: FeedThread[] = [];
  let outcomes: FeedOutcome[] = [];
  const feed = new InboxFeed(
    {
      watchThreads: (on) => {
        subscriptions++;
        onT = on;
        on(threads);
        return () => (onT = null);
      },
      watchOutcomes: (on) => {
        onO = on;
        on(outcomes);
        return () => (onO = null);
      },
      eventOf: async (id) => events.get(id) ?? null,
      wake: async (id) => void woken.push(id),
    },
    async (e) => void pushed.push(e),
    { tickMs: 3_600_000, ...opts },
    () => now,
  );
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    await feed.flushed();
  };
  const th = (id: string, over: Partial<FeedThread> = {}): FeedThread => ({
    id,
    memberUid: 'joao',
    state: 'investigating',
    title: `Thread ${id}`,
    lastEventId: `e-${id}`,
    updatedAtMs: now,
    lastMessageAtMs: now,
    waiting: null,
    ...over,
  });
  return {
    feed,
    pushed,
    woken,
    events,
    th,
    get subscriptions() {
      return subscriptions;
    },
    advance: (ms: number) => (now += ms),
    now: () => now,
    /** Sets the documents and delivers them, like a snapshot. */
    async set(t: FeedThread[], o: FeedOutcome[] = outcomes) {
      threads = t;
      outcomes = o;
      onT?.(threads);
      onO?.(outcomes);
      await settle();
    },
    event(id: string, type: string, data: Record<string, unknown> = {}) {
      events.set(id, { type, data });
    },
    settle,
    kinds: () =>
      pushed.map((p) => `${p.meta.thread_id}:${p.meta.reason}${p.meta.update ? '+' : ''}`),
  };
}

describe('inbox events (item 4PEHr)', () => {
  it('a new thread is pushed once; the same documents again (a reconnect) push nothing', async () => {
    const r = rig();
    r.feed.start();
    r.event('e-t1', 'inbox.added', { newThread: true });
    await r.set([r.th('t1')]);
    expect(r.kinds()).toEqual(['t1:new']);
    expect(r.pushed[0]!.meta).toMatchObject({
      kind: 'inbox',
      thread_id: 't1',
      member: 'joao',
      inbox_cap: '3',
      inbox_active: '1',
    });
    expect(r.pushed[0]!.content).toMatch(/background sub-agent/);
    expect(r.pushed[0]!.content).toMatch(/thread_read \(threadId t1\)/);
    await r.set([r.th('t1')]);
    r.feed.subscribe(); // the listener reconnects: every document again
    await r.settle();
    expect(r.subscriptions).toBe(2);
    expect(r.kinds()).toEqual(['t1:new']);
  });

  it('at most maxInbox in flight; the next goes out when a thread moves on', async () => {
    const r = rig({ maxInbox: 2 });
    r.feed.start();
    for (const id of ['a', 'b', 'c']) r.event(`e-${id}`, 'inbox.added', { newThread: true });
    await r.set([r.th('a'), r.th('b'), r.th('c')]);
    expect(r.kinds()).toEqual(['a:new', 'b:new']);
    expect(r.feed.active).toBe(2);
    // A note on a thread in flight is nothing new; a new message is passed on, not counted.
    r.event('n-a', 'thread.note');
    r.event('m-b', 'inbox.added', { newThread: false });
    await r.set([r.th('a', { lastEventId: 'n-a' }), r.th('b', { lastEventId: 'm-b' }), r.th('c')]);
    expect(r.kinds()).toEqual(['a:new', 'b:new', 'b:message+']);
    expect(r.pushed[2]!.content).toMatch(/already works on thread b/);
    // a is proposed (Your call): it leaves the feed, c goes out.
    await r.set([r.th('b', { lastEventId: 'm-b' }), r.th('c')]);
    expect(r.kinds()).toEqual(['a:new', 'b:new', 'b:message+', 'c:new']);
  });

  it('the answer to inbox_ask, a rejection, a failure and a thread brought back', async () => {
    const r = rig({ maxInbox: 10 });
    r.feed.start();
    r.event('x1', 'thread.answered', { question: 'Thursday or Friday?', answer: 'Thursday' });
    r.event('x2', 'outcome.rejected', { reason: 'Too formal' });
    r.event('x3', 'outcome.failed', { error: 'Teams said 403' });
    r.event('x4', 'thread.restored');
    await r.set([
      r.th('t1', { lastEventId: 'x1' }),
      r.th('t2', { lastEventId: 'x2' }),
      r.th('t3', { lastEventId: 'x3' }),
      r.th('t4', { lastEventId: 'x4' }),
    ]);
    expect(r.kinds()).toEqual(['t1:answered', 't2:rejected', 't3:failed', 't4:restored']);
    expect(r.pushed[0]!.content).toContain('Your question: Thursday or Friday?');
    expect(r.pushed[0]!.content).toContain('Their answer: Thursday');
    expect(r.pushed[1]!.content).toContain('Too formal');
    expect(r.pushed[2]!.content).toContain('Teams said 403');
  });

  it('a new session resumes threads still being investigated, once', async () => {
    const r = rig();
    r.event('n1', 'thread.note');
    r.feed.start();
    await r.set([r.th('t1', { lastEventId: 'n1' })]);
    expect(r.kinds()).toEqual(['t1:resume']);
    r.event('n2', 'thread.note');
    await r.set([r.th('t1', { lastEventId: 'n2' })]);
    expect(r.kinds()).toEqual(['t1:resume']);
  });

  it('an approved outcome goes to its executor once, before anything else', async () => {
    const r = rig({ maxInbox: 1 });
    r.feed.start();
    r.event('e-t1', 'inbox.added', { newThread: true });
    const o = { id: 'o1', threadId: 't9', memberUid: 'joao', type: 'reply', createdAtMs: r.now() };
    await r.set([r.th('t1')], [o]);
    expect(r.kinds()).toEqual(['t9:carry_out']);
    expect(r.pushed[0]!.meta).toMatchObject({ outcome_id: 'o1', outcome_type: 'reply' });
    expect(r.pushed[0]!.content).toMatch(/outcome_done/);
    await r.set([r.th('t1')], [o]); // re-delivered: nothing new
    expect(r.kinds()).toEqual(['t9:carry_out']);
    await r.set([r.th('t1')], []); // done: the slot frees, the thread goes out
    expect(r.kinds()).toEqual(['t9:carry_out', 't1:new']);
  });

  it('a snooze that is due is woken (once); its wake sends the event', async () => {
    const r = rig();
    r.feed.start();
    const snoozed = r.th('t1', {
      state: 'waiting',
      lastEventId: 's1',
      waiting: { on: 'date', untilMs: r.now() + 1000 },
    });
    await r.set([snoozed]);
    expect(r.woken).toEqual([]);
    r.advance(2000);
    r.feed.evaluate();
    r.feed.evaluate();
    await r.settle();
    expect(r.woken).toEqual(['t1']);
    r.event('w1', 'thread.woke');
    await r.set([r.th('t1', { lastEventId: 'w1' })]);
    expect(r.kinds()).toEqual(['t1:woke']);
  });

  it('a nudge is due after nudgeAfterMs waiting on them, once per wait', async () => {
    const r = rig({ nudgeAfterMs: 3 * DAY });
    r.feed.start();
    const waiting = r.th('t1', {
      state: 'waiting',
      lastEventId: 'd1',
      updatedAtMs: r.now(),
      waiting: { on: 'them', untilMs: null },
    });
    await r.set([waiting]);
    expect(r.kinds()).toEqual([]);
    r.advance(3 * DAY);
    r.feed.evaluate();
    await r.settle();
    expect(r.kinds()).toEqual(['t1:nudge_due']);
    expect(r.pushed[0]!.content).toMatch(/outcome_propose, type nudge/);
    r.feed.evaluate();
    await r.set([waiting]);
    expect(r.kinds()).toEqual(['t1:nudge_due']);
  });

  it('at most perMinute events a minute', async () => {
    const r = rig({ maxInbox: 10, perMinute: 2 });
    r.feed.start();
    for (const id of ['a', 'b', 'c']) r.event(`e-${id}`, 'inbox.added', { newThread: true });
    await r.set([r.th('a'), r.th('b'), r.th('c')]);
    expect(r.kinds()).toEqual(['a:new', 'b:new']);
    r.advance(60_000);
    r.feed.evaluate();
    await r.settle();
    expect(r.kinds()).toEqual(['a:new', 'b:new', 'c:new']);
    r.feed.stop();
  });

  it('maxInbox 0 is off; --max-inbox is 0 to 10', () => {
    const r = rig({ maxInbox: 0 });
    r.feed.start();
    expect(r.subscriptions).toBe(0);
    expect(parseMaxInbox('0', '--max-inbox')).toBe(0);
    expect(parseMaxInbox(undefined, '--max-inbox')).toBeUndefined();
    expect(() => parseMaxInbox('11', '--max-inbox')).toThrow(/0 to 10/);
    expect(() => parseMaxInbox('1.5', '--max-inbox')).toThrow();
  });

  it('keeps pushed text short', () => {
    const t = inboxText({
      reason: 'answered',
      threadId: 't1',
      title: 'x'.repeat(500),
      question: 'q'.repeat(5000),
      answer: 'a'.repeat(9000),
    });
    expect(t.length).toBeLessThan(5500);
  });
});
