import { describe, expect, it } from 'vitest';
import type { ActionContext, ItemState } from './actions';
import {
  pingAgent,
  REACH_ANSWER_MS,
  REACH_PARKED_MS,
  REACH_QUIET_MS,
  REACH_REMIND_MS,
  reachKind,
  reachNext,
  silentNotice,
  silentText,
} from './reachout';
import type { Item } from './schema';

const M = 60_000;
const ts = (ms: number) => ({ toMillis: () => ms }) as unknown as Item['updatedAt'];
const T = Date.UTC(2026, 9, 30, 12, 0, 0);

const item = (over: Partial<Item> = {}) =>
  ({
    status: 'working',
    claim: { runId: 'r1', agentUid: 'a', heartbeatAt: ts(T - M) },
    parked: null,
    awaitingAnswer: null,
    workStopped: null,
    ...over,
  }) as unknown as Item;

describe('reachKind', () => {
  it('held, parked, stale; nothing for queued, waiting-for-answer or stopped items', () => {
    expect(reachKind(item(), T)).toBe('held');
    expect(
      reachKind(item({ parked: { runId: 'r1', reason: 'release', at: ts(T) } as never }), T),
    ).toBe('parked');
    // A park of an earlier run does not count.
    expect(
      reachKind(item({ parked: { runId: 'r0', reason: 'release', at: ts(T) } as never }), T),
    ).toBe('held');
    expect(
      reachKind(item({ claim: { runId: 'r1', agentUid: 'a', heartbeatAt: ts(T - 11 * M) } }), T),
    ).toBe('stale');
    expect(reachKind(item({ status: 'queued' }), T)).toBeNull();
    expect(reachKind(item({ awaitingAnswer: { questionId: 'q' } as never }), T)).toBeNull();
    expect(reachKind(item({ workStopped: {} as never }), T)).toBeNull();
    expect(reachKind(item({ claim: null }), T)).toBeNull();
  });
});

describe('reachNext', () => {
  it('quiet → ask after 30 min (2 h when parked)', () => {
    expect(reachNext({ kind: 'held', activityMs: T, askMs: null, flag: null })).toEqual({
      do: 'ask',
      at: T + REACH_QUIET_MS,
    });
    expect(reachNext({ kind: 'parked', activityMs: T, askMs: null, flag: null })).toEqual({
      do: 'ask',
      at: T + REACH_PARKED_MS,
    });
  });
  it('an unanswered request → silent 10 min later; an answered one starts a new quiet period', () => {
    expect(reachNext({ kind: 'held', activityMs: T, askMs: T + 30 * M, flag: null })).toEqual({
      do: 'silent',
      at: T + 40 * M,
      askMs: T + 30 * M,
    });
    expect(
      reachNext({ kind: 'held', activityMs: T + 31 * M, askMs: T + 30 * M, flag: null }),
    ).toEqual({
      do: 'ask',
      at: T + 61 * M,
    });
    expect(REACH_ANSWER_MS).toBe(10 * M);
  });
  it('flagged: a reminder 2 h after the last message; activity clears it', () => {
    const flag = { since: T, at: T + 40 * M, told: T + 40 * M };
    expect(reachNext({ kind: 'held', activityMs: T, askMs: T + 30 * M, flag })).toEqual({
      do: 'remind',
      at: T + 40 * M + REACH_REMIND_MS,
    });
    expect(reachNext({ kind: 'held', activityMs: T + 50 * M, askMs: T + 30 * M, flag })).toEqual({
      do: 'clear',
      at: T + 50 * M,
    });
  });
  it('a stale claim goes back to the queue 30 min after it went stale (40 min after the last heartbeat)', () => {
    expect(
      reachNext({ kind: 'stale', activityMs: T, askMs: null, flag: null, heartbeatMs: T - 5 * M }),
    ).toEqual({ do: 'ask', at: T + 30 * M });
    expect(
      reachNext({ kind: 'stale', activityMs: T, askMs: null, flag: null, heartbeatMs: T - 20 * M }),
    ).toEqual({ do: 'release', at: T + 20 * M });
  });
});

describe('texts', () => {
  it('silent for N min, hours past two hours', () => {
    expect(silentText('Hive', T - 41 * M, T)).toBe('Hive silent for 41 min');
    expect(silentText(undefined, T - 150 * M, T)).toBe('Agent silent for 2 h');
  });
  it('the message: what, where, the unanswered check and the last status', () => {
    expect(
      silentNotice({
        agentName: 'Hive',
        title: 'Dark mode for the board',
        where: 'Build',
        sinceMs: T - 41 * M,
        askMs: T - 10 * M,
        last: { text: 'tests green, opening the PR', atMs: T - 41 * M },
        nowMs: T,
        url: '/p/p?item=i',
      }),
    ).toEqual({
      title: 'Hive is silent on "Dark mode for the board"',
      body: 'No update for 41 min at Build; no answer to a status check 10 min ago. Last: "tests green, opening the PR" (41 min ago).',
      url: '/p/p?item=i',
    });
  });
});

describe('pingAgent', () => {
  const ctx: ActionContext = {
    workspaceId: 'w',
    actor: { type: 'human', id: 'ana', name: 'Ana' },
    newId: () => 'e1',
  };
  it('asks on any claimed item, at most once per 2 minutes', () => {
    const it = item() as unknown as ItemState;
    const p = pingAgent(ctx, { projectId: 'p', itemId: 'i', item: it, nowMs: T });
    expect(p.ops.find((o) => o.path.endsWith('/items/i'))!.data).toMatchObject({
      statusAsk: { runId: 'r1', byUid: 'ana' },
    });
    const asked = item({ statusAsk: { runId: 'r1', byUid: 'x', at: ts(T - M) } }) as never;
    expect(() => pingAgent(ctx, { projectId: 'p', itemId: 'i', item: asked, nowMs: T })).toThrow(
      /2 minutes/,
    );
    expect(() =>
      pingAgent(ctx, {
        projectId: 'p',
        itemId: 'i',
        item: item({ status: 'queued', claim: null }) as never,
        nowMs: T,
      }),
    ).toThrow(/No agent/);
  });
});
