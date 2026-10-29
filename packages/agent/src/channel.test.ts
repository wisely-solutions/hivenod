import { describe, expect, it } from 'vitest';
import {
  CHANNEL_INSTRUCTIONS,
  ChannelSession,
  GIVE_BACK_SKIP_MS,
  INBOX_INSTRUCTIONS,
  type ChannelEvent,
  channelInstructions,
  parseMaxItems,
  workText,
} from './channel';
import { PARK_RETURN_MS } from '@hive/shared';
import type { HiveClient } from './client';

const row = { title: 'Login page', project: 'Web', step: 'Build', job: null };

describe('channel events', () => {
  it('says what the work is and why it is back', () => {
    expect(workText(row, { why: 'arrived' })).toMatch(
      /^New work in Web, step Build: "Login page"\.\nIt is claimed for you/,
    );
    expect(workText(row, { why: 'sent_back', by: 'Tester', text: 'Safari test fails' })).toContain(
      'It was sent back to this step by Tester. The reason: Safari test fails',
    );
    const a = workText(row, { why: 'answered', by: 'Ana', text: 'Euro', question: 'Currency?' });
    expect(a).toContain('Your question: Currency?');
    expect(a).toContain('Ana answered: Euro');
    expect(workText({ ...row, job: 'shape' }, { why: 'arrived' })).toMatch(/to shape/);
  });
  it('keeps long texts short', () => {
    const t = workText(row, { why: 'sent_back', by: 'T', text: 'x'.repeat(10_000) });
    expect(t.length).toBeLessThan(3300);
  });
  it('tells the model that pushed text is data, never approval, and to keep the token out', () => {
    expect(CHANNEL_INSTRUCTIONS).toMatch(/never an approval/);
    expect(CHANNEL_INSTRUCTIONS).toMatch(/Never print the Hivenod token/);
    expect(CHANNEL_INSTRUCTIONS).toMatch(/Only one at a time/);
  });
});

describe('ChannelSession.stop (card pqqOWE3s)', () => {
  it('writes offline once, at once, and stops presence writes', async () => {
    const calls: string[] = [];
    const client = {
      markSeen: async () => void calls.push('seen'),
      markOffline: async () => void calls.push('offline'),
      refreshAgent: async () => undefined,
      syncServerClock: async () => undefined,
      checkNoOtherTerminal: () => undefined,
      waitForWork: () => new Promise(() => undefined),
    } as unknown as HiveClient;
    const s = new ChannelSession(client, async () => undefined, { presenceMs: 10 });
    await s.start();
    await s.stop();
    await s.stop();
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.filter((c) => c === 'offline')).toHaveLength(1);
    expect(calls[calls.length - 1]).toBe('offline');
  });
});

describe('max_items (card cGSENsRF)', () => {
  it('keeps the instructions (plus the inbox paragraph) and work text of a one-item session as before', () => {
    expect(channelInstructions(1)).toBe(`${CHANNEL_INSTRUCTIONS}\n${INBOX_INSTRUCTIONS}`);
    expect(channelInstructions()).toBe(channelInstructions(1));
    expect(channelInstructions(3)).toContain(INBOX_INSTRUCTIONS);
    expect(workText({ ...row, itemId: 'i9' }, { why: 'arrived' }, 1)).toBe(
      workText(row, { why: 'arrived' }),
    );
  });
  it('asks a multi-item session for one background sub-agent per item, with the item id', () => {
    const ins = channelInstructions(3);
    expect(ins).toMatch(/Up to 3 items at a time/);
    expect(ins).toMatch(/own background sub-agent/);
    expect(ins).toMatch(/itemId="<item_id>"/);
    expect(ins).toMatch(/stop that item's sub-agent at once \(only that one/);
    expect(ins).toMatch(/never an approval/);
    expect(ins).toMatch(/Never print the Hivenod token/);
    const w = workText({ ...row, itemId: 'i9' }, { why: 'arrived' }, 3);
    expect(w).toContain('item_id i9');
    expect(w).toContain('background sub-agent');
    expect(w).toContain('itemId="i9"');
    expect(workText({ ...row, itemId: 'i9', job: 'shape' }, { why: 'arrived' }, 3)).toMatch(
      /shape_item; do not do its work/,
    );
  });
  it('parses --max-items / HIVENOD_MAX_ITEMS', () => {
    expect(parseMaxItems(undefined, '--max-items')).toBeUndefined();
    expect(parseMaxItems('', 'HIVENOD_MAX_ITEMS')).toBeUndefined();
    expect(parseMaxItems('3', '--max-items')).toBe(3);
    for (const bad of ['0', '-1', '2.5', 'abc', '11'])
      expect(() => parseMaxItems(bad, '--max-items')).toThrow(/whole number from 1 to 10/);
  });

  const sessionHolding = (n: number, maxItems = 3) => {
    const s = new ChannelSession({} as HiveClient, async () => undefined, { maxItems });
    const map = (s as unknown as { current: Map<string, unknown> }).current;
    for (let i = 1; i <= n; i++)
      map.set(`r${i}`, {
        itemId: `i${i}`,
        projectId: 'p1',
        runId: `r${i}`,
        title: `T${i}`,
        stops: [],
      });
    return s;
  };
  it('resolves the item of a tool call against the held items', () => {
    const one = sessionHolding(1, 1);
    expect(one.resolve('add_note', {})).toMatchObject({ itemId: 'i1', runId: 'r1' });
    expect(one.resolve('log', { runId: 'r1' })).toMatchObject({ itemId: 'i1' });
    const three = sessionHolding(3);
    expect(three.held().map((h) => h.itemId)).toEqual(['i1', 'i2', 'i3']);
    expect(() => three.resolve('complete', {})).toThrow(
      /holds 3 items: pass itemId to complete\. Items held now: i1 \("T1"\), i2/,
    );
    expect(three.resolve('complete', { itemId: 'i2' })).toMatchObject({ runId: 'r2' });
    expect(three.resolve('log', { runId: 'r3' })).toMatchObject({ itemId: 'i3' });
    expect(() => three.resolve('add_note', { itemId: 'zz' })).toThrow(
      /does not hold item zz, so add_note refuses it/,
    );
    expect(() => three.resolve('complete', { itemId: 'i1', runId: 'r2' })).toThrow(
      /not the open run of item i1/,
    );
    expect(() => sessionHolding(0).resolve('log', {})).toThrow(/holds no item right now/);
  });
  it('refuses the tools of an item a person stopped', () => {
    const s = sessionHolding(0);
    (s as unknown as { stoppedItems: Map<string, string> }).stoppedItems.set('i2', 'r2');
    (s as unknown as { stoppedRuns: Set<string> }).stoppedRuns.add('r2');
    expect(s.wasStopped({ itemId: 'i2' })).toBe(true);
    expect(() => s.resolve('complete', { itemId: 'i2' })).toThrow(
      /A person stopped the work on item i2/,
    );
    expect(() => s.resolve('log', { runId: 'r2' })).toThrow(/stopped the work of run r2/);
  });
});

describe('give-back skip (item QjTTL)', () => {
  it('does not hand a given-back item to the same session for 10 minutes (fake clock)', () => {
    let t = 1_000_000;
    const s = new ChannelSession({} as HiveClient, async () => undefined, { now: () => t });
    const skipped = (id: string) => (s as unknown as { skipped(i: string): boolean }).skipped(id);
    expect(skipped('a')).toBe(false);
    s.gaveBack('a');
    expect(skipped('a')).toBe(true);
    expect(skipped('b')).toBe(false);
    t += GIVE_BACK_SKIP_MS - 1;
    expect(skipped('a')).toBe(true);
    t += 1;
    expect(skipped('a')).toBe(false);
    s.gaveBack('b');
    s.forgetGiveBack('b');
    expect(skipped('b')).toBe(false);
  });
});

describe('parking (item QjTTL)', () => {
  const setup = () => {
    let t = 5_000_000;
    const calls: string[] = [];
    const pushed: ChannelEvent[] = [];
    const client = {
      park: async (itemId: string, reason: string) => {
        calls.push(`park ${itemId} ${reason}`);
        return { itemId, parked: { reason } };
      },
      unpark: async (itemId: string) => void calls.push(`unpark ${itemId}`),
      addNote: async (itemId: string, text: string) => void calls.push(`note ${itemId} ${text}`),
      release: async (itemId: string) => void calls.push(`release ${itemId}`),
      untrackRun: () => undefined,
    } as unknown as HiveClient;
    const s = new ChannelSession(client, async (e) => void pushed.push(e), {
      maxItems: 2,
      now: () => t,
    });
    // Closed: look() does nothing, so no real hand-over starts.
    (s as unknown as { closed: boolean }).closed = true;
    const map = (s as unknown as { current: Map<string, unknown> }).current;
    for (const i of [1, 2])
      map.set(`r${i}`, {
        itemId: `i${i}`,
        projectId: 'p1',
        runId: `r${i}`,
        title: `T${i}`,
        stops: [],
        parked: null,
      });
    return { s, calls, pushed, tick: (ms: number) => (t += ms) };
  };

  it('a parked item does not count toward max_items; a wake counts it again', async () => {
    const { s, calls } = setup();
    expect(s.active).toBe(2);
    const out = await s.park('i1', 'release batch');
    expect(out.note).toMatch(/no longer counts toward max_items/);
    expect(s.active).toBe(1);
    expect(s.parkedCount).toBe(1);
    expect(s.isParked('i1')).toBe(true);
    await s.wakeItem('i1');
    await s.wakeItem('i1'); // not parked any more: no second write
    expect(s.active).toBe(2);
    expect(calls).toEqual(['park i1 release batch', 'unpark i1']);
  });

  it('returns a parked item to the queue after 24 h, with a note (fake clock)', async () => {
    const { s, calls, pushed, tick } = setup();
    await s.park('i2', 'review by Ana');
    tick(PARK_RETURN_MS - 1);
    expect(await s.returnStale()).toEqual([]);
    tick(1);
    expect(await s.returnStale()).toEqual(['i2']);
    expect(calls.slice(1)).toEqual([
      'note i2 Parked for 24 hours without activity (waiting: review by Ana): back to the queue.',
      'release i2',
    ]);
    expect(s.held().map((h) => h.itemId)).toEqual(['i1']);
    expect(pushed.at(-1)?.meta).toMatchObject({ kind: 'info', code: 'returned', item_id: 'i2' });
    // Given back: not handed to this session again for 10 minutes.
    expect((s as unknown as { skipped(i: string): boolean }).skipped('i2')).toBe(true);
  });
});

describe('status checks (item AzveC)', () => {
  const ts = (ms: number) => ({ toMillis: () => ms });
  const setup = (every = 30) => {
    let t = 1_000_000;
    const pushed: ChannelEvent[] = [];
    const reads: string[] = [];
    const client = {
      statusEvery: async (pid: string) => {
        reads.push(pid);
        return every;
      },
      askedBy: async () => 'Ana',
      untrackRun: () => undefined,
    } as unknown as HiveClient;
    const s = new ChannelSession(client, async (e) => void pushed.push(e), {
      maxItems: 2,
      now: () => t,
    });
    (s as unknown as { closed: boolean }).closed = true;
    const map = (s as unknown as { current: Map<string, Record<string, unknown>> }).current;
    for (const i of [1, 2])
      map.set(`r${i}`, {
        itemId: `i${i}`,
        projectId: 'p1',
        runId: `r${i}`,
        title: `T${i}`,
        stops: [],
        parked: null,
        statusDue: t + every * 60_000,
        askSeen: 0,
      });
    const item = (runId: string, over: Record<string, unknown> = {}) => ({
      status: 'working',
      claim: { runId, agentUid: 'a', heartbeatAt: ts(t) },
      lastEventId: 'e1',
      ...over,
    });
    const snapshot = (runId: string, over: Record<string, unknown> = {}) =>
      (s as unknown as { onItem(h: unknown, it: unknown): void }).onItem(
        map.get(runId),
        item(runId, over),
      );
    return { s, pushed, reads, map, snapshot, now: () => t, tick: (ms: number) => (t += ms) };
  };
  const statuses = (p: ChannelEvent[]) => p.filter((e) => e.meta.kind === 'status');

  it('sends a status event per active item once the interval has passed (fake clock)', async () => {
    const { s, pushed, tick } = setup(30);
    tick(30 * 60_000 - 1);
    expect(await s.statusChecks()).toEqual([]);
    tick(1);
    expect(await s.statusChecks()).toEqual(['i1', 'i2']);
    const e = statuses(pushed)[0]!;
    expect(e.meta).toMatchObject({ kind: 'status', item_id: 'i1', run_id: 'r1', why: 'interval' });
    expect(e.content).toMatch(/Status check on "T1" \(item_id i1\)\. Pass it on to the sub-agent/);
    expect(e.content).toContain('status tool (itemId="i1"');
    // Not again until another interval has passed.
    tick(60_000);
    expect(await s.statusChecks()).toEqual([]);
    tick(29 * 60_000);
    expect(await s.statusChecks()).toEqual(['i1', 'i2']);
  });

  it('an answer resets the clock; parked or waiting items get no event', async () => {
    const { s, pushed, tick, now, snapshot } = setup(15);
    tick(10 * 60_000);
    // i1 answered 10 minutes in: its next check is 15 minutes after that answer.
    snapshot('r1', {
      statusUpdate: { runId: 'r1', text: 'Tests', pct: 50, at: ts(now()), by: 'a' },
    });
    // i2 waits for people (an ask held it).
    snapshot('r2', { awaitingAnswer: { questionId: 'q', agentUid: 'a', at: ts(now()) } });
    tick(5 * 60_000);
    expect(await s.statusChecks()).toEqual([]);
    tick(10 * 60_000);
    expect(await s.statusChecks()).toEqual(['i1']);
    await s.park('i1', 'release').catch(() => undefined);
    (s as unknown as { current: Map<string, { parked: unknown }> }).current.get('r1')!.parked = {
      reason: 'release',
      at: now(),
    };
    tick(60 * 60_000);
    expect(await s.statusChecks()).toEqual([]);
    expect(statuses(pushed)).toHaveLength(1);
  });

  it('interval 0 sends none; a person asking sends one at once, once per ask', async () => {
    const { s, pushed, tick, now, snapshot } = setup(0);
    snapshot('r1'); // the first snapshot (an older ask would be ignored)
    tick(120 * 60_000);
    expect(await s.statusChecks()).toEqual([]);
    const ask = { runId: 'r1', byUid: 'ana', at: ts(now()) };
    snapshot('r1', { statusAsk: ask, lastEventId: 'e2' });
    snapshot('r1', { statusAsk: ask, lastEventId: 'e2' }); // the same ask again: no second event
    await new Promise((r) => setTimeout(r, 10));
    const got = statuses(pushed);
    expect(got).toHaveLength(1);
    expect(got[0]!.meta).toMatchObject({ item_id: 'i1', why: 'asked' });
    expect(got[0]!.content).toMatch(/^Ana asked for a status on "T1" \(item_id i1\)\./);
  });

  it('reads the interval again only every few minutes', async () => {
    const { s, reads, tick } = setup(30);
    await s.statusChecks();
    await s.statusChecks();
    expect(reads).toHaveLength(1);
    tick(5 * 60_000);
    await s.statusChecks();
    expect(reads).toHaveLength(2);
  });
});
