import { describe, expect, it } from 'vitest';
import {
  CHANNEL_INSTRUCTIONS,
  ChannelSession,
  channelInstructions,
  parseMaxItems,
  workText,
} from './channel';
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
  it('keeps the instructions and work text of a one-item session exactly as before', () => {
    expect(channelInstructions(1)).toBe(CHANNEL_INSTRUCTIONS);
    expect(channelInstructions()).toBe(CHANNEL_INSTRUCTIONS);
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
