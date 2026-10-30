/** Decision insights on threads (slice 9, acceptance 17). */
import { describe, expect, it } from 'vitest';
import { byStep, threadCsv, threadKpis, toDecision, type ThreadDecision } from './threadLogic';

const at = (ms: number) => ({ toMillis: () => ms });
const human = { type: 'human' as const, id: 'alice', name: 'Alice' };
const agent = { type: 'agent' as const, id: 'hive', name: 'Hive' };
function ev(
  type: string,
  data: Record<string, unknown>,
  ms: number,
  actor: typeof human | typeof agent = human,
) {
  return { actor, type, data, threadId: 't1', at: at(ms) } as never;
}
const dec = (id: string, e: unknown) => toDecision(id, e as never);

describe('toDecision', () => {
  it('reads a person’s decisions only; a cancelled request is none', () => {
    expect(dec('a', ev('outcome.approved', { stepLabel: 'Ship it?' }, 1, agent))).toBeNull();
    expect(dec('b', ev('plan.sent_back', { reason: 'x' }, 1, agent))).toBeNull();
    expect(
      dec('c', ev('outcome.revise_requested', { instruction: null, chips: [] }, 1)),
    ).toBeNull();
    expect(dec('d', ev('thread.not_now', {}, 1))).toBeNull();
    expect(
      dec('e', ev('outcome.rejected', { planId: 'p', stepLabel: 'Ship it?' }, 1)),
    ).toMatchObject({
      kind: 'stopped',
    });
    expect(
      dec('f', ev('outcome.rejected', { outcomeId: 'o', stepLabel: 'Reply' }, 1)),
    ).toMatchObject({
      kind: 'rejected',
    });
  });
  it('a send back carries its target; the recommendation is matched by its words', () => {
    const d = dec(
      's',
      ev(
        'plan.sent_back',
        {
          planId: 'p',
          stepLabel: 'Ship it?',
          toLabel: 'Build',
          recommended: 'Approve',
          waitedMs: 600_000,
        },
        5,
      ),
    )!;
    expect(d).toMatchObject({
      kind: 'changes',
      step: 'Ship it?',
      toStep: 'Build',
      followed: false,
    });
    const a = dec(
      'a',
      ev('outcome.approved', { planId: 'p', stepLabel: 'Ship it?', recommended: 'Ship it' }, 6),
    )!;
    expect(a.followed).toBe(true);
    const n = dec(
      'n',
      ev('outcome.approved', { outcomeId: 'o', stepLabel: 'Reply', recommended: 'Hmm' }, 6),
    )!;
    expect(n.followed).toBeNull();
  });
});

describe('threadKpis', () => {
  const rows = [
    ev(
      'plan.sent_back',
      {
        planId: 'p',
        stepLabel: 'Ship it?',
        toLabel: 'Build',
        recommended: 'Approve',
        waitedMs: 60_000,
      },
      1,
    ),
    ev(
      'outcome.approved',
      { planId: 'p', stepLabel: 'Ship it?', recommended: 'Approve', waitedMs: 180_000 },
      2,
    ),
    ev(
      'outcome.approved',
      { planId: 'p', stepLabel: 'Approve idea', recommended: 'Approve', waitedMs: 120_000 },
      0,
    ),
    ev('plan.sent_back', { planId: 'q', stepLabel: 'Ship it?', toLabel: 'Build' }, 3),
    ev('plan.stopped', { planId: 'q', stepLabel: 'Build' }, 4),
  ]
    .map((e, i) => dec(`r${i}`, e))
    .filter((d): d is ThreadDecision => d !== null);
  it('counts made, first time, sent back per target, stopped, median wait, followed', () => {
    expect(threadKpis(rows)).toEqual({
      made: 5,
      approved: 2,
      // Keys: p/Ship it? (first: send back), p/Approve idea (approved), q/Ship it? (send back), q/Build (stopped).
      firstTimePct: 25,
      sentBack: 2,
      stopped: 1,
      sentBackTo: [{ step: 'Ship it? → Build', count: 2 }],
      medianWaitMs: 120_000,
      followedPct: 67,
    });
  });
  it('no decisions: zeros and n/a', () => {
    expect(threadKpis([])).toMatchObject({
      made: 0,
      firstTimePct: null,
      medianWaitMs: null,
      followedPct: null,
    });
  });
  it('groups by step; the CSV has one line per decision', () => {
    expect(byStep(rows)[0]).toMatchObject({ step: 'Ship it?', made: 3, approved: 1, sentBack: 2 });
    const csv = threadCsv(rows, { thread: () => 'Dark mode', person: () => 'Alice' });
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[0]).toContain('Sent back to');
    expect(csv).toContain('Sent back to Build');
  });
});
