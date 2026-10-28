import { describe, expect, it } from 'vitest';
import { DEFAULT_SILENCE_AFTER, DEFAULT_STATUS_EVERY } from './schema';
import { silenceAfterOf, silenceDue, statusEveryOf } from './status';

const M = 60_000;
const ts = (ms: number) => ({ toMillis: () => ms }) as never;
const NOW = 10_000 * M;

function item(extra: Record<string, unknown> = {}) {
  return {
    status: 'working',
    claim: { runId: 'r1', agentUid: 'a', heartbeatAt: ts(NOW) },
    parked: null,
    awaitingAnswer: null,
    workStopped: null,
    statusUpdate: null,
    statusAsk: null,
    ...extra,
  } as never;
}

describe('status settings (item AzveC)', () => {
  it('the periodic status push is off by default; silence is flagged after 40 min', () => {
    expect(DEFAULT_STATUS_EVERY).toBe(0);
    expect(statusEveryOf({})).toBe(0);
    expect(statusEveryOf({ statusEvery: 30 })).toBe(30);
    expect(statusEveryOf({ statusEvery: 7 })).toBe(0);
    expect(DEFAULT_SILENCE_AFTER).toBe(40);
    expect(silenceAfterOf({})).toBe(40);
    expect(silenceAfterOf({ silenceAfter: 120 })).toBe(120);
    expect(silenceAfterOf({ silenceAfter: 0 })).toBe(0);
    expect(silenceAfterOf({ silenceAfter: 33 })).toBe(40);
  });
});

describe('silenceDue counts from the last activity (item AzveC)', () => {
  const due = (o: {
    item?: unknown;
    after?: number;
    startedAgo?: number;
    activityAgo?: number | null;
  }) =>
    silenceDue({
      item: (o.item ?? item()) as never,
      project: o.after === undefined ? {} : { silenceAfter: o.after },
      startedMs: NOW - (o.startedAgo ?? 3 * 60 * M),
      activityMs:
        o.activityAgo === undefined || o.activityAgo === null ? null : NOW - o.activityAgo,
      nowMs: NOW,
    });

  it('silent 40 min after the claim with no activity at all', () => {
    expect(due({ startedAgo: 39 * M })).toBeNull();
    expect(due({ startedAgo: 41 * M })).toEqual({ runId: 'r1', since: NOW - 41 * M, asked: false });
  });

  it('a recent log line or tool write keeps it quiet, without any status', () => {
    expect(due({ activityAgo: 2 * M })).toBeNull();
    expect(due({ activityAgo: 45 * M })).toEqual({
      runId: 'r1',
      since: NOW - 45 * M,
      asked: false,
    });
  });

  it('a status counts as activity', () => {
    const statusUpdate = { runId: 'r1', text: 'x', pct: null, at: ts(NOW - 5 * M), by: 'a' };
    expect(due({ item: item({ statusUpdate }) })).toBeNull();
    // A status of an earlier claim does not.
    const old = { ...statusUpdate, runId: 'r0' };
    expect(due({ item: item({ statusUpdate: old }) })).not.toBeNull();
  });

  it('the project threshold, and 0 = never', () => {
    expect(due({ activityAgo: 25 * M, after: 20 })).not.toBeNull();
    expect(due({ activityAgo: 25 * M })).toBeNull();
    expect(due({ activityAgo: 5 * 60 * M, after: 0 })).toBeNull();
  });

  it('a person asking: silent 10 min later unless there was activity after the ask', () => {
    const statusAsk = { runId: 'r1', byUid: 'p', at: ts(NOW - 11 * M) };
    const asked = item({ statusAsk });
    expect(due({ item: asked, activityAgo: 15 * M, after: 0 })).toMatchObject({ asked: true });
    expect(due({ item: asked, activityAgo: 5 * M, after: 0 })).toBeNull();
    const fresh = item({ statusAsk: { ...statusAsk, at: ts(NOW - 9 * M) } });
    expect(due({ item: fresh, activityAgo: 15 * M, after: 0 })).toBeNull();
  });

  it('never while parked, waiting for an answer, or stopped', () => {
    const parked = { runId: 'r1', reason: 'x', at: ts(NOW - 3 * 60 * M) };
    expect(due({ item: item({ parked }) })).toBeNull();
    expect(due({ item: item({ awaitingAnswer: { questionId: 'q' } }) })).toBeNull();
    expect(due({ item: item({ workStopped: { at: ts(0) } }) })).toBeNull();
    expect(due({ item: item({ status: 'waiting' }) })).toBeNull();
  });
});
